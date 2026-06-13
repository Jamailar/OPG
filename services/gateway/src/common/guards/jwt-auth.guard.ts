import { Injectable, ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { hasExplicitAppHint, hasJwtCredential } from '../utils/auth-route-hints';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest();
    if (isPublic && (hasExplicitAppHint(request) || !hasJwtCredential(request))) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
    if (err || !user) {
      const request = context?.switchToHttp?.().getRequest?.();
      const path = request?.originalUrl || request?.url || 'unknown';
      const reason = err?.message || info?.message || 'Authentication required';
      const normalizedReason = String(reason || '').trim().toLowerCase();
      const tokenExpired = normalizedReason.includes('jwt expired') || normalizedReason.includes('token expired');

      if (tokenExpired) {
        this.logger.debug(`Token expired ${path}`);
        throw new UnauthorizedException({
          message: 'Token expired',
          errors: {
            reason: 'token_expired',
          },
        });
      }

      this.logger.warn(`Unauthorized request ${path}: ${reason}`);
      throw err || new UnauthorizedException({
        message: 'Authentication required',
        errors: {
          reason: 'auth_required',
        },
      });
    }
    return user;
  }
}
