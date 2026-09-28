import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ROLES, type Role } from '../../../database/database.types';
import { CreateCustomerDto } from '../../customers/dto/customers.dto';
import { TopUpWalletDto } from '../../customers/dto/wallet.dto';
import { RecordRepaymentDto } from '../../debts/dto/debts.dto';
import { ConfirmDeliveryDto } from '../../deliveries/dto/deliveries.dto';
import { ProductDto } from '../../products/dto/products.dto';
import { CloseSessionDto, CreateCashMovementDto } from '../../registers/dto/registers.dto';
import { CreateSaleDto, SaleItemInputDto } from '../../sales/dto/sales.dto';

export const SYNC_OPERATION_TYPES = [
  'register.clock_in',
  'register.cash_movement',
  'register.close',
  'customer.create',
  'sale.create',
  'wallet.top_up',
  'debt.repayment',
  'delivery.confirm',
] as const;
export type SyncOperationType = (typeof SYNC_OPERATION_TYPES)[number];

// ─── Push ───────────────────────────────────────────────────────────────────────

export class SyncOperationDto {
  /** UUIDv7 generated on the device when the operation happened. Re-sending it is safe. */
  @IsUUID()
  opId!: string;

  @ApiProperty({ enum: SYNC_OPERATION_TYPES })
  @IsIn(SYNC_OPERATION_TYPES)
  type!: SyncOperationType;

  /** Device time when it happened. */
  @IsISO8601()
  occurredAt!: string;

  /** The staff member who did it (the one PIN-logged on the till at the time). */
  @IsUUID()
  actorId!: string;

  /**
   * The same body the matching online endpoint takes, plus the ids listed per type:
   * register.clock_in {registerId, sessionId, openingFloatKobo} ·
   * register.cash_movement {sessionId, id, kind, amountKobo, reason} ·
   * register.close {sessionId, countedCashKobo, note?} ·
   * customer.create {id, ...} · wallet.top_up {customerId, id, ...} ·
   * debt.repayment {customerId, id, ...} · delivery.confirm {deliveryId, code, ...} ·
   * sale.create {id, registerSessionId, approvedById?, items[{productId, quantity, unitPriceKobo, discountKobo?}], payments, ...}
   */
  @IsObject()
  payload!: Record<string, unknown>;
}

export class SyncPushDto {
  /** Stable identifier of the till or phone (generated once at install). */
  @IsString() @IsNotEmpty() @MaxLength(100)
  deviceId!: string;

  /** In the order they happened. Clock-in before its sales; sales before the close. */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => SyncOperationDto)
  operations!: SyncOperationDto[];
}

// Payload shapes (validated per operation type) ─────────────────────────────────

export class SyncClockInPayload {
  @IsUUID() registerId!: string;
  @IsUUID() sessionId!: string;
  @IsInt() @Min(0) @Max(1_000_000_000_000) openingFloatKobo!: number;
}

export class SyncCashMovementPayload extends CreateCashMovementDto {
  @IsUUID() sessionId!: string;
}

export class SyncClosePayload extends CloseSessionDto {
  @IsUUID() sessionId!: string;
}

export class SyncCustomerPayload extends CreateCustomerDto {}

export class SyncSaleItemDto extends SaleItemInputDto {
  /** What the till actually charged per unit, from its cached catalogue. */
  @IsInt() @Min(0) @Max(100_000_000_000)
  unitPriceKobo!: number;
}

export class SyncSalePayload extends CreateSaleDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => SyncSaleItemDto)
  override items: SyncSaleItemDto[] = [];

  /** The register session the till recorded the sale in. */
  @IsUUID()
  registerSessionId!: string;

  /** Owner/manager who approved a discount or credit override at the till. */
  @IsOptional() @IsUUID()
  approvedById?: string;
}

export class SyncTopUpPayload extends TopUpWalletDto {
  @IsUUID() customerId!: string;
}

export class SyncRepaymentPayload extends RecordRepaymentDto {
  @IsUUID() customerId!: string;
}

export class SyncDeliveryConfirmPayload extends ConfirmDeliveryDto {
  @IsUUID() deliveryId!: string;
}

// Push results ──────────────────────────────────────────────────────────────────

export class SyncErrorDto {
  /** e.g. VALIDATION_FAILED, SESSION_MISMATCH, NOT_FOUND, CONFLICT, SERVER_ERROR */
  code!: string;
  message!: string;
}

export class SyncOperationResultDto {
  opId!: string;

  @ApiProperty({
    enum: ['applied', 'duplicate', 'rejected', 'not_processed'],
    description:
      'applied: done now. duplicate: done earlier (this is the stored outcome). rejected: will never apply; a manager reviews it. ' +
      'not_processed: a temporary server problem stopped the batch here; send this and later operations again.',
  })
  status!: 'applied' | 'duplicate' | 'rejected' | 'not_processed';

