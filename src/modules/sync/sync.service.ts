import { BadRequestException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { sql, Transaction } from 'kysely';
import type { AuthContext } from '../../auth/auth.types';
import { RequestContext } from '../../common/context/request-context';
import { isSupervisor } from '../../common/roles';
import type { DB } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { CustomersService } from '../customers/customers.service';
import { WalletService } from '../customers/wallet.service';
import { DebtsService } from '../debts/debts.service';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { RegisterSessionsService } from '../registers/register-sessions.service';
import { SalesService } from '../sales/sales.service';
import {
  ResolveSyncDto,
  SyncCashMovementPayload,
  SyncClockInPayload,
  SyncClosePayload,
  SyncCustomerPayload,
  SyncDeliveryConfirmPayload,
  SyncOperationDto,
  SyncOperationResultDto,
  SyncPullDto,
  SyncPullQueryDto,
  SyncPushDto,
  SyncPushResultDto,
  SyncRepaymentPayload,
  SyncReviewItemDto,
  SyncReviewQueryDto,
  SyncSalePayload,
  SyncTopUpPayload,
} from './dto/sync.dto';

type Trx = Transaction<DB>;

/** Pull windows overlap by this much, so rows committed by slow transactions are never missed. */
const PULL_OVERLAP_MS = 2 * 60_000;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly registers: RegisterSessionsService,
    private readonly sales: SalesService,
    private readonly customers: CustomersService,
    private readonly wallets: WalletService,
    private readonly debts: DebtsService,
    private readonly deliveries: DeliveriesService,
  ) {}

  // ─── Push ──────────────────────────────────────────────────────────────────────

  /**
   * Applies a till's offline operations in order, each in its own transaction, exactly once.
   * A business rejection (4xx) is recorded and processing continues. A server error stops the
   * batch there, so a later operation can never be applied ahead of an earlier one.
   */
  async push(device: AuthContext, dto: SyncPushDto): Promise<SyncPushResultDto> {
    const results: SyncOperationResultDto[] = [];
    let halted = false;

    for (const op of dto.operations) {
      if (halted) {
        results.push({ opId: op.opId, status: 'not_processed', entityId: null, flags: [], error: null });
        continue;
      }

      const previous = await this.tenantDb.forOrganization(device.organizationId, (trx) =>
        trx.selectFrom('sync_operations').selectAll().where('op_id', '=', op.opId).executeTakeFirst(),
      );
      if (previous) {
        results.push({
          opId: op.opId,
          status: 'duplicate',
          entityId: previous.entity_id,
          flags: previous.flags,
          error: previous.error_code ? { code: previous.error_code, message: previous.error_message ?? '' } : null,
        });
        continue;
      }

      const flags: string[] = [];
      try {
        const actor = await this.actorContext(device, op.actorId);
        const entityId = await RequestContext.run({ ...actor, requestId: op.opId }, () => this.apply(actor, op, flags));
        await this.log(device, dto.deviceId, op, { status: 'applied', entityId, flags });
        results.push({ opId: op.opId, status: 'applied', entityId, flags, error: null });
      } catch (err) {
        if (err instanceof HttpException && err.getStatus() < 500) {
          const error = describe(err);
          await this.log(device, dto.deviceId, op, { status: 'rejected', entityId: null, flags, error });
          results.push({ opId: op.opId, status: 'rejected', entityId: null, flags, error });
        } else {
          this.logger.error(`Sync op ${op.opId} (${op.type}) failed`, err instanceof Error ? err.stack : String(err));
          halted = true;
          results.push({
            opId: op.opId,
            status: 'not_processed',
            entityId: null,
            flags: [],
            error: { code: 'SERVER_ERROR', message: 'Temporary server problem. Send this and the following operations again.' },
          });
        }
      }
    }

    return { serverTime: new Date(), results };
  }

  private async apply(auth: AuthContext, op: SyncOperationDto, flags: string[]): Promise<string> {
    const occurredAt = new Date(op.occurredAt);

    switch (op.type) {
      case 'register.clock_in': {
        const p = await parse(SyncClockInPayload, op.payload);
        await this.registers.clockIn(auth, p.registerId, { openingFloatKobo: p.openingFloatKobo, sessionId: p.sessionId }, { occurredAt });
        return p.sessionId;
      }
      case 'register.cash_movement': {
        const p = await parse(SyncCashMovementPayload, op.payload, 'id');
        await this.registers.recordCashMovement(auth, p.sessionId, p);
        return p.id!;
      }
      case 'register.close': {
        const p = await parse(SyncClosePayload, op.payload);
        await this.registers.close(auth, p.sessionId, { countedCashKobo: p.countedCashKobo, note: p.note }, { occurredAt });
        return p.sessionId;
      }
      case 'customer.create': {
        const p = await parse(SyncCustomerPayload, op.payload, 'id');
        return (await this.customers.create(auth, p)).id;
      }
      case 'sale.create': {
        const p = await parse(SyncSalePayload, op.payload, 'id');
        const sale = await this.sales.create(
          auth,
          { ...p, occurredAt: op.occurredAt, managerApproval: undefined },
          { offline: { registerSessionId: p.registerSessionId, approvedById: p.approvedById ?? null, flags } },
        );
        return sale.id;
      }
      case 'wallet.top_up': {
        const p = await parse(SyncTopUpPayload, op.payload, 'id');
        await this.wallets.topUp(auth, p.customerId, p);
        return p.id!;
      }
      case 'debt.repayment': {
        const p = await parse(SyncRepaymentPayload, op.payload, 'id');
        await this.debts.recordRepayment(auth, p.customerId, p);
        return p.id!;
      }
      case 'delivery.confirm': {
        const p = await parse(SyncDeliveryConfirmPayload, op.payload);
        return (await this.deliveries.confirm(auth, p.deliveryId, p)).id;
      }
    }
  }

  /** The staff member who acted offline. The device's own login proves the organization. */
  private async actorContext(device: AuthContext, actorId: string): Promise<AuthContext> {
    const actor = await this.tenantDb.forOrganization(device.organizationId, (trx) =>
      trx.selectFrom('users').select(['id', 'role', 'default_location_id', 'is_active']).where('id', '=', actorId).executeTakeFirst(),
    );
    if (!actor) throw new NotFoundException({ error: 'UNKNOWN_ACTOR', message: 'The staff member on this operation does not exist' });
    // Deactivated since? The operation still happened while they worked here: accept it.
    return {
      userId: actor.id,
      organizationId: device.organizationId,
      role: actor.role,
      locationId: actor.default_location_id ?? device.locationId,
      sessionId: device.sessionId,
    };
  }

  private async log(
    device: AuthContext,
    deviceId: string,
    op: SyncOperationDto,
    outcome: { status: 'applied' | 'rejected'; entityId: string | null; flags: string[]; error?: { code: string; message: string } },
  ): Promise<void> {
    await this.tenantDb.forOrganization(device.organizationId, (trx) =>
      trx
        .insertInto('sync_operations')
        .values({
          op_id: op.opId,
          organization_id: device.organizationId,
          device_id: deviceId,
          actor_id: outcome.error?.code === 'UNKNOWN_ACTOR' ? device.userId : op.actorId,
          type: op.type,
          occurred_at: new Date(op.occurredAt),
          status: outcome.status,
          entity_id: outcome.entityId,
          flags: outcome.flags,
          error_code: outcome.error?.code ?? null,
          error_message: outcome.error?.message ?? null,
          payload: JSON.stringify(op.payload),
        })
        .onConflict((oc) => oc.columns(['organization_id', 'op_id']).doNothing())
        .execute(),
    );
  }

  // ─── Pull ──────────────────────────────────────────────────────────────────────

  /** Everything a till needs to keep selling offline, changed since the last pull. */
  async pull(device: AuthContext, query: SyncPullQueryDto): Promise<SyncPullDto> {
    const since = query.since ? new Date(query.since) : null;
    const showCost = isSupervisor(device.role);

    return this.tenantDb.transaction(async (trx) => {
      const { now } = await sql<{ now: Date }>`select now() as now`.execute(trx).then((r) => r.rows[0]!);

      const [org, products, customers, wallets, debts, stock, users, registers] = await Promise.all([
        trx
          .selectFrom('organizations')
          .select(['name', 'currency', 'timezone', 'enabled_order_types', 'credit_limit_mode', 'default_credit_limit_kobo'])
          .executeTakeFirstOrThrow(),
        trx.selectFrom('products').selectAll().$if(since !== null, (qb) => qb.where('updated_at', '>=', since!)).orderBy('name').execute(),
        trx.selectFrom('customers').selectAll().$if(since !== null, (qb) => qb.where('updated_at', '>=', since!)).orderBy('name').execute(),
        trx
          .selectFrom('customer_wallets')
          .select(['customer_id', 'balance_kobo', 'updated_at'])
          .$if(since !== null, (qb) => qb.where('updated_at', '>=', since!))
          .execute(),
        trx
          .selectFrom('debt_records')
          .select(['customer_id', sql<number>`sum(amount_kobo - paid_kobo)::bigint`.as('outstanding')])
          .where('status', '=', 'open')
          .groupBy('customer_id')
          .execute(),
        trx
          .selectFrom('stock_levels')
          .select(['product_id', 'location_id', 'quantity', 'updated_at'])
          .$if(since !== null, (qb) => qb.where('updated_at', '>=', since!))
          .$if(!!query.locationId, (qb) => qb.where('location_id', '=', query.locationId!))
          .execute(),
        trx
          .selectFrom('users')
          .select(['id', 'full_name', 'role', 'is_active', 'default_location_id', 'updated_at', sql<boolean>`pin_hash is not null`.as('has_pin')])
          .$if(since !== null, (qb) => qb.where('updated_at', '>=', since!))
          .execute(),
        trx.selectFrom('registers').selectAll().$if(since !== null, (qb) => qb.where('updated_at', '>=', since!)).execute(),
      ]);

      return {
        serverTime: now,
        nextSince: new Date(now.getTime() - PULL_OVERLAP_MS),
        fullSync: since === null,
        settings: {
          name: org.name,
          currency: org.currency,
          timezone: org.timezone,
          enabledOrderTypes: org.enabled_order_types,
          creditLimitMode: org.credit_limit_mode,
          defaultCreditLimitKobo: org.default_credit_limit_kobo,
        },
        products: products.map((p) => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          barcode: p.barcode,
          category: p.category,
          unit: p.unit,
          sellingPriceKobo: p.selling_price_kobo,
          wholesalePriceKobo: p.wholesale_price_kobo,
          costPriceKobo: showCost ? p.cost_price_kobo : null,
          tracksStock: p.tracks_stock,
          reorderLevel: p.reorder_level,
          isActive: p.is_active,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
          stockQuantity: null,
        })),
        customers: customers.map((c) => ({
          id: c.id,
          name: c.name,
          phone: c.phone,
          type: c.type,
          address: c.address,
          creditLimitKobo: c.credit_limit_kobo,
          isActive: c.is_active,
          updatedAt: c.updated_at,
        })),
        walletBalances: wallets.map((w) => ({ customerId: w.customer_id, balanceKobo: w.balance_kobo })),
        outstandingDebts: debts.map((d) => ({ customerId: d.customer_id, outstandingKobo: Number(d.outstanding) })),
        stockLevels: stock.map((l) => ({ productId: l.product_id, locationId: l.location_id, quantity: l.quantity })),
        users: users.map((u) => ({
          id: u.id,
          fullName: u.full_name,
          role: u.role,
          isActive: u.is_active,
          hasPin: u.has_pin,
          defaultLocationId: u.default_location_id,
        })),
        registers: registers.map((r) => ({ id: r.id, name: r.name, locationId: r.location_id, isActive: r.is_active })),
      };
    });
  }

  // ─── Review ────────────────────────────────────────────────────────────────────

  /** Rejected operations, and applied ones with flags, for a manager to look at. */
  async review(query: SyncReviewQueryDto): Promise<SyncReviewItemDto[]> {
    const rows = await this.tenantDb.transaction((trx) =>
      trx
        .selectFrom('sync_operations as o')
        .innerJoin('users as a', 'a.id', 'o.actor_id')
        .leftJoin('users as r', 'r.id', 'o.resolved_by')
        .selectAll('o')
        .select(['a.full_name as actor_name', 'r.full_name as resolved_by_name'])
        .where((eb) => eb.or([eb('o.status', '=', 'rejected'), eb(sql<number>`cardinality(o.flags)`, '>', 0)]))
        .$if(query.status !== 'all', (qb) => qb.where('o.resolved_at', 'is', null))
        .orderBy('o.received_at', 'desc')
        .limit(query.limit ?? 100)
        .execute(),
    );
    return rows.map(toReviewItem);
  }

  async resolve(auth: AuthContext, opId: string, dto: ResolveSyncDto): Promise<SyncReviewItemDto> {
    return this.tenantDb.transaction(async (trx) => {
      const op = await trx.selectFrom('sync_operations').select(['resolved_at']).where('op_id', '=', opId).forUpdate().executeTakeFirst();
      if (!op) throw new NotFoundException('Sync operation not found');
      if (op.resolved_at) throw new BadRequestException('Already resolved');
      await trx
        .updateTable('sync_operations')
        .set({ resolved_at: sql`now()`, resolved_by: auth.userId, resolution_note: dto.note.trim() })
        .where('op_id', '=', opId)
        .execute();
      return this.loadReviewItem(trx, opId);
    });
  }

  private async loadReviewItem(trx: Trx, opId: string): Promise<SyncReviewItemDto> {
    const row = await trx
      .selectFrom('sync_operations as o')
      .innerJoin('users as a', 'a.id', 'o.actor_id')
      .leftJoin('users as r', 'r.id', 'o.resolved_by')
      .selectAll('o')
      .select(['a.full_name as actor_name', 'r.full_name as resolved_by_name'])
      .where('o.op_id', '=', opId)
      .executeTakeFirstOrThrow();
    return toReviewItem(row);
  }
}

