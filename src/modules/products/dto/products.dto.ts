import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const MAX_PRICE_KOBO = 100_000_000_000; // ₦1 billion per unit

export class OpeningStockDto {
  @IsUUID()
  locationId!: string;

  @IsInt() @Min(1) @Max(1_000_000)
  quantity!: number;
}

export class CreateProductDto {
  /** Optional client-generated UUIDv7: resubmitting returns the existing product. */
  @IsOptional() @IsUUID()
  id?: string;

  /** e.g. "Pure Water (Bag of 20 sachets)" */
  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60)
  sku?: string;

  /** Scanned code. Unique within the business. */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60)
  barcode?: string;

  /** For browsing on the POS, e.g. "Water", "Drinks", "Toiletries". */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60)
  category?: string;

  /** What one unit is: bag, pack, bottle, crate, piece... Defaults to "piece". */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(30)
  unit?: string;

  /** Retail price per unit, in kobo. */
  @IsInt() @Min(0) @Max(MAX_PRICE_KOBO)
  sellingPriceKobo!: number;

  /** Price for wholesale orders/customers, in kobo. */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_PRICE_KOBO)
  wholesalePriceKobo?: number;

  /** What one unit costs you, in kobo. Hidden from cashiers and drivers. */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_PRICE_KOBO)
  costPriceKobo?: number;

  /** False for services or items you don't count (e.g. "Delivery fee"). Cannot be changed later. */
  @IsOptional() @IsBoolean()
  tracksStock?: boolean;

  /** Alert when stock at a branch falls to this level. */
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000)
  reorderLevel?: number;

  /** Stock already on the shelf when the product is added, per branch. */
  @IsOptional() @IsArray() @ArrayMaxSize(50)
  @ValidateNested({ each: true }) @Type(() => OpeningStockDto)
  openingStock?: OpeningStockDto[];
}

/**
 * Send only the fields to change. Fields that may be cleared (sku, barcode, category,
 * wholesalePriceKobo, reorderLevel) accept null to clear them.
 */
export class UpdateProductDto {
  @ValidateIf((o: UpdateProductDto) => o.name !== undefined)
  @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60)
  sku?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60)
  barcode?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60)
  category?: string | null;

  @ValidateIf((o: UpdateProductDto) => o.unit !== undefined)
  @IsString() @IsNotEmpty() @MaxLength(30)
  unit?: string;

  @ValidateIf((o: UpdateProductDto) => o.sellingPriceKobo !== undefined)
  @IsInt() @Min(0) @Max(MAX_PRICE_KOBO)
  sellingPriceKobo?: number;

  @ApiProperty({ type: Number, nullable: true, required: false })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_PRICE_KOBO)
  wholesalePriceKobo?: number | null;

  @ValidateIf((o: UpdateProductDto) => o.costPriceKobo !== undefined)
  @IsInt() @Min(0) @Max(MAX_PRICE_KOBO)
  costPriceKobo?: number;

  @ApiProperty({ type: Number, nullable: true, required: false })
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000)
  reorderLevel?: number | null;

  /** Deactivated products disappear from the POS but stay in history and reports. */
  @ValidateIf((o: UpdateProductDto) => o.isActive !== undefined)
  @IsBoolean()
  isActive?: boolean;
}

export class ListProductsQueryDto {
  /** Matches name or SKU (contains), or barcode (exact). */
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  /** Exact barcode match, for scanners. */
  @IsOptional() @IsString() @MaxLength(60)
  barcode?: string;

  @IsOptional() @IsString() @MaxLength(60)
  category?: string;

  /** Include stock on hand at this branch (the POS passes its own branch). */
  @IsOptional() @IsUUID()
  locationId?: string;

  @IsOptional() @IsIn(['true', 'false'])
  includeInactive?: 'true' | 'false';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @IsString() @MaxLength(300)
  cursor?: string;
}

// ─── Responses ──────────────────────────────────────────────────────────────────

export class ProductDto {
  id!: string;
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  sku!: string | null;

  @ApiProperty({ type: String, nullable: true })
  barcode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  category!: string | null;

  unit!: string;
  sellingPriceKobo!: number;

  @ApiProperty({ type: Number, nullable: true })
  wholesalePriceKobo!: number | null;

  /** Null for cashiers and drivers. */
  @ApiProperty({ type: Number, nullable: true })
  costPriceKobo!: number | null;

  tracksStock!: boolean;

  @ApiProperty({ type: Number, nullable: true })
  reorderLevel!: number | null;

  isActive!: boolean;
  createdAt!: Date;
  updatedAt!: Date;

  /** Stock at the requested locationId; null when no locationId was given or stock isn't tracked. */
  @ApiProperty({ type: Number, nullable: true })
  stockQuantity!: number | null;
}

export class ProductStockAtLocationDto {
  locationId!: string;
  locationName!: string;
  quantity!: number;
}

export class ProductDetailDto extends ProductDto {
  @ApiProperty({ type: [ProductStockAtLocationDto] })
  stockByLocation!: ProductStockAtLocationDto[];
}

export class ProductPageDto {
  @ApiProperty({ type: [ProductDto] })
  items!: ProductDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
