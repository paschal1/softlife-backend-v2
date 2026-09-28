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
  Max,
  MaxLength,
  Min,
  NotEquals,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { STOCK_MOVEMENT_TYPES, type StockMovementType } from '../../../database/database.types';

const MAX_QTY = 1_000_000;

// ─── Receive stock ──────────────────────────────────────────────────────────────

export class ReceiveItemDto {
  @IsUUID()
  productId!: string;

  /** Units received (in the product's unit: bags, packs, bottles...). */
  @IsInt() @Min(1) @Max(MAX_QTY)
  quantity!: number;

  /** What each unit cost, in kobo. Recorded on the movement for margin reporting. */
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000_000)
  unitCostKobo?: number;
}

export class ReceiveStockDto {
  /** Optional client-generated UUIDv7: resubmitting the same id is a safe no-op. */
  @IsOptional() @IsUUID()
  id?: string;

  @IsUUID()
  locationId!: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => ReceiveItemDto)
  items!: ReceiveItemDto[];

  @IsOptional() @IsString() @MaxLength(120)
  supplierName?: string;

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

// ─── Adjust stock ───────────────────────────────────────────────────────────────

export const ADJUSTMENT_KINDS = ['wastage', 'correction', 'stock_count'] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

export class AdjustStockDto {
  @IsOptional() @IsUUID()
  id?: string;

  @IsUUID()
  locationId!: string;

  @IsUUID()
  productId!: string;

  @ApiProperty({
    enum: ADJUSTMENT_KINDS,
    description:
      'wastage: remove `quantity` damaged/expired/burst units. ' +
      'correction: add or remove `quantityDelta` (signed) to fix a known error. ' +
      'stock_count: set stock to `countedQuantity` after a physical count; the difference is recorded.',
  })
  @IsIn(ADJUSTMENT_KINDS)
  kind!: AdjustmentKind;

  /** Required for wastage. Positive number of units removed. */
  @ValidateIf((o: AdjustStockDto) => o.kind === 'wastage')
  @IsInt() @Min(1) @Max(MAX_QTY)
  quantity?: number;

  /** Required for correction. Signed, non-zero. */
  @ValidateIf((o: AdjustStockDto) => o.kind === 'correction')
  @IsInt() @NotEquals(0) @Min(-MAX_QTY) @Max(MAX_QTY)
  quantityDelta?: number;

  /** Required for stock_count. What is physically on the shelf. */
  @ValidateIf((o: AdjustStockDto) => o.kind === 'stock_count')
  @IsInt() @Min(0) @Max(MAX_QTY)
  countedQuantity?: number;

  /** Required. e.g. "20 sachets burst in transit", "Monthly stock count". */
  @IsString() @IsNotEmpty() @MaxLength(300)
  reason!: string;
}

// ─── Transfer stock ─────────────────────────────────────────────────────────────

export class TransferItemDto {
  @IsUUID()
  productId!: string;

  @IsInt() @Min(1) @Max(MAX_QTY)
  quantity!: number;
}

export class TransferStockDto {
  @IsOptional() @IsUUID()
  id?: string;

  @IsUUID()
  fromLocationId!: string;

  @IsUUID()
  toLocationId!: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => TransferItemDto)
  items!: TransferItemDto[];

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

// ─── Queries ────────────────────────────────────────────────────────────────────

export class StockLevelsQueryDto {
  /** One branch. Omit for totals across all branches (owner's combined view). */
  @IsOptional() @IsUUID()
  locationId?: string;

  /** Only products at or below their reorder level. */
  @IsOptional() @IsIn(['true', 'false'])
  lowStockOnly?: 'true' | 'false';

  @IsOptional() @IsString() @MaxLength(100)
  search?: string;
}

export class StockMovementsQueryDto {
  @IsOptional() @IsUUID()
  productId?: string;

  @IsOptional() @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ enum: STOCK_MOVEMENT_TYPES })
  @IsOptional() @IsIn(STOCK_MOVEMENT_TYPES)
  type?: StockMovementType;

  @IsOptional() @IsISO8601()
  from?: string;

  @IsOptional() @IsISO8601()
  to?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;
}

// ─── Responses ──────────────────────────────────────────────────────────────────

export class StockOperationItemDto {
  productId!: string;
  productName!: string;
  unit!: string;
  locationId!: string;

  @ApiProperty({ enum: STOCK_MOVEMENT_TYPES })
  type!: StockMovementType;

  /** Signed change. 0 when a stock count matched the records. */
  quantityDelta!: number;
  /** Stock at this branch after the operation (current stock, for a replayed request). */
  quantityAfter!: number;
}

export class StockOperationResultDto {
  batchId!: string;
  /** True when this id was already processed and nothing new was recorded. */
  replayed!: boolean;

  @ApiProperty({ type: [StockOperationItemDto] })
  items!: StockOperationItemDto[];
}

export class StockLevelDto {
  productId!: string;
  productName!: string;
  unit!: string;

  @ApiProperty({ type: String, nullable: true })
  category!: string | null;

  /** Null in the all-branches view. */
  @ApiProperty({ type: String, nullable: true })
  locationId!: string | null;

  quantity!: number;

  @ApiProperty({ type: Number, nullable: true })
  reorderLevel!: number | null;

  /** At or below the reorder level. */
  isLow!: boolean;
}

export class StockMovementDto {
  id!: string;
  batchId!: string;
  productId!: string;
  productName!: string;
  locationId!: string;
  locationName!: string;

  @ApiProperty({ enum: STOCK_MOVEMENT_TYPES })
  type!: StockMovementType;

  quantityDelta!: number;

  @ApiProperty({ type: Number, nullable: true })
  unitCostKobo!: number | null;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  referenceType!: string | null;

  @ApiProperty({ type: String, nullable: true })
  referenceId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  createdById!: string | null;

  @ApiProperty({ type: String, nullable: true })
  createdByName!: string | null;

  createdAt!: Date;
}

export class StockMovementPageDto {
  @ApiProperty({ type: [StockMovementDto] })
  items!: StockMovementDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
