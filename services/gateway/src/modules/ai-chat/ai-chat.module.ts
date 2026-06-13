import { forwardRef, Module } from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import { AiOpenAiController } from './ai-openai.controller';
import { AiGeminiController } from './ai-gemini.controller';
import { AiVoicesController } from './ai-voices.controller';
import { AiVoicesAdminController } from './ai-voices-admin.controller';
import { AiChatService } from './ai-chat.service';
import { AiRoutingService } from './ai-routing.service';
import { AiVoicesService } from './ai-voices.service';
import { AiPointsService } from './ai-points.service';
import { AiGatewayThrottleService } from './ai-gateway-throttle.service';
import { AiGatewayUsageQueueService } from './ai-gateway-usage-queue.service';
import { AiProtocolAdapterService } from './ai-protocol-adapter.service';
import { AiUpstreamClientService } from './ai-upstream-client.service';
import { AiGatewayErrorClassifierService } from './ai-gateway-error-classifier.service';
import { AiGatewaySchedulerService } from './ai-gateway-scheduler.service';
import { AiVideoResultProxyService } from './ai-video-result-proxy.service';
import { AuthModule } from '../auth/auth.module';
import { AiDebugAuthService } from './guards/ai-debug-auth.service';
import { AiDebugJwtAuthGuard } from './guards/ai-debug-jwt-auth.guard';
import { OpenAiCompatAuthGuard } from './guards/openai-compat-auth.guard';
import { AppApiKeysModule } from '../api-keys/app-api-keys.module';
import { UploadModule } from '../upload/upload.module';
import { OutboundProxyModule } from '../outbound-proxy/outbound-proxy.module';
import { RuntimeSettingsModule } from '../runtime-settings/runtime-settings.module';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';

@Module({
  imports: [forwardRef(() => AuthModule), AppApiKeysModule, UploadModule, OutboundProxyModule, RuntimeSettingsModule],
  controllers: [AiChatController, AiOpenAiController, AiGeminiController, AiVoicesController, AiVoicesAdminController],
  providers: [
    AiChatService,
    AiRoutingService,
    AiVoicesService,
    AiPointsService,
    AiGatewayThrottleService,
    AiGatewayUsageQueueService,
    AiProtocolAdapterService,
    AiUpstreamClientService,
    AiGatewayErrorClassifierService,
    AiGatewaySchedulerService,
    AiVideoResultProxyService,
    AiDebugAuthService,
    AiDebugJwtAuthGuard,
    OpenAiCompatAuthGuard,
    PlatformAdminAccessGuard,
  ],
  exports: [AiChatService, AiRoutingService, AiVoicesService, AiPointsService, AiDebugAuthService, AiDebugJwtAuthGuard],
})
export class AiChatModule {}
