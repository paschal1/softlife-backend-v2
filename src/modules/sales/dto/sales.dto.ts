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
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PIN_PATTERN } from '../../../auth/dto/auth.dto';
import { ORDER_TYPES, SALE_PAYMENT_METHODS, type OrderType, type SalePaymentMethod } from '../../../database/database.types';

const MAX_KOBO = 100_000_000_000;

// ─── Requests ───────────────────────────────────────────────────────────────────

export class SaleItemInputDto {
  @IsUUID()
  productId!: string;

  @IsInt() @Min(1) @Max(1_000_000)
  quantity!: number;

  /** Discount on this whole line, in kobo. Cashiers need a manager's approval to discount. */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_KOBO)
  discountKobo?: number;
}

export class SalePaymentInputDto {
  @ApiProperty({
    enum: SALE_PAYMENT_METHODS,
    description:
      'cash, transfer (reference required), card (POS terminal), wallet (customer required), credit (customer required; becomes a debt), ' +
      'pay_on_delivery (delivery and pre-orders only: collected at the door or at pickup)',
  })
  @IsIn(SALE_PAYMENT_METHODS)
  method!: SalePaymentMethod;

  /** Amount applied to the sale, in kobo. */
  @IsInt() @Min(1) @Max(MAX_KOBO)
  amountKobo!: number;

  /** Cash only: what the customer handed over. Change is calculated from it. */
  @IsOptional() @IsInt() @Min(1) @Max(MAX_KOBO)
  tenderedKobo?: number;

  /** Transfer reference (required for transfers) or POS terminal slip number (optional). */
  @ValidateIf((o: SalePaymentInputDto) => o.method === 'transfer' || o.reference !== undefined)
  @IsString() @IsNotEmpty() @MaxLength(100)
  reference?: string;
}

export class SaleDeliveryInputDto {
  /** delivery (default) or pickup. Delivery orders are always delivery; pre-orders can be either. */
  @ApiPropertyOptional({ enum: ['delivery', 'pickup'] })
  @IsOptional() @IsIn(['delivery', 'pickup'])
  fulfilment?: 'delivery' | 'pickup';

  /** Required unless fulfilment is pickup. */
  @ValidateIf((o: SaleDeliveryInputDto) => o.fulfilment !== 'pickup')
  @IsString() @IsNotEmpty() @MaxLength(500)
  address?: string;

  /** Delivery or pickup date, YYYY-MM-DD. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  /** Optional at sale time; the dispatcher can assign later (DEL-02). */
  @IsOptional() @IsUUID()
  driverId?: string;
}

export class ManagerApprovalDto {
  /** The approving owner or manager. */
  @IsUUID()
  userId!: string;

  @Matches(PIN_PATTERN, { message: 'pin must be 4 to 6 digits' })
  pin!: string;
}

export class CreateSaleDto {
  /**
   * Client-generated UUIDv7. Strongly recommended: if the connection drops after submitting,
   * resubmitting with the same id returns the original sale instead of charging twice.
   */
  @IsOptional() @IsUUID()
  id?: string;

  @ApiProperty({ enum: ORDER_TYPES, description: 'Must be one of the business\'s enabled order types (POS-02).' })
  @IsIn(ORDER_TYPES)
  orderType!: OrderType;

  /** Required for credit orders and for wallet or credit payments (CUST-01). */
  @IsOptional() @IsUUID()
  customerId?: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => SaleItemInputDto)
  items!: SaleItemInputDto[];

  /** Must add up to the total exactly (POS-03). */
  @IsArray() @ArrayMaxSize(10)
  @ValidateNested({ each: true }) @Type(() => SalePaymentInputDto)
  payments!: SalePaymentInputDto[];

  /** Required for delivery orders and pre-orders. */
  @ValidateIf((o: CreateSaleDto) => o.orderType === 'delivery' || o.orderType === 'pre_order' || o.delivery !== undefined)
  @ValidateNested() @Type(() => SaleDeliveryInputDto)
  delivery?: SaleDeliveryInputDto;

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;

  /**
   * Send when the previous attempt returned 409 MANAGER_APPROVAL_REQUIRED: the manager enters
   * their PIN on this till and the sale is resubmitted with it.
   */
  @IsOptional() @ValidateNested() @Type(() => ManagerApprovalDto)
  managerApproval?: ManagerApprovalDto;

  /** When the sale happened, if recorded offline. Defaults to now. At most 72 hours ago. */
  @IsOptional() @IsISO8601()
  occurredAt?: string;
}

export class VoidSaleDto {
  /** Required: why the sale is being reversed, e.g. "Customer returned unopened pack". */
  @IsString() @IsNotEmpty() @MaxLength(300)
  reason!: string;

  /** Cashiers need a manager to approve voids. Owners and managers can void directly. */
  @IsOptional() @ValidateNested() @Type(() => ManagerApprovalDto)
  managerApproval?: ManagerApprovalDto;
}

