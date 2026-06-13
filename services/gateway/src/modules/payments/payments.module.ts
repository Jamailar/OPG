import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { AppleIapService } from './apple-iap.service';
import { RedeemModule } from '../redeem/redeem.module';
import { AiChatModule } from '../ai-chat/ai-chat.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [RedeemModule, AiChatModule, AuthModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, AppleIapService],
  exports: [PaymentsService, AppleIapService],
})
export class PaymentsModule {}