function toReviewItem(o: {
  op_id: string;
  device_id: string;
  actor_id: string;
  actor_name: string;
  type: string;
  occurred_at: Date;
  received_at: Date;
  status: 'applied' | 'rejected';
  entity_id: string | null;
  flags: string[];
  error_code: string | null;
  error_message: string | null;
  payload: unknown;
  resolved_at: Date | null;
  resolved_by_name: string | null;
  resolution_note: string | null;
}): SyncReviewItemDto {
  return {
    opId: o.op_id,
    deviceId: o.device_id,
    actorId: o.actor_id,
    actorName: o.actor_name,
    type: o.type,
    occurredAt: o.occurred_at,
    receivedAt: o.received_at,
    status: o.status,
    entityId: o.entity_id,
    flags: o.flags,
    errorCode: o.error_code,
    errorMessage: o.error_message,
    payload: o.payload,
    resolvedAt: o.resolved_at,
    resolvedByName: o.resolved_by_name,
    resolutionNote: o.resolution_note,
  };
}

/** Validates an operation's payload exactly like the online endpoint's ValidationPipe would. */
async function parse<T extends object>(cls: new () => T, payload: Record<string, unknown>, requiredId?: 'id'): Promise<T> {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) {
    throw new BadRequestException({ error: 'VALIDATION_FAILED', message: flattenErrors(errors).join('; ') });
  }
  if (requiredId && !(instance as Record<string, unknown>)[requiredId]) {
    throw new BadRequestException({ error: 'ID_REQUIRED', message: 'Offline operations must carry the id generated on the device' });
  }
  return instance;
}

function flattenErrors(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    const own = Object.values(e.constraints ?? {}).map((m) => (m.startsWith(e.property) ? `${prefix ? `${prefix}.` : ''}${m}` : `${path}: ${m}`));
    return [...own, ...flattenErrors(e.children ?? [], path)];
  });
}

const STATUS_CODES: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' };

function describe(err: HttpException): { code: string; message: string } {
  const response = err.getResponse();
  const body = typeof response === 'string' ? { message: response } : (response as { error?: unknown; message?: unknown });
  const custom = typeof body.error === 'string' && /^[A-Z_]+$/.test(body.error) ? body.error : null;
  const message = Array.isArray(body.message) ? body.message.join('; ') : String(body.message ?? err.message);
  return { code: custom ?? STATUS_CODES[err.getStatus()] ?? `HTTP_${err.getStatus()}`, message };
}
