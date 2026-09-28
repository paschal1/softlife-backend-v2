import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { sql, Transaction } from 'kysely';
import type { AuthContext } from '../../auth/auth.types';
import { uuidv7 } from '../../common/ids/uuidv7';
import { decodeCursor, encodeCursor } from '../../common/pagination';
import { isSupervisor } from '../../common/roles';
import type { DB, DeliveryStatus } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import { StorageService } from '../../storage/storage.service';
import { StockLedger } from '../inventory/stock-ledger.service';
import { evaluateVariance } from '../registers/eod';
import { RegisterSessionsService } from '../registers/register-sessions.service';
import { collectionError, DeliveryAction, MAX_CODE_ATTEMPTS, transitionError } from './delivery-rules';
import type {
  AssignDeliveryDto,
  ConfirmDeliveryDto,
  DeliveryDto,
  DeliveryPageDto,
  DriverCashDto,
  FailDeliveryDto,
  ListDeliveriesQueryDto,
  RemitCashDto,
  RemittanceDto,
} from './dto/deliveries.dto';

type Trx = Transaction<DB>;
const OPEN_STATUSES: DeliveryStatus[] = ['queued', 'assigned', 'out_for_delivery', 'failed'];

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly registers: RegisterSessionsService,
    private readonly stock: StockLedger,
    private readonly events: EventPublisher,
    private readonly storage: StorageService,
  ) {}

  // ─── Queue (DEL-01) ────────────────────────────────────────────────────────────

  async list(auth: AuthContext, query: ListDeliveriesQueryDto): Promise<DeliveryPageDto> {
    const limit = query.limit ?? 100;
    const cursor = query.cursor ? decodeCursor(query.cursor, 3) : null;
    const status = query.status ?? 'open';
    const driverOnly = auth.role === 'driver';

    return this.tenantDb.transaction(async (trx) => {
      const rows = await this.baseQuery(trx)
        .$if(status === 'open', (qb) => qb.where('d.status', 'in', OPEN_STATUSES))
        .$if(status !== 'open' && status !== 'all', (qb) => qb.where('d.status', '=', status as DeliveryStatus))
        .$if(driverOnly, (qb) => qb.where('d.driver_id', '=', auth.userId))
        .$if(!driverOnly && !!query.driverId, (qb) => qb.where('d.driver_id', '=', query.driverId!))
        .$if(!!query.date, (qb) => qb.where('d.scheduled_date', '=', query.date!))
        .$if(!!query.locationId, (qb) => qb.where('d.location_id', '=', query.locationId!))
        .$if(!!query.fulfilment, (qb) => qb.where('d.fulfilment', '=', query.fulfilment!))
        .$if(cursor !== null, (qb) =>
          qb.where(sql<boolean>`(d.scheduled_date, d.created_at, d.id) > (${cursor![0]!}::date, ${new Date(cursor![1]!)}, ${cursor![2]!})`),
        )
        .orderBy('d.scheduled_date')
        .orderBy('d.created_at')
        .orderBy('d.id')
        .limit(limit + 1)
        .execute();

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: await this.hydrate(trx, auth, page),
        nextCursor: rows.length > limit && last ? encodeCursor([last.scheduled_date, last.created_at.toISOString(), last.id]) : null,
      };
    });
  }

  async get(auth: AuthContext, id: string): Promise<DeliveryDto> {
    return this.tenantDb.transaction((trx) => this.load(trx, auth, id));
  }

  // ─── Assign and dispatch (DEL-02) ──────────────────────────────────────────────

  async assign(auth: AuthContext, id: string, dto: AssignDeliveryDto): Promise<DeliveryDto> {
    return this.tenantDb.transaction(async (trx) => {
      const d = await this.lockFor(trx, id, 'assign');
      const driver = await trx
        .selectFrom('users')
        .select(['role', 'full_name'])
        .where('id', '=', dto.driverId)
        .where('is_active', '=', true)
        .executeTakeFirst();
      if (driver?.role !== 'driver') throw new BadRequestException('That user is not an active driver');

      await trx
        .updateTable('deliveries')
        .set({ status: 'assigned', driver_id: dto.driverId, expected_at: dto.expectedAt ? new Date(dto.expectedAt) : null, failure_reason: null })
        .where('id', '=', id)
        .execute();
      await this.events.record(trx, {
        type: EventTypes.DeliveryAssigned,
        aggregateType: 'delivery',
        aggregateId: id,
        locationId: d.location_id,
        payload: {
          before: { status: d.status, driverId: d.driver_id },
          after: { status: 'assigned', driverId: dto.driverId, driverName: driver.full_name, expectedAt: dto.expectedAt ?? null },
        },
      });
      return this.load(trx, auth, id);
    });
  }

  async dispatch(auth: AuthContext, id: string): Promise<DeliveryDto> {
    return this.tenantDb.transaction(async (trx) => {
      const d = await this.lockFor(trx, id, 'dispatch');
      this.assertDriverOrSupervisor(auth, d.driver_id);
      await trx.updateTable('deliveries').set({ status: 'out_for_delivery' }).where('id', '=', id).execute();
      await this.events.record(trx, {
        type: EventTypes.DeliveryDispatched,
        aggregateType: 'delivery',
        aggregateId: id,
        locationId: d.location_id,
        payload: { driverId: d.driver_id, before: { status: d.status }, after: { status: 'out_for_delivery' } },
      });
      return this.load(trx, auth, id);
    });
  }

  // ─── Confirm (DEL-03) ──────────────────────────────────────────────────────────

  async confirm(auth: AuthContext, id: string, dto: ConfirmDeliveryDto): Promise<DeliveryDto> {
    type Outcome = { ok: true; delivery: DeliveryDto } | { ok: false; message: string };

    // Wrong codes must be COMMITTED before rejecting, so the transaction returns an outcome.
    const outcome = await this.tenantDb.transaction(async (trx): Promise<Outcome> => {
      const d = await this.lockFor(trx, id, 'confirm');
      if (d.fulfilment === 'delivery') this.assertDriverOrSupervisor(auth, d.driver_id);
      else if (auth.role === 'driver') throw new ForbiddenException('Pickups are confirmed by shop staff');

      // Proof: the customer's code, or (managers only) the recipient's name.
      let proof: 'code' | 'recipient_name';
      if (dto.code !== undefined) {
        if (d.code_attempts >= MAX_CODE_ATTEMPTS) {
          return { ok: false, message: 'Too many wrong codes on this delivery. A manager must confirm it with the recipient\'s name.' };
        }
        if (dto.code !== d.confirmation_code) {
          await trx.updateTable('deliveries').set({ code_attempts: d.code_attempts + 1 }).where('id', '=', id).execute();
          const left = MAX_CODE_ATTEMPTS - d.code_attempts - 1;
          return { ok: false, message: left > 0 ? `Wrong delivery code. ${left} attempt(s) left.` : 'Wrong delivery code. A manager must now confirm this delivery.' };
        }
        proof = 'code';
      } else if (dto.receivedByName) {
        if (!isSupervisor(auth.role)) throw new ForbiddenException('Drivers confirm with the customer\'s delivery code');
        proof = 'recipient_name';
      } else {
        throw new BadRequestException('Provide the customer\'s delivery code (or, for managers, the recipient\'s name)');
      }

      const collections = dto.collections ?? [];
      const problem = collectionError(d.cod_kobo, collections);
      if (problem) throw new BadRequestException(problem);

      // Pickup balances are paid at the shop counter, so cash goes straight into the till.
      const tillCash = d.fulfilment === 'pickup' ? collections.filter((c) => c.method === 'cash').reduce((s, c) => s + c.amountKobo, 0) : 0;
      if (tillCash > 0) {
        await this.registers.recordCashInOpenSession(trx, auth, {
          kind: 'cash_sale',
          amountKobo: tillCash,
          referenceType: 'delivery',
          referenceId: id,
          action: 'taking cash',
        });
      }

      if (collections.length > 0) {
        await trx
          .insertInto('delivery_collections')
          .values(
            collections.map((c) => ({
              id: uuidv7(),
              organization_id: auth.organizationId,
              delivery_id: id,
              method: c.method,
              amount_kobo: c.amountKobo,
              reference: c.reference?.trim() || null,
              collected_by: auth.userId,
            })),
          )
          .execute();
      }

      const returns = dto.returns ?? [];
      if (returns.length > 0) {
        await trx
          .insertInto('delivery_returns')
          .values(
            returns.map((r) => ({
              id: uuidv7(),
              organization_id: auth.organizationId,
              delivery_id: id,
              product_id: r.productId,
              quantity: r.quantity,
              note: r.note?.trim() || null,
            })),
          )
          .execute();
        await this.stock.record(
          trx,
          returns.map((r) => ({
            productId: r.productId,
            locationId: d.location_id,
            type: 'delivery_return' as const,
            quantityDelta: r.quantity,
            reason: r.note ?? null,
            referenceType: 'delivery',
            referenceId: id,
          })),
          { organizationId: auth.organizationId, actorId: auth.userId, batchId: uuidv7() },
        );
      }

      const signatureKey = dto.signaturePngBase64
        ? (await this.storage.put(StorageService.keyFor(auth.organizationId, 'signatures', `${id}.png`), decodeSignature(dto.signaturePngBase64), 'image/png')).key
        : null;

      const collected = collections.reduce((s, c) => s + c.amountKobo, 0);
      await trx
        .updateTable('deliveries')
        .set({
          signature_key: signatureKey,
          status: 'delivered',
          delivered_at: sql`now()`,
          delivered_by: auth.userId,
          proof_method: proof,
          received_by_name: dto.receivedByName?.trim() || null,
          collected_kobo: collected,
        })
        .where('id', '=', id)
        .execute();

      await this.events.record(trx, {
        type: EventTypes.DeliveryConfirmed,
        aggregateType: 'delivery',
        aggregateId: id,
        locationId: d.location_id,
        payload: {
          saleId: d.sale_id,
          fulfilment: d.fulfilment,
          proof,
          signatureCaptured: signatureKey !== null,
          receivedByName: dto.receivedByName?.trim() || null,
          collectedKobo: collected,
          collections: collections.map((c) => ({ method: c.method, amountKobo: c.amountKobo })),
          returns: returns.map((r) => ({ productId: r.productId, quantity: r.quantity })),
          before: { status: d.status },
          after: { status: 'delivered' },
        },
      });

      return { ok: true, delivery: await this.load(trx, auth, id) };
    });

    if (!outcome.ok) throw new UnauthorizedException(outcome.message);
    return outcome.delivery;
  }

  async fail(auth: AuthContext, id: string, dto: FailDeliveryDto): Promise<DeliveryDto> {
    return this.tenantDb.transaction(async (trx) => {
      const d = await this.lockFor(trx, id, 'fail');
      this.assertDriverOrSupervisor(auth, d.driver_id);
      const reason = dto.reason.trim();
      await trx
        .updateTable('deliveries')
        .set({ status: 'failed', failure_reason: reason, attempts: d.attempts + 1 })
        .where('id', '=', id)
        .execute();
      await this.events.record(trx, {
        type: EventTypes.DeliveryFailed,
        aggregateType: 'delivery',
        aggregateId: id,
        locationId: d.location_id,
        payload: { reason, attempt: d.attempts + 1, driverId: d.driver_id, before: { status: d.status }, after: { status: 'failed' } },
      });
      return this.load(trx, auth, id);
    });
  }

  /** A short-lived link to the signature captured at the door. */
  async signatureLink(auth: AuthContext, id: string): Promise<{ url: string; expiresAt: Date }> {
    const d = await this.tenantDb.transaction((trx) =>
      trx.selectFrom('deliveries').select(['signature_key', 'driver_id']).where('id', '=', id).executeTakeFirst(),
    );
    if (!d || (!isSupervisor(auth.role) && d.driver_id !== auth.userId)) throw new NotFoundException('Delivery not found');
    if (!d.signature_key) throw new NotFoundException('No signature was captured for this delivery');
    return this.storage.downloadUrl(d.signature_key, `delivery-${id}-signature.png`);
  }

  // ─── Driver cash ───────────────────────────────────────────────────────────────

  /** Cash collected at doors that hasn't reached a till yet, per person holding it. */
  async driverCash(auth: AuthContext): Promise<DriverCashDto[]> {
    return this.tenantDb.transaction(async (trx) => {
      const rows = await trx
        .selectFrom('delivery_collections as c')
        .innerJoin('deliveries as d', 'd.id', 'c.delivery_id')
        .innerJoin('users as u', 'u.id', 'c.collected_by')
        .select([
          'c.collected_by',
          'u.full_name',
          sql<number>`sum(c.amount_kobo)::bigint`.as('total'),
          sql<number>`count(*)`.as('count'),
          sql<Date>`min(c.collected_at)`.as('oldest'),
        ])
        .where('c.method', '=', 'cash')
        .where('c.remittance_id', 'is', null)
        .where('d.fulfilment', '=', 'delivery')
        .$if(!isSupervisor(auth.role), (qb) => qb.where('c.collected_by', '=', auth.userId))
        .groupBy(['c.collected_by', 'u.full_name'])
        .orderBy('total', 'desc')
        .execute();
      return rows.map((r) => ({
        userId: r.collected_by,
        name: r.full_name,
        unremittedKobo: Number(r.total),
        collections: Number(r.count),
        oldestCollectedAt: r.oldest,
      }));
    });
  }

  /**
   * A driver hands in the cash they collected. The receiver must be clocked in: the cash goes
   * into their till and EOD. A short hand-in is flagged exactly like an EOD variance.
   */
  async remit(auth: AuthContext, dto: RemitCashDto): Promise<RemittanceDto> {
    return this.tenantDb.transaction(async (trx) => {
      if (dto.id) {
        const existing = await trx.selectFrom('delivery_remittances').select('id').where('id', '=', dto.id).executeTakeFirst();
        if (existing) return this.loadRemittance(trx, existing.id);
      }
      const id = dto.id ?? uuidv7();

      const pending = await trx
        .selectFrom('delivery_collections as c')
        .innerJoin('deliveries as d', 'd.id', 'c.delivery_id')
        .select(['c.id', 'c.amount_kobo'])
        .where('c.collected_by', '=', dto.driverId)
        .where('c.method', '=', 'cash')
        .where('c.remittance_id', 'is', null)
        .where('d.fulfilment', '=', 'delivery')
        .forUpdate()
        .execute();
      const expected = pending.reduce((s, c) => s + c.amount_kobo, 0);
      if (expected === 0) throw new BadRequestException('This person has no delivery cash waiting to be handed in');

      const session =
        dto.countedKobo > 0
          ? await this.registers.recordCashInOpenSession(trx, auth, {
              kind: 'delivery_cash',
              amountKobo: dto.countedKobo,
              referenceType: 'delivery_remittance',
              referenceId: id,
              action: 'receiving driver cash',
            })
          : { sessionId: (await this.registers.requireOpenSession(trx, auth.userId, 'receiving driver cash')).id };

      const org = await trx.selectFrom('organizations').select('eod_variance_alert_kobo').executeTakeFirstOrThrow();
      const { varianceKobo, flagged } = evaluateVariance(expected, dto.countedKobo, org.eod_variance_alert_kobo);

      await trx
        .insertInto('delivery_remittances')
        .values({
          id,
          organization_id: auth.organizationId,
          driver_id: dto.driverId,
          expected_kobo: expected,
          counted_kobo: dto.countedKobo,
          variance_kobo: varianceKobo,
          register_session_id: session.sessionId,
          received_by: auth.userId,
          note: dto.note?.trim() || null,
        })
        .execute();
      await trx
        .updateTable('delivery_collections')
        .set({ remittance_id: id })
        .where('id', 'in', pending.map((c) => c.id))
        .execute();

      await this.events.record(trx, {
        type: EventTypes.DriverCashRemitted,
        aggregateType: 'user',
        aggregateId: dto.driverId,
        payload: { remittanceId: id, expectedKobo: expected, countedKobo: dto.countedKobo, varianceKobo, collections: pending.length },
      });
      if (flagged) {
        await this.events.record(trx, {
          type: EventTypes.ThresholdCrossed,
          aggregateType: 'user',
          aggregateId: dto.driverId,
          payload: { rule: 'driver_cash_variance', remittanceId: id, varianceKobo, thresholdKobo: org.eod_variance_alert_kobo },
        });
      }
      return this.loadRemittance(trx, id);
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────────

  private async lockFor(trx: Trx, id: string, action: DeliveryAction) {
    const d = await trx.selectFrom('deliveries').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!d) throw new NotFoundException('Delivery not found');
    const problem = transitionError(action, d.status, d.fulfilment);
    if (problem) throw new BadRequestException(problem);
    return d;
  }

  private assertDriverOrSupervisor(auth: AuthContext, driverId: string | null): void {
    if (!isSupervisor(auth.role) && auth.userId !== driverId) {
      throw new ForbiddenException('Only the assigned driver or a manager can do this');
    }
  }

  /** Shared select for list/get (not private: its row type is reused by hydrate()). */
  baseQuery(trx: Trx) {
    return trx
      .selectFrom('deliveries as d')
      .innerJoin('sales as s', 's.id', 'd.sale_id')
      .innerJoin('locations as l', 'l.id', 'd.location_id')
      .leftJoin('customers as c', 'c.id', 'd.customer_id')
      .leftJoin('users as driver', 'driver.id', 'd.driver_id')
      .leftJoin('users as deliverer', 'deliverer.id', 'd.delivered_by')
      .selectAll('d')
      .select([
        's.number as sale_number',
        'l.name as location_name',
        'c.name as customer_name',
        'c.phone as customer_phone',
        'driver.full_name as driver_name',
        'deliverer.full_name as delivered_by_name',
      ]);
  }

  private async load(trx: Trx, auth: AuthContext, id: string): Promise<DeliveryDto> {
    const row = await this.baseQuery(trx).where('d.id', '=', id).executeTakeFirst();
    if (!row || (auth.role === 'driver' && row.driver_id !== auth.userId)) throw new NotFoundException('Delivery not found');
    return (await this.hydrate(trx, auth, [row]))[0]!;
  }

  private async hydrate(trx: Trx, auth: AuthContext, rows: Awaited<ReturnType<ReturnType<DeliveriesService['baseQuery']>['execute']>>): Promise<DeliveryDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [items, collections, returns] = await Promise.all([
      trx
        .selectFrom('sale_items')
        .select(['sale_id', 'product_name', 'quantity', 'unit'])
        .where('sale_id', 'in', rows.map((r) => r.sale_id))
        .orderBy('line_no')
        .execute(),
      trx
        .selectFrom('delivery_collections as c')
        .innerJoin('users as u', 'u.id', 'c.collected_by')
        .select(['c.delivery_id', 'c.method', 'c.amount_kobo', 'c.reference', 'u.full_name', 'c.collected_at', 'c.remittance_id'])
        .where('c.delivery_id', 'in', ids)
        .orderBy('c.collected_at')
        .execute(),
      trx
        .selectFrom('delivery_returns as r')
        .innerJoin('products as p', 'p.id', 'r.product_id')
        .select(['r.delivery_id', 'r.product_id', 'p.name', 'r.quantity', 'r.note'])
        .where('r.delivery_id', 'in', ids)
        .execute(),
    ]);
    const hideCode = auth.role === 'driver';

    return rows.map((d) => ({
      id: d.id,
      saleId: d.sale_id,
      saleNumber: d.sale_number,
      status: d.status,
      fulfilment: d.fulfilment,
      locationId: d.location_id,
      locationName: d.location_name,
      customer: d.customer_id && d.customer_name ? { id: d.customer_id, name: d.customer_name, phone: d.customer_phone } : null,
      address: d.address,
      scheduledDate: d.scheduled_date,
      driverId: d.driver_id,
      driverName: d.driver_name,
      expectedAt: d.expected_at,
      codKobo: d.cod_kobo,
      collectedKobo: d.collected_kobo,
      confirmationCode: hideCode ? null : d.confirmation_code,
      attempts: d.attempts,
      failureReason: d.failure_reason,
      deliveredAt: d.delivered_at,
      deliveredByName: d.delivered_by_name,
      proofMethod: d.proof_method,
      receivedByName: d.received_by_name,
      hasSignature: d.signature_key !== null,
      items: items.filter((i) => i.sale_id === d.sale_id).map((i) => ({ productName: i.product_name, quantity: i.quantity, unit: i.unit })),
      collections: collections
        .filter((c) => c.delivery_id === d.id)
        .map((c) => ({
          method: c.method,
          amountKobo: c.amount_kobo,
          reference: c.reference,
          collectedByName: c.full_name,
          collectedAt: c.collected_at,
          remitted: c.remittance_id !== null,
        })),
      returns: returns
        .filter((r) => r.delivery_id === d.id)
        .map((r) => ({ productId: r.product_id, productName: r.name, quantity: r.quantity, note: r.note })),
      createdAt: d.created_at,
    }));
  }

  private async loadRemittance(trx: Trx, id: string): Promise<RemittanceDto> {
    const r = await trx
      .selectFrom('delivery_remittances as r')
      .innerJoin('users as u', 'u.id', 'r.driver_id')
      .selectAll('r')
      .select([
        'u.full_name as driver_name',
        (eb) =>
          eb
            .selectFrom('delivery_collections')
            .select(sql<number>`count(*)`.as('n'))
            .whereRef('delivery_collections.remittance_id', '=', 'r.id')
            .as('settled'),
      ])
      .where('r.id', '=', id)
      .executeTakeFirstOrThrow();
    const org = await trx.selectFrom('organizations').select('eod_variance_alert_kobo').executeTakeFirstOrThrow();
    return {
      id: r.id,
      driverId: r.driver_id,
      driverName: r.driver_name,
      expectedKobo: r.expected_kobo,
      countedKobo: r.counted_kobo,
      varianceKobo: r.variance_kobo,
      varianceFlagged: Math.abs(r.variance_kobo) > org.eod_variance_alert_kobo,
      registerSessionId: r.register_session_id,
      receivedById: r.received_by,
      note: r.note,
      collectionsSettled: Number(r.settled ?? 0),
      createdAt: r.created_at,
    };
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIGNATURE_BYTES = 512 * 1024;

/** Accepts a bare base64 PNG or a data URL; refuses anything that isn't really a small PNG. */
function decodeSignature(input: string): Buffer {
  const bytes = Buffer.from(input.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (bytes.length > MAX_SIGNATURE_BYTES) throw new BadRequestException('Signature image is too large (max 512 KB)');
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new BadRequestException('Signature must be a PNG image');
  }
  return bytes;
}
