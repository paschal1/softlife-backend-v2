import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, sql } from 'kysely';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Env } from '../../config/env';
import { SYSTEM_DB } from '../../database/database.tokens';
import type { DB } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { StorageService } from '../../storage/storage.service';
import { NotificationService } from '../notifications/notification.service';
import { AuditQueryService } from './audit-query.service';
import { csvHeader, csvLines, CSV_ROW_LIMIT, PDF_ROW_LIMIT, renderPdf } from './audit-render';
import type { AuditEntryDto, AuditFiltersDto } from './dto/audit.dto';

const KEEP_FILES_DAYS = 7;
const MAX_ATTEMPTS = 3;
/** A 'running' export older than this was abandoned by a crashed worker. */
const STALE_RUN = sql`interval '30 minutes'`;

class ExportTooLarge extends Error {}

/** Builds queued exports in the background, stores them, and tells the requester. Runs in the worker. */
@Injectable()
export class ExportRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExportRunner.name);
  private readonly pollMs: number;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    @Inject(SYSTEM_DB) private readonly db: Kysely<DB>,
    private readonly tenantDb: TenantDatabase,
    private readonly audit: AuditQueryService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationService,
    config: ConfigService<Env, true>,
  ) {
    this.pollMs = config.get('EXPORT_POLL_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
    this.logger.log('Export runner started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.expireOldFiles();
        if (!(await this.processOne())) await sleep(this.pollMs);
      } catch (err) {
        this.logger.error('Export runner iteration failed', err instanceof Error ? err.stack : String(err));
        await sleep(this.pollMs);
      }
    }
  }

  /** Claims one export (new, or abandoned by a crashed worker) and builds it. */
  async processOne(): Promise<boolean> {
    const job = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('exports')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb('status', '=', 'queued'),
            eb.and([eb('status', '=', 'running'), eb('started_at', '<', sql<Date>`now() - ${STALE_RUN}`)]),
          ]),
        )
        .orderBy('created_at')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return null;
      if (row.attempts >= MAX_ATTEMPTS) {
        await trx.updateTable('exports').set({ status: 'failed', error: 'Gave up after repeated failures', finished_at: sql`now()` }).where('id', '=', row.id).execute();
        return null;
      }
      await trx.updateTable('exports').set({ status: 'running', started_at: sql`now()`, attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
      return row;
    });
    if (!job) return false;

    try {
      const built = await this.build(job.organization_id, job.format, job.filters as AuditFiltersDto, job.requested_by);
      const key = StorageService.keyFor(job.organization_id, 'exports', `${job.id}.${job.format}`);
      const stored = await this.storage.put(key, built.body, job.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf');

      await this.db
        .updateTable('exports')
        .set({
          status: 'done',
          file_key: stored.key,
          file_size: stored.size,
          row_count: built.rows,
          finished_at: sql`now()`,
          expires_at: sql`now() + make_interval(days => ${KEEP_FILES_DAYS})`,
          error: null,
        })
        .where('id', '=', job.id)
        .execute();

      await this.tenantDb.forOrganization(job.organization_id, (trx) =>
        this.notifications.create(trx, {
          organizationId: job.organization_id,
          userIds: [job.requested_by],
          draft: {
            kind: 'export_ready',
            severity: 'info',
            title: `Your audit log ${job.format.toUpperCase()} is ready`,
            body: `${built.rows.toLocaleString('en-NG')} entries. Download it within ${KEEP_FILES_DAYS} days.`,
            data: { exportId: job.id },
          },
          sourceKey: `export:${job.id}`,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const final = err instanceof ExportTooLarge || job.attempts + 1 >= MAX_ATTEMPTS;
      this.logger.warn(`Export ${job.id} failed: ${message}`);
      await this.db
        .updateTable('exports')
        .set(final ? { status: 'failed', error: message, finished_at: sql`now()` } : { status: 'queued', error: message })
        .where('id', '=', job.id)
        .execute();
    }
    return true;
  }

  private async build(organizationId: string, format: 'csv' | 'pdf', filters: AuditFiltersDto, requestedBy: string) {
    return this.tenantDb.forOrganization(organizationId, async (trx) => {
      const org = await trx.selectFrom('organizations').select(['name', 'timezone']).executeTakeFirstOrThrow();
      const limit = format === 'csv' ? CSV_ROW_LIMIT : PDF_ROW_LIMIT;

      if (format === 'csv') {
        const parts: string[] = [csvHeader()];
        let rows = 0;
        for await (const batch of this.audit.all(trx, filters)) {
          rows += batch.length;
          if (rows > limit) throw new ExportTooLarge(`More than ${limit.toLocaleString('en-NG')} entries match. Narrow the dates or filters.`);
          parts.push(csvLines(batch, org.timezone));
        }
        return { body: Buffer.from(parts.join(''), 'utf8'), rows };
      }

      const entries: AuditEntryDto[] = [];
      for await (const batch of this.audit.all(trx, filters)) {
        entries.push(...batch);
        if (entries.length > limit) {
          throw new ExportTooLarge(`PDF exports are limited to ${limit.toLocaleString('en-NG')} entries. Use CSV, or narrow the dates or filters.`);
        }
      }
      const requester = await trx.selectFrom('users').select('full_name').where('id', '=', requestedBy).executeTakeFirst();
      const body = await renderPdf(entries, {
        businessName: org.name,
        timezone: org.timezone,
        filtersText: describeFilters(filters),
        generatedAt: new Date(),
        generatedBy: requester?.full_name ?? 'unknown',
      });
      return { body, rows: entries.length };
    });
  }

  /** Deletes files past their expiry. The export record itself is kept. */
  private async expireOldFiles(): Promise<void> {
    const expired = await this.db
      .selectFrom('exports')
      .select(['id', 'file_key'])
      .where('status', '=', 'done')
      .where('expires_at', '<', sql<Date>`now()`)
      .limit(20)
      .execute();
    for (const e of expired) {
      if (e.file_key) await this.storage.delete(e.file_key).catch(() => undefined);
      await this.db.updateTable('exports').set({ status: 'expired' }).where('id', '=', e.id).execute();
    }
  }
}

function describeFilters(f: AuditFiltersDto): string {
  const parts = [
    f.from ? `from ${f.from.slice(0, 10)}` : 'from the beginning',
    f.to ? `to ${f.to.slice(0, 10)}` : 'to now',
    f.action ? `action ${f.action}` : '',
    f.entityType ? `${f.entityType} records` : '',
    f.q ? `matching "${f.q}"` : '',
  ];
  return parts.filter(Boolean).join(', ');
}
