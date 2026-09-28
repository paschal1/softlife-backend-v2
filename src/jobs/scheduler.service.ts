import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, sql } from 'kysely';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Env } from '../config/env';
import { SYSTEM_DB } from '../database/database.tokens';
import type { DB } from '../database/database.types';
import { TenantDatabase } from '../database/tenant-database.service';
import { DailySummaryService } from '../modules/insights/daily-summary.service';
import { formatDigest } from '../modules/insights/digest-format';
import { ageInDays, bucketFor } from '../modules/debts/aging';
import { formatAmount } from '../modules/receipts/receipt-format';
import { NotificationService } from '../modules/notifications/notification.service';
import { localParts } from './local-time';

/** Local hour when overdue-debt alerts go out: start of the business day. */
const OVERDUE_ALERT_HOUR = 9;
/** A failed run may be retried after this long. */
const RETRY_AFTER_MS = 10 * 60_000;

interface Org {
  id: string;
  name: string;
  timezone: string;
  daily_digest_hour: number;
}

/**
 * Runs each business's daily jobs on its own clock. Every run is claimed by inserting a
 * job_runs row, so with several workers each job still runs exactly once per business per day.
 */
@Injectable()
export class Scheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(Scheduler.name);
  private readonly tickMs: number;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    @Inject(SYSTEM_DB) private readonly systemDb: Kysely<DB>,
    private readonly tenantDb: TenantDatabase,
    private readonly summaries: DailySummaryService,
    private readonly notifications: NotificationService,
    config: ConfigService<Env, true>,
  ) {
    this.tickMs = config.get('SCHEDULER_TICK_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
    this.logger.log('Scheduler started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.tick(new Date());
      } catch (err) {
        this.logger.error('Scheduler tick failed', err instanceof Error ? err.stack : String(err));
      }
      await sleep(this.tickMs);
    }
  }

  async tick(now: Date): Promise<void> {
    const orgs = await this.systemDb
      .selectFrom('organizations')
      .select(['id', 'name', 'timezone', 'daily_digest_hour'])
      .where('status', '=', 'active')
      .execute();

    for (const org of orgs) {
      const local = localParts(now, org.timezone);
      if (local.hour >= org.daily_digest_hour) {
        await this.runOnce(org, 'daily_digest', local.date, () => this.dailyDigest(org, local.date));
      }
      if (local.hour >= OVERDUE_ALERT_HOUR) {
        await this.runOnce(org, 'debt_overdue', local.date, () => this.overdueDebts(org, local.date, now));
      }
    }
  }

  /** Claims (org, job, period) and runs it. A failed run can be retried after RETRY_AFTER_MS. */
  private async runOnce(org: Org, job: string, periodKey: string, fn: () => Promise<void>): Promise<void> {
    const claimed = await this.systemDb
      .insertInto('job_runs')
      .values({ organization_id: org.id, job, period_key: periodKey })
      .onConflict((oc) => oc.doNothing())
      .returning('job')
      .executeTakeFirst();
    const retried = claimed
      ? undefined
      : await this.systemDb
          .updateTable('job_runs')
          .set({ started_at: sql`now()`, error: null })
          .where('organization_id', '=', org.id)
          .where('job', '=', job)
          .where('period_key', '=', periodKey)
          .where('finished_at', 'is', null)
          .where('error', 'is not', null)
          .where('started_at', '<', new Date(Date.now() - RETRY_AFTER_MS))
          .returning('job')
          .executeTakeFirst();
    if (!claimed && !retried) return;

    try {
      await fn();
      await this.mark(org.id, job, periodKey, { finished: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`${job} for ${org.name} (${periodKey}) failed: ${message}`);
      await this.mark(org.id, job, periodKey, { error: message.slice(0, 1000) });
    }
  }

  private mark(orgId: string, job: string, periodKey: string, outcome: { finished: true } | { error: string }) {
    return this.systemDb
      .updateTable('job_runs')
      .set('finished' in outcome ? { finished_at: sql`now()` } : { error: outcome.error })
      .where('organization_id', '=', orgId)
      .where('job', '=', job)
      .where('period_key', '=', periodKey)
      .execute();
  }

  // ─── Jobs ──────────────────────────────────────────────────────────────────────

  /** INS-01/INS-03: the evening summary for owners and managers. */
  private async dailyDigest(org: Org, date: string): Promise<void> {
    await this.tenantDb.forOrganization(org.id, async (trx) => {
      const summary = await this.summaries.build(trx, date, org.timezone);
      const message = formatDigest(summary, org.name);
      await this.notifications.create(trx, {
        organizationId: org.id,
        userIds: await this.notifications.supervisors(trx),
        draft: { kind: 'daily_digest', severity: 'info', title: message.title, body: message.body, data: { date, sms: message.sms } },
        sourceKey: `daily_digest:${date}`,
      });
    });
  }

  /** DEBT-03: alert once when a debt crosses 30, 60 and 90 days. One message per customer. */
  private async overdueDebts(org: Org, date: string, now: Date): Promise<void> {
    await this.tenantDb.forOrganization(org.id, async (trx) => {
      const debts = await trx
        .selectFrom('debt_records as d')
        .innerJoin('customers as c', 'c.id', 'd.customer_id')
        .select(['d.id', 'd.customer_id', 'c.name', 'd.amount_kobo', 'd.paid_kobo', 'd.created_at'])
        .where('d.status', '=', 'open')
        .where('d.created_at', '<', new Date(now.getTime() - 30 * 86_400_000))
        .execute();
      if (debts.length === 0) return;

      const crossed = new Map<string, { name: string; totalKobo: number; worst: string; count: number }>();
      for (const d of debts) {
        const bucket = bucketFor(ageInDays(d.created_at, now));
        if (bucket === 'days0to30') continue;
        const inserted = await trx
          .insertInto('debt_overdue_alerts')
          .values({ organization_id: org.id, debt_record_id: d.id, bucket })
          .onConflict((oc) => oc.doNothing())
          .returning('bucket')
          .executeTakeFirst();
        if (!inserted) continue; // already alerted for this bucket

        const entry = crossed.get(d.customer_id) ?? { name: d.name, totalKobo: 0, worst: bucket, count: 0 };
        entry.totalKobo += d.amount_kobo - d.paid_kobo;
        entry.count += 1;
        if (bucket > entry.worst) entry.worst = bucket;
        crossed.set(d.customer_id, entry);
      }

      const recipients = await this.notifications.supervisors(trx);
      const label: Record<string, string> = { days31to60: '30', days61to90: '60', days90plus: '90' };
      for (const [customerId, c] of crossed) {
        await this.notifications.create(trx, {
          organizationId: org.id,
          userIds: recipients,
          draft: {
            kind: 'debt_overdue',
            severity: c.worst === 'days90plus' ? 'critical' : 'warning',
            title: `${c.name}: ₦${formatAmount(c.totalKobo)} now over ${label[c.worst]} days`,
            body: `${c.count} debt${c.count === 1 ? '' : 's'} passed ${label[c.worst]} days unpaid. See the aging report to follow up.`,
            data: { customerId },
          },
          sourceKey: `debt_overdue:${customerId}:${date}`,
        });
      }
    });
  }
}
