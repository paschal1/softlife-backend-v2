import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Transaction } from 'kysely';
import type { AuthContext } from '../../auth/auth.types';
import { uuidv7 } from '../../common/ids/uuidv7';
import type { DB } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import { StorageService } from '../../storage/storage.service';
import { AuditQueryService } from './audit-query.service';
import type { CreateExportDto, ExportDto } from './dto/audit.dto';

/** At most this many exports waiting or running per business, so one click-happy user can't flood the worker. */
const MAX_ACTIVE_EXPORTS = 3;

@Injectable()
export class ExportsService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly audit: AuditQueryService,
    private readonly storage: StorageService,
    private readonly events: EventPublisher,
  ) {}

  /** AUD-02: queues an export; the worker builds it and notifies the requester when ready. */
  async request(auth: AuthContext, dto: CreateExportDto): Promise<ExportDto> {
    const { format, ...filters } = dto;
    this.audit.validate(filters);

    return this.tenantDb.transaction(async (trx) => {
      const active = await trx
        .selectFrom('exports')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirstOrThrow();
      if (Number(active.n) >= MAX_ACTIVE_EXPORTS) {
        throw new BadRequestException('Several exports are already being prepared. Please wait for them to finish.');
      }

      const id = uuidv7();
      await trx
        .insertInto('exports')
        .values({ id, organization_id: auth.organizationId, kind: 'audit_log', format, filters: JSON.stringify(filters), requested_by: auth.userId })
        .execute();

      // Pulling the audit log is itself an auditable act.
      await this.events.record(trx, {
        type: EventTypes.AuditExported,
        aggregateType: 'export',
        aggregateId: id,
        payload: { format, filters: { ...filters } },
      });
      return this.load(trx, id);
    });
  }

  async list(): Promise<ExportDto[]> {
    return this.tenantDb.transaction(async (trx) => {
      const rows = await trx.selectFrom('exports').select('id').orderBy('created_at', 'desc').limit(50).execute();
      return Promise.all(rows.map((r) => this.load(trx, r.id)));
    });
  }

  async get(id: string): Promise<ExportDto> {
    return this.tenantDb.transaction((trx) => this.load(trx, id));
  }

  private async load(trx: Transaction<DB>, id: string): Promise<ExportDto> {
    const e = await trx
      .selectFrom('exports as e')
      .innerJoin('users as u', 'u.id', 'e.requested_by')
      .selectAll('e')
      .select('u.full_name as requested_by_name')
      .where('e.id', '=', id)
      .executeTakeFirst();
    if (!e) throw new NotFoundException('Export not found');

    const ready = e.status === 'done' && e.file_key && e.expires_at && e.expires_at > new Date();
    const link = ready ? await this.storage.downloadUrl(e.file_key!, `audit-log-${e.created_at.toISOString().slice(0, 10)}.${e.format}`) : null;

    return {
      id: e.id,
      kind: e.kind,
      format: e.format,
      status: e.status === 'done' && !ready ? 'expired' : e.status,
      filters: e.filters,
      rowCount: e.row_count,
      fileSize: e.file_size,
      error: e.error,
      requestedById: e.requested_by,
      requestedByName: e.requested_by_name,
      createdAt: e.created_at,
      finishedAt: e.finished_at,
      expiresAt: e.expires_at,
      downloadUrl: link?.url ?? null,
    };
  }
}
