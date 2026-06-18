import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { AppApiKeysService } from '../api-keys/app-api-keys.service';
import { DeveloperAuthorizationService } from './developer-authorization.service';

const normalizeToken = (value: unknown): string | null => {
  const token = String(value || '').trim();
  if (!token) {
    return null;
  }
  if (token.toLowerCase().startsWith('bearer ')) {
    return token.slice(7).trim() || null;
  }
  return token;
};

@Injectable()
export class DeveloperSdkAuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly appApiKeysService: AppApiKeysService,
    private readonly developerAuthorizationService: DeveloperAuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token =
      normalizeToken(request?.headers?.authorization) ||
      normalizeToken(request?.headers?.['x-opg-api-key']) ||
      normalizeToken(request?.headers?.apikey) ||
      normalizeToken(request?.query?.key);

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    const appHint = String(request?.params?.app || request?.query?.app || '').trim() || undefined;

    if (token.startsWith('opg_dev_')) {
      request.user = await this.developerAuthorizationService.authenticateGrant(token, appHint);
      return true;
    }

    if (token.startsWith('rbx_')) {
      request.user = await this.appApiKeysService.authenticateApiKey(token, appHint);
      return true;
    }

    const jwtUser = await this.authService.verifyAccessToken(token);
    const allowPlatformAuthorize = String(request?.originalUrl || request?.url || '').includes('/sdk/auth/sessions/')
      && String(request?.originalUrl || request?.url || '').includes('/authorize');
    if (appHint && String(jwtUser?.appSlug || '').trim() && String(jwtUser.appSlug).trim() !== appHint && !allowPlatformAuthorize) {
      throw new UnauthorizedException('JWT token does not match tenant app');
    }
    request.user = jwtUser;
    return true;
  }
}
