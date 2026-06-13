import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { RuntimeSettingsService } from '../../modules/runtime-settings/runtime-settings.service';

@Injectable()
export class FeedbackAdminApiKeyGuard implements CanActivate {
  constructor(private readonly runtimeSettingsService: RuntimeSettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const provided = this.extractKey(req);
    if (!provided) {
      throw new UnauthorizedException('invalid feedback admin api key');
    }

    const dbValid = await this.runtimeSettingsService.validatePlatformApiKey(provided, 'feedback:admin').catch(() => false);
    if (!dbValid) {
      const expected = String(process.env.FEEDBACK_ADMIN_API_KEY || '').trim();
      if (!expected || !this.secureEquals(provided, expected)) {
        throw new UnauthorizedException('invalid feedback admin api key');
      }
    }

    req.feedbackAdminApiKey = true;
    return true;
  }

  private extractKey(req: any): string {
    const headerKey = String(req?.headers?.['x-admin-key'] || req?.headers?.['x-feedback-admin-key'] || '').trim();
    if (headerKey) {
      return headerKey;
    }

    const authorization = String(req?.headers?.authorization || '').trim();
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || '';
  }

  private secureEquals(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(left, right);
  }
}
