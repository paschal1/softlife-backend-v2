import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../auth/decorators/roles.decorator';
import { TenantDatabase } from '../../database/tenant-database.service';
import { localParts } from '../../jobs/local-time';
import { DailySummaryService } from './daily-summary.service';
import { DailySummaryDto, DailySummaryQueryDto } from './dto/insights.dto';

@ApiTags('Insights')
@ApiBearerAuth()
@Controller('insights')
export class InsightsController {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly summaries: DailySummaryService,
  ) {}

  @Get('daily-summary')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'A business day at a glance (INS-01)',
    description: 'Sales and payment mix, top products, till variances and open tills, credit and repayments, low stock, deliveries and cash with drivers. The same figures as the evening digest.',
  })
  @ApiOkResponse({ type: DailySummaryDto })
  daily(@Query() query: DailySummaryQueryDto): Promise<DailySummaryDto> {
    return this.tenantDb.transaction(async (trx) => {
      const org = await trx.selectFrom('organizations').select('timezone').executeTakeFirstOrThrow();
      const date = query.date ?? localParts(new Date(), org.timezone).date;
      return this.summaries.build(trx, date, org.timezone, query.locationId);
    });
  }
}
