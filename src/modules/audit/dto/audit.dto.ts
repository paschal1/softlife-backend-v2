import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

/** Shared by the viewer and exports. */
export class AuditFiltersDto {
  @IsOptional() @IsISO8601()
  from?: string;

  @IsOptional() @IsISO8601()
  to?: string;

  /** Who did it. */
  @IsOptional() @IsUUID()
  actorId?: string;

  /** Exact type ("sale.voided") or a whole area with * ("sale.*", "wallet.*"). */
  @IsOptional() @Matches(/^[a-z_]+(\.([a-z_]+|\*))?$/, { message: 'action must look like "sale.voided" or "sale.*"' })
  action?: string;

  /** e.g. sale, product, customer, register_session, delivery, user. */
  @IsOptional() @Matches(/^[a-z_]+$/)
  entityType?: string;

  /** Everything that ever happened to one record, e.g. a product's full price history. */
  @IsOptional() @IsUUID()
  entityId?: string;

  @IsOptional() @IsUUID()
  locationId?: string;

  /** Free text inside the recorded details, e.g. a reason, reference or amount. */
  @IsOptional() @IsString() @MaxLength(100)
  q?: string;
}

export class AuditQueryDto extends AuditFiltersDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;
}

export class AuditEntryDto {
  id!: string;
  occurredAt!: Date;
  recordedAt!: Date;
  /** e.g. "sale.voided" */
  actionType!: string;
  entityType!: string;
  entityId!: string;

  /** Product, customer or staff name when the entry is about one. */
  @ApiProperty({ type: String, nullable: true })
  entityName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  actorId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  actorName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locationName!: string | null;

  /** One readable sentence, e.g. "Changed Pure Water: price ₦300.00 → ₦350.00". */
  summary!: string;

  @ApiProperty({ type: Object, nullable: true })
  before!: unknown;

  @ApiProperty({ type: Object, nullable: true })
  after!: unknown;
}

export class AuditPageDto {
  @ApiProperty({ type: [AuditEntryDto] })
  items!: AuditEntryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class CreateExportDto extends AuditFiltersDto {
  @ApiProperty({ enum: ['csv', 'pdf'], description: 'CSV for spreadsheets (up to 200,000 rows); PDF for printing and sharing (up to 5,000 rows).' })
  @IsIn(['csv', 'pdf'])
  format!: 'csv' | 'pdf';
}

export class ExportDto {
  id!: string;

  @ApiProperty({ enum: ['audit_log'] })
  kind!: 'audit_log';

  @ApiProperty({ enum: ['csv', 'pdf'] })
  format!: 'csv' | 'pdf';

  @ApiProperty({ enum: ['queued', 'running', 'done', 'failed', 'expired'] })
  status!: 'queued' | 'running' | 'done' | 'failed' | 'expired';

  @ApiProperty({ type: Object })
  filters!: unknown;

  @ApiProperty({ type: Number, nullable: true })
  rowCount!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  fileSize!: number | null;

  @ApiProperty({ type: String, nullable: true })
  error!: string | null;

  requestedById!: string;
  requestedByName!: string;
  createdAt!: Date;

  @ApiProperty({ type: Date, nullable: true })
  finishedAt!: Date | null;

  /** The file is deleted after this. */
  @ApiProperty({ type: Date, nullable: true })
  expiresAt!: Date | null;

  /** Present when done: valid for 15 minutes. Fetch the export again for a fresh one. */
  @ApiPropertyOptional({ type: String, nullable: true })
  downloadUrl!: string | null;
}
