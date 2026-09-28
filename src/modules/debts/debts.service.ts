import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, Transaction } from 'kysely';
import type { AuthContext } from '../../auth/auth.types';
import { uuidv7 } from '../../common/ids/uuidv7';
import { decodeCursor, encodeCursor } from '../../common/pagination';
import type { DB } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import { WalletLedger } from '../customers/wallet-ledger.service';
import { RegisterSessionsService } from '../registers/register-sessions.service';
import { addToTotals, ageInDays, AGING_BUCKETS, allocateRepayment, AllocationError, bucketFor, emptyTotals } from './aging';
import type {
  AgingQueryDto,
  AgingReportDto,
  CustomerDebtsDto,
  RecordRepaymentDto,
  RepaymentDto,
  RepaymentPageDto,
  RepaymentResultDto,
  RepaymentsQueryDto,
} from './dto/debts.dto';

type Trx = Transaction<DB>;

@Injectable()
export class DebtsService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly registers: RegisterSessionsService,
    private readonly wallets: WalletLedger,
    private readonly events: EventPublisher,
  ) {}

  /** DEBT-04: record a full or partial repayment; oldest debts are cleared first. */
  async recordRepayment(auth: AuthContext, customerId: string, dto: RecordRepaymentDto): Promise<RepaymentResultDto> {
    try {
      return await this.tenantDb.transaction(async (trx) => {
        if (dto.id) {
          const existing = await trx.selectFrom('debt_repayments').select('id').where('id', '=', dto.id).executeTakeFirst();
          if (existing) return this.result(trx, customerId, existing.id, true);
        }
        const id = dto.id ?? uuidv7();

        const customer = await trx
          .selectFrom('customers')
          .select(['id', 'name'])
          .where('id', '=', customerId)
          .forUpdate()
          .executeTakeFirst();
        if (!customer) throw new NotFoundException('Customer not found');

        const debts = await trx
          .selectFrom('debt_records')
          .select(['id', 'amount_kobo', 'paid_kobo'])
          .where('customer_id', '=', customerId)
          .where('status', '=', 'open')
          .$if(!!dto.debtRecordId, (qb) => qb.where('id', '=', dto.debtRecordId!))
          .orderBy('created_at')
          .orderBy('id')
          .forUpdate()
          .execute();
        if (dto.debtRecordId && debts.length === 0) throw new BadRequestException('That debt is not open for this customer');

        const allocations = allocateRepayment(
          dto.amountKobo,
          debts.map((d) => ({ id: d.id, outstandingKobo: d.amount_kobo - d.paid_kobo })),
        );

        const till =
          dto.method === 'cash'
            ? await this.registers.recordCashInOpenSession(trx, auth, {
                kind: 'debt_repayment',
                amountKobo: dto.amountKobo,
                referenceType: 'debt_repayment',
                referenceId: id,
                action: 'taking cash',
              })
            : null;

        const walletTxnId = dto.method === 'wallet' ? uuidv7() : null;
        if (walletTxnId) {
          await this.wallets.record(trx, {
            id: walletTxnId,
            organizationId: auth.organizationId,
            customerId,
            type: 'payment',
            amountKobo: -dto.amountKobo,
            actorId: auth.userId,
            referenceType: 'debt_repayment',
            referenceId: id,
          });
        }

        await trx
          .insertInto('debt_repayments')
          .values({
            id,
            organization_id: auth.organizationId,
            customer_id: customerId,
            amount_kobo: dto.amountKobo,
            method: dto.method,
            reference: dto.reference?.trim() || null,
            note: dto.note?.trim() || null,
            wallet_transaction_id: walletTxnId,
            register_session_id: till?.sessionId ?? null,
            created_by: auth.userId,
          })
          .execute();

        // The database trigger adds each allocation to its debt's paid amount.
        await trx
          .insertInto('debt_repayment_allocations')
          .values(
            allocations.map((a) => ({
              id: uuidv7(),
              organization_id: auth.organizationId,
              repayment_id: id,
              debt_record_id: a.debtRecordId,
              amount_kobo: a.amountKobo,
            })),
          )
          .execute();

        const outstandingAfter = await this.outstanding(trx, customerId);
        await this.events.record(trx, {
          type: EventTypes.RepaymentRecorded,
          aggregateType: 'customer',
          aggregateId: customerId,
          payload: {
            repaymentId: id,
            amountKobo: dto.amountKobo,
            method: dto.method,
            reference: dto.reference?.trim() || null,
            allocations: allocations.map((a) => ({ debtRecordId: a.debtRecordId, amountKobo: a.amountKobo })),
            before: { outstandingKobo: outstandingAfter + dto.amountKobo },
            after: { outstandingKobo: outstandingAfter },
          },
        });
        if (walletTxnId) {
          await this.events.record(trx, {
            type: EventTypes.WalletDebited,
            aggregateType: 'customer',
            aggregateId: customerId,
            payload: { transactionId: walletTxnId, repaymentId: id, amountKobo: -dto.amountKobo },
          });
        }

        return this.result(trx, customerId, id, false);
      });
    } catch (err) {
      if (err instanceof AllocationError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  async customerDebts(customerId: string, status: 'open' | 'all' = 'open'): Promise<CustomerDebtsDto> {
    const asOf = new Date();
    return this.tenantDb.transaction(async (trx) => {
      const customer = await trx.selectFrom('customers').select(['id', 'name']).where('id', '=', customerId).executeTakeFirst();
      if (!customer) throw new NotFoundException('Customer not found');

      const rows = await trx
        .selectFrom('debt_records as d')
        .innerJoin('sales as s', 's.id', 'd.sale_id')
        .select(['d.id', 'd.sale_id', 's.number', 'd.amount_kobo', 'd.paid_kobo', 'd.status', 'd.created_at'])
        .where('d.customer_id', '=', customerId)
        .$if(status === 'open', (qb) => qb.where('d.status', '=', 'open'))
        .orderBy('d.created_at')
        .execute();

      const aging = emptyTotals();
      const debts = rows.map((d) => {
        const outstandingKobo = d.status === 'open' ? d.amount_kobo - d.paid_kobo : 0;
        const ageDays = ageInDays(d.created_at, asOf);
        if (outstandingKobo > 0) addToTotals(aging, outstandingKobo, d.created_at, asOf);
        return {
          id: d.id,
          saleId: d.sale_id,
          saleNumber: d.number,
          amountKobo: d.amount_kobo,
          paidKobo: d.paid_kobo,
          outstandingKobo,
          status: d.status,
          createdAt: d.created_at,
          ageDays,
          bucket: bucketFor(ageDays),
        };
      });

      return { customerId, customerName: customer.name, outstandingKobo: aging.totalKobo, aging, debts };
    });
  }

  /** DEBT-03: who owes what, and for how long. Most urgent first. */
  async agingReport(query: AgingQueryDto): Promise<AgingReportDto> {
    const asOf = query.asOf ? new Date(query.asOf) : new Date();
    const minBucketIndex = query.minBucket ? AGING_BUCKETS.indexOf(query.minBucket) : 0;

    const rows = await this.tenantDb.transaction((trx) =>
      trx
        .selectFrom('debt_records as d')
        .innerJoin('customers as c', 'c.id', 'd.customer_id')
        .select(['d.customer_id', 'c.name', 'c.phone', 'd.amount_kobo', 'd.paid_kobo', 'd.created_at'])
        .where('d.status', '=', 'open')
        .where('d.created_at', '<=', asOf)
        .execute(),
    );

    const byCustomer = new Map<string, { name: string; phone: string | null; totals: ReturnType<typeof emptyTotals>; count: number; oldestDays: number }>();
    const totals = emptyTotals();
    for (const r of rows) {
      const outstanding = r.amount_kobo - r.paid_kobo;
      const entry = byCustomer.get(r.customer_id) ?? { name: r.name, phone: r.phone, totals: emptyTotals(), count: 0, oldestDays: 0 };
      addToTotals(entry.totals, outstanding, r.created_at, asOf);
      addToTotals(totals, outstanding, r.created_at, asOf);
      entry.count += 1;
      entry.oldestDays = Math.max(entry.oldestDays, ageInDays(r.created_at, asOf));
      byCustomer.set(r.customer_id, entry);
    }

    const customers = [...byCustomer.entries()]
      .map(([customerId, e]) => ({
        customerId,
        customerName: e.name,
        phone: e.phone,
        openDebts: e.count,
        oldestDays: e.oldestDays,
        ...e.totals,
      }))
      .filter((c) => AGING_BUCKETS.indexOf(bucketFor(c.oldestDays)) >= minBucketIndex)
      .sort((a, b) => b.oldestDays - a.oldestDays || b.totalKobo - a.totalKobo);

    return { asOf, totals, customers };
  }

  async repayments(customerId: string, query: RepaymentsQueryDto): Promise<RepaymentPageDto> {
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? decodeCursor(query.cursor, 2) : null;

    return this.tenantDb.transaction(async (trx) => {
      const rows = await trx
        .selectFrom('debt_repayments as r')
        .select(['r.id', 'r.created_at'])
        .where('r.customer_id', '=', customerId)
        .$if(cursor !== null, (qb) => qb.where(sql<boolean>`(r.created_at, r.id) < (${new Date(cursor![0]!)}, ${cursor![1]!})`))
        .orderBy('r.created_at', 'desc')
        .orderBy('r.id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const items = await Promise.all(page.map((r) => this.loadRepayment(trx, r.id)));
      const last = page[page.length - 1];
      return { items, nextCursor: rows.length > limit && last ? encodeCursor([last.created_at.toISOString(), last.id]) : null };
    });
  }

  private async result(trx: Trx, customerId: string, repaymentId: string, replayed: boolean): Promise<RepaymentResultDto> {
    const repayment = await this.loadRepayment(trx, repaymentId);
    if (repayment.customerId !== customerId) throw new BadRequestException('This repayment id belongs to another customer');
    return { repayment, outstandingAfterKobo: await this.outstanding(trx, customerId), replayed };
  }

  private async loadRepayment(trx: Trx, id: string): Promise<RepaymentDto> {
    const r = await trx
      .selectFrom('debt_repayments as r')
      .innerJoin('users as u', 'u.id', 'r.created_by')
      .selectAll('r')
      .select('u.full_name as created_by_name')
      .where('r.id', '=', id)
      .executeTakeFirstOrThrow();
    const allocations = await trx
      .selectFrom('debt_repayment_allocations as a')
      .innerJoin('debt_records as d', 'd.id', 'a.debt_record_id')
      .innerJoin('sales as s', 's.id', 'd.sale_id')
      .select(['a.debt_record_id', 'd.sale_id', 's.number', 'a.amount_kobo'])
      .where('a.repayment_id', '=', id)
      .orderBy('d.created_at')
      .execute();
    return {
      id: r.id,
      customerId: r.customer_id,
      amountKobo: r.amount_kobo,
      method: r.method,
      reference: r.reference,
      note: r.note,
      registerSessionId: r.register_session_id,
      createdById: r.created_by,
      createdByName: r.created_by_name,
      createdAt: r.created_at,
      allocations: allocations.map((a) => ({ debtRecordId: a.debt_record_id, saleId: a.sale_id, saleNumber: a.number, amountKobo: a.amount_kobo })),
    };
  }

  private async outstanding(trx: Trx, customerId: string): Promise<number> {
    const row = await trx
      .selectFrom('debt_records')
      .select(sql<number>`coalesce(sum(amount_kobo - paid_kobo), 0)::bigint`.as('outstanding'))
      .where('customer_id', '=', customerId)
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow();
    return Number(row.outstanding);
  }
}
