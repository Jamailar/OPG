import { Module } from '@nestjs/common';
import { CloudflareEmailService } from './cloudflare-email.service';
import { EmailDeliveryController } from './email-delivery.controller';
import { EmailDeliveryService } from './email-delivery.service';

@Module({
  controllers: [EmailDeliveryController],
  providers: [CloudflareEmailService, EmailDeliveryService],
  exports: [EmailDeliveryService],
})
export class EmailDeliveryModule {}
