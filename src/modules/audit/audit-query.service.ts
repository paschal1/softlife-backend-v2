import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, Transaction } from 'kysely';
import { decodeCursor, encodeCursor, likeEscape } from '../../common/pagination';
import type { DB } from '../../database/database.types';
import { describeEntry } from './describe';
import type { AuditEntryDto, AuditFiltersDto } from './dto/audit.dto';

type Trx = Transaction<DB>;

/** Largest window a free-text search may scan. */
const MAX_TEXT_SEARCH_DAYS = 366;

/** Filtered, readable audit log access, shared by the viewer (API) and exports (worker). */
@Injectable()
export class AuditQueryService {
  async page(trx: Trx, filters: AuditFiltersDto, limit: number, cursor?: string): Promise<{ items: AuditEntryDto[]; nextCursor: string | null }> {
    const after = cursor ? decodeCursor(cursor, 2) : null;
    const rows = await this.query(trx, filters)
      .$if(after !== null, (qb) => qb.where(sql<boolean>`(a.occurred_at, a.id) < (${new Date(after![0]!)}, ${after![1]!})`))
      .orderBy('a.occurred_at', 'desc')
      .orderBy('a.id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toEntry),
      nextCursor: rows.length > limit && last ? encodeCursor([last.occurred_at.toISOString(), last.id]) : null,
    };
  }

  async one(trx: Trx, id: string): Promise<AuditEntryDto> {
    const row = await this.query(trx, {}).where('a.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Audit entry not found');
    return toEntry(row);
  }

  /** Walks every matching entry in pages, oldest first (the natural order for an export). */
  async *all(trx: Trx, filters: AuditFiltersDto, batchSize = 1000): AsyncGenerator<AuditEntryDto[]> {
    let after: [Date, string] | null = null;
    for (;;) {
      const cursor: [Date, string] | null = after;
        const rows: Row[] = await this.query(trx, filters)
        .$if(cursor !== null, (qb) => qb.where(sql<boolean>`(a.occurred_at, a.id) > (${cursor![0]}, ${cursor![1]})`))
        .orderBy('a.occurred_at')
        .orderBy('a.id')
        .limit(batchSize)
        .execute();
      if (rows.length === 0) return;
      yield rows.map(toEntry);
      const last = rows[rows.length - 1]!;
      after = [last.occurred_at, last.id];
      if (rows.length < batchSize) return;
    }
  }

  validate(filters: AuditFiltersDto): void {
    if (filters.from && filters.to && new Date(filters.from) >= new Date(filters.to)) {
      throw new BadRequestException('"from" must be before "to"');
    }
    if (filters.q) {
      const from = filters.from ? new Date(filters.from).getTime() : 0;
      const to = filters.to ? new Date(filters.to).getTime() : Date.now();
      if (!filters.from || (to - from) / 86_400_000 > MAX_TEXT_SEARCH_DAYS) {
        throw new BadRequestException(`Text search needs a date range of at most ${MAX_TEXT_SEARCH_DAYS} days (set "from")`);
      }
    }
  }

  private query(trx: Trx, f: AuditFiltersDto) {
    const action = f.action;
    const prefix = action?.endsWith('.*') ? `${likeEscape(action.slice(0, -1))}%` : null;
    const text = f.q?.trim() ? `%${likeEscape(f.q.trim())}%` : null;

    return trx
      .selectFrom('audit_log as a')
      .leftJoin('users as actor', 'actor.id', 'a.actor_id')
      .leftJoin('locations as l', 'l.id', 'a.location_id')
      // Entity names: ids are UUIDs, unique across tables, so these joins can't cross-match.
      .leftJoin('products as p', 'p.id', 'a.entity_id')
      .leftJoin('customers as c', 'c.id', 'a.entity_id')
      .leftJoin('users as u', 'u.id', 'a.entity_id')
      .select([
        'a.id',
        'a.occurred_at',
        'a.recorded_at',
        'a.action_type',
        'a.entity_type',
        'a.entity_id',
        'a.actor_id',
        'a.location_id',
        'a.before_state',
        'a.after_state',
        'actor.full_name as actor_name',
        'l.name as location_name',
        sql<string | null>`coalesce(p.name, c.name, u.full_name)`.as('entity_name'),
      ])
      .$if(!!f.from, (qb) => qb.where('a.occurred_at', '>=', new Date(f.from!)))
      .$if(!!f.to, (qb) => qb.where('a.occurred_at', '<', new Date(f.to!)))
      .$if(!!f.actorId, (qb) => qb.where('a.actor_id', '=', f.actorId!))
      .$if(!!action && prefix === null, (qb) => qb.where('a.action_type', '=', action!))
      .$if(prefix !== null, (qb) => qb.where('a.action_type', 'like', prefix!))
      .$if(!!f.entityType, (qb) => qb.where('a.entity_type', '=', f.entityType!))
      .$if(!!f.entityId, (qb) => qb.where('a.entity_id', '=', f.entityId!))
      .$if(!!f.locationId, (qb) => qb.where('a.location_id', '=', f.locationId!))
      .$if(text !== null, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb(sql<string>`a.after_state::text`, 'ilike', text!),
            eb(sql<string>`a.before_state::text`, 'ilike', text!),
            eb(sql<string>`coalesce(p.name, c.name, u.full_name, '')`, 'ilike', text!),
          ]),
        ),
      );
  }
}

type Row = {
  id: string;
  occurred_at: Date;
  recorded_at: Date;
  action_type: string;
  entity_type: string;
  entity_id: string;
  actor_id: string | null;
  location_id: string | null;
  before_state: unknown;
  after_state: unknown;
  actor_name: string | null;
  location_name: string | null;
  entity_name: string | null;
};

const asObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function toEntry(r: Row): AuditEntryDto {
  return {
    id: r.id,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    actionType: r.action_type,
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityName: r.entity_name,
    actorId: r.actor_id,
    actorName: r.actor_name,
    locationId: r.location_id,
    locationName: r.location_name,
    summary: describeEntry({
      actionType: r.action_type,
      entityName: r.entity_name,
      before: asObject(r.before_state),
      after: asObject(r.after_state),
    }),
    before: r.before_state,
    after: r.after_state,
  };
}
