import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Selectable, type Transaction, type Updateable } from 'kysely';
import type { AuthContext } from '../../auth/auth.types';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../common/db/pg-errors';
import { uuidv7 } from '../../common/ids/uuidv7';
import { decodeCursor, encodeCursor, likeEscape } from '../../common/pagination';
import { normalizePhone } from '../../common/phone';
import { isSupervisor } from '../../common/roles';
import type { CustomersTable, DB } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import type { CreateCustomerDto, CustomerDto, CustomerPageDto, ListCustomersQueryDto, UpdateCustomerDto } from './dto/customers.dto';

type Trx = Transaction<DB>;
type CustomerRow = Selectable<CustomersTable> & { balance_kobo: number | null; outstanding_debt: number | null };

@Injectable()
export class CustomersService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly events: EventPublisher,
  ) {}

  async create(auth: AuthContext, dto: CreateCustomerDto): Promise<CustomerDto> {
    // CUST-02: tags drive wholesale pricing, and limits drive credit exposure, so they are not cashier decisions.
    if (dto.type && dto.type !== 'retail' && !isSupervisor(auth.role)) {
      throw new ForbiddenException('Only owners and managers can tag customers as wholesale, VIP or staff');
    }
    if (dto.creditLimitKobo !== undefined && auth.role !== 'owner') {
      throw new ForbiddenException('Only the owner can set credit limits');
    }

    return this.withFriendlyErrors(() =>
      this.tenantDb.transaction(async (trx) => {
        if (dto.id) {
          const existing = await trx.selectFrom('customers').select('id').where('id', '=', dto.id).executeTakeFirst();
          if (existing) return this.load(trx, existing.id);
        }
        const id = dto.id ?? uuidv7();

        await trx
          .insertInto('customers')
          .values({
            id,
            organization_id: auth.organizationId,
            name: dto.name.trim(),
            phone: dto.phone ? normalizePhone(dto.phone) : null,
            email: dto.email?.trim().toLowerCase() || null,
            type: dto.type ?? 'retail',
            address: dto.address?.trim() || null,
            credit_limit_kobo: dto.creditLimitKobo ?? null,
            notes: dto.notes?.trim() || null,
            created_by: auth.userId,
          })
          .execute();

        const customer = await this.load(trx, id);
        await this.events.record(trx, {
          type: EventTypes.CustomerCreated,
          aggregateType: 'customer',
          aggregateId: id,
          payload: {
            after: {
              name: customer.name,
              phone: customer.phone,
              type: customer.type,
              creditLimitKobo: customer.creditLimitKobo,
            },
          },
        });
        return customer;
      }),
    );
  }

  async update(auth: AuthContext, id: string, dto: UpdateCustomerDto): Promise<CustomerDto> {
    if ((dto.type !== undefined || dto.isActive !== undefined) && !isSupervisor(auth.role)) {
      throw new ForbiddenException('Only owners and managers can change a customer type or status');
    }
    if (dto.creditLimitKobo !== undefined && auth.role !== 'owner') {
      throw new ForbiddenException('Only the owner can set credit limits');
    }

    return this.withFriendlyErrors(() =>
      this.tenantDb.transaction(async (trx) => {
        const current = await trx.selectFrom('customers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!current) throw new NotFoundException('Customer not found');

        const next: Updateable<CustomersTable> = {};
        if (dto.name !== undefined) next.name = dto.name.trim();
        if (dto.phone !== undefined) next.phone = dto.phone === null ? null : normalizePhone(dto.phone);
        if (dto.email !== undefined) next.email = dto.email?.trim().toLowerCase() || null;
        if (dto.type !== undefined) next.type = dto.type;
        if (dto.address !== undefined) next.address = dto.address?.trim() || null;
        if (dto.creditLimitKobo !== undefined) next.credit_limit_kobo = dto.creditLimitKobo;
        if (dto.notes !== undefined) next.notes = dto.notes?.trim() || null;
        if (dto.isActive !== undefined) next.is_active = dto.isActive;

        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(next)) {
          const old = current[column as keyof typeof current];
          if (old === value) {
            delete (next as Record<string, unknown>)[column];
          } else {
            before[column] = old;
            after[column] = value;
          }
        }

        if (Object.keys(next).length > 0) {
          await trx.updateTable('customers').set(next).where('id', '=', id).execute();
          await this.events.record(trx, {
            type: EventTypes.CustomerUpdated,
            aggregateType: 'customer',
            aggregateId: id,
            payload: { before, after },
          });
        }
        return this.load(trx, id);
      }),
    );
  }

  /** CUST-01: find a customer at checkout by name or any form of their phone number. */
  async list(query: ListCustomersQueryDto): Promise<CustomerPageDto> {
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const search = query.search?.trim();
    const namePattern = search ? `%${likeEscape(search)}%` : null;
    const phoneDigits = search ? phoneNeedle(search) : null;

    return this.tenantDb.transaction(async (trx) => {
      const defaultLimit = await this.defaultCreditLimit(trx);
      const rows = await this.baseQuery(trx)
        .$if(query.includeInactive !== 'true', (qb) => qb.where('c.is_active', '=', true))
        .$if(!!query.type, (qb) => qb.where('c.type', '=', query.type!))
        .$if(namePattern !== null, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb('c.name', 'ilike', namePattern!),
              ...(phoneDigits ? [eb('c.phone', 'like', `%${phoneDigits}%`)] : []),
            ]),
          ),
        )
        .$if(cursor !== null, (qb) => qb.where((eb) => eb(eb.refTuple('c.name', 'c.id'), '>', eb.tuple(cursor![0]!, cursor![1]!))))
        .orderBy('c.name')
        .orderBy('c.id')
        .limit(limit + 1)
        .execute();

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => toDto(r, defaultLimit)),
        nextCursor: rows.length > limit && last ? encodeCursor([last.name, last.id]) : null,
      };
    });
  }

  async get(id: string): Promise<CustomerDto> {
    return this.tenantDb.transaction((trx) => this.load(trx, id));
  }

  /** Also used by Sales for credit checks. */
  async load(trx: Trx, id: string): Promise<CustomerDto> {
    const row = await this.baseQuery(trx).where('c.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Customer not found');
    return toDto(row, await this.defaultCreditLimit(trx));
  }

  private baseQuery(trx: Trx) {
    return trx
      .selectFrom('customers as c')
      .leftJoin('customer_wallets as w', 'w.customer_id', 'c.id')
      .leftJoin(
        (eb) =>
          eb
            .selectFrom('debt_records')
            .select(['customer_id', sql<number>`sum(amount_kobo - paid_kobo)::bigint`.as('outstanding_debt')])
            .where('status', '=', 'open')
            .groupBy('customer_id')
            .as('d'),
        (join) => join.onRef('d.customer_id', '=', 'c.id'),
      )
      .selectAll('c')
      .select(['w.balance_kobo', 'd.outstanding_debt']);
  }

  private async defaultCreditLimit(trx: Trx): Promise<number | null> {
    const org = await trx.selectFrom('organizations').select('default_credit_limit_kobo').executeTakeFirstOrThrow();
    return org.default_credit_limit_kobo;
  }

  private async withFriendlyErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('Another customer already has this phone number');
      }
      throw err;
    }
  }
}

/** "0803 123", "+234803123" and "803123" should all find +2348031234567. */
function phoneNeedle(search: string): string | null {
  let digits = search.replace(/\D/g, '');
  if (digits.length < 4) return null;
  if (digits.startsWith('234')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return digits.length > 0 ? digits : null;
}

function toDto(r: CustomerRow, defaultLimit: number | null): CustomerDto {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    type: r.type,
    address: r.address,
    creditLimitKobo: r.credit_limit_kobo,
    effectiveCreditLimitKobo: r.credit_limit_kobo ?? defaultLimit,
    walletBalanceKobo: r.balance_kobo ?? 0,
    outstandingDebtKobo: Number(r.outstanding_debt ?? 0),
    notes: r.notes,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

