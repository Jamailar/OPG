import { Module } from '@nestjs/common';
import { PlatformAdminController } from './platform-admin.controller';
import { FeedbackAdminApiController } from './feedback-admin-api.controller';
import { PlatformAdminService } from './platform-admin.service';
import { AiChatModule } from '../ai-chat/ai-chat.module';
import { BehaviorAnalyticsModule } from '../behavior-analytics/behavior-analytics.module';
import { PaymentsModule } from '../payments/payments.module';
import { RedeemModule } from '../redeem/redeem.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { AuthModule } from '../auth/auth.module';
import { TenantSiteModule } from '../tenant-site/tenant-site.module';
import { EmailDeliveryModule } from '../email-delivery/email-delivery.module';
import { OutboundProxyModule } from '../outbound-proxy/outbound-proxy.module';
import { PlatformAppAnalyticsService } from './platform-app-analytics.service';
import { PlatformAnalyticsSchemaHealthService } from './platform-analytics-schema-health.service';
import { PlatformAnalyticsResponseCacheService } from './platform-analytics-response-cache.service';
import { PlatformAnalyticsSourceTablesService } from './platform-analytics-source-tables.service';
import { PlatformAnalyticsFactsReadStateService } from './platform-analytics-facts-read-state.service';
import { PlatformAnalyticsFactsRefreshStateRepository } from './platform-analytics-facts-refresh-state.repository';
import { PlatformAdminAiDebugJwtAuthGuard } from './guards/platform-admin-ai-debug-jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { FeedbackAdminApiKeyGuard } from '../../common/guards/feedback-admin-api-key.guard';
import { RuntimeSettingsModule } from '../runtime-settings/runtime-settings.module';

@Module({
  imports: [AiChatModule, RedeemModule, BehaviorAnalyticsModule, FeedbackModule, PaymentsModule, AuthModule, TenantSiteModule, EmailDeliveryModule, OutboundProxyModule, RuntimeSettingsModule],
  controllers: [PlatformAdminController, FeedbackAdminApiController],
  providers: [
    PlatformAdminService,
    PlatformAppAnalyticsService,
    PlatformAnalyticsSchemaHealthService,
    PlatformAnalyticsResponseCacheService,
    PlatformAnalyticsSourceTablesService,
    PlatformAnalyticsFactsReadStateService,
    PlatformAnalyticsFactsRefreshStateRepository,
    PlatformAdminAiDebugJwtAuthGuard,
    PlatformAdminAccessGuard,
    FeedbackAdminApiKeyGuard,
  ],
  exports: [PlatformAdminService],
})
export class PlatformAdminModule {}
