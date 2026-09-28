import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { REPAYMENT_METHODS, type RepaymentMethod } from '../../../database/database.types';
import { AGING_BUCKETS, type AgingBucket } from '../aging';

export class RecordRepaymentDto {
  /** Optional client-generated UUIDv7: resubmitting is a safe no-op. */
  @IsOptional() @IsUUID()
  id?: string;

  /** Amount paid, in kobo. Cannot exceed what the customer owes. */
  @IsInt() @Min(1) @Max(100_000_000_000)
  amountKobo!: number;

  @ApiProperty({
    enum: REPAYMENT_METHODS,
    description: "cash goes into the caller's open till; transfer needs the reference; wallet takes it from the customer's wallet",
  })
  @IsIn(REPAYMENT_METHODS)
  method!: RepaymentMethod;

  /** Transfer reference (required for transfers) or POS slip number. */
  @ValidateIf((o: RecordRepaymentDto) => o.method === 'transfer' || o.reference !== undefined)
  @IsString() @IsNotEmpty() @MaxLength(100)
  reference?: string;

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;

  /** Pay a specific debt. Omit to clear the oldest debts first. */
  @IsOptional() @IsUUID()
  debtRecordId?: string;
}

export class CustomerDebtsQueryDto {
  @ApiPropertyOptional({ enum: ['open', 'all'], description: 'open (default) or all, including settled and voided' })
  @IsOptional() @IsIn(['open', 'all'])
  status?: 'open' | 'all';
}

export class AgingQueryDto {
  /** Age debts as of this moment. Defaults to now. */
  @IsOptional() @IsISO8601()
  asOf?: string;

  /** Only customers with debt in this bucket or older. */
  @ApiPropertyOptional({ enum: AGING_BUCKETS })
  @IsOptional() @IsIn(AGING_BUCKETS)
  minBucket?: AgingBucket;
}

export class RepaymentsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;
}

// ─── Responses ──────────────────────────────────────────────────────────────────

export class AgingTotalsDto {
  days0to30!: number;
  days31to60!: number;
  days61to90!: number;
  days90plus!: number;
  totalKobo!: number;
}

export class DebtDto {
  id!: string;
  saleId!: string;
  saleNumber!: number;
  amountKobo!: number;
  paidKobo!: number;
  outstandingKobo!: number;

  @ApiProperty({ enum: ['open', 'settled', 'voided'] })
  status!: 'open' | 'settled' | 'voided';

  createdAt!: Date;
  ageDays!: number;

  @ApiProperty({ enum: AGING_BUCKETS })
  bucket!: AgingBucket;
}

export class CustomerDebtsDto {
  customerId!: string;
  customerName!: string;
  outstandingKobo!: number;
  aging!: AgingTotalsDto;

  @ApiProperty({ type: [DebtDto] })
  debts!: DebtDto[];
}

export class RepaymentAllocationDto {
  debtRecordId!: string;
  saleId!: string;
  saleNumber!: number;
  amountKobo!: number;
}

export class RepaymentDto {
  id!: string;
  customerId!: string;
  amountKobo!: number;

  @ApiProperty({ enum: REPAYMENT_METHODS })
  method!: RepaymentMethod;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, nullable: true })
  registerSessionId!: string | null;

  createdById!: string;
  createdByName!: string;
  createdAt!: Date;

  /** Which debts this payment cleared. */
  @ApiProperty({ type: [RepaymentAllocationDto] })
  allocations!: RepaymentAllocationDto[];
}

export class RepaymentResultDto {
  repayment!: RepaymentDto;
  /** What the customer still owes after this payment. */
  outstandingAfterKobo!: number;
  replayed!: boolean;
}

export class RepaymentPageDto {
  @ApiProperty({ type: [RepaymentDto] })
  items!: RepaymentDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class AgingCustomerDto extends AgingTotalsDto {
  customerId!: string;
  customerName!: string;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  openDebts!: number;
  oldestDays!: number;
}

export class AgingReportDto {
  asOf!: Date;
  totals!: AgingTotalsDto;

  /** Most urgent first: oldest debt, then largest amount. */
  @ApiProperty({ type: [AgingCustomerDto] })
  customers!: AgingCustomerDto[];
}
