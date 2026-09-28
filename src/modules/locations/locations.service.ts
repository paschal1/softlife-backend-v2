import { ConflictException, Injectable } from '@nestjs/common';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../common/db/pg-errors';
import { uuidv7 } from '../../common/ids/uuidv7';
import { normalizePhone } from '../../common/phone';
import { RequestContext } from '../../common/context/request-context';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import type { CreateLocationDto, LocationDto } from './dto/locations.dto';

/**
 * The reference pattern for every module:
 *   1. All reads/writes go through tenantDb.transaction() — RLS does the tenant filtering.
 *   2. Every state change records its domain event in the SAME transaction.
 *   3. No module calls another module's service to react to a change — it subscribes to the event.
 */
@Injectable()
export class LocationsService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly events: EventPublisher,
  ) {}

  list(): Promise<LocationDto[]> {
    return this.tenantDb.transaction((trx) =>
      trx
        .selectFrom('locations')
        .select(['id', 'name', 'address', 'phone', 'is_active as isActive', 'created_at as createdAt'])
        .orderBy('created_at')
        .execute(),
    );
  }

  async create(dto: CreateLocationDto): Promise<LocationDto> {
    const { organizationId } = RequestContext.require();
    const id = uuidv7();
    const values = {
      name: dto.name.trim(),
      address: dto.address?.trim() || null,
      phone: dto.phone ? normalizePhone(dto.phone) : null,
    };

    try {
      return await this.tenantDb.transaction(async (trx) => {
        const location = await trx
          .insertInto('locations')
          .values({ id, organization_id: organizationId, ...values })
          .returning(['id', 'name', 'address', 'phone', 'is_active as isActive', 'created_at as createdAt'])
          .executeTakeFirstOrThrow();

        await this.events.record(trx, {
          type: EventTypes.LocationCreated,
          aggregateType: 'location',
          aggregateId: id,
          locationId: id,
          payload: { after: values },
        });
        return location;
      });
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('A branch with this name already exists');
      }
      throw err;
    }
  }
}
