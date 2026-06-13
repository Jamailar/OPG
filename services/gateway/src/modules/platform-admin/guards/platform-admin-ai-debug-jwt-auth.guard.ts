import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AiDebugAuthService } from '../../ai-chat/guards/ai-debug-auth.service';

@Injectable()
export class PlatformAdminAiDebugJwtAuthGuard extends JwtAuthGuard {
  constructor(
    reflector: Reflector,
    private readonly aiDebugAuthService: AiDebugAuthService,
  ) {
    super(reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    if (this.isAllowedDebugPath(request)) {
      const debugUser = await this.aiDebugAuthService.authenticateRequest(request);
      if (debugUser) {
        request.user = debugUser;
        request.aiDebugAuth = true;
        return true;
      }
    }

    return super.canActivate(context) as boolean | Promise<boolean>;
  }

  private isAllowedDebugPath(request: any): boolean {
    const path = String(request?.path || request?.url || request?.originalUrl || '').split('?')[0] || '';
    return /(?:^|\/)platform-admin\/(?:ai(?:\/|$)|apps\/[^/]+\/ai(?:\/|$)|proxies(?:\/|$))/.test(path);
  }
}
