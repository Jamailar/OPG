import { Module } from '@nestjs/common';
import { AiAgentsService } from './ai-agents.service';
import { AiAgentRuntimeService } from './ai-agent-runtime.service';
import { AiAgentObservabilityRetentionService } from './ai-agent-observability-retention.service';
import { AiAgentsPlatformController } from './ai-agents-platform.controller';
import { AiAgentsAppController } from './ai-agents-app.controller';
import { AiChatModule } from '../ai-chat/ai-chat.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';

@Module({
  imports: [AiChatModule, AuthModule],
  controllers: [AiAgentsPlatformController, AiAgentsAppController],
  providers: [AiAgentsService, AiAgentRuntimeService, AiAgentObservabilityRetentionService, PlatformAdminAccessGuard],
  exports: [AiAgentsService],
})
export class AiAgentsModule {}
