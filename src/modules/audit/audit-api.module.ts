import { Module } from '@nestjs/common';
import { AuditQueryService } from './audit-query.service';
import { AuditController } from './audit.controller';
import { ExportsService } from './exports.service';

/** API side of the audit log: viewer and export requests. (The worker side is AuditModule.) */
@Module({
  controllers: [AuditController],
  providers: [AuditQueryService, ExportsService],
})
export class AuditApiModule {}
