import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Largest amount accepted in one field: ₦10 billion. Catches naira-vs-kobo mix-ups early. */
const MAX_KOBO = 1_000_000_000_000;

// ─── Requests ───────────────────────────────────────────────────────────────────

export class CreateRegisterDto {
  @IsUUID()
  locationId!: string;

  /** e.g. "Front Counter", "Till 2" */
  @IsString() @IsNotEmpty() @MaxLength(80)
  name!: string;
}

export class ClockInDto {
  /** Cash in the till at the start of the shift, in kobo (₦5,000 = 500000). */
  @IsInt() @Min(0) @Max(MAX_KOBO)
  openingFloatKobo!: number;

  /**
   * Optional client-generated UUIDv7 for this session. Retrying with the same id
   * returns the original session instead of failing, so a flaky connection can't
   * cause a double clock-in.
   */
  @IsOptional() @IsUUID()
  sessionId?: string;
}

export const MANUAL_CASH_MOVEMENTS = ['pay_in', 'pay_out'] as const;
export type ManualCashMovement = (typeof MANUAL_CASH_MOVEMENTS)[number];

export class CreateCashMovementDto {
  @ApiProperty({ enum: MANUAL_CASH_MOVEMENTS, description: 'pay_in adds cash to the till; pay_out removes it' })
  @IsIn(MANUAL_CASH_MOVEMENTS)
  kind!: ManualCashMovement;

  /** Always positive, in kobo. Direction comes from `kind`. */
  @IsInt() @Min(1) @Max(MAX_KOBO)
  amountKobo!: number;

  /** Required. e.g. "Diesel for generator", "Change from owner". */
  @IsString() @IsNotEmpty() @MaxLength(300)
  reason!: string;

  /** Optional client-generated UUIDv7 for safe retries. */
  @IsOptional() @IsUUID()
  id?: string;
}

export class CloseSessionDto {
  /** Cash physically counted in the till at end of shift, in kobo. */
  @IsInt() @Min(0) @Max(MAX_KOBO)
  countedCashKobo!: number;

  /** Staff explanation, especially useful when there is a variance. */
  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

export class ListRegistersQueryDto {
  @IsOptional() @IsUUID()
  locationId?: string;
}

export class ListSessionsQueryDto {
  @IsOptional() @IsUUID()
  registerId?: string;

  /** Owners and managers only; cashiers and drivers always see just their own sessions. */
  @IsOptional() @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ enum: ['open', 'closed'] })
  @IsOptional() @IsIn(['open', 'closed'])
  status?: 'open' | 'closed';

  /** Sessions opened at or after this time (ISO 8601). */
  @IsOptional() @IsISO8601()
  from?: string;

  /** Sessions opened before this time (ISO 8601). */
  @IsOptional() @IsISO8601()
  to?: string;

  /** Only sessions with a flagged EOD variance. */
  @IsOptional() @IsIn(['true', 'false'])
  flagged?: 'true' | 'false';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  /** Opaque cursor from a previous page's `nextCursor`. */
  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;
}

// ─── Responses ──────────────────────────────────────────────────────────────────

export class RegisterCurrentSessionDto {
  id!: string;
  staffId!: string;
  staffName!: string;
  openedAt!: Date;
  openingFloatKobo!: number;
}

export class RegisterStatusDto {
  id!: string;
  name!: string;
  locationId!: string;
  isActive!: boolean;

  @ApiProperty({ enum: ['open', 'closed'] })
  status!: 'open' | 'closed';

  @ApiProperty({ type: RegisterCurrentSessionDto, nullable: true })
  currentSession!: RegisterCurrentSessionDto | null;

  @ApiProperty({ type: Date, nullable: true })
  lastClosedAt!: Date | null;
}

export class CashBreakdownDto {
  openingFloatKobo!: number;
  payInsKobo!: number;
  /** Positive magnitude of cash paid out. */
  payOutsKobo!: number;
  cashSalesKobo!: number;
  /** Positive magnitude of cash refunded. */
  cashRefundsKobo!: number;
  walletTopUpsKobo!: number;
  debtRepaymentsKobo!: number;
  /** Cash handed in by drivers from pay-on-delivery orders. */
  deliveryCashKobo!: number;
  /** What should be in the till now: all cash in minus all cash out. */
  expectedCashKobo!: number;
}

export class RegisterSessionSummaryDto {
  id!: string;
  registerId!: string;
  registerName!: string;
  locationId!: string;
  staffId!: string;
  staffName!: string;

  @ApiProperty({ enum: ['open', 'closed'] })
  status!: 'open' | 'closed';

  openingFloatKobo!: number;
  openedAt!: Date;

  @ApiProperty({ type: Date, nullable: true })
  closedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  closedById!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  expectedCashKobo!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  countedCashKobo!: number | null;

  /** counted − expected. Negative = short, positive = over. Null while open. */
  @ApiProperty({ type: Number, nullable: true })
  varianceKobo!: number | null;

  varianceFlagged!: boolean;

  @ApiProperty({ type: String, nullable: true })
  closingNote!: string | null;
}

export class SalesByMethodDto {
  cashKobo!: number;
  transferKobo!: number;
  cardKobo!: number;
  walletKobo!: number;
  creditKobo!: number;
  /** Still to be collected at the door or at pickup. */
  payOnDeliveryKobo!: number;
}

export class SessionSalesSummaryDto {
  /** Completed (not voided) sales in this session. */
  count!: number;
  totalKobo!: number;
  voidedCount!: number;
  /** Payment mix of completed sales (EOD-01). */
  byMethod!: SalesByMethodDto;
}

/** The EOD report: session summary, sales and payment mix, and everything that moved through the till. */
export class RegisterSessionReportDto extends RegisterSessionSummaryDto {
  sales!: SessionSalesSummaryDto;
  cash!: CashBreakdownDto;
}

export class CurrentSessionResponseDto {
  /** Null when the caller is not clocked in; the POS should show the clock-in screen. */
  @ApiProperty({ type: RegisterSessionReportDto, nullable: true })
  session!: RegisterSessionReportDto | null;
}

export class RegisterSessionPageDto {
  @ApiProperty({ type: [RegisterSessionSummaryDto] })
  items!: RegisterSessionSummaryDto[];

  /** Pass as `cursor` to get the next page. Null on the last page. */
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class CashMovementDto {
  id!: string;
  registerSessionId!: string;

  @ApiProperty({ enum: MANUAL_CASH_MOVEMENTS })
  kind!: ManualCashMovement;

  /** Signed: negative for pay-outs. */
  amountKobo!: number;
  reason!: string;
  createdById!: string;
  createdAt!: Date;
}
