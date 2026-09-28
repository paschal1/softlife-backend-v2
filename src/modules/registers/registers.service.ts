import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from '../../common/db/pg-errors';
import { uuidv7 } from '../../common/ids/uuidv7';
import { RequestContext } from '../../common/context/request-context';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import type { CreateRegisterDto, RegisterStatusDto } from './dto/registers.dto';

@Injectable()
export class RegistersService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly events: EventPublisher,
  ) {}

  async create(dto: CreateRegisterDto): Promise<RegisterStatusDto> {
    const { organizationId } = RequestContext.require();
    const id = uuidv7();
    const name = dto.name.trim();

    try {
      return await this.tenantDb.transaction(async (trx) => {
        const register = await trx
          .insertInto('registers')
          .values({ id, organization_id: organizationId, location_id: dto.locationId, name })
          .returning(['id', 'name', 'location_id', 'is_active'])
          .executeTakeFirstOrThrow();

        await this.events.record(trx, {
          type: EventTypes.RegisterCreated,
          aggregateType: 'register',
          aggregateId: id,
          locationId: dto.locationId,
          payload: { after: { name, locationId: dto.locationId } },
        });

        return {
          id: register.id,
          name: register.name,
          locationId: register.location_id,
          isActive: register.is_active,
          status: 'closed' as const,
          currentSession: null,
          lastClosedAt: null,
        };
      });
    } catch (err) {
      const code = pgErrorCode(err);
      if (code === PG_UNIQUE_VIOLATION) throw new ConflictException('A register with this name already exists at this branch');
      if (code === PG_FOREIGN_KEY_VIOLATION) throw new BadRequestException('Unknown location');
      throw err;
    }
  }

  /** REG-03: every register with its live status, in one call. */
  async listWithStatus(locationId?: string): Promise<RegisterStatusDto[]> {
    return this.tenantDb.transaction(async (trx) => {
      const rows = await trx
        .selectFrom('registers as r')
        .leftJoin('register_sessions as s', (join) =>
          join.onRef('s.register_id', '=', 'r.id').on('s.status', '=', 'open'),
        )
        .leftJoin('users as u', 'u.id', 's.user_id')
        .select([
          'r.id',
          'r.name',
          'r.location_id',
          'r.is_active',
          's.id as session_id',
          's.opened_at',
          's.opening_float_kobo',
          's.user_id as staff_id',
          'u.full_name as staff_name',
        ])
        .$if(locationId !== undefined, (qb) => qb.where('r.location_id', '=', locationId!))
        .orderBy('r.created_at')
        .execute();

      const lastClosed = await trx
        .selectFrom('register_sessions')
        .select((eb) => ['register_id', eb.fn.max('closed_at').as('last_closed_at')])
        .where('status', '=', 'closed')
        .groupBy('register_id')
        .execute();
      const lastClosedById = new Map(lastClosed.map((r) => [r.register_id, r.last_closed_at]));

      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        locationId: r.location_id,
        isActive: r.is_active,
        status: r.session_id ? ('open' as const) : ('closed' as const),
        currentSession:
          r.session_id && r.staff_id && r.opened_at && r.opening_float_kobo !== null
            ? {
                id: r.session_id,
                staffId: r.staff_id,
                staffName: r.staff_name ?? '',
                openedAt: r.opened_at,
                openingFloatKobo: r.opening_float_kobo,
              }
            : null,
        lastClosedAt: lastClosedById.get(r.id) ?? null,
      }));
    });
  }
}
