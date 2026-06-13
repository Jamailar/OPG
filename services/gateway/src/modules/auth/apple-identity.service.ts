import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';

type AppWithSettingsRow = {
  id: string;
  slug: string;
  name: string;
  extra_json: unknown;
};

type AppleCredentialRow = {
  id: string;
  name: string;
  bundle_id: string;
  service_id: string | null;
  team_id: string;
  key_id: string | null;
  issuer_id: string | null;
  private_key: string | null;
  environment: string;
  is_active: boolean;
};

export type AppleLoginConfig = {
  credentialId: string | null;
  bundleId: string;
  serviceId: string | null;
  teamId: string;
  keyId: string | null;
  issuerId: string | null;
  privateKey: string | null;
  environment: 'SANDBOX' | 'PRODUCTION';
  appAppleId: string | null;
  appAttestMode: 'OFF' | 'MONITOR' | 'ENFORCE_SENSITIVE' | 'ENFORCE_ALL';
};

export type VerifiedAppleIdentity = {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  isPrivateEmail: boolean;
  audience: string;
  raw: Record<string, unknown>;
};

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nullableString(value: unknown): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function parseEnvironment(value: unknown): 'SANDBOX' | 'PRODUCTION' {
  return String(value || '').trim().toUpperCase() === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION';
}

function parseAttestMode(value: unknown): AppleLoginConfig['appAttestMode'] {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'OFF' || normalized === 'MONITOR' || normalized === 'ENFORCE_ALL') return normalized;
  return 'ENFORCE_SENSITIVE';
}

@Injectable()
export class AppleIdentityService {
  private jwks: unknown | null = null;
  private configCache = new Map<string, { expiresAt: number; value: AppleLoginConfig | null }>();
  private readonly configCacheTtlMs = 60_000;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
  ) {}

  async getPublicConfig(appSlug?: string) {
    const app = await this.resolveAppWithSettings(appSlug);
    const config = await this.resolveAppleLoginConfig(app);
    if (!config) {
      return {
        enabled: false,
        app_attest: { enabled: false, mode: 'OFF' },
      };
    }
    return {
      enabled: true,
      bundle_id: config.bundleId,
      service_id: config.serviceId,
      team_id: config.teamId,
      environment: config.environment,
      nonce_required: true,
      app_attest: {
        enabled: config.appAttestMode !== 'OFF',
        mode: config.appAttestMode,
      },
    };
  }

  async verifyIdentityToken(input: {
    appSlug?: string;
    identityToken?: string;
    nonce?: string;
  }): Promise<{ app: AppWithSettingsRow; config: AppleLoginConfig; identity: VerifiedAppleIdentity }> {
    const app = await this.resolveAppWithSettings(input.appSlug);
    const config = await this.resolveAppleLoginConfig(app);
    const token = String(input.identityToken || '').trim();
    if (!token) {
      throw new BadRequestException('identity_token is required');
    }
    if (!config) {
      throw new BadRequestException('当前租户未配置 Apple 登录');
    }

    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
    }
    const audiences = [config.bundleId, config.serviceId].filter(Boolean) as string[];
    const verified = await jwtVerify(token, this.jwks as any, {
      issuer: APPLE_ISSUER,
      audience: audiences,
    }).catch((error: any) => {
      throw new UnauthorizedException(`Apple 登录失败：${error?.message || 'identity_token 无效'}`);
    });

    const payload = verified.payload as Record<string, unknown>;
    const sub = nullableString(payload.sub);
    if (!sub) {
      throw new UnauthorizedException('Apple 登录失败：未获取到 sub');
    }
    const nonce = nullableString(input.nonce);
    const tokenNonce = nullableString(payload.nonce);
    if (nonce && tokenNonce && tokenNonce !== nonce && tokenNonce !== this.sha256Base64Url(nonce)) {
      throw new UnauthorizedException('Apple 登录失败：nonce 不匹配');
    }

    return {
      app,
      config,
      identity: {
        sub,
        email: nullableString(payload.email),
        emailVerified: payload.email_verified === true || String(payload.email_verified || '').toLowerCase() === 'true',
        isPrivateEmail: payload.is_private_email === true || String(payload.is_private_email || '').toLowerCase() === 'true',
        audience: String(payload.aud || ''),
        raw: payload,
      },
    };
  }

  async resolveAppWithSettings(appSlug?: string): Promise<AppWithSettingsRow> {
    const slug = String(appSlug || '').trim() || this.config.app.defaultSlug;
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT a.id, a.slug, a.name, s.extra_json
         FROM apps a
         LEFT JOIN app_settings s ON s.app_id = a.id
        WHERE a.slug = $1
        LIMIT 1`,
      slug,
    ) as Promise<AppWithSettingsRow[]>);
    const app = rows[0];
    if (!app) {
      throw new BadRequestException(`App not found: ${slug}`);
    }
    return app;
  }

  async resolveAppleLoginConfig(app: AppWithSettingsRow): Promise<AppleLoginConfig | null> {
    const cached = this.configCache.get(app.id);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const extra = asPlainObject(app.extra_json);
    const credentialId = nullableString(extra.apple_login_credential_ref_id);
    let credential: AppleCredentialRow | null = null;
    if (credentialId) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT id, name, bundle_id, service_id, team_id, key_id, issuer_id, private_key, environment, is_active
           FROM apple_login_credentials
          WHERE id = $1::uuid
          LIMIT 1`,
        credentialId,
      ) as Promise<AppleCredentialRow[]>);
      credential = rows[0] || null;
    }
    if (credential && !credential.is_active) {
      credential = null;
    }

    const config = {
      credentialId: credential?.id || credentialId,
      bundleId: credential?.bundle_id || nullableString(extra.apple_bundle_id) || '',
      serviceId: credential?.service_id || nullableString(extra.apple_service_id),
      teamId: credential?.team_id || nullableString(extra.apple_team_id) || '',
      keyId: credential?.key_id || nullableString(extra.apple_key_id),
      issuerId: credential?.issuer_id || nullableString(extra.apple_issuer_id),
      privateKey: credential?.private_key || nullableString(extra.apple_private_key),
      environment: parseEnvironment(credential?.environment || extra.apple_environment),
      appAppleId: nullableString(extra.apple_app_apple_id),
      appAttestMode: parseAttestMode(extra.ios_app_attest_mode),
    } satisfies AppleLoginConfig;

    const value = config.bundleId && config.teamId ? config : null;
    this.configCache.set(app.id, { expiresAt: now + this.configCacheTtlMs, value });
    return value;
  }

  private sha256Base64Url(value: string) {
    return createHash('sha256').update(value).digest('base64url');
  }
}
