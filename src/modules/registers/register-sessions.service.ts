import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, Transaction } from 'kysely';
import type { AuthContext } from '../../auth/auth.types';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../common/db/pg-errors';
import { isUuid, uuidv7 } from '../../common/ids/uuidv7';
import type { CashMovementKind, DB } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import type {
  CashMovementDto,
  ClockInDto,
  CloseSessionDto,
  CreateCashMovementDto,
  CurrentSessionResponseDto,
  ListSessionsQueryDto,
  RegisterSessionPageDto,
  RegisterSessionReportDto,
  RegisterSessionSummaryDto,
  SessionSalesSummaryDto,
} from './dto/registers.dto';
import { buildCashBreakdown, CashBreakdown, evaluateVariance } from './eod';

type Trx = Transaction<DB>;

const SUPERVISOR_ROLES = new Set(['owner', 'manager']);

@Injectable()
export class RegisterSessionsService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly events: EventPublisher,
  ) {}

  // ─── Clock-in (REG-01) ─────────────────────────────────────────────────────────

  /** options.occurredAt: when it really happened, for clock-ins recorded offline. */
  async clockIn(auth: AuthContext, registerId: string, dto: ClockInDto, options: { occurredAt?: Date } = {}): Promise<RegisterSessionReportDto> {
    const sessionId = dto.sessionId ?? uuidv7();

    try {
      return await this.tenantDb.transaction(async (trx) => {
        // Safe retry: the same client-generated id returns the original session.
        if (dto.sessionId) {
          const existing = await trx
            .selectFrom('register_sessions')
            .select(['id', 'user_id', 'register_id'])
            .where('id', '=', dto.sessionId)
            .executeTakeFirst();
          if (existing) {
            if (existing.user_id !== auth.userId || existing.register_id !== registerId) {
              throw new ConflictException('This session id is already in use');
            }
            return this.requireReport(trx, existing.id);
          }
        }

        // Lock the register row so two people tapping "clock in" at once are serialized.
        const register = await trx
          .selectFrom('registers')
          .select(['id', 'name', 'location_id', 'is_active'])
          .where('id', '=', registerId)
          .forUpdate()
          .executeTakeFirst();
        if (!register) throw new NotFoundException('Register not found');
        if (!register.is_active) throw new BadRequestException('This register has been deactivated');

        const occupied = await trx
          .selectFrom('register_sessions as s')
          .innerJoin('users as u', 'u.id', 's.user_id')
          .select(['s.user_id', 'u.full_name', 's.opened_at'])
          .where('s.register_id', '=', registerId)
          .where('s.status', '=', 'open')
          .executeTakeFirst();
        if (occupied) {
          throw new ConflictException(
            occupied.user_id === auth.userId
              ? 'You are already clocked into this register'
              : `${register.name} is in use by ${occupied.full_name} since ${occupied.opened_at.toISOString()}. They must run End of Day first.`,
          );
        }

        const elsewhere = await trx
          .selectFrom('register_sessions as s')
          .innerJoin('registers as r', 'r.id', 's.register_id')
          .select(['r.name'])
          .where('s.user_id', '=', auth.userId)
          .where('s.status', '=', 'open')
          .executeTakeFirst();
        if (elsewhere) {
          throw new ConflictException(`You are still clocked into ${elsewhere.name}. Run End of Day there first.`);
        }

        await trx
          .insertInto('register_sessions')
          .values({
            id: sessionId,
            organization_id: auth.organizationId,
            register_id: registerId,
            location_id: register.location_id,
            user_id: auth.userId,
            opening_float_kobo: dto.openingFloatKobo,
            ...(options.occurredAt ? { opened_at: options.occurredAt } : {}),
          })
          .execute();

        await this.insertMovement(trx, auth, sessionId, 'opening_float', dto.openingFloatKobo, null);

        await this.events.record(trx, {
          occurredAt: options.occurredAt,
          type: EventTypes.RegisterOpened,
          aggregateType: 'register_session',
          aggregateId: sessionId,
          locationId: register.location_id,
          payload: {
            after: {
              registerId,
              registerName: register.name,
              staffId: auth.userId,
              openingFloatKobo: dto.openingFloatKobo,
            },
          },
        });

        return this.requireReport(trx, sessionId);
      });
    } catch (err) {
      // The partial unique indexes are the final word if two requests race past the checks.
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('This register or staff member was just clocked in elsewhere. Refresh and try again.');
      }
      throw err;
    }
  }

  /** The caller's open session, for the POS to decide between the sales screen and clock-in. */
  async current(auth: AuthContext): Promise<CurrentSessionResponseDto> {
    return this.tenantDb.transaction(async (trx) => {
      const open = await trx
        .selectFrom('register_sessions')
        .select('id')
        .where('user_id', '=', auth.userId)
        .where('status', '=', 'open')
        .executeTakeFirst();
      return { session: open ? await this.requireReport(trx, open.id) : null };
    });
  }

  /**
   * REG-02, for use by the Sales module inside its own transaction: returns the caller's
   * open session (locked against a concurrent EOD) or refuses the sale.
   */
  async requireOpenSession(trx: Trx, userId: string, action = 'making sales') {
    const session = await trx
      .selectFrom('register_sessions')
      .select(['id', 'register_id', 'location_id'])
      .where('user_id', '=', userId)
      .where('status', '=', 'open')
      .forShare()
      .executeTakeFirst();
    if (!session) throw new ForbiddenException(`Clock in to a register before ${action}`);
    return session;
  }

  /**
   * For other modules taking or paying out cash (cash sales, cash wallet top-ups, cash debt
   * repayments, cash refunds): records it in the caller's open till, inside the caller's
   * transaction, so EOD expected cash includes it. Returns the session it landed in.
   */
  async recordCashInOpenSession(
    trx: Trx,
    auth: AuthContext,
    input: { kind: Exclude<CashMovementKind, 'opening_float' | 'pay_in' | 'pay_out'>; amountKobo: number; referenceType: string; referenceId: string; action: string },
  ): Promise<{ sessionId: string; registerId: string }> {
    const session = await this.requireOpenSession(trx, auth.userId, input.action);
    await this.insertMovement(trx, auth, session.id, input.kind, input.amountKobo, null, uuidv7(), {
      type: input.referenceType,
      id: input.referenceId,
    });
    return { sessionId: session.id, registerId: session.register_id };
  }

  // ─── Pay-ins / pay-outs ────────────────────────────────────────────────────────

  async recordCashMovement(auth: AuthContext, sessionId: string, dto: CreateCashMovementDto): Promise<CashMovementDto> {
    return this.tenantDb.transaction(async (trx) => {
      if (dto.id) {
        const existing = await trx
          .selectFrom('register_cash_movements')
          .selectAll()
          .where('id', '=', dto.id)
          .executeTakeFirst();
        if (existing) {
          if (existing.register_session_id !== sessionId) throw new ConflictException('This id is already in use');
          return toCashMovementDto(existing);
        }
      }

      const session = await this.lockSession(trx, sessionId);
      assertCanOperate(auth, session.user_id);
      if (session.status !== 'open') throw new ConflictException('This register session is already closed');

      const signed = dto.kind === 'pay_out' ? -dto.amountKobo : dto.amountKobo;
      if (dto.kind === 'pay_out') {
        const { expectedCashKobo } = await this.cashBreakdown(trx, sessionId);
        if (expectedCashKobo + signed < 0) {
          throw new BadRequestException(
            `Pay-out of ${dto.amountKobo} kobo is more than the ${expectedCashKobo} kobo expected in the till`,
          );
        }
      }

      const movement = await this.insertMovement(trx, auth, sessionId, dto.kind, signed, dto.reason.trim(), dto.id);

      await this.events.record(trx, {
        type: EventTypes.RegisterCashMoved,
        aggregateType: 'register_session',
        aggregateId: sessionId,
        locationId: session.location_id,
        payload: { kind: dto.kind, amountKobo: signed, reason: dto.reason.trim(), movementId: movement.id },
      });

      return toCashMovementDto(movement);
    });
  }

  // ─── End of Day (EOD-01, EOD-02) ───────────────────────────────────────────────

  /** Step 1 of EOD: what should be in the till. Changes nothing. */
  async eodPreview(auth: AuthContext, sessionId: string): Promise<RegisterSessionReportDto> {
    return this.tenantDb.transaction(async (trx) => {
      const report = await this.requireReport(trx, sessionId);
      assertCanOperate(auth, report.staffId);
      return report;
    });
  }

  /** Step 2 of EOD: record the counted cash, compute and flag the variance, close the till. */
  async close(auth: AuthContext, sessionId: string, dto: CloseSessionDto, options: { occurredAt?: Date } = {}): Promise<RegisterSessionReportDto> {
    return this.tenantDb.transaction(async (trx) => {
      const session = await this.lockSession(trx, sessionId);
      assertCanOperate(auth, session.user_id);

      if (session.status === 'closed') {
        // A retried request after a dropped connection: return the result rather than an error.
        if (session.counted_cash_kobo === dto.countedCashKobo) return this.requireReport(trx, sessionId);
        throw new ConflictException('This register session is already closed');
      }

      const cash = await this.cashBreakdown(trx, sessionId);
      const org = await trx
        .selectFrom('organizations')
        .select('eod_variance_alert_kobo')
        .executeTakeFirstOrThrow();
      const { varianceKobo, flagged } = evaluateVariance(
        cash.expectedCashKobo,
        dto.countedCashKobo,
        org.eod_variance_alert_kobo,
      );
      const note = dto.note?.trim() || null;

      await trx
        .updateTable('register_sessions')
        .set({
          status: 'closed',
          closed_at: options.occurredAt ?? sql`now()`,
          closed_by: auth.userId,
          expected_cash_kobo: cash.expectedCashKobo,
          counted_cash_kobo: dto.countedCashKobo,
          variance_kobo: varianceKobo,
          variance_flagged: flagged,
          closing_note: note,
        })
        .where('id', '=', sessionId)
        .execute();

      await this.events.record(trx, {
        occurredAt: options.occurredAt,
        type: EventTypes.RegisterClosed,
        aggregateType: 'register_session',
        aggregateId: sessionId,
        locationId: session.location_id,
        payload: {
          before: { status: 'open' },
          after: {
            status: 'closed',
            registerId: session.register_id,
            staffId: session.user_id,
            closedBy: auth.userId,
            expectedCashKobo: cash.expectedCashKobo,
            countedCashKobo: dto.countedCashKobo,
            varianceKobo,
            varianceFlagged: flagged,
            note,
          },
        },
      });

      if (flagged) {
        await this.events.record(trx, {
          type: EventTypes.ThresholdCrossed,
          aggregateType: 'register_session',
          aggregateId: sessionId,
          locationId: session.location_id,
          payload: {
            rule: 'register_variance',
            staffId: session.user_id,
            registerId: session.register_id,
            varianceKobo,
            thresholdKobo: org.eod_variance_alert_kobo,
          },
        });
      }

      return this.requireReport(trx, sessionId);
    });
  }

  // ─── Review (EOD-03) ───────────────────────────────────────────────────────────

  async list(auth: AuthContext, query: ListSessionsQueryDto): Promise<RegisterSessionPageDto> {
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const ownOnly = !SUPERVISOR_ROLES.has(auth.role);

    return this.tenantDb.transaction(async (trx) => {
      const rows = await this.sessionQuery(trx)
        .$if(ownOnly, (qb) => qb.where('s.user_id', '=', auth.userId))
        .$if(!ownOnly && !!query.userId, (qb) => qb.where('s.user_id', '=', query.userId!))
        .$if(!!query.registerId, (qb) => qb.where('s.register_id', '=', query.registerId!))
        .$if(!!query.status, (qb) => qb.where('s.status', '=', query.status!))
        .$if(!!query.flagged, (qb) => qb.where('s.variance_flagged', '=', query.flagged === 'true'))
        .$if(!!query.from, (qb) => qb.where('s.opened_at', '>=', new Date(query.from!)))
        .$if(!!query.to, (qb) => qb.where('s.opened_at', '<', new Date(query.to!)))
        .$if(cursor !== null, (qb) =>
          qb.where(sql<boolean>`(s.opened_at, s.id) < (${cursor!.openedAt}, ${cursor!.id})`),
        )
        .orderBy('s.opened_at', 'desc')
        .orderBy('s.id', 'desc')
        .limit(limit + 1)
        .execute();

      const page = rows.slice(0, limit).map(toSummary);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor: rows.length > limit && last ? encodeCursor(last.openedAt, last.id) : null,
      };
    });
  }

  async get(auth: AuthContext, sessionId: string): Promise<RegisterSessionReportDto> {
    return this.tenantDb.transaction(async (trx) => {
      const report = await this.requireReport(trx, sessionId);
      if (!SUPERVISOR_ROLES.has(auth.role) && report.staffId !== auth.userId) {
        throw new NotFoundException('Register session not found');
      }
      return report;
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────────

  private sessionQuery(trx: Trx) {
    return trx
      .selectFrom('register_sessions as s')
      .innerJoin('registers as r', 'r.id', 's.register_id')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .selectAll('s')
      .select(['r.name as register_name', 'u.full_name as staff_name']);
  }

  private async requireReport(trx: Trx, sessionId: string): Promise<RegisterSessionReportDto> {
    const row = await this.sessionQuery(trx).where('s.id', '=', sessionId).executeTakeFirst();
    if (!row) throw new NotFoundException('Register session not found');
    return {
      ...toSummary(row),
      sales: await this.salesSummary(trx, sessionId),
      cash: await this.cashBreakdown(trx, sessionId),
    };
  }

  private async salesSummary(trx: Trx, sessionId: string): Promise<SessionSalesSummaryDto> {
    const totals = await trx
      .selectFrom('sales')
      .select([
        sql<number>`count(*) filter (where status = 'completed')`.as('count'),
        sql<number>`coalesce(sum(total_kobo) filter (where status = 'completed'), 0)::bigint`.as('total'),
        sql<number>`count(*) filter (where status = 'voided')`.as('voided'),
      ])
      .where('register_session_id', '=', sessionId)
      .executeTakeFirstOrThrow();
    const methods = await trx
      .selectFrom('sale_payments as p')
      .innerJoin('sales as s', 's.id', 'p.sale_id')
      .select(['p.method', sql<number>`sum(p.amount_kobo)::bigint`.as('total')])
      .where('s.register_session_id', '=', sessionId)
      .where('s.status', '=', 'completed')
      .groupBy('p.method')
      .execute();
    const by = Object.fromEntries(methods.map((m) => [m.method, Number(m.total)]));
    return {
      count: Number(totals.count),
      totalKobo: Number(totals.total),
      voidedCount: Number(totals.voided),
      byMethod: {
        cashKobo: by.cash ?? 0,
        transferKobo: by.transfer ?? 0,
        cardKobo: by.card ?? 0,
        walletKobo: by.wallet ?? 0,
        creditKobo: by.credit ?? 0,
        payOnDeliveryKobo: by.pay_on_delivery ?? 0,
      },
    };
  }

  private async lockSession(trx: Trx, sessionId: string) {
    const session = await trx
      .selectFrom('register_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (!session) throw new NotFoundException('Register session not found');
    return session;
  }

  private async cashBreakdown(trx: Trx, sessionId: string): Promise<CashBreakdown> {
    const totals = await trx
      .selectFrom('register_cash_movements')
      .select(['kind', sql<number>`coalesce(sum(amount_kobo), 0)::bigint`.as('total')])
      .where('register_session_id', '=', sessionId)
      .groupBy('kind')
      .execute();
    return buildCashBreakdown(Object.fromEntries(totals.map((t) => [t.kind, Number(t.total)])));
  }

  private insertMovement(
    trx: Trx,
    auth: AuthContext,
    sessionId: string,
    kind: CashMovementKind,
    signedAmountKobo: number,
    reason: string | null,
    id: string = uuidv7(),
    reference?: { type: string; id: string },
  ) {
    return trx
      .insertInto('register_cash_movements')
      .values({
        id,
        organization_id: auth.organizationId,
        register_session_id: sessionId,
        kind,
        amount_kobo: signedAmountKobo,
        reason,
        reference_type: reference?.type ?? null,
        reference_id: reference?.id ?? null,
        created_by: auth.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}

/** Staff operate their own session; owners and managers can operate anyone's (supervised EOD). */
function assertCanOperate(auth: AuthContext, sessionOwnerId: string): void {
  if (auth.userId !== sessionOwnerId && !SUPERVISOR_ROLES.has(auth.role)) {
    throw new ForbiddenException('Only the staff member on this register, or a manager, can do this');
  }
}

type SessionRow = {
  id: string;
  register_id: string;
  location_id: string;
  user_id: string;
  status: 'open' | 'closed';
  opening_float_kobo: number;
  opened_at: Date;
  closed_at: Date | null;
  closed_by: string | null;
  expected_cash_kobo: number | null;
  counted_cash_kobo: number | null;
  variance_kobo: number | null;
  variance_flagged: boolean;
  closing_note: string | null;
  register_name: string;
  staff_name: string;
};

function toSummary(row: SessionRow): RegisterSessionSummaryDto {
  return {
    id: row.id,
    registerId: row.register_id,
    registerName: row.register_name,
    locationId: row.location_id,
    staffId: row.user_id,
    staffName: row.staff_name,
    status: row.status,
    openingFloatKobo: row.opening_float_kobo,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    closedById: row.closed_by,
    expectedCashKobo: row.expected_cash_kobo,
    countedCashKobo: row.counted_cash_kobo,
    varianceKobo: row.variance_kobo,
    varianceFlagged: row.variance_flagged,
    closingNote: row.closing_note,
  };
}

function toCashMovementDto(row: {
  id: string;
  register_session_id: string;
  kind: CashMovementKind;
  amount_kobo: number;
  reason: string | null;
  created_by: string;
  created_at: Date;
}): CashMovementDto {
  return {
    id: row.id,
    registerSessionId: row.register_session_id,
    kind: row.kind as CashMovementDto['kind'],
    amountKobo: row.amount_kobo,
    reason: row.reason ?? '',
    createdById: row.created_by,
    createdAt: row.created_at,
  };
}

function encodeCursor(openedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([openedAt.toISOString(), id])).toString('base64url');
}

function decodeCursor(cursor: string): { openedAt: Date; id: string } {
  try {
    const [openedAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string];
    const date = new Date(openedAt);
    if (Number.isNaN(date.getTime()) || !isUuid(id)) throw new Error();
    return { openedAt: date, id };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
