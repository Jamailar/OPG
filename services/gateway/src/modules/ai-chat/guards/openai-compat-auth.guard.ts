import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '../../auth/auth.service';
import { AppApiKeysService } from '../../api-keys/app-api-keys.service';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { hasExplicitAppHint } from '../../../common/utils/auth-route-hints';
import { AiDebugAuthService } from './ai-debug-auth.service';
import { DeveloperAuthorizationService, DeveloperScopeKey } from '../../developer-sdk/developer-authorization.service';

const pickCookieValue = (cookieHeader: string | undefined, key: string): string | null => {
  if (!cookieHeader || !key) {
    return null;
  }

  const entries = cookieHeader.split(';');
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const cookieKey = trimmed.slice(0, eqIndex).trim();
    if (cookieKey !== key) {
      continue;
    }

    const rawValue = trimmed.slice(eqIndex + 1).trim();
    if (!rawValue) {
      return null;
    }

    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return null;
};

const normalizeToken = (value: string | null | undefined): string | null => {
  const token = String(value || '').trim();
  if (!token) {
    return null;
  }

  if (token.toLowerCase().startsWith('bearer ')) {
    return token.slice(7).trim() || null;
  }

  return token;
};

const extractToken = (req: any): string | null => {
  const authHeader = normalizeToken(req?.headers?.authorization);
  if (authHeader) {
    return authHeader;
  }

  const googleApiKeyHeader = normalizeToken(req?.headers?.['x-goog-api-key']);
  if (googleApiKeyHeader) {
    return googleApiKeyHeader;
  }

  const cookieHeader = String(req?.headers?.cookie || '');
  return (
    normalizeToken(pickCookieValue(cookieHeader, 'access_token')) ||
    normalizeToken(pickCookieValue(cookieHeader, 'token')) ||
    normalizeToken(req?.query?.access_token) ||
    normalizeToken(req?.query?.key) ||
    null
  );
};

@Injectable()
export class OpenAiCompatAuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly appApiKeysService: AppApiKeysService,
    private readonly reflector: Reflector,
    private readonly aiDebugAuthService: AiDebugAuthService,
    private readonly developerAuthorizationService: DeveloperAuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic && hasExplicitAppHint(request)) {
      return true;
    }

    const token = extractToken(request);
    if (!token) {
      if (isPublic) {
        return true;
      }

      throw new UnauthorizedException('Authentication required');
    }

    const appHint = String(request?.params?.app || request?.query?.app || '').trim() || undefined;

    if (token.startsWith('opg_dev_')) {
      request.user = await this.developerAuthorizationService.authenticateGrant(token, appHint, this.requiredDeveloperScope(request));
      return true;
    }

    if (token.startsWith('rbx_')) {
      request.user = await this.appApiKeysService.authenticateApiKey(token, appHint);
      return true;
    }

    const debugUser = await this.aiDebugAuthService.authenticateRequest(request);
    if (debugUser) {
      if (appHint && String(debugUser?.appSlug || '').trim() && String(debugUser.appSlug).trim() !== appHint) {
        throw new UnauthorizedException('AI debug token does not match tenant app');
      }
      request.user = debugUser;
      request.aiDebugAuth = true;
      return true;
    }

    const jwtUser = await this.authService.verifyAccessToken(token);
    if (appHint && String(jwtUser?.appSlug || '').trim() && String(jwtUser.appSlug).trim() !== appHint) {
      throw new UnauthorizedException('JWT token does not match tenant app');
    }
    request.user = jwtUser;
    return true;
  }

  private requiredDeveloperScope(request: any): DeveloperScopeKey {
    const path = String(request?.path || request?.url || '').toLowerCase();
    const method = String(request?.method || 'GET').toUpperCase();
    if (method === 'GET' && (path.includes('/models') || path.includes('/default-models'))) {
      return 'ai:models:read';
    }
    if (path.includes('/videos/')) {
      return 'ai:video:write';
    }
    return 'ai:chat:write';
  }
}
