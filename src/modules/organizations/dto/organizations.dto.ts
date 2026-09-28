import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import { ORDER_TYPES, type OrderType } from '../../../database/database.types';

export const CREDIT_LIMIT_MODES = ['soft', 'hard'] as const;
export type CreditLimitMode = (typeof CREDIT_LIMIT_MODES)[number];

export class OrganizationDto {
  id!: string;
  name!: string;
  countryCode!: string;
  currency!: string;
  timezone!: string;
  enabledModules!: string[];
  status!: string;
  /** EOD variances above this, over or short, raise an alert. In kobo. */
  eodVarianceAlertKobo!: number;

  /** soft: warn and require a manager PIN to exceed a credit limit. hard: block the sale. */
  @ApiProperty({ enum: CREDIT_LIMIT_MODES })
  creditLimitMode!: CreditLimitMode;

  /** Applies to customers without their own limit. Null = unlimited. In kobo. */
  @ApiProperty({ type: Number, nullable: true })
  defaultCreditLimitKobo!: number | null;

  /** Order types this business's tills offer (POS-02). */
  @ApiProperty({ enum: ORDER_TYPES, isArray: true })
  enabledOrderTypes!: OrderType[];

  /** Local hour (0–23) the daily digest is sent. */
  dailyDigestHour!: number;

  createdAt!: Date;
}

/** Send only the settings to change. */
export class UpdateOrganizationSettingsDto {
  /** EOD variance alert threshold in kobo (₦1,000 = 100000). 0 flags any variance. */
  @ValidateIf((o: UpdateOrganizationSettingsDto) => o.eodVarianceAlertKobo !== undefined)
  @IsInt() @Min(0) @Max(100_000_000_000)
  eodVarianceAlertKobo?: number;

  @ApiProperty({ enum: CREDIT_LIMIT_MODES, required: false })
  @ValidateIf((o: UpdateOrganizationSettingsDto) => o.creditLimitMode !== undefined)
  @IsIn(CREDIT_LIMIT_MODES)
  creditLimitMode?: CreditLimitMode;

  /** Null to remove the default (unlimited). */
  @ApiProperty({ type: Number, nullable: true, required: false })
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000_000)
  defaultCreditLimitKobo?: number | null;

  /** Which order types tills offer. At least one. */
  @ApiProperty({ enum: ORDER_TYPES, isArray: true, required: false })
  @ValidateIf((o: UpdateOrganizationSettingsDto) => o.enabledOrderTypes !== undefined)
  @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsIn(ORDER_TYPES, { each: true })
  enabledOrderTypes?: OrderType[];

  /** Local hour (0–23) to send the daily digest, e.g. 20 for 8pm. */
  @ValidateIf((o: UpdateOrganizationSettingsDto) => o.dailyDigestHour !== undefined)
  @IsInt() @Min(0) @Max(23)
  dailyDigestHour?: number;
}
