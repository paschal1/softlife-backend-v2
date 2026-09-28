import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Kysely, sql } from 'kysely';
import { Public } from '../auth/decorators/public.decorator';
import { SYSTEM_DB } from '../database/database.tokens';
import type { DB } from '../database/database.types';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(@Inject(SYSTEM_DB) private readonly db: Kysely<DB>) {}

  /** Point uptime monitoring here from day one (per the Technology Stack tab). */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness + database check' })
  async check() {
    try {
      await sql`select 1`.execute(this.db);
      return { status: 'ok', database: 'up', time: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'down' });
    }
  }
}
