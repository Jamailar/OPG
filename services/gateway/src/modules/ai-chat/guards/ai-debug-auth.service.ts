import { Inject, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { PRISMA_CLIENT } from '../../../config/database.module';

type AiDebugAuthUser = {
  userId: string;
  id: string;
  email: string;
  role: string;
  sessionToken: string | null;
  sessionId: string | null;
  appSlug: string;
};

@Injectable()
export class AiDebugAuthService implements OnModuleInit {
  private readonly logger = new Logger(AiDebugAuthService.name);
  private productionConfigWarningLogged = false;

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  onModuleInit() {
    this.warnIfProductionConfigured();
    this.assertEnabledConfigIsUsable();
  }

  async authenticateRequest(request: any): Promise<AiDebugAuthUser | null> {
    if (this.isProductionLike()) {
      this.warnIfProductionConfigured();
      return null;
    }
    this.assertEnabledConfigIsUsable();

    if (!this.isEnabled()) {
      return null;
    }

    const expectedToken = this.expectedToken();
    if (!expectedToken) {
      return null;
    }

    const providedToken = this.extractBearerToken(request);
    if (!providedToken || !this.secureEquals(providedToken, expectedToken)) {
      return null;
    }

    const userId = String(process.env.API_NODE_AI_DEBUG_AUTH_USER_ID || '').trim();
    if (!userId) {
      throw new UnauthorizedException('AI debug auth user is not configured');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        deletedAt: true,
        sessionToken: true,
        app: {
          select: {
            slug: true,
          },
        },
      },
    });

    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('AI debug auth user is not available');
    }

    const appSlug = await this.resolveAppSlug(request, user.app?.slug || '');
    return {
      userId: user.id,
      id: user.id,
      email: user.email,
      role: String(user.role || ''),
      sessionToken: user.sessionToken || null,
      sessionId: null,
      appSlug,
    };
  }

  private async resolveAppSlug(request: any, userAppSlug: string): Promise<string> {
    const requested = this.normalizeString(request?.params?.app) || this.normalizeString(request?.query?.app);
    const configured = this.normalizeString(process.env.API_NODE_AI_DEBUG_AUTH_APP_SLUG);
    const slug = requested || configured || this.normalizeString(userAppSlug);
    if (!slug) {
      throw new UnauthorizedException('AI debug auth app is not configured');
    }

    const rows = await this.prisma.app.findMany({
      where: {
        slug,
      },
      select: {
        id: true,
      },
      take: 1,
    });
    if (rows.length === 0) {
      throw new UnauthorizedException('AI debug auth app is not available');
    }
    return slug;
  }

  private warnIfProductionConfigured() {
    if (!this.isProductionLike()) {
      return;
    }

    const token = this.expectedToken();
    if (this.isEnabled() || token) {
      if (!this.productionConfigWarningLogged) {
        this.logger.warn('API_NODE_AI_DEBUG_AUTH_* is ignored in production');
        this.productionConfigWarningLogged = true;
      }
    }
  }

  private assertEnabledConfigIsUsable() {
    if (!this.isEnabled() || this.isProductionLike()) {
      return;
    }

    const token = this.expectedToken();
    if (token.length < 24) {
      this.logger.error('API_NODE_AI_DEBUG_AUTH_TOKEN must be at least 24 characters');
      throw new UnauthorizedException('AI debug auth token is not safely configured');
    }
    if (token.startsWith('rbx_')) {
      this.logger.error('API_NODE_AI_DEBUG_AUTH_TOKEN must not use the app API key prefix');
      throw new UnauthorizedException('AI debug auth token prefix is not allowed');
    }

    if (!this.normalizeString(process.env.API_NODE_AI_DEBUG_AUTH_USER_ID)) {
      this.logger.error('API_NODE_AI_DEBUG_AUTH_USER_ID is required when AI debug auth is enabled');
      throw new UnauthorizedException('AI debug auth user is not configured');
    }
  }

  private isEnabled(): boolean {
    const raw = this.normalizeString(process.env.API_NODE_AI_DEBUG_AUTH_ENABLED).toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
  }

  private expectedToken(): string {
    return this.normalizeString(process.env.API_NODE_AI_DEBUG_AUTH_TOKEN);
  }

  private isProductionLike(): boolean {
    return [process.env.NODE_ENV, process.env.APP_ENV]
      .map((value) => this.normalizeString(value).toLowerCase())
      .some((value) => value === 'production' || value === 'prod');
  }

  private extractBearerToken(request: any): string {
    const authorization = this.normalizeString(request?.headers?.authorization);
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return this.normalizeString(match?.[1]);
  }

  private normalizeString(value: unknown): string {
    return String(value || '').trim();
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
