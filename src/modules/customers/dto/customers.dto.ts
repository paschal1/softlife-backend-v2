import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { PHONE_PATTERN } from '../../../auth/dto/auth.dto';
import { CUSTOMER_TYPES, type CustomerType } from '../../../database/database.types';

const MAX_KOBO = 100_000_000_000;

export class CreateCustomerDto {
  /** Optional client-generated UUIDv7: resubmitting returns the existing customer. */
  @IsOptional() @IsUUID()
  id?: string;

  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string;

  /** Any Nigerian format; stored as +234... Unique per business. */
  @IsOptional() @Matches(PHONE_PATTERN, { message: 'phone must be a valid phone number' })
  phone?: string;

  @IsOptional() @IsEmail() @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ enum: CUSTOMER_TYPES, description: 'Only owners and managers can set a type other than retail.' })
  @IsOptional() @IsIn(CUSTOMER_TYPES)
  type?: CustomerType;

  /** Delivery address, landmarks welcome. */
  @IsOptional() @IsString() @MaxLength(500)
  address?: string;

  /** Owner only. Kobo. Omit to use the business default. */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_KOBO)
  creditLimitKobo?: number;

  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string;
}

/** Send only fields to change. Nullable fields accept null to clear them. */
export class UpdateCustomerDto {
  @ValidateIf((o: UpdateCustomerDto) => o.name !== undefined)
  @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional() @Matches(PHONE_PATTERN, { message: 'phone must be a valid phone number' })
  phone?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional() @IsEmail() @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({ enum: CUSTOMER_TYPES, description: 'Owners and managers only.' })
  @ValidateIf((o: UpdateCustomerDto) => o.type !== undefined)
  @IsIn(CUSTOMER_TYPES)
  type?: CustomerType;

  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional() @IsString() @MaxLength(500)
  address?: string | null;

  /** Owner only. Null to fall back to the business default. */
  @ApiProperty({ type: Number, nullable: true, required: false })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_KOBO)
  creditLimitKobo?: number | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string | null;

  /** Owners and managers only. Deactivated customers can't be sold to on credit or charged from their wallet. */
  @ValidateIf((o: UpdateCustomerDto) => o.isActive !== undefined)
  @IsBoolean()
  isActive?: boolean;
}

export class ListCustomersQueryDto {
  /** Name (contains) or phone number (any format). */
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: CUSTOMER_TYPES })
  @IsOptional() @IsIn(CUSTOMER_TYPES)
  type?: CustomerType;

  @IsOptional() @IsIn(['true', 'false'])
  includeInactive?: 'true' | 'false';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @IsString() @MaxLength(300)
  cursor?: string;
}

export class CustomerDto {
  id!: string;
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ enum: CUSTOMER_TYPES })
  type!: CustomerType;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;

  /** This customer's own limit, if set. */
  @ApiProperty({ type: Number, nullable: true })
  creditLimitKobo!: number | null;

  /** The limit that actually applies: own limit, else the business default. Null = unlimited. */
  @ApiProperty({ type: Number, nullable: true })
  effectiveCreditLimitKobo!: number | null;

  /** Shown at checkout (WAL-02). */
  walletBalanceKobo!: number;

  /** Total unpaid credit (DEBT-01). */
  outstandingDebtKobo!: number;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  isActive!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
}

export class CustomerPageDto {
  @ApiProperty({ type: [CustomerDto] })
  items!: CustomerDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
