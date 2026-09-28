import { Module } from '@nestjs/common';
import { AuditLogSubscriber } from './audit-log.subscriber';

@Module({
  providers: [AuditLogSubscriber],
})
export class AuditModule {}