  /** The id of what was created or changed (sale, session, customer...). */
  @ApiProperty({ type: String, nullable: true })
  entityId!: string | null;

  /** Applied, but something needs a manager's eye (e.g. price_differs_from_catalogue). */
  @ApiProperty({ type: [String] })
  flags!: string[];

  @ApiProperty({ type: SyncErrorDto, nullable: true })
  error!: SyncErrorDto | null;
}

export class SyncPushResultDto {
  serverTime!: Date;

  @ApiProperty({ type: [SyncOperationResultDto] })
  results!: SyncOperationResultDto[];
}

// ─── Pull ───────────────────────────────────────────────────────────────────────

export class SyncPullQueryDto {
  /** nextSince from the previous pull. Omit for a full download (first run or reset). */
  @IsOptional() @IsISO8601()
  since?: string;

  /** The till's branch: limits stock levels to it. */
  @IsOptional() @IsUUID()
  locationId?: string;
}

export class SyncCustomerDto {
  id!: string;
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  type!: string;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  creditLimitKobo!: number | null;

  isActive!: boolean;
  updatedAt!: Date;
}

export class SyncWalletDto {
  customerId!: string;
  balanceKobo!: number;
}

export class SyncDebtDto {
  customerId!: string;
  outstandingKobo!: number;
}

export class SyncStockLevelDto {
  productId!: string;
  locationId!: string;
  quantity!: number;
}

export class SyncUserDto {
  id!: string;
  fullName!: string;

  @ApiProperty({ enum: ROLES })
  role!: Role;

  isActive!: boolean;
  hasPin!: boolean;

  @ApiProperty({ type: String, nullable: true })
  defaultLocationId!: string | null;
}

export class SyncRegisterDto {
  id!: string;
  name!: string;
  locationId!: string;
  isActive!: boolean;
}

export class SyncSettingsDto {
  name!: string;
  currency!: string;
  timezone!: string;
  enabledOrderTypes!: string[];
  creditLimitMode!: string;

  @ApiProperty({ type: Number, nullable: true })
  defaultCreditLimitKobo!: number | null;
}

export class SyncPullDto {
  serverTime!: Date;
  /** Pass as `since` next time. Deliberately overlaps a little so nothing committed late is missed; upsert by id. */
  nextSince!: Date;
  /** True when this is a full download: replace local data rather than merge. */
  fullSync!: boolean;
  settings!: SyncSettingsDto;

  @ApiProperty({ type: [ProductDto] })
  products!: ProductDto[];

  @ApiProperty({ type: [SyncCustomerDto] })
  customers!: SyncCustomerDto[];

  @ApiProperty({ type: [SyncWalletDto] })
  walletBalances!: SyncWalletDto[];

  /** Always complete: every customer who owes. Anyone missing owes nothing. */
  @ApiProperty({ type: [SyncDebtDto] })
  outstandingDebts!: SyncDebtDto[];

  @ApiProperty({ type: [SyncStockLevelDto] })
  stockLevels!: SyncStockLevelDto[];

  /** For the "who's clocking in?" screen. No PIN hashes ever leave the server. */
  @ApiProperty({ type: [SyncUserDto] })
  users!: SyncUserDto[];

  @ApiProperty({ type: [SyncRegisterDto] })
  registers!: SyncRegisterDto[];
}

// ─── Review ─────────────────────────────────────────────────────────────────────

export class SyncReviewQueryDto {
  @ApiPropertyOptional({ enum: ['open', 'all'] })
  @IsOptional() @IsIn(['open', 'all'])
  status?: 'open' | 'all';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}

export class ResolveSyncDto {
  /** What was done about it, e.g. "Re-entered as sale #1043", "Price change agreed". */
  @IsString() @IsNotEmpty() @MaxLength(500)
  note!: string;
}

export class SyncReviewItemDto {
  opId!: string;
  deviceId!: string;
  actorId!: string;
  actorName!: string;
  type!: string;
  occurredAt!: Date;
  receivedAt!: Date;

  @ApiProperty({ enum: ['applied', 'rejected'] })
  status!: 'applied' | 'rejected';

  @ApiProperty({ type: String, nullable: true })
  entityId!: string | null;

  @ApiProperty({ type: [String] })
  flags!: string[];

  @ApiProperty({ type: String, nullable: true })
  errorCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  errorMessage!: string | null;

  /** Exactly what the till sent. */
  @ApiProperty({ type: Object })
  payload!: unknown;

  @ApiProperty({ type: Date, nullable: true })
  resolvedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  resolvedByName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  resolutionNote!: string | null;
}
