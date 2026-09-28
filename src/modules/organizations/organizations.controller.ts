import { BadRequestException, Body, Controller, Get, NotFoundException, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Transaction } from 'kysely';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { DB, OrganizationsTable } from '../../database/database.types';
import type { Updateable } from 'kysely';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import { OrganizationDto, UpdateOrganizationSettingsDto } from './dto/organizations.dto';

@ApiTags('Organization')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly events: EventPublisher,
  ) {}

  /** RLS means "select from organizations" can only ever return the caller's own. */
  @Get('current')
  @ApiOperation({ summary: "The caller's organization and settings" })
  @ApiOkResponse({ type: OrganizationDto })
  current(): Promise<OrganizationDto> {
    return this.tenantDb.transaction((trx) => this.load(trx));
  }

  @Patch('current/settings')
  @Roles('owner')
  @ApiOperation({
    summary: 'Update business settings',
    description: 'EOD variance alert threshold, credit limit mode (soft/hard), default credit limit, enabled order types, and daily digest hour. Send only what changes.',
  })
  @ApiOkResponse({ type: OrganizationDto })
  updateSettings(@Body() dto: UpdateOrganizationSettingsDto): Promise<OrganizationDto> {
    const changes: Updateable<OrganizationsTable> = {};
    if (dto.eodVarianceAlertKobo !== undefined) changes.eod_variance_alert_kobo = dto.eodVarianceAlertKobo;
    if (dto.creditLimitMode !== undefined) changes.credit_limit_mode = dto.creditLimitMode;
    if (dto.defaultCreditLimitKobo !== undefined) changes.default_credit_limit_kobo = dto.defaultCreditLimitKobo;
    if (dto.enabledOrderTypes !== undefined) changes.enabled_order_types = dto.enabledOrderTypes;
    if (dto.dailyDigestHour !== undefined) changes.daily_digest_hour = dto.dailyDigestHour;
    if (Object.keys(changes).length === 0) throw new BadRequestException('No settings to change');

    return this.tenantDb.transaction(async (trx) => {
      const before = await this.load(trx);
      await trx.updateTable('organizations').set(changes).execute();
      const after = await this.load(trx);

      const keys = ['eodVarianceAlertKobo', 'creditLimitMode', 'defaultCreditLimitKobo', 'enabledOrderTypes', 'dailyDigestHour'] as const;
      const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changed.length > 0) {
        await this.events.record(trx, {
          type: EventTypes.OrganizationSettingsUpdated,
          aggregateType: 'organization',
          aggregateId: before.id,
          payload: {
            before: Object.fromEntries(changed.map((k) => [k, before[k]])),
            after: Object.fromEntries(changed.map((k) => [k, after[k]])),
          },
        });
      }
      return after;
    });
  }

  private async load(trx: Transaction<DB>): Promise<OrganizationDto> {
    const org = await trx
      .selectFrom('organizations')
      .select([
        'id',
        'name',
        'country_code as countryCode',
        'currency',
        'timezone',
        'enabled_modules as enabledModules',
        'status',
        'eod_variance_alert_kobo as eodVarianceAlertKobo',
        'credit_limit_mode as creditLimitMode',
        'default_credit_limit_kobo as defaultCreditLimitKobo',
        'enabled_order_types as enabledOrderTypes',
        'daily_digest_hour as dailyDigestHour',
        'created_at as createdAt',
      ])
      .executeTakeFirst();
    if (!org) throw new NotFoundException();
    return org;
  }
}
