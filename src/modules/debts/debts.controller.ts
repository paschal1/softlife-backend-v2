import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DebtsService } from './debts.service';
import {
  AgingQueryDto,
  AgingReportDto,
  CustomerDebtsDto,
  CustomerDebtsQueryDto,
  RecordRepaymentDto,
  RepaymentPageDto,
  RepaymentResultDto,
  RepaymentsQueryDto,
} from './dto/debts.dto';

@ApiTags('Debts & repayments')
@ApiBearerAuth()
@Controller('customers/:customerId/debts')
export class CustomerDebtsController {
  constructor(private readonly debts: DebtsService) {}

  @Get()
  @ApiOperation({ summary: "A customer's debts with ages and aging buckets", description: 'Open debts by default; status=all includes settled and voided.' })
  @ApiOkResponse({ type: CustomerDebtsDto })
  list(@Param('customerId', ParseUUIDPipe) customerId: string, @Query() query: CustomerDebtsQueryDto): Promise<CustomerDebtsDto> {
    return this.debts.customerDebts(customerId, query.status);
  }

  @Post('repayments')
  @ApiOperation({
    summary: 'Record a repayment (DEBT-04)',
    description:
      "Full or partial. Clears the oldest debts first unless debtRecordId is given. Cash goes into the caller's open till; " +
      'wallet takes it from the customer\'s wallet; transfer needs the reference. Cannot exceed what is owed. Retry-safe with id.',
  })
  @ApiCreatedResponse({ type: RepaymentResultDto })
  repay(
    @CurrentUser() auth: AuthContext,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: RecordRepaymentDto,
  ): Promise<RepaymentResultDto> {
    return this.debts.recordRepayment(auth, customerId, dto);
  }

  @Get('repayments')
  @ApiOperation({ summary: 'Repayment history, with which debts each payment cleared' })
  @ApiOkResponse({ type: RepaymentPageDto })
  repayments(@Param('customerId', ParseUUIDPipe) customerId: string, @Query() query: RepaymentsQueryDto): Promise<RepaymentPageDto> {
    return this.debts.repayments(customerId, query);
  }
}

@ApiTags('Debts & repayments')
@ApiBearerAuth()
@Controller('debts')
export class DebtsReportController {
  constructor(private readonly debts: DebtsService) {}

  @Get('aging')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Debt aging report (DEBT-03)',
    description: 'Everyone who owes, split into 0–30, 31–60, 61–90 and 90+ day buckets. Oldest debt first, so you chase the right customers first.',
  })
  @ApiOkResponse({ type: AgingReportDto })
  aging(@Query() query: AgingQueryDto): Promise<AgingReportDto> {
    return this.debts.agingReport(query);
  }
}
