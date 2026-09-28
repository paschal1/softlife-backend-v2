import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { validateEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { OutboxRelay } from './events/outbox-relay.service';
import { Scheduler } from './jobs/scheduler.service';
import { AuditModule } from './modules/audit/audit.module';
import { AuditQueryService } from './modules/audit/audit-query.service';
import { ExportRunner } from './modules/audit/export-runner.service';
import { InsightsModule } from './modules/insights/insights.module';
import { AlertsSubscriber } from './modules/notifications/alerts.subscriber';
import { NotificationDispatcher } from './modules/notifications/notification-dispatcher.service';
import { NotificationsCoreModule } from './modules/notifications/notifications-core.module';
import { StorageModule } from './storage/storage.module';

/**
 * The background process:
 *  - OutboxRelay: delivers domain events to subscribers (audit log, alerts)
 *  - Scheduler: daily digest and overdue-debt alerts, on each business's own clock
 *  - NotificationDispatcher: sends queued push and SMS messages, with retries
 *  - ExportRunner: builds requested exports (audit log CSV/PDF) into file storage
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    DatabaseModule,
    StorageModule,
    AuditModule,
    NotificationsCoreModule,
    InsightsModule,
  ],
  providers: [OutboxRelay, AlertsSubscriber, Scheduler, NotificationDispatcher, AuditQueryService, ExportRunner],
})
export class WorkerModule {}
