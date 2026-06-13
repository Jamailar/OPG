import { Module } from '@nestjs/common';
import { BehaviorAnalyticsService } from './behavior-analytics.service';

@Module({
  providers: [BehaviorAnalyticsService],
  exports: [BehaviorAnalyticsService],
})
export class BehaviorAnalyticsModule {}
