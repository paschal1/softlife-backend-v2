import { Module } from '@nestjs/common';
import { DailySummaryService } from './daily-summary.service';
import { InsightsController } from './insights.controller';

@Module({
  controllers: [InsightsController],
  providers: [DailySummaryService],
  exports: [DailySummaryService],
})
export class InsightsModule {}
