import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AuthModule } from '../auth/auth.module';
import { RedeemModule } from '../redeem/redeem.module';
import { BehaviorAnalyticsModule } from '../behavior-analytics/behavior-analytics.module';
import { AiChatModule } from '../ai-chat/ai-chat.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { AppApiKeysModule } from '../api-keys/app-api-keys.module';
@Module({
  imports: [AuthModule, RedeemModule, BehaviorAnalyticsModule, AiChatModule, FeedbackModule, AppApiKeysModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
