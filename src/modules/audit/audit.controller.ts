import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { TenantDatabase } from '../../database/tenant-database.service';
import { AuditQueryService } from './audit-query.service';
import { AuditEntryDto, AuditPageDto, AuditQueryDto, CreateExportDto, ExportDto } from './dto/audit.dto';
import { ExportsService } from './exports.service';

@ApiTags('Audit log')
@ApiBearerAuth()
@Roles('owner', 'manager')
@Controller('audit-log')
export class AuditController {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly audit: AuditQueryService,
    private readonly exports: ExportsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Browse the audit log (AUD-02)',
    description:
      'Newest first. Filter by date, staff, action ("sale.voided" or "sale.*"), record type, one record\'s full history (entityId), branch, or text. ' +
      'Each entry has a readable summary plus the exact before/after values.',
  })
  @ApiOkResponse({ type: AuditPageDto })
  list(@Query() query: AuditQueryDto): Promise<AuditPageDto> {
    const { limit, cursor, ...filters } = query;
    this.audit.validate(filters);
    return this.tenantDb.transaction((trx) => this.audit.page(trx, filters, limit ?? 50, cursor));
  }

  @Post('exports')
  @ApiOperation({
    summary: 'Export the audit log (AUD-02)',
    description: 'Prepared in the background: you get a notification when it is ready. Poll GET /audit-log/exports/:id for the download link. Exports are themselves recorded in the audit log.',
  })
  @ApiCreatedResponse({ type: ExportDto })
  export(@CurrentUser() auth: AuthContext, @Body() dto: CreateExportDto): Promise<ExportDto> {
    return this.exports.request(auth, dto);
  }

  @Get('exports')
  @ApiOperation({ summary: 'Recent exports' })
  @ApiOkResponse({ type: [ExportDto] })
  listExports(): Promise<ExportDto[]> {
    return this.exports.list();
  }

  @Get('exports/:id')
  @ApiOperation({ summary: 'Export status and download link', description: 'When done, downloadUrl is valid for 15 minutes; call again for a fresh one. Files are kept 7 days.' })
  @ApiOkResponse({ type: ExportDto })
  getExport(@Param('id', ParseUUIDPipe) id: string): Promise<ExportDto> {
    return this.exports.get(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One audit entry with its full before/after detail' })
  @ApiOkResponse({ type: AuditEntryDto })
  one(@Param('id', ParseUUIDPipe) id: string): Promise<AuditEntryDto> {
    return this.tenantDb.transaction((trx) => this.audit.one(trx, id));
  }
}
