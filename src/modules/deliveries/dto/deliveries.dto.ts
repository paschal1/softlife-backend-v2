import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
import { COLLECTION_METHODS, DELIVERY_STATUSES, type CollectionMethod, type DeliveryStatus, type Fulfilment } from '../../../database/database.types';

const MAX_KOBO = 100_000_000_000;

// ─── Requests ───────────────────────────────────────────────────────────────────

export class ListDeliveriesQueryDto {
  /** Default: everything still open (queued, assigned, out for delivery, failed). */
  @ApiPropertyOptional({ enum: [...DELIVERY_STATUSES, 'open', 'all'] })
  @IsOptional() @IsIn([...DELIVERY_STATUSES, 'open', 'all'])
  status?: DeliveryStatus | 'open' | 'all';

  /** Scheduled for this day, YYYY-MM-DD. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  /** Owners/managers only; drivers always see their own. */
  @IsOptional() @IsUUID()
  driverId?: string;

  @IsOptional() @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ enum: ['delivery', 'pickup'] })
  @IsOptional() @IsIn(['delivery', 'pickup'])
  fulfilment?: Fulfilment;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @IsString() @MaxLength(300)
  cursor?: string;
}

export class AssignDeliveryDto {
  /** A user with the driver role. */
  @IsUUID()
  driverId!: string;

  /** When the driver should arrive (DEL-02). */
  @IsOptional() @IsISO8601()
  expectedAt?: string;
}

export class FailDeliveryDto {
  /** e.g. "Customer not home", "Customer could not pay", "Wrong address". */
  @IsString() @IsNotEmpty() @MaxLength(300)
  reason!: string;
}

export class CollectionInputDto {
  @ApiProperty({ enum: COLLECTION_METHODS })
  @IsIn(COLLECTION_METHODS)
  method!: CollectionMethod;

  @IsInt() @Min(1) @Max(MAX_KOBO)
  amountKobo!: number;

  /** Required for transfers; POS slip number for card. */
  @ValidateIf((o: CollectionInputDto) => o.method === 'transfer' || o.reference !== undefined)
  @IsString() @IsNotEmpty() @MaxLength(100)
  reference?: string;
}

export class ReturnInputDto {
  /** e.g. the "Empty 19L Bottle" product, or goods the customer refused. */
  @IsUUID()
  productId!: string;

  @IsInt() @Min(1) @Max(100_000)
  quantity!: number;

  @IsOptional() @IsString() @MaxLength(200)
  note?: string;
}

export class ConfirmDeliveryDto {
  /** The 4-digit code from the customer's receipt. Preferred proof. */
  @IsOptional() @Matches(/^\d{4}$/, { message: 'code must be 4 digits' })
  code?: string;

  /**
   * Owners/managers only, when the customer can't produce the code: who received the goods.
   * Drivers must use the code.
   */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  receivedByName?: string;

  /** Money taken at the door. Must equal the amount due exactly. */
  @IsOptional() @IsArray() @ArrayMaxSize(5)
  @ValidateNested({ each: true }) @Type(() => CollectionInputDto)
  collections?: CollectionInputDto[];

  /**
   * Optional signature captured on the driver's phone (DEL-03): a PNG, base64-encoded, up to ~500 KB.
   * Extra evidence alongside the code; it does not replace it.
   */
  @IsOptional() @IsString() @MaxLength(700_000)
  signaturePngBase64?: string;

  /** Empties or rejected goods brought back (DEL-03). They go back into stock at the branch. */
  @IsOptional() @IsArray() @ArrayMaxSize(50)
  @ValidateNested({ each: true }) @Type(() => ReturnInputDto)
  returns?: ReturnInputDto[];
}

export class RemitCashDto {
  /** Optional client-generated UUIDv7 for safe retries. */
  @IsOptional() @IsUUID()
  id?: string;

  /** Whose cash is being handed in (usually a driver). */
  @IsUUID()
  driverId!: string;

  /** Cash actually counted at the till, in kobo. */
  @IsInt() @Min(0) @Max(MAX_KOBO)
  countedKobo!: number;

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

// ─── Responses ──────────────────────────────────────────────────────────────────

export class DeliveryItemDto {
  productName!: string;
  quantity!: number;
  unit!: string;
}

export class DeliveryCustomerDto {
  id!: string;
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;
}

export class DeliveryCollectionDto {
  @ApiProperty({ enum: COLLECTION_METHODS })
  method!: CollectionMethod;

  amountKobo!: number;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;

  collectedByName!: string;
  collectedAt!: Date;
  remitted!: boolean;
}

export class DeliveryReturnDto {
  productId!: string;
  productName!: string;
  quantity!: number;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;
}

export class DeliveryDto {
  id!: string;
  saleId!: string;
  saleNumber!: number;

  @ApiProperty({ enum: DELIVERY_STATUSES })
  status!: DeliveryStatus;

  @ApiProperty({ enum: ['delivery', 'pickup'] })
  fulfilment!: Fulfilment;

  locationId!: string;
  locationName!: string;

  @ApiProperty({ type: DeliveryCustomerDto, nullable: true })
  customer!: DeliveryCustomerDto | null;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;

  /** YYYY-MM-DD */
  scheduledDate!: string;

  @ApiProperty({ type: String, nullable: true })
  driverId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  driverName!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  expectedAt!: Date | null;

  /** To collect at the door (pay on delivery / balance on pickup). */
  codKobo!: number;
  collectedKobo!: number;

  /** Hidden from drivers: the customer gives it to them at the door. */
  @ApiProperty({ type: String, nullable: true })
  confirmationCode!: string | null;

  /** Failed attempts so far. */
  attempts!: number;

  @ApiProperty({ type: String, nullable: true })
  failureReason!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  deliveredAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  deliveredByName!: string | null;

  @ApiProperty({ enum: ['code', 'recipient_name'], nullable: true })
  proofMethod!: 'code' | 'recipient_name' | null;

  @ApiProperty({ type: String, nullable: true })
  receivedByName!: string | null;

  /** A signature was captured at the door (GET /deliveries/:id/signature for a link to it). */
  hasSignature!: boolean;

  /** What to load on the bike or truck. */
  @ApiProperty({ type: [DeliveryItemDto] })
  items!: DeliveryItemDto[];

  @ApiProperty({ type: [DeliveryCollectionDto] })
  collections!: DeliveryCollectionDto[];

  @ApiProperty({ type: [DeliveryReturnDto] })
  returns!: DeliveryReturnDto[];

  createdAt!: Date;
}

export class DeliveryPageDto {
  @ApiProperty({ type: [DeliveryDto] })
  items!: DeliveryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class DriverCashDto {
  userId!: string;
  name!: string;
  /** Cash collected at doors and not yet handed in at a till. */
  unremittedKobo!: number;
  collections!: number;

  @ApiProperty({ type: Date, nullable: true })
  oldestCollectedAt!: Date | null;
}

export class RemittanceDto {
  id!: string;
  driverId!: string;
  driverName!: string;
  expectedKobo!: number;
  countedKobo!: number;
  /** counted − expected. Negative = the driver handed in less than they collected. */
  varianceKobo!: number;
  varianceFlagged!: boolean;
  registerSessionId!: string;
  receivedById!: string;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  collectionsSettled!: number;
  createdAt!: Date;
}

export class SignatureLinkDto {
  /** Valid for 15 minutes. */
  url!: string;
  expiresAt!: Date;
}