export class ListSalesQueryDto {
  @IsOptional() @IsISO8601()
  from?: string;

  @IsOptional() @IsISO8601()
  to?: string;

  /** Owners/managers only; cashiers always see their own sales. */
  @IsOptional() @IsUUID()
  cashierId?: string;

  @IsOptional() @IsUUID()
  customerId?: string;

  @IsOptional() @IsUUID()
  registerSessionId?: string;

  @ApiPropertyOptional({ enum: ORDER_TYPES })
  @IsOptional() @IsIn(ORDER_TYPES)
  orderType?: OrderType;

  @ApiPropertyOptional({ enum: ['completed', 'voided'] })
  @IsOptional() @IsIn(['completed', 'voided'])
  status?: 'completed' | 'voided';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;
}

// ─── Responses ──────────────────────────────────────────────────────────────────

export class SaleItemDto {
  lineNo!: number;
  productId!: string;
  /** As it was at the time of sale. */
  productName!: string;
  unit!: string;
  quantity!: number;
  unitPriceKobo!: number;
  discountKobo!: number;
  lineTotalKobo!: number;
}

export class SalePaymentDto {
  @ApiProperty({ enum: SALE_PAYMENT_METHODS })
  method!: SalePaymentMethod;

  amountKobo!: number;

  @ApiProperty({ type: Number, nullable: true })
  tenderedKobo!: number | null;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;
}

export class SaleCustomerDto {
  id!: string;
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;
}

export class SaleDeliveryDto {
  deliveryId!: string;

  @ApiProperty({ enum: ['delivery', 'pickup'] })
  fulfilment!: 'delivery' | 'pickup';

  @ApiProperty({ enum: ['queued', 'assigned', 'out_for_delivery', 'delivered', 'failed', 'cancelled'] })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;

  /** YYYY-MM-DD */
  date!: string;

  @ApiProperty({ type: String, nullable: true })
  driverId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  driverName!: string | null;

  /** Amount to collect on delivery or pickup. */
  codKobo!: number;

  /**
   * Give this to the customer (it prints on the receipt). They tell it to the driver at the door,
   * which proves the delivery happened. Hidden from drivers.
   */
  @ApiProperty({ type: String, nullable: true })
  confirmationCode!: string | null;
}

export class SaleSummaryDto {
  id!: string;
  /** Sequential per business: the receipt number. */
  number!: number;

  @ApiProperty({ enum: ['completed', 'voided'] })
  status!: 'completed' | 'voided';

  @ApiProperty({ enum: ORDER_TYPES })
  orderType!: OrderType;

  totalKobo!: number;
  creditKobo!: number;
  cashierId!: string;
  cashierName!: string;

  @ApiProperty({ type: String, nullable: true })
  customerName!: string | null;

  occurredAt!: Date;
}

/** Everything a receipt needs. */
export class SaleDto extends SaleSummaryDto {
  locationId!: string;
  locationName!: string;
  registerId!: string;
  registerName!: string;
  registerSessionId!: string;

  @ApiProperty({ type: SaleCustomerDto, nullable: true })
  customer!: SaleCustomerDto | null;

  subtotalKobo!: number;
  discountKobo!: number;
  /** Everything except credit. */
  paidKobo!: number;
  changeKobo!: number;

  @ApiProperty({ type: [SaleItemDto] })
  items!: SaleItemDto[];

  @ApiProperty({ type: [SalePaymentDto] })
  payments!: SalePaymentDto[];

  @ApiProperty({ type: SaleDeliveryDto, nullable: true })
  delivery!: SaleDeliveryDto | null;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, nullable: true })
  approvedById!: string | null;

  @ApiProperty({ type: String, nullable: true })
  approvedByName!: string | null;

  /** What the manager approved, e.g. ["discount", "credit_limit"]. */
  @ApiProperty({ type: [String] })
  approvalReasons!: string[];

  createdAt!: Date;

  @ApiProperty({ type: Date, nullable: true })
  voidedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  voidReason!: string | null;
}

export class SalePageDto {
  @ApiProperty({ type: [SaleSummaryDto] })
  items!: SaleSummaryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class ManualRefundDto {
  @ApiProperty({ enum: ['transfer', 'card'] })
  method!: 'transfer' | 'card';

  amountKobo!: number;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;
}

export class VoidReversalDto {
  /** Cash taken out of the voider's till (appears in its EOD). */
  cashRefundKobo!: number;
  /** Credited back to the customer's wallet. */
  walletRefundKobo!: number;
  /** Debt cancelled. */
  debtVoidedKobo!: number;
  /** Product lines returned to stock. */
  stockLinesRestored!: number;
}

export class VoidSaleResultDto {
  sale!: SaleDto;
  reversed!: VoidReversalDto;

  /**
   * Transfer and POS/card payments the system cannot send back by itself. Refund these to the
   * customer yourself (bank app or POS terminal reversal).
   */
  @ApiProperty({ type: [ManualRefundDto] })
  manualRefunds!: ManualRefundDto[];
}
