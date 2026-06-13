import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AiDebugAuthService } from './ai-debug-auth.service';

@Injectable()
export class AiDebugJwtAuthGuard extends JwtAuthGuard {
  constructor(
    reflector: Reflector,
    private readonly aiDebugAuthService: AiDebugAuthService,
  ) {
    super(reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const debugUser = await this.aiDebugAuthService.authenticateRequest(request);
    if (debugUser) {
      request.user = debugUser;
      request.aiDebugAuth = true;
      return true;
    }

    return super.canActivate(context) as boolean | Promise<boolean>;
  }
}
