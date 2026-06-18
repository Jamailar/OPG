import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AdminType, AppStatus, Prisma, PrismaClient, UserRole } from '@prisma/client';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import {
  AiAppModelRouteInput,
  AiAppModelVisibilityInput,
  AiModelConnectivityTestResult,
  AiModelConnectivityTestInput,
  AiModelInput,
  AiRoutingService,
  ResolvedAiRoute,
  AiSourceConnectivityTestInput,
  AiSourceInput,
  AiUsageLogsQueryInput,
  AiUsageSummaryQueryInput,
} from '../ai-chat/ai-routing.service';
import { AiChatService, ForwardedAiResponse } from '../ai-chat/ai-chat.service';
import { AiPointsService } from '../ai-chat/ai-points.service';
import { BehaviorAnalyticsService } from '../behavior-analytics/behavior-analytics.service';
import { FeedbackService } from '../feedback/feedback.service';
import { PaymentsService } from '../payments/payments.service';
import { RedeemService, RedeemGrantInput } from '../redeem/redeem.service';
import { AuthService } from '../auth/auth.service';
import { TenantSiteService } from '../tenant-site/tenant-site.service';
import { OutboundHttpClientService } from '../outbound-proxy/outbound-http-client.service';
import { SmsService } from '../sms/sms.service';
import { PlatformAppAnalyticsService } from './platform-app-analytics.service';
import { clearAppSlugAliasCache } from '../../common/middleware/app-slug-alias.middleware';
import {
  PLATFORM_APP_ADMIN_PERMISSION_CATALOG,
  PLATFORM_APP_ADMIN_PERMISSION_KEYS,
  findInvalidPlatformAppAdminPermissions,
  normalizePlatformAppAdminPermissions,
} from '../../common/platform-admin-permissions';

type AdminPermissionRow = {
  id: string;
  allowed_pages: unknown;
};

type TenantAnalyticsQuery = {
  days?: string;
  from?: string;
  to?: string;
  recent_limit?: string;
  timezone?: string;
  granularity?: string;
  segment?: string;
  created_scope?: string;
  last_login_scope?: string;
  login_method?: string;
  membership_type?: string;
  source?: string;
  paid_status?: string;
  account_status?: string;
  sort_by?: string;
  sort_order?: string;
  page?: string;
  page_size?: string;
};

const ADMIN_PERMISSION_CATALOG = PLATFORM_APP_ADMIN_PERMISSION_CATALOG;
const ADMIN_PERMISSION_KEYS = PLATFORM_APP_ADMIN_PERMISSION_KEYS;
const ALL_ADMIN_PAGE_PERMISSIONS = [...ADMIN_PERMISSION_KEYS].sort();

type AppSettingsWechatConfig = {
  wechat_open_app_ref_id?: string;
  wechat_open_app_id?: string;
  wechat_open_app_secret?: string;
  google_oauth_client_ref_id?: string;
  google_client_id?: string;
  github_oauth_app_ref_id?: string;
  github_client_id?: string;
  github_client_secret?: string;
  apple_login_credential_ref_id?: string;
  ios_app_attest_mode?: string;
  apple_app_apple_id?: string;
  payment_method_ref_ids?: string[];
  sms_template_ref_id?: string;
  sms_provider_ref_id?: string;
  sms_signature_ref_id?: string;
};

type WechatOpenAppRow = {
  id: string;
  name: string;
  app_id: string;
  app_secret: string;
  is_active: boolean;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type GoogleOAuthClientRow = {
  id: string;
  name: string;
  client_id: string;
  client_secret: string | null;
  outbound_proxy_id: string | null;
  is_active: boolean;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  outbound_proxy_name?: string | null;
  outbound_proxy_protocol?: string | null;
  outbound_proxy_status?: string | null;
  outbound_proxy_latency_ms?: number | null;
  outbound_proxy_detected_ip?: string | null;
  outbound_proxy_region?: string | null;
};

type GitHubOAuthAppRow = {
  id: string;
  name: string;
  client_id: string;
  client_secret: string;
  is_active: boolean;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type AppleLoginCredentialRow = {
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
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type PlatformPaymentMethodType = 'ALIPAY' | 'WECHAT' | 'STRIPE' | 'PADDLE' | 'LEMONSQUEEZY' | 'APPLE_IAP';

type PlatformPaymentMethodRow = {
  id: string;
  provider_type: PlatformPaymentMethodType;
  name: string;
  is_active: boolean;
  is_default: boolean;
  config_json: unknown;
  notes: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type RedeemPackagePaymentType = 'ONE_TIME' | 'RECURRING';
type RedeemPackagePaymentStatus = 'ACTIVE' | 'INACTIVE';
type RedeemPackagePeriodType = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

type RedeemPackageBillingInput = {
  enabled?: boolean;
  type?: RedeemPackagePaymentType | string;
  status?: RedeemPackagePaymentStatus | string;
  membership_days?: number | string;
  sign_scene?: string;
  sign_validity_period?: number | string | null;
  period_type?: RedeemPackagePeriodType | string | null;
  period?: number | string | null;
  execute_time?: string | null;
};

type PaymentProductBridgeRow = {
  id: string;
  app_id: string;
  code: string;
  name: string;
  description: string | null;
  type: string;
  status: string;
  amount: unknown;
  membership_days: number | null;
  points_topup: number | null;
  sign_scene: string | null;
  sign_validity_period: number | null;
  period_type: string | null;
  period: number | null;
  execute_time: string | null;
  created_at: Date;
  updated_at: Date;
};

function asPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function mergeWechatSettingsExtraJson(existing: unknown, payload: unknown): Record<string, unknown> | undefined {
  const base = asPlainObject(existing);
  const incoming = asPlainObject(payload);
  const next: Record<string, unknown> = { ...base, ...incoming };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }

  if (typeof next.wechat_open_app_ref_id === 'string') {
    next.wechat_open_app_ref_id = next.wechat_open_app_ref_id.trim();
    if (!next.wechat_open_app_ref_id) {
      delete next.wechat_open_app_ref_id;
    }
  }

  if (typeof next.wechat_open_app_id === 'string') {
    next.wechat_open_app_id = next.wechat_open_app_id.trim();
    if (!next.wechat_open_app_id) {
      delete next.wechat_open_app_id;
    }
  }

  if (typeof next.wechat_open_app_secret === 'string') {
    next.wechat_open_app_secret = next.wechat_open_app_secret.trim();
    if (!next.wechat_open_app_secret) {
      delete next.wechat_open_app_secret;
    }
  }

  if (typeof next.google_oauth_client_ref_id === 'string') {
    next.google_oauth_client_ref_id = next.google_oauth_client_ref_id.trim();
    if (!next.google_oauth_client_ref_id) {
      delete next.google_oauth_client_ref_id;
    }
  }

  if (typeof next.google_client_id === 'string') {
    next.google_client_id = next.google_client_id.trim();
    if (!next.google_client_id) {
      delete next.google_client_id;
    }
  }

  if (typeof next.github_oauth_app_ref_id === 'string') {
    next.github_oauth_app_ref_id = next.github_oauth_app_ref_id.trim();
    if (!next.github_oauth_app_ref_id) {
      delete next.github_oauth_app_ref_id;
    }
  }

  if (typeof next.github_client_id === 'string') {
    next.github_client_id = next.github_client_id.trim();
    if (!next.github_client_id) {
      delete next.github_client_id;
    }
  }

  if (typeof next.github_client_secret === 'string') {
    next.github_client_secret = next.github_client_secret.trim();
    if (!next.github_client_secret) {
      delete next.github_client_secret;
    }
  }

  for (const key of ['apple_login_credential_ref_id', 'ios_app_attest_mode', 'apple_app_apple_id']) {
    if (typeof next[key] === 'string') {
      next[key] = String(next[key]).trim();
      if (!next[key]) {
        delete next[key];
      }
    }
  }

  if (Array.isArray(next.payment_method_ref_ids)) {
    const ids = next.payment_method_ref_ids
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    if (ids.length > 0) {
      next.payment_method_ref_ids = [...new Set(ids)];
    } else {
      delete next.payment_method_ref_ids;
    }
  } else if (typeof next.payment_method_ref_ids === 'string') {
    const ids = next.payment_method_ref_ids
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (ids.length > 0) {
      next.payment_method_ref_ids = [...new Set(ids)];
    } else {
      delete next.payment_method_ref_ids;
    }
  }

  if (Array.isArray(next.oauth_redirect_hosts)) {
    const hosts = next.oauth_redirect_hosts
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    if (hosts.length > 0) {
      next.oauth_redirect_hosts = hosts;
    } else {
      delete next.oauth_redirect_hosts;
    }
  } else if (typeof next.oauth_redirect_hosts === 'string') {
    const hosts = next.oauth_redirect_hosts
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (hosts.length > 0) {
      next.oauth_redirect_hosts = hosts;
    } else {
      delete next.oauth_redirect_hosts;
    }
  }

  if (typeof next.sms_template_ref_id === 'string') {
    next.sms_template_ref_id = next.sms_template_ref_id.trim();
    if (!next.sms_template_ref_id) {
      delete next.sms_template_ref_id;
    }
  }

  if (typeof next.sms_provider_ref_id === 'string') {
    next.sms_provider_ref_id = next.sms_provider_ref_id.trim();
    if (!next.sms_provider_ref_id) {
      delete next.sms_provider_ref_id;
    }
  }

  if (typeof next.sms_signature_ref_id === 'string') {
    next.sms_signature_ref_id = next.sms_signature_ref_id.trim();
    if (!next.sms_signature_ref_id) {
      delete next.sms_signature_ref_id;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function pickWechatSettings(extraJson: unknown): AppSettingsWechatConfig {
  const raw = asPlainObject(extraJson);
  return {
    wechat_open_app_ref_id:
      typeof raw.wechat_open_app_ref_id === 'string' && raw.wechat_open_app_ref_id.trim()
        ? raw.wechat_open_app_ref_id.trim()
        : undefined,
    wechat_open_app_id:
      typeof raw.wechat_open_app_id === 'string' && raw.wechat_open_app_id.trim()
        ? raw.wechat_open_app_id.trim()
        : undefined,
    wechat_open_app_secret:
      typeof raw.wechat_open_app_secret === 'string' && raw.wechat_open_app_secret.trim()
        ? raw.wechat_open_app_secret.trim()
        : undefined,
    google_oauth_client_ref_id:
      typeof raw.google_oauth_client_ref_id === 'string' && raw.google_oauth_client_ref_id.trim()
        ? raw.google_oauth_client_ref_id.trim()
        : undefined,
    google_client_id:
      typeof raw.google_client_id === 'string' && raw.google_client_id.trim()
        ? raw.google_client_id.trim()
        : undefined,
    github_oauth_app_ref_id:
      typeof raw.github_oauth_app_ref_id === 'string' && raw.github_oauth_app_ref_id.trim()
        ? raw.github_oauth_app_ref_id.trim()
        : undefined,
    github_client_id:
      typeof raw.github_client_id === 'string' && raw.github_client_id.trim()
        ? raw.github_client_id.trim()
        : undefined,
    github_client_secret:
      typeof raw.github_client_secret === 'string' && raw.github_client_secret.trim()
        ? raw.github_client_secret.trim()
        : undefined,
    apple_login_credential_ref_id:
      typeof raw.apple_login_credential_ref_id === 'string' && raw.apple_login_credential_ref_id.trim()
        ? raw.apple_login_credential_ref_id.trim()
        : undefined,
    ios_app_attest_mode:
      typeof raw.ios_app_attest_mode === 'string' && raw.ios_app_attest_mode.trim()
        ? raw.ios_app_attest_mode.trim()
        : undefined,
    apple_app_apple_id:
      typeof raw.apple_app_apple_id === 'string' && raw.apple_app_apple_id.trim()
        ? raw.apple_app_apple_id.trim()
        : undefined,
    payment_method_ref_ids: Array.isArray(raw.payment_method_ref_ids)
      ? raw.payment_method_ref_ids.map((item) => String(item || '').trim()).filter(Boolean)
      : undefined,
    sms_template_ref_id:
      typeof raw.sms_template_ref_id === 'string' && raw.sms_template_ref_id.trim()
        ? raw.sms_template_ref_id.trim()
        : undefined,
    sms_provider_ref_id:
      typeof raw.sms_provider_ref_id === 'string' && raw.sms_provider_ref_id.trim()
        ? raw.sms_provider_ref_id.trim()
        : undefined,
    sms_signature_ref_id:
      typeof raw.sms_signature_ref_id === 'string' && raw.sms_signature_ref_id.trim()
        ? raw.sms_signature_ref_id.trim()
        : undefined,
  };
}

@Injectable()
export class PlatformAdminService implements OnModuleInit {
  private wechatOpenAppSchemaEnsured: Promise<void> | null = null;
  private googleOAuthClientSchemaEnsured: Promise<void> | null = null;
  private githubOAuthAppSchemaEnsured: Promise<void> | null = null;
  private paymentMethodSchemaEnsured: Promise<void> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly aiRoutingService: AiRoutingService,
    private readonly aiChatService: AiChatService,
    private readonly aiPointsService: AiPointsService,
    private readonly redeemService: RedeemService,
    private readonly behaviorAnalyticsService: BehaviorAnalyticsService,
    private readonly feedbackService: FeedbackService,
    private readonly paymentsService: PaymentsService,
    private readonly authService: AuthService,
    private readonly platformAppAnalyticsService: PlatformAppAnalyticsService,
    private readonly tenantSiteService: TenantSiteService,
    private readonly outboundHttpClient: OutboundHttpClientService,
    private readonly smsService: SmsService,
  ) {}

  async onModuleInit() {
    await Promise.allSettled([
      this.ensureWechatOpenAppSchema(),
      this.ensureGoogleOAuthClientSchema(),
      this.ensureGitHubOAuthAppSchema(),
      this.ensurePaymentMethodSchema(),
    ]);
  }

  private platformAppSlug() {
    const slug = String(this.config.app.platformSlug || 'platform')
      .trim()
      .toLowerCase();
    return slug || 'platform';
  }

  private isPlatformAppSlug(slug: unknown) {
    return String(slug || '').trim().toLowerCase() === this.platformAppSlug();
  }

  private assertTenantSlugAllowed(slug: string) {
    if (this.isPlatformAppSlug(slug)) {
      throw new BadRequestException('platform app slug is reserved');
    }
  }

  async listApps(includeInactive = true) {
    const where: Prisma.AppWhereInput = {
      slug: { not: this.platformAppSlug() },
      ...(includeInactive ? {} : { status: AppStatus.ACTIVE }),
    };
    const apps = await this.prisma.app.findMany({
      where,
      include: {
        domains: true,
        settings: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    const aliasMap = await this.listSlugAliasesForApps(apps.map((app) => app.id));

    return {
      items: apps.map((app) => this.serializeApp({ ...app, slugAliases: aliasMap.get(app.id) || [] })),
    };
  }

  async listGlobalWechatOpenApps(actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureWechatOpenAppSchema();

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM wechat_open_apps
       ORDER BY is_active DESC, updated_at DESC, created_at DESC`,
    ) as Promise<WechatOpenAppRow[]>);

    return {
      items: rows.map((row) => this.serializeWechatOpenApp(row)),
    };
  }

  async createGlobalWechatOpenApp(
    actorUserId: string,
    payload: { name?: string; app_id?: string; app_secret?: string; is_active?: boolean },
  ) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureWechatOpenAppSchema();

    const name = String(payload?.name || '').trim();
    const appId = String(payload?.app_id || '').trim();
    const appSecret = String(payload?.app_secret || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!appId) {
      throw new BadRequestException('app_id is required');
    }
    if (!appSecret) {
      throw new BadRequestException('app_secret is required');
    }

    const [nameDup, appIdDup] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM wechat_open_apps WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        name,
      ) as Promise<Array<{ id: string }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM wechat_open_apps WHERE LOWER(app_id) = LOWER($1) LIMIT 1`,
        appId,
      ) as Promise<Array<{ id: string }>>),
    ]);
    if (nameDup.length > 0) {
      throw new BadRequestException('微信登录应用名称已存在');
    }
    if (appIdDup.length > 0) {
      throw new BadRequestException('微信 AppID 已存在');
    }

    const created = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO wechat_open_apps (
         id, name, app_id, app_secret, is_active, created_by_user_id, updated_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5::uuid, $5::uuid
       )
       RETURNING *`,
      name,
      appId,
      appSecret,
      payload?.is_active !== false,
      actorUserId,
    ) as Promise<WechatOpenAppRow[]>);

    return this.serializeWechatOpenApp(created[0]);
  }

  async updateGlobalWechatOpenApp(
    openAppId: string,
    actorUserId: string,
    payload: { name?: string; app_id?: string; app_secret?: string; is_active?: boolean },
  ) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureWechatOpenAppSchema();

    const existing = await this.getWechatOpenAppRow(openAppId);
    const name = payload?.name === undefined ? existing.name : String(payload.name || '').trim();
    const appId = payload?.app_id === undefined ? existing.app_id : String(payload.app_id || '').trim();
    const appSecret = payload?.app_secret === undefined ? existing.app_secret : String(payload.app_secret || '').trim();
    const isActive = payload?.is_active === undefined ? existing.is_active : !!payload.is_active;

    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!appId) {
      throw new BadRequestException('app_id is required');
    }
    if (!appSecret) {
      throw new BadRequestException('app_secret is required');
    }

    const [nameDup, appIdDup] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM wechat_open_apps WHERE LOWER(name) = LOWER($1) AND id <> $2::uuid LIMIT 1`,
        name,
        openAppId,
      ) as Promise<Array<{ id: string }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM wechat_open_apps WHERE LOWER(app_id) = LOWER($1) AND id <> $2::uuid LIMIT 1`,
        appId,
        openAppId,
      ) as Promise<Array<{ id: string }>>),
    ]);
    if (nameDup.length > 0) {
      throw new BadRequestException('微信登录应用名称已存在');
    }
    if (appIdDup.length > 0) {
      throw new BadRequestException('微信 AppID 已存在');
    }

    const updated = await (this.prisma.$queryRawUnsafe(
      `UPDATE wechat_open_apps
       SET name = $2,
           app_id = $3,
           app_secret = $4,
           is_active = $5,
           updated_by_user_id = $6::uuid,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      openAppId,
      name,
      appId,
      appSecret,
      isActive,
      actorUserId,
    ) as Promise<WechatOpenAppRow[]>);

    return this.serializeWechatOpenApp(updated[0]);
  }

  async deleteGlobalWechatOpenApp(openAppId: string, actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureWechatOpenAppSchema();
    await this.getWechatOpenAppRow(openAppId);

    const refs = await this.prisma.appSetting.findMany({
      where: {
        extraJson: {
          path: ['wechat_open_app_ref_id'],
          equals: openAppId,
        } as any,
      },
      select: { appId: true },
      take: 3,
    });
    if (refs.length > 0) {
      throw new BadRequestException('该微信登录应用仍被租户引用，无法删除');
    }

    await this.prisma.$executeRawUnsafe(`DELETE FROM wechat_open_apps WHERE id = $1::uuid`, openAppId);
    return { success: true };
  }

  async testGlobalWechatOpenApp(openAppId: string, actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureWechatOpenAppSchema();
    const row = await this.getWechatOpenAppRow(openAppId);
    const query = new URLSearchParams({
      grant_type: 'client_credential',
      appid: row.app_id,
      secret: row.app_secret,
    });
    try {
      const response = await fetch(`https://api.weixin.qq.com/cgi-bin/token?${query.toString()}`, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
        headers: { accept: 'application/json' },
      });
      const payload = (await response.json()) as { access_token?: string; errcode?: number; errmsg?: string };
      if (!response.ok || payload.errcode || !payload.access_token) {
        return {
          success: false,
          provider: 'wechat',
          message: payload.errmsg || `微信凭证不可用（${payload.errcode || response.status}）`,
        };
      }
      return { success: true, provider: 'wechat', message: '微信凭证可用' };
    } catch (error) {
      return { success: false, provider: 'wechat', message: this.describeNetworkFailure(error, 10000) };
    }
  }

  async listGlobalGoogleOAuthClients(actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureGoogleOAuthClientSchema();

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         g.*,
         p.name AS outbound_proxy_name,
         p.protocol AS outbound_proxy_protocol,
         p.status AS outbound_proxy_status,
         p.latency_ms AS outbound_proxy_latency_ms,
         p.detected_ip AS outbound_proxy_detected_ip,
         p.region AS outbound_proxy_region
       FROM google_oauth_clients g
       LEFT JOIN outbound_proxies p ON p.id = g.outbound_proxy_id
       ORDER BY g.is_active DESC, g.updated_at DESC, g.created_at DESC`,
    ) as Promise<GoogleOAuthClientRow[]>);

    return {
      items: rows.map((row) => this.serializeGoogleOAuthClient(row)),
    };
  }

  async createGlobalGoogleOAuthClient(
    actorUserId: string,
    payload: { name?: string; client_id?: string; client_secret?: string; outbound_proxy_id?: string | null; is_active?: boolean },
  ) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureGoogleOAuthClientSchema();

    const name = String(payload?.name || '').trim();
    const clientId = String(payload?.client_id || '').trim();
    const clientSecret = String(payload?.client_secret || '').trim() || null;
    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!clientId) {
      throw new BadRequestException('client_id is required');
    }
    const outboundProxyId = this.normalizeOptionalUuid(payload?.outbound_proxy_id, 'outbound_proxy_id');
    if (outboundProxyId) {
      await this.ensureOutboundProxyExists(outboundProxyId);
    }

    const [nameDup, clientIdDup] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM google_oauth_clients WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        name,
      ) as Promise<Array<{ id: string }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM google_oauth_clients WHERE LOWER(client_id) = LOWER($1) LIMIT 1`,
        clientId,
      ) as Promise<Array<{ id: string }>>),
    ]);
    if (nameDup.length > 0) {
      throw new BadRequestException('Google 登录应用名称已存在');
    }
    if (clientIdDup.length > 0) {
      throw new BadRequestException('Google Client ID 已存在');
    }

    const created = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO google_oauth_clients (
         id, name, client_id, client_secret, outbound_proxy_id, is_active, created_by_user_id, updated_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4::uuid, $5, $6::uuid, $6::uuid
       )
       RETURNING *`,
      name,
      clientId,
      clientSecret,
      outboundProxyId,
      payload?.is_active !== false,
      actorUserId,
    ) as Promise<GoogleOAuthClientRow[]>);

    this.authService.clearOAuthConfigCache();
    return this.serializeGoogleOAuthClient(created[0]);
  }

  async updateGlobalGoogleOAuthClient(
    clientRowId: string,
    actorUserId: string,
    payload: { name?: string; client_id?: string; client_secret?: string; outbound_proxy_id?: string | null; is_active?: boolean },
  ) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureGoogleOAuthClientSchema();

    const existing = await this.getGoogleOAuthClientRow(clientRowId);
    const name = payload?.name === undefined ? existing.name : String(payload.name || '').trim();
    const clientId = payload?.client_id === undefined ? existing.client_id : String(payload.client_id || '').trim();
    const clientSecret = payload?.client_secret === undefined ? existing.client_secret : String(payload.client_secret || '').trim() || null;
    const outboundProxyId = payload?.outbound_proxy_id === undefined
      ? existing.outbound_proxy_id
      : this.normalizeOptionalUuid(payload.outbound_proxy_id, 'outbound_proxy_id');
    const isActive = payload?.is_active === undefined ? existing.is_active : !!payload.is_active;

    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!clientId) {
      throw new BadRequestException('client_id is required');
    }
    if (outboundProxyId) {
      await this.ensureOutboundProxyExists(outboundProxyId);
    }

    const [nameDup, clientIdDup] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM google_oauth_clients WHERE LOWER(name) = LOWER($1) AND id <> $2::uuid LIMIT 1`,
        name,
        clientRowId,
      ) as Promise<Array<{ id: string }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM google_oauth_clients WHERE LOWER(client_id) = LOWER($1) AND id <> $2::uuid LIMIT 1`,
        clientId,
        clientRowId,
      ) as Promise<Array<{ id: string }>>),
    ]);
    if (nameDup.length > 0) {
      throw new BadRequestException('Google 登录应用名称已存在');
    }
    if (clientIdDup.length > 0) {
      throw new BadRequestException('Google Client ID 已存在');
    }

    const updated = await (this.prisma.$queryRawUnsafe(
      `UPDATE google_oauth_clients
       SET name = $2,
           client_id = $3,
           client_secret = $4,
           outbound_proxy_id = $5::uuid,
           is_active = $6,
           updated_by_user_id = $7::uuid,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      clientRowId,
      name,
      clientId,
      clientSecret,
      outboundProxyId,
      isActive,
      actorUserId,
    ) as Promise<GoogleOAuthClientRow[]>);

    this.authService.clearOAuthConfigCache();
    return this.serializeGoogleOAuthClient(updated[0]);
  }

  async deleteGlobalGoogleOAuthClient(clientRowId: string, actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureGoogleOAuthClientSchema();
    await this.getGoogleOAuthClientRow(clientRowId);

    const refs = await this.prisma.appSetting.findMany({
      where: {
        extraJson: {
          path: ['google_oauth_client_ref_id'],
          equals: clientRowId,
        } as any,
      },
      select: { appId: true },
      take: 3,
    });
    if (refs.length > 0) {
      throw new BadRequestException('该 Google 登录应用仍被租户引用，无法删除');
    }

    await this.prisma.$executeRawUnsafe(`DELETE FROM google_oauth_clients WHERE id = $1::uuid`, clientRowId);
    this.authService.clearOAuthConfigCache();
    return { success: true };
  }

  async testGlobalGoogleOAuthClient(clientRowId: string, actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureGoogleOAuthClientSchema();
    const row = await this.getGoogleOAuthClientRow(clientRowId);
    if (!row.client_id.endsWith('.apps.googleusercontent.com')) {
      return { success: false, provider: 'google', message: 'Google Client ID 格式不正确' };
    }
    try {
      const response = await this.outboundHttpClient.fetch('https://accounts.google.com/.well-known/openid-configuration', {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
        headers: { accept: 'application/json' },
      }, {
        proxyId: row.outbound_proxy_id,
      });
      if (!response.ok) {
        return { success: false, provider: 'google', message: `Google OpenID 配置不可达（${response.status}）` };
      }
      return { success: true, provider: 'google', message: 'Google 登录配置可用' };
    } catch (error) {
      return { success: false, provider: 'google', message: this.describeNetworkFailure(error, 10000) };
    }
  }

  async listGlobalGitHubOAuthApps(actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureGitHubOAuthAppSchema();

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM github_oauth_apps
       ORDER BY is_active DESC, updated_at DESC, created_at DESC`,
    ) as Promise<GitHubOAuthAppRow[]>);

    return {
      items: rows.map((row) => this.serializeGitHubOAuthApp(row)),
    };
  }

  async createGlobalGitHubOAuthApp(
    actorUserId: string,
    payload: { name?: string; client_id?: string; client_secret?: string; is_active?: boolean },
  ) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureGitHubOAuthAppSchema();

    const name = String(payload?.name || '').trim();
    const clientId = String(payload?.client_id || '').trim();
    const clientSecret = String(payload?.client_secret || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!clientId) {
      throw new BadRequestException('client_id is required');
    }
    if (!clientSecret) {
      throw new BadRequestException('client_secret is required');
    }

    const [nameDup, clientIdDup] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM github_oauth_apps WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        name,
      ) as Promise<Array<{ id: string }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM github_oauth_apps WHERE LOWER(client_id) = LOWER($1) LIMIT 1`,
        clientId,
      ) as Promise<Array<{ id: string }>>),
    ]);
    if (nameDup.length > 0) {
      throw new BadRequestException('GitHub 登录应用名称已存在');
    }
    if (clientIdDup.length > 0) {
      throw new BadRequestException('GitHub Client ID 已存在');
    }

    const created = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO github_oauth_apps (
         id, name, client_id, client_secret, is_active, created_by_user_id, updated_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5::uuid, $5::uuid
       )
       RETURNING *`,
      name,
      clientId,
      clientSecret,
      payload?.is_active !== false,
      actorUserId,
    ) as Promise<GitHubOAuthAppRow[]>);

    return this.serializeGitHubOAuthApp(created[0]);
  }

  async updateGlobalGitHubOAuthApp(
    appRowId: string,
    actorUserId: string,
    payload: { name?: string; client_id?: string; client_secret?: string; is_active?: boolean },
  ) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureGitHubOAuthAppSchema();

    const existing = await this.getGitHubOAuthAppRow(appRowId);
    const name = payload?.name === undefined ? existing.name : String(payload.name || '').trim();
    const clientId = payload?.client_id === undefined ? existing.client_id : String(payload.client_id || '').trim();
    const clientSecret = payload?.client_secret === undefined ? existing.client_secret : String(payload.client_secret || '').trim();
    const isActive = payload?.is_active === undefined ? existing.is_active : !!payload.is_active;

    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!clientId) {
      throw new BadRequestException('client_id is required');
    }
    if (!clientSecret) {
      throw new BadRequestException('client_secret is required');
    }

    const [nameDup, clientIdDup] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM github_oauth_apps WHERE LOWER(name) = LOWER($1) AND id <> $2::uuid LIMIT 1`,
        name,
        appRowId,
      ) as Promise<Array<{ id: string }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT id FROM github_oauth_apps WHERE LOWER(client_id) = LOWER($1) AND id <> $2::uuid LIMIT 1`,
        clientId,
        appRowId,
      ) as Promise<Array<{ id: string }>>),
    ]);
    if (nameDup.length > 0) {
      throw new BadRequestException('GitHub 登录应用名称已存在');
    }
    if (clientIdDup.length > 0) {
      throw new BadRequestException('GitHub Client ID 已存在');
    }

    const updated = await (this.prisma.$queryRawUnsafe(
      `UPDATE github_oauth_apps
       SET name = $2,
           client_id = $3,
           client_secret = $4,
           is_active = $5,
           updated_by_user_id = $6::uuid,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      appRowId,
      name,
      clientId,
      clientSecret,
      isActive,
      actorUserId,
    ) as Promise<GitHubOAuthAppRow[]>);

    return this.serializeGitHubOAuthApp(updated[0]);
  }

  async deleteGlobalGitHubOAuthApp(appRowId: string, actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureGitHubOAuthAppSchema();
    await this.getGitHubOAuthAppRow(appRowId);

    const refs = await this.prisma.appSetting.findMany({
      where: {
        extraJson: {
          path: ['github_oauth_app_ref_id'],
          equals: appRowId,
        } as any,
      },
      select: { appId: true },
      take: 3,
    });
    if (refs.length > 0) {
      throw new BadRequestException('该 GitHub 登录应用仍被租户引用，无法删除');
    }

    await this.prisma.$executeRawUnsafe(`DELETE FROM github_oauth_apps WHERE id = $1::uuid`, appRowId);
    return { success: true };
  }

  async testGlobalGitHubOAuthApp(appRowId: string, actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    await this.ensureGitHubOAuthAppSchema();
    const row = await this.getGitHubOAuthAppRow(appRowId);
    if (!row.client_id || !row.client_secret) {
      return { success: false, provider: 'github', message: 'GitHub Client ID / Secret 缺失' };
    }
    try {
      const response = await fetch('https://api.github.com/rate_limit', {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'OPGGateway/1.0',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!response.ok) {
        return { success: false, provider: 'github', message: `GitHub API 不可达（${response.status}）` };
      }
      return { success: true, provider: 'github', message: 'GitHub 登录配置可用' };
    } catch (error) {
      return { success: false, provider: 'github', message: this.describeNetworkFailure(error, 10000) };
    }
  }

  async listGlobalAppleLoginCredentials(actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, name, bundle_id, service_id, team_id, key_id, issuer_id, private_key, environment, is_active,
              created_by_user_id, updated_by_user_id, created_at, updated_at
         FROM apple_login_credentials
        ORDER BY updated_at DESC`,
    ) as Promise<AppleLoginCredentialRow[]>);
    return { items: rows.map((row) => this.serializeAppleLoginCredential(row)) };
  }

  async createGlobalAppleLoginCredential(actorUserId: string, payload: any) {
    await this.ensureAdminUser(actorUserId);
    const normalized = this.normalizeAppleLoginCredentialPayload(payload || {}, false);
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO apple_login_credentials (
         name, bundle_id, service_id, team_id, key_id, issuer_id, private_key, environment, is_active,
         created_by_user_id, updated_by_user_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $10::uuid
       )
       RETURNING id, name, bundle_id, service_id, team_id, key_id, issuer_id, private_key, environment, is_active,
                 created_by_user_id, updated_by_user_id, created_at, updated_at`,
      normalized.name,
      normalized.bundle_id,
      normalized.service_id,
      normalized.team_id,
      normalized.key_id,
      normalized.issuer_id,
      normalized.private_key,
      normalized.environment,
      normalized.is_active,
      actorUserId,
    ) as Promise<AppleLoginCredentialRow[]>);
    return this.serializeAppleLoginCredential(rows[0]);
  }

  async updateGlobalAppleLoginCredential(credentialId: string, actorUserId: string, payload: any) {
    await this.ensureAdminUser(actorUserId);
    const existing = await this.getAppleLoginCredentialRow(credentialId);
    const normalized = this.normalizeAppleLoginCredentialPayload({ ...existing, ...(payload || {}) }, true);
    const privateKey = String(payload?.private_key || '').trim() ? normalized.private_key : existing.private_key;
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE apple_login_credentials
          SET name = $2,
              bundle_id = $3,
              service_id = $4,
              team_id = $5,
              key_id = $6,
              issuer_id = $7,
              private_key = $8,
              environment = $9,
              is_active = $10,
              updated_by_user_id = $11::uuid,
              updated_at = now()
        WHERE id = $1::uuid
        RETURNING id, name, bundle_id, service_id, team_id, key_id, issuer_id, private_key, environment, is_active,
                  created_by_user_id, updated_by_user_id, created_at, updated_at`,
      credentialId,
      normalized.name,
      normalized.bundle_id,
      normalized.service_id,
      normalized.team_id,
      normalized.key_id,
      normalized.issuer_id,
      privateKey,
      normalized.environment,
      normalized.is_active,
      actorUserId,
    ) as Promise<AppleLoginCredentialRow[]>);
    return this.serializeAppleLoginCredential(rows[0]);
  }

  async deleteGlobalAppleLoginCredential(credentialId: string, actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    await this.getAppleLoginCredentialRow(credentialId);
    await this.prisma.$executeRawUnsafe(`DELETE FROM apple_login_credentials WHERE id = $1::uuid`, credentialId);
    return { success: true };
  }

  async testGlobalAppleLoginCredential(credentialId: string, actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    const row = await this.getAppleLoginCredentialRow(credentialId);
    if (!row.bundle_id || !row.team_id) {
      return { success: false, provider: 'apple', message: 'Apple 凭证缺少 Bundle ID 或 Team ID' };
    }
    try {
      const response = await fetch('https://appleid.apple.com/auth/keys', { signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        return { success: false, provider: 'apple', message: `Apple 公钥不可达（${response.status}）` };
      }
      return { success: true, provider: 'apple', message: 'Apple 凭证可用' };
    } catch (error) {
      return { success: false, provider: 'apple', message: this.describeNetworkFailure(error, 10000) };
    }
  }

  async listGlobalPaymentMethods(actorUserId: string) {
    await this.ensureSuperAdmin(actorUserId);
    await this.ensurePaymentMethodSchema();

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_payment_methods
       ORDER BY provider_type ASC, is_default DESC, is_active DESC, updated_at DESC`,
    ) as Promise<PlatformPaymentMethodRow[]>);
    return {
      items: rows.map((row) => this.serializePaymentMethod(row)),
    };
  }

  async createGlobalPaymentMethod(
    actorUserId: string,
    payload: {
      provider_type?: string;
      name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      config?: Record<string, unknown>;
    },
  ) {
    await this.ensureSuperAdmin(actorUserId);
    await this.ensurePaymentMethodSchema();

    const providerType = this.normalizePaymentProviderType(payload.provider_type);
    const name = String(payload.name || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const configJson = this.normalizePaymentMethodConfig(providerType, payload.config || {});
    this.assertPaymentMethodConfig(providerType, configJson);
    const isActive = payload.is_active !== false;
    const isDefault = !!payload.is_default;
    const notes = String(payload.notes || '').trim() || null;

    const dupRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
       FROM platform_payment_methods
       WHERE LOWER(name) = LOWER($1)
       LIMIT 1`,
      name,
    ) as Promise<Array<{ id: string }>>);
    if (dupRows.length > 0) {
      throw new BadRequestException('支付方式名称已存在');
    }

    if (isDefault) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE platform_payment_methods
         SET is_default = false, updated_at = now()
         WHERE provider_type = $1`,
        providerType,
      );
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO platform_payment_methods (
         id, provider_type, name, is_active, is_default, config_json, notes, created_by_user_id, updated_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7::uuid, $7::uuid
       )
       RETURNING *`,
      providerType,
      name,
      isActive,
      isDefault,
      JSON.stringify(configJson),
      notes,
      actorUserId,
    ) as Promise<PlatformPaymentMethodRow[]>);

    await this.paymentsService.refreshRuntimePaymentConfig();
    return this.serializePaymentMethod(rows[0]);
  }

  async updateGlobalPaymentMethod(
    methodId: string,
    actorUserId: string,
    payload: {
      provider_type?: string;
      name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      config?: Record<string, unknown>;
    },
  ) {
    await this.ensureSuperAdmin(actorUserId);
    await this.ensurePaymentMethodSchema();

    const existing = await this.getPaymentMethodRow(methodId);
    const providerType = this.normalizePaymentProviderType(payload.provider_type || existing.provider_type);
    const name = payload.name === undefined ? existing.name : String(payload.name || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const isActive = payload.is_active === undefined ? existing.is_active : !!payload.is_active;
    const isDefault = payload.is_default === undefined ? existing.is_default : !!payload.is_default;
    const notes = payload.notes === undefined ? existing.notes : String(payload.notes || '').trim() || null;

    const mergedConfig = this.normalizePaymentMethodConfig(providerType, {
      ...asPlainObject(existing.config_json),
      ...(asPlainObject(payload.config)),
    });
    this.assertPaymentMethodConfig(providerType, mergedConfig);

    const dupRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
       FROM platform_payment_methods
       WHERE LOWER(name) = LOWER($1) AND id <> $2::uuid
       LIMIT 1`,
      name,
      methodId,
    ) as Promise<Array<{ id: string }>>);
    if (dupRows.length > 0) {
      throw new BadRequestException('支付方式名称已存在');
    }

    if (isDefault) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE platform_payment_methods
         SET is_default = false, updated_at = now()
         WHERE provider_type = $1 AND id <> $2::uuid`,
        providerType,
        methodId,
      );
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE platform_payment_methods
       SET provider_type = $2,
           name = $3,
           is_active = $4,
           is_default = $5,
           config_json = $6::jsonb,
           notes = $7,
           updated_by_user_id = $8::uuid,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      methodId,
      providerType,
      name,
      isActive,
      isDefault,
      JSON.stringify(mergedConfig),
      notes,
      actorUserId,
    ) as Promise<PlatformPaymentMethodRow[]>);

    await this.paymentsService.refreshRuntimePaymentConfig();
    return this.serializePaymentMethod(rows[0]);
  }

  async deleteGlobalPaymentMethod(methodId: string, actorUserId: string) {
    await this.ensureSuperAdmin(actorUserId);
    await this.ensurePaymentMethodSchema();
    await this.getPaymentMethodRow(methodId);
    await this.prisma.$executeRawUnsafe(`DELETE FROM platform_payment_methods WHERE id = $1::uuid`, methodId);
    await this.paymentsService.refreshRuntimePaymentConfig();
    return { success: true };
  }

  async testGlobalPaymentMethod(actorUserId: string, payload: { method_id?: string; timeout_ms?: number }) {
    await this.ensureSuperAdmin(actorUserId);
    await this.ensurePaymentMethodSchema();
    const methodId = String(payload.method_id || '').trim();
    if (!methodId) {
      throw new BadRequestException('method_id is required');
    }
    const method = await this.getPaymentMethodRow(methodId);
    const cfg = asPlainObject(method.config_json);
    const timeoutMsRaw = Number(payload.timeout_ms ?? 10000);
    const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.min(Math.max(Math.floor(timeoutMsRaw), 1000), 60000) : 10000;
    const startedAt = Date.now();

    if (method.provider_type === 'ALIPAY') {
      const gateway = String(cfg.gateway_url || '').trim() || 'https://openapi.alipay.com/gateway.do';
      const response = await fetch(gateway, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      return {
        provider_type: method.provider_type,
        method_id: method.id,
        method_name: method.name,
        ok: response.ok || response.status === 400 || response.status === 405,
        status_code: response.status,
        elapsed_ms: Date.now() - startedAt,
        test_url: gateway,
      };
    }

    if (method.provider_type === 'WECHAT') {
      const base = String(cfg.gateway_url || '').trim() || 'https://api.mch.weixin.qq.com';
      const url = `${base.replace(/\/+$/, '')}/pay/orderquery`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: '<xml></xml>',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        provider_type: method.provider_type,
        method_id: method.id,
        method_name: method.name,
        ok: response.ok || response.status === 400 || response.status === 401 || response.status === 403,
        status_code: response.status,
        elapsed_ms: Date.now() - startedAt,
        test_url: url,
      };
    }

    if (method.provider_type === 'STRIPE') {
      const base = String(cfg.api_base_url || '').trim() || 'https://api.stripe.com';
      const url = `${base.replace(/\/+$/, '')}/v1/account`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${String(cfg.secret_key || '').trim()}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        provider_type: method.provider_type,
        method_id: method.id,
        method_name: method.name,
        ok: response.ok,
        status_code: response.status,
        elapsed_ms: Date.now() - startedAt,
        test_url: url,
      };
    }

    if (method.provider_type === 'PADDLE') {
      const base = String(cfg.api_base_url || '').trim() || 'https://sandbox-api.paddle.com';
      const url = `${base.replace(/\/+$/, '')}/transactions?per_page=1`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${String(cfg.api_key || '').trim()}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        provider_type: method.provider_type,
        method_id: method.id,
        method_name: method.name,
        ok: response.ok,
        status_code: response.status,
        elapsed_ms: Date.now() - startedAt,
        test_url: url,
      };
    }

    if (method.provider_type === 'LEMONSQUEEZY') {
      const base = String(cfg.api_base_url || '').trim() || 'https://api.lemonsqueezy.com';
      const storeId = String(cfg.store_id || '').trim();
      const url = `${base.replace(/\/+$/, '')}/v1/stores/${encodeURIComponent(storeId)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${String(cfg.api_key || '').trim()}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        provider_type: method.provider_type,
        method_id: method.id,
        method_name: method.name,
        ok: response.ok,
        status_code: response.status,
        elapsed_ms: Date.now() - startedAt,
        test_url: url,
      };
    }

    throw new BadRequestException(`unsupported provider type: ${method.provider_type}`);
  }

  async listGlobalSmsProviders(actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.listProviders();
  }

  async createGlobalSmsProvider(
    actorUserId: string,
    payload: {
      provider_type?: string;
      name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      config?: Record<string, unknown>;
    },
  ) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.createProvider(actorUserId, payload);
  }

  async updateGlobalSmsProvider(
    providerId: string,
    actorUserId: string,
    payload: {
      provider_type?: string;
      name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      config?: Record<string, unknown>;
    },
  ) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.updateProvider(providerId, actorUserId, payload);
  }

  async deleteGlobalSmsProvider(providerId: string, actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.deleteProvider(providerId, actorUserId);
  }

  async testGlobalSmsProvider(
    actorUserId: string,
    payload: { provider_id?: string; timeout_ms?: number },
  ) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.testProvider(payload);
  }

  async listGlobalSmsSignatures(actorUserId: string, query: { provider_id?: string }) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.listSignatures(query);
  }

  async createGlobalSmsSignature(
    actorUserId: string,
    payload: {
      provider_id?: string;
      sign_name?: string;
      name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      meta?: Record<string, unknown>;
    },
  ) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.createSignature(actorUserId, payload);
  }

  async updateGlobalSmsSignature(
    signatureId: string,
    actorUserId: string,
    payload: {
      provider_id?: string;
      sign_name?: string;
      name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      meta?: Record<string, unknown>;
    },
  ) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.updateSignature(signatureId, actorUserId, payload);
  }

  async deleteGlobalSmsSignature(signatureId: string, actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.deleteSignature(signatureId, actorUserId);
  }

  async listGlobalSmsTemplates(actorUserId: string, query: { provider_id?: string }) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.listTemplates(query);
  }

  async createGlobalSmsTemplate(
    actorUserId: string,
    payload: {
      provider_id?: string;
      template_code?: string;
      code?: string;
      template_name?: string;
      name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      meta?: Record<string, unknown>;
    },
  ) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.createTemplate(actorUserId, payload);
  }

  async updateGlobalSmsTemplate(
    templateId: string,
    actorUserId: string,
    payload: {
      provider_id?: string;
      template_code?: string;
      code?: string;
      template_name?: string;
      name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      meta?: Record<string, unknown>;
    },
  ) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.updateTemplate(templateId, actorUserId, payload);
  }

  async deleteGlobalSmsTemplate(templateId: string, actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.deleteTemplate(templateId, actorUserId);
  }

  async listAppPaymentProductsForTest(appId: string, actorUserId: string) {
    await this.ensureSuperAdmin(actorUserId);
    return this.paymentsService.platformListProductsForApp(actorUserId, appId);
  }

  async listAppPaymentOrders(
    appId: string,
    actorUserId: string,
    query?: { page?: string; page_size?: string; status?: string },
  ) {
    await this.ensureSuperAdmin(actorUserId);
    const app = await this.ensureAppExists(appId);
    const pageRaw = Number(query?.page ?? 1);
    const pageSizeRaw = Number(query?.page_size ?? 20);
    const page = Number.isFinite(pageRaw) ? pageRaw : 1;
    const pageSize = Number.isFinite(pageSizeRaw) ? pageSizeRaw : 20;
    return this.paymentsService.adminListOrders(app.slug, actorUserId, page, pageSize, query?.status);
  }

  async refundAppPaymentOrder(
    appId: string,
    actorUserId: string,
    orderId: string,
    payload?: { amount?: string; reason?: string },
  ) {
    await this.ensureSuperAdmin(actorUserId);
    const app = await this.ensureAppExists(appId);
    return this.paymentsService.adminRefundOrder(app.slug, actorUserId, orderId, payload || {});
  }

  async runPlatformPaymentOneTimeTest(
    actorUserId: string,
    payload: { app_id?: string; app_slug?: string; one_time_product_id: string; user_id?: string },
  ) {
    await this.ensureSuperAdmin(actorUserId);
    return this.paymentsService.platformRunOneTimeTest(actorUserId, payload);
  }

  async runPlatformPaymentWechatOneTimeTest(
    actorUserId: string,
    payload: { app_id?: string; app_slug?: string; one_time_product_id: string; user_id?: string },
  ) {
    await this.ensureSuperAdmin(actorUserId);
    return this.paymentsService.platformRunWechatOneTimeTest(actorUserId, payload);
  }

  async runPlatformPaymentRecurringTest(
    actorUserId: string,
    payload: { app_id?: string; app_slug?: string; recurring_product_id: string; user_id?: string; execute_time?: string },
  ) {
    await this.ensureSuperAdmin(actorUserId);
    return this.paymentsService.platformRunRecurringTest(actorUserId, payload);
  }

  async runPlatformPaymentFullFlowTest(
    actorUserId: string,
    payload: { app_id?: string; app_slug?: string; one_time_product_id: string; recurring_product_id: string; user_id?: string },
  ) {
    await this.ensureSuperAdmin(actorUserId);
    return this.paymentsService.platformRunFullFlowTest(actorUserId, payload);
  }

  async sendAppSmsTestCode(
    appId: string,
    actorUserId: string,
    payload: {
      phone?: string;
      code?: string;
      persist_code?: boolean;
      respect_cooldown?: boolean;
    },
  ) {
    await this.ensureSuperAdmin(actorUserId);
    const app = await this.ensureAppExists(appId);
    const phone = String(payload?.phone || '').trim();
    if (!phone) {
      throw new BadRequestException('phone is required');
    }
    return this.smsService.sendSmsCodeForAppTest({
      app_id: app.id,
      phone,
      code: payload?.code,
      persist_code: payload?.persist_code === true,
      respect_cooldown: payload?.respect_cooldown === true,
    });
  }

  async listSmsProviderCatalog(actorUserId: string) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.getProviderCatalog();
  }

  async listSmsMessageEvents(actorUserId: string, query: any) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.listEvents(query || {});
  }

  async getSmsObservabilitySummary(actorUserId: string, query: any) {
    await this.ensureAdminUser(actorUserId);
    return this.smsService.getSummary(query || {});
  }

  async getAppDetail(appId: string) {
    const app = await this.prisma.app.findUnique({
      where: { id: appId },
      include: {
        domains: true,
        settings: true,
      },
    });
    if (!app) {
      throw new NotFoundException('App not found');
    }
    if (this.isPlatformAppSlug(app.slug)) {
      throw new NotFoundException('App not found');
    }
    const aliasMap = await this.listSlugAliasesForApps([app.id]);
    return this.serializeApp({ ...app, slugAliases: aliasMap.get(app.id) || [] });
  }

  async createApp(payload: any) {
    const slug = (payload.slug || '').trim().toLowerCase();
    if (!slug) {
      throw new BadRequestException('slug is required');
    }
    this.assertTenantSlugAllowed(slug);
    const name = String(payload.name || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const status = String(payload.status || '').trim().toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const existing = await this.prisma.app.findUnique({ where: { slug } });
    if (existing) {
      throw new BadRequestException('App slug already exists');
    }
    await this.assertSlugNotUsedByAlias(slug);
    const inserted = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO apps (id, slug, name, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3::"AppStatus", now(), now())
       RETURNING id`,
      slug,
      name,
      status,
    ) as Promise<Array<{ id: string }>>);
    const app = { id: inserted[0]?.id };
    if (!app.id) {
      throw new BadRequestException('create app failed');
    }

    if (Array.isArray(payload.domains)) {
      for (const domain of payload.domains) {
        await this.prisma.appDomain.create({
          data: {
            appId: app.id,
            domain: String(domain.domain || '').trim().toLowerCase(),
            domainType: domain.domain_type,
            isPrimary: !!domain.is_primary,
          },
        });
      }
    }

    if (Array.isArray(payload.slug_aliases)) {
      await this.replaceAppSlugAliases(app.id, slug, payload.slug_aliases);
    }

    if (payload.settings) {
      const extraJson = mergeWechatSettingsExtraJson(payload.settings.extra_json, {
        wechat_open_app_ref_id: payload.settings.wechat_open_app_ref_id,
        wechat_open_app_id: payload.settings.wechat_open_app_id,
        wechat_open_app_secret: payload.settings.wechat_open_app_secret,
        google_oauth_client_ref_id: payload.settings.google_oauth_client_ref_id,
        google_client_id: payload.settings.google_client_id,
        github_oauth_app_ref_id: payload.settings.github_oauth_app_ref_id,
        github_client_id: payload.settings.github_client_id,
        github_client_secret: payload.settings.github_client_secret,
        apple_login_credential_ref_id: payload.settings.apple_login_credential_ref_id,
        ios_app_attest_mode: payload.settings.ios_app_attest_mode,
        apple_app_apple_id: payload.settings.apple_app_apple_id,
        payment_method_ref_ids: payload.settings.payment_method_ref_ids,
        sms_template_ref_id: payload.settings.sms_template_ref_id,
        sms_provider_ref_id: payload.settings.sms_provider_ref_id,
        sms_signature_ref_id: payload.settings.sms_signature_ref_id,
      });
      await this.prisma.appSetting.create({
        data: {
          appId: app.id,
          appUrl: payload.settings.app_url,
          brandName: payload.settings.brand_name || payload.name,
          senderName: payload.settings.sender_name,
          senderNickname: payload.settings.sender_nickname,
          wechatRedirectUri: payload.settings.wechat_redirect_uri,
          alipayNotifyUrl: payload.settings.alipay_notify_url,
          alipayAgreementNotifyUrl: payload.settings.alipay_agreement_notify_url,
          extraJson: extraJson as Prisma.InputJsonValue | undefined,
          notes: payload.settings.notes,
          emailPrimaryColor: payload.settings.email_primary_color,
          emailSecondaryColor: payload.settings.email_secondary_color,
          emailGreeting: payload.settings.email_greeting,
          emailCodeLabel: payload.settings.email_code_label,
          emailExpireText: payload.settings.email_expire_text,
          emailFooterText: payload.settings.email_footer_text,
        },
      });
      this.authService.clearOAuthConfigCache();
    }

    return this.getAppDetail(app.id);
  }

  async updateApp(appId: string, payload: any) {
    const currentApp = await this.ensureAppExists(appId);
    const nextNameRaw = payload.name === undefined ? undefined : String(payload.name || '').trim();
    if (nextNameRaw !== undefined && !nextNameRaw) {
      throw new BadRequestException('name cannot be empty');
    }
    const nextStatusRaw = String(payload.status || '').trim().toUpperCase();
    const nextStatus = nextStatusRaw === 'ACTIVE' || nextStatusRaw === 'INACTIVE' ? nextStatusRaw : undefined;

    if (nextNameRaw !== undefined || nextStatus !== undefined) {
      if (nextNameRaw !== undefined && nextStatus !== undefined) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE apps
           SET name = $2,
               status = $3::"AppStatus",
               updated_at = now()
           WHERE id = $1::uuid`,
          appId,
          nextNameRaw,
          nextStatus,
        );
      } else if (nextNameRaw !== undefined) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE apps
           SET name = $2,
               updated_at = now()
           WHERE id = $1::uuid`,
          appId,
          nextNameRaw,
        );
      } else if (nextStatus !== undefined) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE apps
           SET status = $2::"AppStatus",
               updated_at = now()
           WHERE id = $1::uuid`,
          appId,
          nextStatus,
        );
      }
    }

    if (Array.isArray(payload.domains)) {
      await this.prisma.appDomain.deleteMany({ where: { appId } });
      for (const domain of payload.domains) {
        await this.prisma.appDomain.create({
          data: {
            appId,
            domain: String(domain.domain || '').trim().toLowerCase(),
            domainType: domain.domain_type,
            isPrimary: !!domain.is_primary,
          },
        });
      }
    }

    if (Array.isArray(payload.slug_aliases)) {
      await this.replaceAppSlugAliases(appId, currentApp.slug, payload.slug_aliases);
    }

    if (payload.settings) {
      const existing = await this.prisma.appSetting.findUnique({ where: { appId } });
      const extraJson = mergeWechatSettingsExtraJson(existing?.extraJson, {
        ...(asPlainObject(payload.settings.extra_json)),
        wechat_open_app_ref_id: payload.settings.wechat_open_app_ref_id,
        wechat_open_app_id: payload.settings.wechat_open_app_id,
        wechat_open_app_secret: payload.settings.wechat_open_app_secret,
        google_oauth_client_ref_id: payload.settings.google_oauth_client_ref_id,
        google_client_id: payload.settings.google_client_id,
        github_oauth_app_ref_id: payload.settings.github_oauth_app_ref_id,
        github_client_id: payload.settings.github_client_id,
        github_client_secret: payload.settings.github_client_secret,
        apple_login_credential_ref_id: payload.settings.apple_login_credential_ref_id,
        ios_app_attest_mode: payload.settings.ios_app_attest_mode,
        apple_app_apple_id: payload.settings.apple_app_apple_id,
        payment_method_ref_ids: payload.settings.payment_method_ref_ids,
        sms_template_ref_id: payload.settings.sms_template_ref_id,
        sms_provider_ref_id: payload.settings.sms_provider_ref_id,
        sms_signature_ref_id: payload.settings.sms_signature_ref_id,
      });
      if (existing) {
        await this.prisma.appSetting.update({
          where: { appId },
          data: {
            appUrl: payload.settings.app_url,
            brandName: payload.settings.brand_name,
            senderName: payload.settings.sender_name,
            senderNickname: payload.settings.sender_nickname,
            wechatRedirectUri: payload.settings.wechat_redirect_uri,
            alipayNotifyUrl: payload.settings.alipay_notify_url,
            alipayAgreementNotifyUrl: payload.settings.alipay_agreement_notify_url,
            extraJson: extraJson as Prisma.InputJsonValue | undefined,
            notes: payload.settings.notes,
            emailPrimaryColor: payload.settings.email_primary_color,
            emailSecondaryColor: payload.settings.email_secondary_color,
            emailGreeting: payload.settings.email_greeting,
            emailCodeLabel: payload.settings.email_code_label,
            emailExpireText: payload.settings.email_expire_text,
            emailFooterText: payload.settings.email_footer_text,
          },
        });
      } else {
        await this.prisma.appSetting.create({
          data: {
            appId,
            appUrl: payload.settings.app_url,
            brandName: payload.settings.brand_name,
            senderName: payload.settings.sender_name,
            senderNickname: payload.settings.sender_nickname,
            wechatRedirectUri: payload.settings.wechat_redirect_uri,
            alipayNotifyUrl: payload.settings.alipay_notify_url,
            alipayAgreementNotifyUrl: payload.settings.alipay_agreement_notify_url,
            extraJson: extraJson as Prisma.InputJsonValue | undefined,
            notes: payload.settings.notes,
            emailPrimaryColor: payload.settings.email_primary_color,
            emailSecondaryColor: payload.settings.email_secondary_color,
            emailGreeting: payload.settings.email_greeting,
            emailCodeLabel: payload.settings.email_code_label,
            emailExpireText: payload.settings.email_expire_text,
            emailFooterText: payload.settings.email_footer_text,
          },
        });
      }
      this.authService.clearOAuthConfigCache();
    }

    return this.getAppDetail(appId);
  }

  async getAppSiteSettings(appId: string) {
    await this.ensureAppExists(appId);
    return this.tenantSiteService.getAdminSiteSettings(appId);
  }

  async updateAppSiteSettings(appId: string, payload: any) {
    await this.ensureAppExists(appId);
    return this.tenantSiteService.updateAdminSiteSettings(appId, payload || {});
  }

  async createAppSiteDownloadUploadUrl(appId: string, userId: string, platform: string, payload: any) {
    await this.ensureAppExists(appId);
    return this.tenantSiteService.createDownloadUploadUrl(appId, platform, payload || {}, userId);
  }

  async confirmAppSiteDownloadUpload(appId: string, platform: string, payload: any) {
    await this.ensureAppExists(appId);
    return this.tenantSiteService.confirmDownloadUpload(appId, platform, payload || {});
  }

  async getAppStats(appId: string) {
    const app = await this.ensureAppExists(appId);
    const [usersTotal, usersActive, adminsTotal, superAdminsTotal, newUsers7d] =
      await Promise.all([
        this.prisma.user.count({ where: { appId, deletedAt: null } }),
        this.prisma.user.count({ where: { appId, deletedAt: null, isActive: true } }),
        this.countUsersByRole(appId, 'ADMIN'),
        this.countSuperAdmins(appId),
        this.prisma.user.count({
          where: {
            appId,
            deletedAt: null,
            createdAt: {
              gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          },
        }),
      ]);

    return {
      app_id: app.id,
      app_slug: app.slug,
      app_name: app.name,
      users_total: usersTotal,
      users_active: usersActive,
      admins_total: adminsTotal,
      super_admins_total: superAdminsTotal,
      new_users_7d: newUsers7d,
    };
  }

  async getAppBusinessAnalytics(appId: string, query: TenantAnalyticsQuery = {}) {
    const app = await this.ensureAppExists(appId);
    const { from, to, days, recentLimit } = this.resolveAnalyticsRange(query);
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [userOverviewRows, userMembershipRows, userDailyRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE deleted_at IS NULL)::bigint AS users_total,
           COUNT(*) FILTER (WHERE deleted_at IS NULL AND is_active = true)::bigint AS users_active,
           COUNT(*) FILTER (WHERE deleted_at IS NULL AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz)::bigint AS users_new_in_range,
           COUNT(*) FILTER (WHERE deleted_at IS NULL AND created_at >= $4::timestamptz)::bigint AS users_new_7d,
           COUNT(*) FILTER (WHERE deleted_at IS NULL AND created_at >= $5::timestamptz)::bigint AS users_new_30d,
           COUNT(*) FILTER (
             WHERE deleted_at IS NULL
               AND membership_type::text = 'PREMIUM'
               AND (membership_expires_at IS NULL OR membership_expires_at >= now())
           )::bigint AS premium_users,
           COUNT(*) FILTER (
             WHERE deleted_at IS NULL
               AND (
                 membership_type::text <> 'PREMIUM'
                 OR membership_expires_at IS NOT NULL AND membership_expires_at < now()
               )
           )::bigint AS free_users,
           COUNT(*) FILTER (WHERE deleted_at IS NULL AND last_login_at IS NOT NULL AND last_login_at >= $4::timestamptz)::bigint AS login_users_7d,
           COUNT(*) FILTER (WHERE deleted_at IS NULL AND last_login_at IS NOT NULL AND last_login_at >= $5::timestamptz)::bigint AS login_users_30d
         FROM users
         WHERE app_id = $1::uuid`,
        appId,
        from,
        to,
        sevenDaysAgo,
        thirtyDaysAgo,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           COALESCE(membership_type::text, 'FREE') AS membership_type,
           COUNT(*)::bigint AS users_count
         FROM users
         WHERE app_id = $1::uuid AND deleted_at IS NULL
         GROUP BY 1
         ORDER BY users_count DESC`,
        appId,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `WITH days AS (
           SELECT generate_series(
             date_trunc('day', $2::timestamptz),
             date_trunc('day', $3::timestamptz),
             interval '1 day'
           ) AS day
         ),
         new_users AS (
           SELECT date_trunc('day', created_at) AS day, COUNT(*)::bigint AS users_new
           FROM users
           WHERE app_id = $1::uuid
             AND deleted_at IS NULL
             AND created_at >= $2::timestamptz
             AND created_at <= $3::timestamptz
           GROUP BY 1
         ),
         login_users AS (
           SELECT date_trunc('day', last_login_at) AS day, COUNT(*)::bigint AS users_login
           FROM users
           WHERE app_id = $1::uuid
             AND deleted_at IS NULL
             AND last_login_at IS NOT NULL
             AND last_login_at >= $2::timestamptz
             AND last_login_at <= $3::timestamptz
           GROUP BY 1
         )
         SELECT
           to_char(days.day, 'YYYY-MM-DD') AS day,
           COALESCE(new_users.users_new, 0)::bigint AS users_new,
           COALESCE(login_users.users_login, 0)::bigint AS users_login
         FROM days
         LEFT JOIN new_users ON new_users.day = days.day
         LEFT JOIN login_users ON login_users.day = days.day
         ORDER BY days.day ASC`,
        appId,
        from,
        to,
      ) as Promise<Array<Record<string, unknown>>>),
    ]);

    const paymentsTables = await this.resolvePaymentsTableAvailability();
    let orderOverview: Record<string, unknown> = {
      orders_total: 0,
      orders_paid: 0,
      orders_pending: 0,
      orders_failed: 0,
      orders_closed: 0,
      gmv_amount: 0,
      paid_amount: 0,
      avg_order_amount: 0,
    };
    let ordersByStatusRows: Array<Record<string, unknown>> = [];
    let ordersByPaymentTypeRows: Array<Record<string, unknown>> = [];
    let orderDailyRows: Array<Record<string, unknown>> = [];
    let recentOrderRows: Array<Record<string, unknown>> = [];

    if (paymentsTables.orders) {
      const [overviewRows, byStatusRows, byPaymentTypeRows, dailyRows, recentRows] = await Promise.all([
        (this.prisma.$queryRawUnsafe(
          `SELECT
             COUNT(*)::bigint AS orders_total,
             SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END)::bigint AS orders_paid,
             SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END)::bigint AS orders_pending,
             SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END)::bigint AS orders_failed,
             SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END)::bigint AS orders_closed,
             COALESCE(SUM(total_amount), 0)::numeric AS gmv_amount,
             COALESCE(SUM(CASE WHEN status = 'PAID' THEN total_amount ELSE 0 END), 0)::numeric AS paid_amount,
             COALESCE(AVG(total_amount), 0)::numeric AS avg_order_amount
           FROM alipay_orders
           WHERE app_id = $1::uuid
             AND created_at >= $2::timestamptz
             AND created_at <= $3::timestamptz`,
          appId,
          from,
          to,
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(
          `SELECT
             status,
             COUNT(*)::bigint AS orders_count,
             COALESCE(SUM(total_amount), 0)::numeric AS amount_total
           FROM alipay_orders
           WHERE app_id = $1::uuid
             AND created_at >= $2::timestamptz
             AND created_at <= $3::timestamptz
           GROUP BY status
           ORDER BY amount_total DESC, orders_count DESC`,
          appId,
          from,
          to,
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(
          `SELECT
             payment_type,
             COUNT(*)::bigint AS orders_count,
             COALESCE(SUM(total_amount), 0)::numeric AS amount_total
           FROM alipay_orders
           WHERE app_id = $1::uuid
             AND created_at >= $2::timestamptz
             AND created_at <= $3::timestamptz
           GROUP BY payment_type
           ORDER BY amount_total DESC, orders_count DESC`,
          appId,
          from,
          to,
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(
          `WITH days AS (
             SELECT generate_series(
               date_trunc('day', $2::timestamptz),
               date_trunc('day', $3::timestamptz),
               interval '1 day'
             ) AS day
           ),
           orders_daily AS (
             SELECT
               date_trunc('day', created_at) AS day,
               COUNT(*)::bigint AS orders_total,
               SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END)::bigint AS orders_paid,
               COALESCE(SUM(total_amount), 0)::numeric AS amount_total,
               COALESCE(SUM(CASE WHEN status = 'PAID' THEN total_amount ELSE 0 END), 0)::numeric AS amount_paid
             FROM alipay_orders
             WHERE app_id = $1::uuid
               AND created_at >= $2::timestamptz
               AND created_at <= $3::timestamptz
             GROUP BY 1
           )
           SELECT
             to_char(days.day, 'YYYY-MM-DD') AS day,
             COALESCE(orders_daily.orders_total, 0)::bigint AS orders_total,
             COALESCE(orders_daily.orders_paid, 0)::bigint AS orders_paid,
             COALESCE(orders_daily.amount_total, 0)::numeric AS amount_total,
             COALESCE(orders_daily.amount_paid, 0)::numeric AS amount_paid
           FROM days
           LEFT JOIN orders_daily ON orders_daily.day = days.day
           ORDER BY days.day ASC`,
          appId,
          from,
          to,
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(
          `SELECT
             o.id,
             o.out_trade_no,
             o.status,
             o.trade_status,
             o.payment_type,
             o.total_amount,
             o.paid_at,
             o.created_at,
             u.email AS user_email,
             p.name AS product_name
           FROM alipay_orders o
           LEFT JOIN users u ON u.id = o.user_id
           LEFT JOIN payment_products p ON p.id = o.product_id
           WHERE o.app_id = $1::uuid
           ORDER BY o.created_at DESC
           LIMIT $2`,
          appId,
          recentLimit,
        ) as Promise<Array<Record<string, unknown>>>),
      ]);
      orderOverview = overviewRows[0] || orderOverview;
      ordersByStatusRows = byStatusRows;
      ordersByPaymentTypeRows = byPaymentTypeRows;
      orderDailyRows = dailyRows;
      recentOrderRows = recentRows;
    }

    let billingOverview: Record<string, unknown> = {
      agreements_total: 0,
      agreements_valid: 0,
      agreements_pending: 0,
      agreements_invalid: 0,
      agreements_unsigned: 0,
      agreements_new_in_range: 0,
      agreements_due_in_7d: 0,
      deductions_total: 0,
      deductions_success: 0,
      deductions_failed: 0,
      deductions_pending: 0,
      deductions_amount_total: 0,
      deductions_success_amount: 0,
    };
    let agreementsByStatusRows: Array<Record<string, unknown>> = [];
    let deductionsByStatusRows: Array<Record<string, unknown>> = [];
    let deductionsDailyRows: Array<Record<string, unknown>> = [];
    let recentDeductionRows: Array<Record<string, unknown>> = [];

    if (paymentsTables.agreements || paymentsTables.deductions) {
      const tasks: Array<Promise<Array<Record<string, unknown>>>> = [];
      if (paymentsTables.agreements) {
        tasks.push(
          (this.prisma.$queryRawUnsafe(
            `SELECT
               COUNT(*)::bigint AS agreements_total,
               SUM(CASE WHEN status = 'VALID' THEN 1 ELSE 0 END)::bigint AS agreements_valid,
               SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END)::bigint AS agreements_pending,
               SUM(CASE WHEN status = 'INVALID' THEN 1 ELSE 0 END)::bigint AS agreements_invalid,
               SUM(CASE WHEN status = 'UNSIGNED' THEN 1 ELSE 0 END)::bigint AS agreements_unsigned,
               SUM(CASE WHEN created_at >= $2::timestamptz AND created_at <= $3::timestamptz THEN 1 ELSE 0 END)::bigint AS agreements_new_in_range,
               SUM(
                 CASE
                   WHEN status = 'VALID'
                     AND next_deduction_at IS NOT NULL
                     AND next_deduction_at >= now()
                     AND next_deduction_at <= now() + interval '7 day'
                   THEN 1 ELSE 0
                 END
               )::bigint AS agreements_due_in_7d
             FROM alipay_agreements
             WHERE app_id = $1::uuid`,
            appId,
            from,
            to,
          ) as Promise<Array<Record<string, unknown>>>),
        );
        tasks.push(
          (this.prisma.$queryRawUnsafe(
            `SELECT
               status,
               COUNT(*)::bigint AS agreements_count
             FROM alipay_agreements
             WHERE app_id = $1::uuid
             GROUP BY status
             ORDER BY agreements_count DESC`,
            appId,
          ) as Promise<Array<Record<string, unknown>>>),
        );
      } else {
        tasks.push(Promise.resolve([]), Promise.resolve([]));
      }

      if (paymentsTables.deductions) {
        tasks.push(
          (this.prisma.$queryRawUnsafe(
            `SELECT
               COUNT(*)::bigint AS deductions_total,
               SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END)::bigint AS deductions_success,
               SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END)::bigint AS deductions_failed,
               SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END)::bigint AS deductions_pending,
               COALESCE(SUM(amount), 0)::numeric AS deductions_amount_total,
               COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN amount ELSE 0 END), 0)::numeric AS deductions_success_amount
             FROM alipay_deductions
             WHERE app_id = $1::uuid
               AND created_at >= $2::timestamptz
               AND created_at <= $3::timestamptz`,
            appId,
            from,
            to,
          ) as Promise<Array<Record<string, unknown>>>),
        );
        tasks.push(
          (this.prisma.$queryRawUnsafe(
            `SELECT
               status,
               COUNT(*)::bigint AS deductions_count,
               COALESCE(SUM(amount), 0)::numeric AS amount_total
             FROM alipay_deductions
             WHERE app_id = $1::uuid
               AND created_at >= $2::timestamptz
               AND created_at <= $3::timestamptz
             GROUP BY status
             ORDER BY amount_total DESC, deductions_count DESC`,
            appId,
            from,
            to,
          ) as Promise<Array<Record<string, unknown>>>),
        );
        tasks.push(
          (this.prisma.$queryRawUnsafe(
            `WITH days AS (
               SELECT generate_series(
                 date_trunc('day', $2::timestamptz),
                 date_trunc('day', $3::timestamptz),
                 interval '1 day'
               ) AS day
             ),
             deductions_daily AS (
               SELECT
                 date_trunc('day', created_at) AS day,
                 COUNT(*)::bigint AS deductions_total,
                 SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END)::bigint AS deductions_success,
                 COALESCE(SUM(amount), 0)::numeric AS amount_total,
                 COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN amount ELSE 0 END), 0)::numeric AS amount_success
               FROM alipay_deductions
               WHERE app_id = $1::uuid
                 AND created_at >= $2::timestamptz
                 AND created_at <= $3::timestamptz
               GROUP BY 1
             )
             SELECT
               to_char(days.day, 'YYYY-MM-DD') AS day,
               COALESCE(deductions_daily.deductions_total, 0)::bigint AS deductions_total,
               COALESCE(deductions_daily.deductions_success, 0)::bigint AS deductions_success,
               COALESCE(deductions_daily.amount_total, 0)::numeric AS amount_total,
               COALESCE(deductions_daily.amount_success, 0)::numeric AS amount_success
             FROM days
             LEFT JOIN deductions_daily ON deductions_daily.day = days.day
             ORDER BY days.day ASC`,
            appId,
            from,
            to,
          ) as Promise<Array<Record<string, unknown>>>),
        );
        tasks.push(
          (this.prisma.$queryRawUnsafe(
            `SELECT
               d.id,
               d.out_trade_no,
               d.status,
               d.trade_status,
               d.amount,
               d.executed_at,
               d.created_at,
               u.email AS user_email,
               p.name AS product_name,
               a.agreement_no
             FROM alipay_deductions d
             LEFT JOIN users u ON u.id = d.user_id
             LEFT JOIN payment_products p ON p.id = d.product_id
             LEFT JOIN alipay_agreements a ON a.id = d.agreement_id
             WHERE d.app_id = $1::uuid
             ORDER BY d.created_at DESC
             LIMIT $2`,
            appId,
            recentLimit,
          ) as Promise<Array<Record<string, unknown>>>),
        );
      } else {
        tasks.push(Promise.resolve([]), Promise.resolve([]), Promise.resolve([]), Promise.resolve([]));
      }

      const [agreementsOverviewRows, agreementsStatusRows, deductionsOverviewRows, deductionsStatusRows, deductionsDaily, deductionsRecent] =
        await Promise.all(tasks);

      billingOverview = {
        ...billingOverview,
        ...(agreementsOverviewRows[0] || {}),
        ...(deductionsOverviewRows[0] || {}),
      };
      agreementsByStatusRows = agreementsStatusRows;
      deductionsByStatusRows = deductionsStatusRows;
      deductionsDailyRows = deductionsDaily;
      recentDeductionRows = deductionsRecent;
    }

    const behavior = await this.behaviorAnalyticsService.getAppBehaviorAnalytics(appId, from, to);
    const usersOverview = userOverviewRows[0] || {};
    const usersTotal = this.toFiniteInteger(usersOverview.users_total, 0);
    const usersActive = this.toFiniteInteger(usersOverview.users_active, 0);
    const ordersTotal = this.toFiniteInteger(orderOverview.orders_total, 0);
    const ordersPaid = this.toFiniteInteger(orderOverview.orders_paid, 0);
    const deductionsTotal = this.toFiniteInteger(billingOverview.deductions_total, 0);
    const deductionsSuccess = this.toFiniteInteger(billingOverview.deductions_success, 0);

    return {
      app_id: app.id,
      app_slug: app.slug,
      app_name: app.name,
      range: {
        days,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      tables: {
        ...paymentsTables,
        behavior_events: behavior.table_ready,
      },
      users: {
        overview: {
          users_total: usersTotal,
          users_active: usersActive,
          users_new_in_range: this.toFiniteInteger(usersOverview.users_new_in_range, 0),
          users_new_7d: this.toFiniteInteger(usersOverview.users_new_7d, 0),
          users_new_30d: this.toFiniteInteger(usersOverview.users_new_30d, 0),
          premium_users: this.toFiniteInteger(usersOverview.premium_users, 0),
          free_users: this.toFiniteInteger(usersOverview.free_users, 0),
          login_users_7d: this.toFiniteInteger(usersOverview.login_users_7d, 0),
          login_users_30d: this.toFiniteInteger(usersOverview.login_users_30d, 0),
          active_ratio: usersTotal > 0 ? usersActive / usersTotal : 0,
        },
        membership_distribution: userMembershipRows.map((row) => ({
          membership_type: String(row.membership_type || ''),
          users_count: this.toFiniteInteger(row.users_count, 0),
        })),
        daily: userDailyRows.map((row) => ({
          day: String(row.day || ''),
          users_new: this.toFiniteInteger(row.users_new, 0),
          users_login: this.toFiniteInteger(row.users_login, 0),
        })),
      },
      orders: {
        overview: {
          orders_total: ordersTotal,
          orders_paid: ordersPaid,
          orders_pending: this.toFiniteInteger(orderOverview.orders_pending, 0),
          orders_failed: this.toFiniteInteger(orderOverview.orders_failed, 0),
          orders_closed: this.toFiniteInteger(orderOverview.orders_closed, 0),
          gmv_amount: this.toFiniteNumber(orderOverview.gmv_amount, 0),
          paid_amount: this.toFiniteNumber(orderOverview.paid_amount, 0),
          avg_order_amount: this.toFiniteNumber(orderOverview.avg_order_amount, 0),
          paid_ratio: ordersTotal > 0 ? ordersPaid / ordersTotal : 0,
        },
        by_status: ordersByStatusRows.map((row) => ({
          status: String(row.status || ''),
          orders_count: this.toFiniteInteger(row.orders_count, 0),
          amount_total: this.toFiniteNumber(row.amount_total, 0),
        })),
        by_payment_type: ordersByPaymentTypeRows.map((row) => ({
          payment_type: String(row.payment_type || ''),
          orders_count: this.toFiniteInteger(row.orders_count, 0),
          amount_total: this.toFiniteNumber(row.amount_total, 0),
        })),
        daily: orderDailyRows.map((row) => ({
          day: String(row.day || ''),
          orders_total: this.toFiniteInteger(row.orders_total, 0),
          orders_paid: this.toFiniteInteger(row.orders_paid, 0),
          amount_total: this.toFiniteNumber(row.amount_total, 0),
          amount_paid: this.toFiniteNumber(row.amount_paid, 0),
        })),
        recent_orders: recentOrderRows.map((row) => ({
          id: String(row.id || ''),
          out_trade_no: String(row.out_trade_no || ''),
          status: String(row.status || ''),
          trade_status: this.normalizeNullableString(row.trade_status),
          payment_type: String(row.payment_type || ''),
          total_amount: this.toFiniteNumber(row.total_amount, 0),
          paid_at: row.paid_at,
          created_at: row.created_at,
          user_email: this.normalizeNullableString(row.user_email),
          product_name: this.normalizeNullableString(row.product_name),
        })),
      },
      billing: {
        overview: {
          agreements_total: this.toFiniteInteger(billingOverview.agreements_total, 0),
          agreements_valid: this.toFiniteInteger(billingOverview.agreements_valid, 0),
          agreements_pending: this.toFiniteInteger(billingOverview.agreements_pending, 0),
          agreements_invalid: this.toFiniteInteger(billingOverview.agreements_invalid, 0),
          agreements_unsigned: this.toFiniteInteger(billingOverview.agreements_unsigned, 0),
          agreements_new_in_range: this.toFiniteInteger(billingOverview.agreements_new_in_range, 0),
          agreements_due_in_7d: this.toFiniteInteger(billingOverview.agreements_due_in_7d, 0),
          deductions_total: deductionsTotal,
          deductions_success: deductionsSuccess,
          deductions_failed: this.toFiniteInteger(billingOverview.deductions_failed, 0),
          deductions_pending: this.toFiniteInteger(billingOverview.deductions_pending, 0),
          deductions_amount_total: this.toFiniteNumber(billingOverview.deductions_amount_total, 0),
          deductions_success_amount: this.toFiniteNumber(billingOverview.deductions_success_amount, 0),
          deductions_success_ratio: deductionsTotal > 0 ? deductionsSuccess / deductionsTotal : 0,
        },
        agreements_by_status: agreementsByStatusRows.map((row) => ({
          status: String(row.status || ''),
          agreements_count: this.toFiniteInteger(row.agreements_count, 0),
        })),
        deductions_by_status: deductionsByStatusRows.map((row) => ({
          status: String(row.status || ''),
          deductions_count: this.toFiniteInteger(row.deductions_count, 0),
          amount_total: this.toFiniteNumber(row.amount_total, 0),
        })),
        deductions_daily: deductionsDailyRows.map((row) => ({
          day: String(row.day || ''),
          deductions_total: this.toFiniteInteger(row.deductions_total, 0),
          deductions_success: this.toFiniteInteger(row.deductions_success, 0),
          amount_total: this.toFiniteNumber(row.amount_total, 0),
          amount_success: this.toFiniteNumber(row.amount_success, 0),
        })),
        recent_deductions: recentDeductionRows.map((row) => ({
          id: String(row.id || ''),
          out_trade_no: String(row.out_trade_no || ''),
          status: String(row.status || ''),
          trade_status: this.normalizeNullableString(row.trade_status),
          amount: this.toFiniteNumber(row.amount, 0),
          executed_at: row.executed_at,
          created_at: row.created_at,
          user_email: this.normalizeNullableString(row.user_email),
          product_name: this.normalizeNullableString(row.product_name),
          agreement_no: this.normalizeNullableString(row.agreement_no),
        })),
      },
      behavior: {
        overview: behavior.overview,
        daily: behavior.daily,
        top_routes: behavior.top_routes,
        top_events: behavior.top_events,
        frequency_distribution: behavior.frequency_distribution,
        path_transitions: behavior.path_transitions,
      },
      generated_at: new Date().toISOString(),
    };
  }

  async getAppAnalyticsOverview(appId: string, query: TenantAnalyticsQuery = {}) {
    return this.platformAppAnalyticsService.getOverview(appId, query);
  }

  async getAppAnalyticsGrowth(appId: string, query: TenantAnalyticsQuery = {}) {
    return this.platformAppAnalyticsService.getGrowth(appId, query);
  }

  async getAppAnalyticsRetention(appId: string, query: TenantAnalyticsQuery = {}) {
    return this.platformAppAnalyticsService.getRetention(appId, query);
  }

  async getAppAnalyticsProfiles(appId: string, query: TenantAnalyticsQuery = {}) {
    return this.platformAppAnalyticsService.getProfiles(appId, query);
  }

  async getAppAnalyticsConversion(appId: string, query: TenantAnalyticsQuery = {}) {
    return this.platformAppAnalyticsService.getConversion(appId, query);
  }

  async getAppAnalyticsUsers(appId: string, query: TenantAnalyticsQuery = {}) {
    return this.platformAppAnalyticsService.getUsers(appId, query);
  }

  async deactivateTenantUser(appId: string, userId: string, actorUserId: string, payload: { reason?: string } = {}) {
    await this.ensureAppExists(appId);
    const target = await this.findUserInAppIncludingDeleted(appId, userId);
    if (!target) {
      throw new NotFoundException('User not found');
    }
    if (target.deleted_at) {
      return this.serializeManagedUser(target);
    }
    if (target.is_superuser) {
      throw new BadRequestException('Cannot deactivate superuser');
    }

    const now = new Date();
    const tombstoneEmail = this.buildDeactivatedEmail(String(target.id));
    const reason = String(payload.reason || '').trim().slice(0, 500) || null;
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE users
       SET is_active = false,
           deleted_at = $3::timestamptz,
           deactivated_at = $3::timestamptz,
           deactivated_by_user_id = $4::uuid,
           deactivation_reason = $5,
           deactivated_email = COALESCE(deactivated_email, email),
           deactivated_phone = COALESCE(deactivated_phone, phone),
           email = $6,
           phone = NULL,
           phone_verified = false,
           session_token = NULL,
           current_refresh_token_hash = NULL,
           refresh_token_issued_at = NULL,
           refresh_token_last_used_at = NULL,
           updated_at = now()
       WHERE id = $1::uuid AND app_id = $2::uuid
       RETURNING id, app_id, email, phone, phone_verified, display_name, full_name, role, admin_type, is_active, is_superuser,
                 created_at, updated_at, last_login_at, deleted_at, deactivated_at, deactivated_email, deactivated_phone`,
      userId,
      appId,
      now,
      actorUserId,
      reason,
      tombstoneEmail,
    ) as Promise<Array<Record<string, unknown>>>);
    return this.serializeManagedUser(rows[0]);
  }

  async restoreTenantUser(appId: string, userId: string) {
    await this.ensureAppExists(appId);
    const target = await this.findUserInAppIncludingDeleted(appId, userId);
    if (!target) {
      throw new NotFoundException('User not found');
    }
    if (!target.deleted_at) {
      return this.serializeManagedUser(target);
    }
    const restoreEmail = String(target.deactivated_email || '').trim();
    const restorePhone = String(target.deactivated_phone || '').trim() || null;
    if (!restoreEmail) {
      throw new BadRequestException('Missing restore email');
    }
    const conflictRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id,
              lower(email) = lower($3::text) AS email_conflict,
              ($4::text IS NOT NULL AND phone = $4::text AND phone_verified = true) AS phone_conflict
       FROM users
       WHERE app_id = $1::uuid
         AND id <> $2::uuid
         AND (
           lower(email) = lower($3::text)
           OR ($4::text IS NOT NULL AND deleted_at IS NULL AND phone = $4::text AND phone_verified = true)
         )
       LIMIT 1`,
      appId,
      userId,
      restoreEmail,
      restorePhone,
    ) as Promise<Array<{ id: string; email_conflict: boolean; phone_conflict: boolean }>>);
    if (conflictRows.length) {
      throw new ConflictException(conflictRows[0].phone_conflict ? '手机号已被其他账号使用' : '邮箱已被其他账号使用');
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE users
       SET is_active = true,
           deleted_at = NULL,
           deactivated_at = NULL,
           deactivated_by_user_id = NULL,
           deactivation_reason = NULL,
           email = $3,
           phone = $4,
           phone_verified = CASE WHEN $4::text IS NULL THEN false ELSE true END,
           deactivated_email = NULL,
           deactivated_phone = NULL,
           updated_at = now()
       WHERE id = $1::uuid AND app_id = $2::uuid
       RETURNING id, app_id, email, phone, phone_verified, display_name, full_name, role, admin_type, is_active, is_superuser,
                 created_at, updated_at, last_login_at, deleted_at, deactivated_at, deactivated_email, deactivated_phone`,
      userId,
      appId,
      restoreEmail,
      restorePhone,
    ) as Promise<Array<Record<string, unknown>>>);
    return this.serializeManagedUser(rows[0]);
  }

  async unlinkTenantUserPhone(appId: string, userId: string) {
    return this.updateTenantUserContact(appId, userId, 'phone');
  }

  async unlinkTenantUserEmail(appId: string, userId: string) {
    return this.updateTenantUserContact(appId, userId, 'email');
  }

  async listAppAdmins(appId: string) {
    const app = await this.ensureAppExists(appId);
    const users = await this.prisma.user.findMany({
      where: {
        appId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    const adminUsers = users.filter((user) => this.roleEquals(user.role, 'ADMIN'));

    const items = await Promise.all(
      adminUsers.map(async (user) => ({
        id: user.id,
        app_id: user.appId,
        email: user.email,
        display_name: user.displayName || user.fullName || user.email,
        role: this.roleEquals(user.role, 'ADMIN') ? UserRole.ADMIN : user.role,
        admin_type: this.roleEquals(user.adminType, 'SUPER_ADMIN') ? AdminType.SUPER_ADMIN : AdminType.ADMIN,
        is_active: user.isActive,
        page_permissions:
          this.roleEquals(user.adminType, 'SUPER_ADMIN')
            ? ALL_ADMIN_PAGE_PERMISSIONS
            : await this.fetchAdminPermissions(appId, user.id),
        created_at: user.createdAt,
        updated_at: user.updatedAt,
        last_login_at: user.lastLoginAt,
      })),
    );

    return {
      app_id: app.id,
      app_slug: app.slug,
      total: items.length,
      permission_catalog: ADMIN_PERMISSION_CATALOG,
      items,
    };
  }

  async getMyAppAdminPermissions(appId: string, actorUserId: string) {
    const app = await this.ensureAppExists(appId);
    const user = await this.findActiveAdminActor(actorUserId);
    if (!user || !this.roleEquals(user.role, 'ADMIN')) {
      throw new ForbiddenException('app admin required');
    }
    const isPlatformSuperAdmin =
      this.roleEquals(user.adminType, 'SUPER_ADMIN') &&
      String(user.app?.slug || '') === this.config.app.platformSlug;
    if (!isPlatformSuperAdmin && user.appId !== app.id) {
      throw new ForbiddenException('app admin required');
    }
    const isSuperAdmin = this.roleEquals(user.adminType, 'SUPER_ADMIN');
    const pagePermissions = isSuperAdmin ? ALL_ADMIN_PAGE_PERMISSIONS : await this.fetchAdminPermissions(app.id, user.id);
    return {
      app_id: app.id,
      app_slug: app.slug,
      is_super_admin: isSuperAdmin,
      page_permissions: pagePermissions,
      permission_catalog: ADMIN_PERMISSION_CATALOG,
      sensitive_actions_super_admin_only: [
        'admin_accounts',
        'refund_payment_order',
        'grant_ai_points',
        'review_feedback_reward',
        'create_redeem_codes',
        'void_redeem_code',
        'revoke_redeem_redemption',
        'distribute_redeem_package',
        'payment_tests',
      ],
    };
  }

  async createOrUpdateAppAdmin(appId: string, payload: any, actorUserId: string) {
    await this.ensureAppExists(appId);

    const email = String(payload.email || '').trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('email is required');
    }

    const adminType = (payload.admin_type as AdminType) || AdminType.ADMIN;
    const permissions = this.normalizeAdminPermissions(payload.page_permissions);

    let user = await this.prisma.user.findFirst({
      where: {
        appId,
        email,
        deletedAt: null,
      },
    });

    if (!user) {
      if (!payload.password) {
        throw new BadRequestException('password is required for new admin');
      }
      user = await this.prisma.user.create({
        data: {
          appId,
          email,
          hashedPassword: await bcrypt.hash(String(payload.password), 10),
          fullName: payload.display_name || email.split('@')[0],
          displayName: payload.display_name || email.split('@')[0],
          isActive: true,
          sessionToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        },
      });
    } else {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          displayName: payload.display_name ?? user.displayName,
          fullName: payload.display_name ?? user.fullName,
          isActive: true,
          hashedPassword: payload.password ? await bcrypt.hash(String(payload.password), 10) : undefined,
        },
      });
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE users
       SET role = 'ADMIN', admin_type = $2::"AdminType", updated_at = now()
       WHERE id = $1::uuid`,
      user.id,
      adminType,
    );

    if (adminType === AdminType.SUPER_ADMIN) {
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM admin_page_permissions WHERE app_id = $1::uuid AND admin_user_id = $2::uuid`,
        appId,
        user.id,
      );
    } else {
      await this.upsertAdminPermissions(appId, user.id, permissions, actorUserId);
    }

    return {
      id: user.id,
      app_id: user.appId,
      email: user.email,
      display_name: user.displayName || user.fullName || user.email,
      role: UserRole.ADMIN,
      admin_type: adminType,
      is_active: user.isActive,
      page_permissions: adminType === AdminType.SUPER_ADMIN ? ALL_ADMIN_PAGE_PERMISSIONS : permissions,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
      last_login_at: user.lastLoginAt,
    };
  }

  async resetAdminPassword(
    appId: string,
    adminUserId: string,
    payload: { new_password: string; invalidate_sessions?: boolean },
  ) {
    const user = await this.findActiveUserInApp(appId, adminUserId);
    if (!user || !this.roleEquals(user.role, 'ADMIN')) {
      throw new NotFoundException('Admin user not found');
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        hashedPassword: await bcrypt.hash(payload.new_password, 10),
        sessionToken: payload.invalidate_sessions ? null : user.sessionToken,
        currentRefreshTokenHash: payload.invalidate_sessions ? null : undefined,
        refreshTokenIssuedAt: payload.invalidate_sessions ? null : undefined,
        refreshTokenLastUsedAt: payload.invalidate_sessions ? null : undefined,
      },
    });

    return {
      id: updated.id,
      email: updated.email,
      message: 'Password updated',
    };
  }

  async updateAdminPermissions(appId: string, adminUserId: string, pagePermissions: string[], actorUserId: string) {
    const user = await this.findActiveUserInApp(appId, adminUserId);
    if (!user || !this.roleEquals(user.role, 'ADMIN')) {
      throw new NotFoundException('Admin user not found');
    }
    if (this.roleEquals(user.adminType, 'SUPER_ADMIN')) {
      throw new BadRequestException('SUPER_ADMIN always has all permissions');
    }

    const normalized = this.normalizeAdminPermissions(pagePermissions);
    await this.upsertAdminPermissions(appId, adminUserId, normalized, actorUserId);
    return {
      id: user.id,
      page_permissions: normalized,
    };
  }

  async updateAdminStatus(appId: string, adminUserId: string, isActive: boolean) {
    const user = await this.findActiveUserInApp(appId, adminUserId);
    if (!user || !this.roleEquals(user.role, 'ADMIN')) {
      throw new NotFoundException('Admin user not found');
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { isActive },
    });
    return {
      id: updated.id,
      is_active: updated.isActive,
    };
  }

  async deleteAppAdmin(appId: string, adminUserId: string) {
    const user = await this.findActiveUserInApp(appId, adminUserId);
    if (!user || !this.roleEquals(user.role, 'ADMIN')) {
      throw new NotFoundException('Admin user not found');
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE users
       SET role = 'USER', admin_type = NULL, updated_at = now()
       WHERE id = $1::uuid`,
      user.id,
    );
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM admin_page_permissions WHERE app_id = $1::uuid AND admin_user_id = $2::uuid`,
      appId,
      adminUserId,
    );

    return { deleted: true };
  }

  async listGlobalAiSources() {
    return {
      items: await this.aiRoutingService.listGlobalSources(),
    };
  }

  listGlobalAiProviderTemplates() {
    return this.aiRoutingService.listProviderTemplates();
  }

  async createGlobalAiSource(actorUserId: string, payload: AiSourceInput) {
    return this.aiRoutingService.createGlobalSource(actorUserId, payload);
  }

  async updateGlobalAiSource(sourceId: string, actorUserId: string, payload: AiSourceInput) {
    return this.aiRoutingService.updateGlobalSource(sourceId, actorUserId, payload);
  }

  async deleteGlobalAiSource(sourceId: string) {
    return this.aiRoutingService.deleteGlobalSource(sourceId);
  }

  async testGlobalAiSourceConnectivity(payload: AiSourceConnectivityTestInput) {
    return this.aiRoutingService.testSourceConnectivity(payload);
  }

  async listGlobalAiModels() {
    return {
      items: await this.aiRoutingService.listGlobalModels(),
    };
  }

  async createGlobalAiModel(actorUserId: string, payload: AiModelInput) {
    return this.aiRoutingService.createGlobalModel(actorUserId, payload);
  }

  async updateGlobalAiModel(modelId: string, actorUserId: string, payload: AiModelInput) {
    return this.aiRoutingService.updateGlobalModel(modelId, actorUserId, payload);
  }

  async listGlobalAiModelSourceRoutes(modelId: string) {
    return this.aiRoutingService.listGlobalModelSourceRoutes(modelId);
  }

  async replaceGlobalAiModelSourceRoutes(modelId: string, actorUserId: string, payload: { items?: any[] }) {
    return this.aiRoutingService.replaceGlobalModelSourceRoutes(modelId, actorUserId, payload);
  }

  async deleteGlobalAiModel(modelId: string) {
    return this.aiRoutingService.deleteGlobalModel(modelId);
  }

  async testGlobalAiModelConnectivity(payload: AiModelConnectivityTestInput) {
    return this.aiRoutingService.testModelConnectivity(payload);
  }

  async runGlobalAiModelPlayground(payload: {
    app_id?: string;
    model_id?: string;
    capability?: string;
    source_id?: string;
    upstream_model?: string;
    endpoint_path?: string;
    api_type?: string;
    request_overrides?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    video_mode?: 'sync' | 'async';
  }) {
    const app = await this.resolvePlaygroundApp(payload?.app_id);
    const route = await this.aiRoutingService.resolvePlaygroundRoute({
      app_id: app.id,
      app_slug: app.slug,
      model_id: payload?.model_id,
      capability: payload?.capability,
      source_id: payload?.source_id,
      upstream_model: payload?.upstream_model,
      endpoint_path: payload?.endpoint_path,
      api_type: payload?.api_type,
      request_overrides: payload?.request_overrides,
    });
    const forwarded = await this.aiChatService.invokePlaygroundRoute(
      route,
      this.normalizePlaygroundPayload(payload?.payload),
      { request_path: '/platform-admin/ai/models/playground' },
      { video_mode: payload?.video_mode === 'async' ? 'async' : 'sync' },
    );
    return this.serializeAiPlaygroundResult(route, forwarded);
  }

  async queryGlobalAiModelPlaygroundTask(payload: {
    app_id?: string;
    model_id?: string;
    capability?: string;
    source_id?: string;
    upstream_model?: string;
    endpoint_path?: string;
    api_type?: string;
    request_overrides?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) {
    const app = await this.resolvePlaygroundApp(payload?.app_id);
    const route = await this.aiRoutingService.resolvePlaygroundRoute({
      app_id: app.id,
      app_slug: app.slug,
      model_id: payload?.model_id,
      capability: payload?.capability,
      source_id: payload?.source_id,
      upstream_model: payload?.upstream_model,
      endpoint_path: payload?.endpoint_path,
      api_type: payload?.api_type,
      request_overrides: payload?.request_overrides,
    });
    const forwarded = await this.aiChatService.queryPlaygroundVideoTask(
      route,
      this.normalizePlaygroundPayload(payload?.payload),
      { request_path: '/platform-admin/ai/models/playground/query' },
    );
    return this.serializeAiPlaygroundResult(route, forwarded);
  }

  async testGlobalAiModelConnectivityBatch(payload: {
    capability?: string;
    model_ids?: string[];
    only_active?: boolean;
    test_prompt?: string;
    timeout_ms?: number;
  }) {
    const capabilityRaw = String(payload?.capability || 'image').trim().toLowerCase();
    if (!['chat', 'embedding', 'tts', 'stt', 'image', 'video'].includes(capabilityRaw)) {
      throw new BadRequestException(`invalid capability: ${capabilityRaw}`);
    }
    const onlyActive = payload?.only_active !== false;
    const timeoutMs = Number(payload?.timeout_ms ?? 12000);
    const modelIds = Array.isArray(payload?.model_ids)
      ? payload.model_ids.map((item) => String(item || '').trim()).filter((item) => !!item)
      : [];
    const modelIdSet = new Set(modelIds);
    const testPrompt = String(payload?.test_prompt || (capabilityRaw === 'image' ? '测试图片' : 'ping')).trim() || 'ping';
    const startedAt = new Date();

    const models = await this.aiRoutingService.listGlobalModels();
    const targetModels = models
      .filter((item: any) => String(item?.capability || '').toLowerCase() === capabilityRaw)
      .filter((item: any) => !onlyActive || item?.is_active !== false)
      .filter((item: any) => modelIdSet.size === 0 || modelIdSet.has(String(item?.id || '')));

    const items: Array<AiModelConnectivityTestResult & {
      model_id: string;
      capability: string;
      is_active: boolean;
      default_source_id: string;
    }> = [];

    for (const model of targetModels) {
      try {
        const testResult = await this.aiRoutingService.testModelConnectivity({
          model_id: model.id,
          source_id: model.default_source_id,
          test_prompt: testPrompt,
          timeout_ms: Number.isFinite(timeoutMs) ? Math.min(Math.max(Math.round(timeoutMs), 2000), 30000) : 12000,
        });
        items.push({
          ...testResult,
          model_id: model.id,
          capability: model.capability,
          is_active: model.is_active !== false,
          default_source_id: model.default_source_id,
        });
      } catch (error: any) {
        const statusCode = this.resolveAiModelBatchTestStatus(error);
        items.push({
          ok: false,
          status_code: statusCode,
          latency_ms: 0,
          endpoint_url: String(model?.endpoint_path || ''),
          model_key: String(model?.model_key || ''),
          upstream_model: String(model?.upstream_model || model?.model_key || ''),
          source_id: String(model?.default_source_id || ''),
          source_name: String(model?.default_source_name || ''),
          provider_type: String(model?.default_source_provider_type || ''),
          message: this.resolveAiModelBatchTestMessage(error),
          response_excerpt: '',
          model_id: String(model?.id || ''),
          capability: String(model?.capability || capabilityRaw),
          is_active: model?.is_active !== false,
          default_source_id: String(model?.default_source_id || ''),
        });
      }
    }

    const success = items.filter((item) => item.ok).length;
    const failed = items.length - success;

    return {
      capability: capabilityRaw,
      only_active: onlyActive,
      total: items.length,
      success,
      failed,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      items,
    };
  }

  async getGlobalAiUsageSummary(query: AiUsageSummaryQueryInput) {
    return this.aiRoutingService.getUsageSummary(query);
  }

  async getGlobalAiUsageBreakdown(query: AiUsageSummaryQueryInput) {
    return this.aiRoutingService.getUsageBreakdown(query);
  }

  async getAppAiUsageSummary(appId: string, query: AiUsageSummaryQueryInput) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.getUsageSummary({
      ...query,
      app_id: appId,
    });
  }

  async getAppAiUsageBreakdown(appId: string, query: AiUsageSummaryQueryInput) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.getUsageBreakdown({
      ...query,
      app_id: appId,
    });
  }

  private resolveAiModelBatchTestStatus(error: unknown): number | null {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    const rawStatus = Number((error as any)?.status);
    return Number.isFinite(rawStatus) ? rawStatus : null;
  }

  private resolveAiModelBatchTestMessage(error: unknown): string {
    if (error instanceof HttpException) {
      const response = error.getResponse() as any;
      if (typeof response === 'string' && response.trim()) {
        return response;
      }
      if (response?.message) {
        return Array.isArray(response.message) ? response.message.join('; ') : String(response.message);
      }
      return error.message || '模型测试失败';
    }
    const message = (error as any)?.message;
    return String(message || '模型测试失败');
  }

  async listGlobalAiUsageLogs(query: AiUsageLogsQueryInput) {
    return this.aiRoutingService.listUsageLogs(query);
  }

  async listAppAiUsageLogs(appId: string, query: AiUsageLogsQueryInput) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.listUsageLogs({
      ...query,
      app_id: appId,
    });
  }

  async listAppAiModelRoutes(appId: string) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.listAppModelRoutes(appId);
  }

  async upsertAppAiModelRoute(appId: string, modelId: string, actorUserId: string, payload: AiAppModelRouteInput) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.upsertAppModelRoute(appId, modelId, actorUserId, payload);
  }

  async deleteAppAiModelRoute(appId: string, modelId: string) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.deleteAppModelRoute(appId, modelId);
  }

  async upsertAppAiModelVisibility(
    appId: string,
    modelId: string,
    actorUserId: string,
    payload: AiAppModelVisibilityInput,
  ) {
    const app = await this.ensureAppExists(appId);
    const result = await this.aiRoutingService.upsertAppModelVisibility(appId, modelId, actorUserId, payload || {});
    this.aiChatService.clearModelPricingCacheForApp(app.slug);
    return result;
  }

  async listAppAiCapabilityDefaults(appId: string) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.listAppCapabilityDefaults(appId);
  }

  async upsertAppAiCapabilityDefault(appId: string, capability: string, actorUserId: string, payload: any) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.upsertAppCapabilityDefault(appId, capability, actorUserId, payload);
  }

  async deleteAppAiCapabilityDefault(appId: string, capability: string) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.deleteAppCapabilityDefault(appId, capability);
  }

  async listAppAiDefaultModelSlots(appId: string) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.listAppDefaultModelSlots(appId);
  }

  async upsertAppAiDefaultModelSlot(appId: string, slotKey: string, actorUserId: string, payload: any) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.upsertAppDefaultModelSlot(appId, slotKey, actorUserId, payload);
  }

  async deleteAppAiDefaultModelSlot(appId: string, slotKey: string) {
    await this.ensureAppExists(appId);
    return this.aiRoutingService.deleteAppDefaultModelSlot(appId, slotKey);
  }

  async getAppAiPointsSettings(appId: string) {
    await this.ensureAppExists(appId);
    return this.aiPointsService.getSettingsByAppId(appId);
  }

  async updateAppAiPointsSettings(appId: string, actorUserId: string, payload: Record<string, unknown>) {
    await this.ensureAppExists(appId);
    return this.aiPointsService.upsertSettingsByAppId(appId, actorUserId, payload);
  }

  async grantAppAiPoints(appId: string, actorUserId: string, payload: Record<string, unknown>) {
    await this.ensureAppExists(appId);
    const userId = String(payload?.user_id || '').trim();
    const email = String(payload?.email || '').trim();
    const phone = String(payload?.phone || '').trim();
    const amountRaw = Number(payload?.amount);
    const reason = String(payload?.reason || '').trim();

    if (!userId && !email && !phone) {
      throw new BadRequestException('请提供 user_id、email 或 phone 之一');
    }
    if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
      throw new BadRequestException('amount must be > 0');
    }
    const amount = this.roundTo2(amountRaw);
    if (amount <= 0) {
      throw new BadRequestException('amount must be > 0');
    }
    if (amount > 10_000_000) {
      throw new BadRequestException('amount is too large');
    }

    const targetUser = await this.findAppUserByIdentity(appId, {
      userId: userId || undefined,
      email: email || undefined,
      phone: phone || undefined,
    });
    if (!targetUser) {
      throw new NotFoundException('用户不存在或不属于当前应用');
    }

    const normalizedReason = reason.slice(0, 200);
    const referenceId = `manual_grant:${appId}:${targetUser.id}:${Date.now()}`;
    const result = await this.aiPointsService.creditPoints({
      app_id: appId,
      user_id: targetUser.id,
      amount,
      event_type: 'manual_grant',
      reference_type: 'platform_admin',
      reference_id: referenceId,
      metadata: {
        actor_user_id: actorUserId,
        reason: normalizedReason || null,
        source: 'platform_admin_manual_grant',
      },
    });

    return {
      app_id: appId,
      user_id: targetUser.id,
      user_email: targetUser.email,
      user_display_name: targetUser.displayName || targetUser.fullName || targetUser.email,
      amount,
      balance_before: result.balance_before,
      balance_after: result.balance_after,
      ledger_id: result.ledger_id,
      reason: normalizedReason || null,
      created_at: new Date().toISOString(),
    };
  }

  async listAppFeedbacks(
    appId: string,
    options?: {
      page?: number | string;
      page_size?: number | string;
      status?: string;
      priority?: string;
      assignee_user_id?: string;
      q?: string;
    },
  ) {
    await this.ensureAppExists(appId);
    return this.feedbackService.listFeedbacksByAppId(appId, options);
  }

  async getAppFeedback(appId: string, feedbackId: string) {
    await this.ensureAppExists(appId);
    return this.feedbackService.getFeedbackByAppId(appId, feedbackId);
  }

  async updateAppFeedback(
    appId: string,
    feedbackId: string,
    actorUserId: string,
    payload: Record<string, unknown>,
  ) {
    await this.ensureAppExists(appId);
    return this.feedbackService.updateFeedbackByAppId(appId, feedbackId, actorUserId, payload);
  }

  async addAppFeedbackComment(
    appId: string,
    feedbackId: string,
    actorUserId: string,
    payload: { body?: string; is_internal?: boolean },
  ) {
    await this.ensureAppExists(appId);
    return this.feedbackService.addFeedbackCommentByAppId(appId, feedbackId, actorUserId, payload);
  }

  async reviewAppFeedback(
    appId: string,
    feedbackId: string,
    actorUserId: string,
    payload: { action?: string; note?: string },
  ) {
    await this.ensureAppExists(appId);
    return this.feedbackService.reviewFeedbackByAppId(appId, feedbackId, actorUserId, payload);
  }

  async listAppSiteMessages(
    appId: string,
    options?: {
      type?: string;
      status?: string;
      category?: string;
      q?: string;
      page?: string | number;
      page_size?: string | number;
    },
  ) {
    await this.ensureAppExists(appId);
    return this.tenantSiteService.listAdminMessages(appId, options);
  }

  async updateAppSiteMessage(appId: string, messageId: string, actorUserId: string, payload: any) {
    await this.ensureAppExists(appId);
    return this.tenantSiteService.updateAdminMessage(appId, messageId, actorUserId, payload || {});
  }

  async listAppSiteCookieConsents(
    appId: string,
    options?: { region_mode?: string; page?: string | number; page_size?: string | number },
  ) {
    await this.ensureAppExists(appId);
    return this.tenantSiteService.listAdminCookieConsents(appId, options);
  }

  async listRedeemPackages(appId: string) {
    await this.ensureAppExists(appId);
    const payload = await this.redeemService.listPackagesByAppId(appId);
    return this.attachRedeemPackagePaymentProducts(appId, payload);
  }

  async createRedeemPackage(
    appId: string,
    actorUserId: string,
    payload: {
      name: string;
      description?: string;
      cover_url?: string;
      language_code?: string;
      price_cny?: number | string;
      is_active?: boolean;
      billing?: RedeemPackageBillingInput;
      grants: RedeemGrantInput[];
    },
  ) {
    await this.ensureAppExists(appId);
    const created = await this.redeemService.createPackageByAppId(appId, actorUserId, payload);
    return this.syncRedeemPackagePaymentProduct(appId, created, payload?.billing);
  }

  async updateRedeemPackage(
    appId: string,
    packageId: string,
    actorUserId: string,
    payload: {
      name?: string;
      description?: string;
      cover_url?: string;
      language_code?: string;
      price_cny?: number | string;
      is_active?: boolean;
      billing?: RedeemPackageBillingInput;
      grants?: RedeemGrantInput[];
    },
  ) {
    await this.ensureAppExists(appId);
    const updated = await this.redeemService.updatePackageByAppId(appId, packageId, actorUserId, payload);
    return this.syncRedeemPackagePaymentProduct(appId, updated, payload?.billing);
  }

  async deleteRedeemPackage(appId: string, packageId: string) {
    await this.ensureAppExists(appId);
    await this.deactivateRedeemPackagePaymentProduct(appId, packageId);
    return this.redeemService.deletePackageByAppId(appId, packageId);
  }

  async distributeRedeemPackageToUser(
    appId: string,
    packageId: string,
    actorUserId: string,
    payload: { user_id: string },
  ) {
    await this.ensureAppExists(appId);
    return this.redeemService.distributePackageToUserByAppId(appId, packageId, actorUserId, payload);
  }

  async createRedeemCodeBatch(
    appId: string,
    actorUserId: string,
    payload: {
      name?: string;
      note?: string;
      count: number;
      code_prefix?: string;
      max_uses?: number;
      expires_at?: string;
      package_id?: string;
      grants?: RedeemGrantInput[];
    },
  ) {
    await this.ensureAppExists(appId);
    return this.redeemService.createCodeBatchByAppId(appId, actorUserId, payload);
  }

  async listRedeemCodes(appId: string, page = 1, pageSize = 20, batchId?: string) {
    await this.ensureAppExists(appId);
    return this.redeemService.listCodesByAppId(appId, page, pageSize, batchId);
  }

  async listRedeemCodeRedemptions(appId: string, page = 1, pageSize = 20, batchId?: string) {
    await this.ensureAppExists(appId);
    return this.redeemService.listCodeRedemptionsByAppId(appId, page, pageSize, batchId);
  }

  async revokeRedeemCodeRedemption(
    appId: string,
    redemptionId: string,
    actorUserId: string,
    reason?: string,
  ) {
    await this.ensureAppExists(appId);
    return this.redeemService.revokeCodeRedemptionByAppId(appId, redemptionId, actorUserId, reason);
  }

  async listRedeemCodeBatches(appId: string, page = 1, pageSize = 20) {
    await this.ensureAppExists(appId);
    return this.redeemService.listCodeBatchesByAppId(appId, page, pageSize);
  }

  async getRedeemBatchTxt(
    appId: string,
    batchId: string,
    options?: {
      format?: 'code' | 'url';
      baseUrl?: string;
    },
  ) {
    await this.ensureAppExists(appId);
    return this.redeemService.buildBatchTxtByAppId(appId, batchId, options);
  }

  async voidRedeemCode(appId: string, code: string, reason?: string) {
    await this.ensureAppExists(appId);
    return this.redeemService.voidCodeByAppId(appId, code, reason);
  }

  private async ensureAppExists(appId: string) {
    const app = await this.prisma.app.findUnique({ where: { id: appId } });
    if (!app) {
      throw new NotFoundException('App not found');
    }
    if (this.isPlatformAppSlug(app.slug)) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  private async attachRedeemPackagePaymentProducts(appId: string, payload: any) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (!items.length) {
      return payload;
    }
    const hasTable = await this.isTableAvailable('payment_products');
    if (!hasTable) {
      return {
        ...payload,
        items: items.map((item: any) => ({ ...item, payment_product: null })),
      };
    }

    const codeList = items
      .map((item: any) => this.buildRedeemPackagePaymentCode(item?.id))
      .filter((code: string) => !!code);
    if (!codeList.length) {
      return payload;
    }

    const paymentRows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM payment_products
       WHERE app_id = $1::uuid
         AND code = ANY($2::varchar[])`,
      appId,
      codeList,
    ) as Promise<PaymentProductBridgeRow[]>);
    const paymentMap = new Map<string, PaymentProductBridgeRow>();
    paymentRows.forEach((row) => paymentMap.set(String(row.code || ''), row));

    return {
      ...payload,
      items: items.map((item: any) => {
        const code = this.buildRedeemPackagePaymentCode(item?.id);
        const linked = paymentMap.get(code);
        return {
          ...item,
          payment_product: linked ? this.serializeRedeemPackagePaymentProduct(linked) : null,
        };
      }),
    };
  }

  private serializeRedeemPackagePaymentProduct(row: PaymentProductBridgeRow) {
    return {
      id: row.id,
      code: row.code,
      type: String(row.type || 'ONE_TIME').toUpperCase(),
      status: String(row.status || 'ACTIVE').toUpperCase(),
      amount: this.normalizeCurrencyAmount(row.amount),
      membership_days: Math.max(Number(row.membership_days || 0), 0),
      points_topup: Math.max(Number(row.points_topup || 0), 0),
      sign_scene: row.sign_scene || null,
      sign_validity_period: row.sign_validity_period === null || row.sign_validity_period === undefined
        ? null
        : Number(row.sign_validity_period),
      period_type: row.period_type || null,
      period: row.period === null || row.period === undefined ? null : Number(row.period),
      execute_time: row.execute_time || null,
      updated_at: row.updated_at,
    };
  }

  private normalizeCurrencyAmount(value: unknown): number {
    const parsed = Number(value || 0);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return Math.round(parsed * 100) / 100;
  }

  private buildRedeemPackagePaymentCode(packageId: unknown): string {
    const raw = String(packageId || '').trim().replace(/-/g, '').toUpperCase();
    if (!raw) {
      return '';
    }
    return `PKG_${raw.slice(0, 32)}`;
  }

  private normalizeMembershipDaysFromGrants(grants: unknown): number {
    if (!Array.isArray(grants)) {
      return 0;
    }
    let maxDays = 0;
    for (const grant of grants) {
      const scope = String((grant as any)?.scope || '').trim();
      if (scope !== 'app_membership' && scope !== 'ai_membership') {
        continue;
      }
      const days = Number((grant as any)?.days || 0);
      if (Number.isFinite(days) && days > maxDays) {
        maxDays = Math.floor(days);
      }
    }
    return Math.max(maxDays, 0);
  }

  private normalizeRedeemBillingInput(input: unknown): {
    enabled?: boolean;
    type?: RedeemPackagePaymentType;
    status?: RedeemPackagePaymentStatus;
    membership_days?: number;
    sign_scene?: string | null;
    sign_validity_period?: number | null;
    period_type?: RedeemPackagePeriodType | null;
    period?: number | null;
    execute_time?: string | null;
  } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return {};
    }
    const obj = input as Record<string, unknown>;
    const typeRaw = String(obj.type || '').trim().toUpperCase();
    const statusRaw = String(obj.status || '').trim().toUpperCase();
    const periodTypeRaw = String(obj.period_type || '').trim().toUpperCase();
    const signSceneRaw = this.normalizeNullableString(obj.sign_scene);
    const executeTimeRaw = this.normalizeExecuteTime(obj.execute_time);
    const membershipDaysRaw = Number(obj.membership_days);
    const signValidityRaw = Number(obj.sign_validity_period);
    const periodRaw = Number(obj.period);

    const next: {
      enabled?: boolean;
      type?: RedeemPackagePaymentType;
      status?: RedeemPackagePaymentStatus;
      membership_days?: number;
      sign_scene?: string | null;
      sign_validity_period?: number | null;
      period_type?: RedeemPackagePeriodType | null;
      period?: number | null;
      execute_time?: string | null;
    } = {};

    if (obj.enabled !== undefined) {
      next.enabled = !!obj.enabled;
    }
    if (typeRaw === 'ONE_TIME' || typeRaw === 'RECURRING') {
      next.type = typeRaw as RedeemPackagePaymentType;
    }
    if (statusRaw === 'ACTIVE' || statusRaw === 'INACTIVE') {
      next.status = statusRaw as RedeemPackagePaymentStatus;
    }
    if (Number.isFinite(membershipDaysRaw) && membershipDaysRaw >= 0) {
      next.membership_days = Math.floor(membershipDaysRaw);
    }
    if (signSceneRaw !== null) {
      next.sign_scene = signSceneRaw;
    }
    if (obj.sign_validity_period !== undefined) {
      next.sign_validity_period = Number.isFinite(signValidityRaw) && signValidityRaw > 0
        ? Math.floor(signValidityRaw)
        : null;
    }
    if (obj.period_type !== undefined) {
      next.period_type = ['DAY', 'WEEK', 'MONTH', 'YEAR'].includes(periodTypeRaw)
        ? (periodTypeRaw as RedeemPackagePeriodType)
        : null;
    }
    if (obj.period !== undefined) {
      next.period = Number.isFinite(periodRaw) && periodRaw > 0 ? Math.floor(periodRaw) : null;
    }
    if (obj.execute_time !== undefined) {
      next.execute_time = executeTimeRaw;
    }
    return next;
  }

  private normalizeExecuteTime(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const trimmed = String(value).trim();
    if (!trimmed) {
      return null;
    }
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) {
      throw new BadRequestException('execute_time 必须为 HH:mm 或 HH:mm:ss');
    }
    const [hourPart, minutePart, secondPart] = trimmed.split(':');
    const hour = Number(hourPart);
    const minute = Number(minutePart);
    const second = secondPart === undefined ? 0 : Number(secondPart);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23 || !Number.isFinite(minute) || minute < 0 || minute > 59) {
      throw new BadRequestException('execute_time 时间范围不合法');
    }
    if (!Number.isFinite(second) || second < 0 || second > 59) {
      throw new BadRequestException('execute_time 秒值不合法');
    }
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
  }

  private async ensurePaymentProductsTableForRedeem() {
    const hasTable = await this.isTableAvailable('payment_products');
    if (hasTable) {
      return;
    }
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS payment_products (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
         code varchar(64) NOT NULL,
         name varchar(128) NOT NULL,
         description text NULL,
         type varchar(32) NOT NULL DEFAULT 'ONE_TIME',
         status varchar(32) NOT NULL DEFAULT 'ACTIVE',
         amount numeric(10, 2) NOT NULL,
         currency varchar(8) NOT NULL DEFAULT 'CNY',
         membership_days integer NOT NULL DEFAULT 0,
         points_topup integer NOT NULL DEFAULT 0,
         sign_scene varchar(64) NULL,
         sign_validity_period integer NULL DEFAULT 365,
         period_type varchar(16) NULL,
         period integer NULL,
         execute_time varchar(32) NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         UNIQUE (app_id, code)
       )`,
    );
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE payment_products
       ADD COLUMN IF NOT EXISTS points_topup integer NOT NULL DEFAULT 0`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_payment_products_app_created
       ON payment_products(app_id, created_at DESC)`,
    );
  }

  private async syncRedeemPackagePaymentProduct(appId: string, pkg: any, billingInput?: RedeemPackageBillingInput) {
    if (!pkg || !pkg.id) {
      return pkg;
    }
    await this.ensurePaymentProductsTableForRedeem();

    const paymentCode = this.buildRedeemPackagePaymentCode(pkg.id);
    if (!paymentCode) {
      return pkg;
    }
    const existingRows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM payment_products
       WHERE app_id = $1::uuid AND code = $2
       LIMIT 1`,
      appId,
      paymentCode,
    ) as Promise<PaymentProductBridgeRow[]>);
    const existing = existingRows[0] || null;
    const billing = this.normalizeRedeemBillingInput(billingInput);
    const amount = this.normalizeCurrencyAmount((pkg as any).price_cny);
    const inferredMembershipDays = this.normalizeMembershipDaysFromGrants((pkg as any).grants);
    const enabled = billing.enabled !== undefined
      ? billing.enabled
      : existing
        ? true
        : amount > 0;

    if (!enabled && !existing) {
      return {
        ...pkg,
        payment_product: null,
      };
    }

    const type = billing.type || (existing ? String(existing.type || 'ONE_TIME').toUpperCase() as RedeemPackagePaymentType : 'ONE_TIME');
    if (type !== 'ONE_TIME' && type !== 'RECURRING') {
      throw new BadRequestException('billing.type 仅支持 ONE_TIME / RECURRING');
    }

    const membershipDays = billing.membership_days !== undefined
      ? billing.membership_days
      : existing && existing.membership_days !== null && existing.membership_days !== undefined
        ? Number(existing.membership_days)
        : inferredMembershipDays;
    const status = enabled
      ? (billing.status || ((pkg as any).is_active === false ? 'INACTIVE' : 'ACTIVE'))
      : 'INACTIVE';

    let periodType: RedeemPackagePeriodType | null = null;
    let period: number | null = null;
    let signValidityPeriod: number | null = null;
    let executeTime: string | null = null;
    let signScene: string | null = billing.sign_scene !== undefined
      ? billing.sign_scene || null
      : existing
        ? this.normalizeNullableString(existing.sign_scene)
        : null;

    if (type === 'RECURRING') {
      periodType = billing.period_type || (existing ? (String(existing.period_type || '').toUpperCase() as RedeemPackagePeriodType) : null) || 'MONTH';
      if (!['DAY', 'WEEK', 'MONTH', 'YEAR'].includes(String(periodType || ''))) {
        throw new BadRequestException('billing.period_type 必须为 DAY/WEEK/MONTH/YEAR');
      }
      period = billing.period !== undefined
        ? billing.period
        : existing && existing.period !== null && existing.period !== undefined
          ? Number(existing.period)
          : 1;
      if (!Number.isFinite(Number(period)) || Number(period) <= 0) {
        throw new BadRequestException('billing.period 必须为大于 0 的整数');
      }
      signValidityPeriod = billing.sign_validity_period !== undefined
        ? billing.sign_validity_period
        : existing && existing.sign_validity_period !== null && existing.sign_validity_period !== undefined
          ? Number(existing.sign_validity_period)
          : 365;
      if (signValidityPeriod !== null && (!Number.isFinite(Number(signValidityPeriod)) || Number(signValidityPeriod) <= 0)) {
        throw new BadRequestException('billing.sign_validity_period 必须为大于 0 的整数');
      }
      executeTime = billing.execute_time !== undefined
        ? billing.execute_time
        : existing
          ? this.normalizeExecuteTime(existing.execute_time)
          : null;
      signScene = signScene || null;
      if (membershipDays <= 0) {
        throw new BadRequestException('周期扣款商品必须设置 membership_days > 0');
      }
    } else {
      periodType = null;
      period = null;
      signValidityPeriod = null;
      executeTime = null;
      signScene = null;
    }

    const nextName = String((pkg as any).name || '').trim() || '未命名产品';
    const nextDescription = this.normalizeNullableString((pkg as any).description);
    const nextStatus = status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';

    if (!existing) {
      const insertedRows = await (this.prisma.$queryRawUnsafe(
        `INSERT INTO payment_products (
           id, app_id, code, name, description, type, status, amount, currency,
           membership_days, sign_scene, sign_validity_period, period_type, period, execute_time, created_at, updated_at
         )
         VALUES (
           gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7::numeric, 'CNY',
           $8, $9, $10, $11, $12, $13, now(), now()
         )
         RETURNING *`,
        appId,
        paymentCode,
        nextName,
        nextDescription,
        type,
        nextStatus,
        amount,
        Math.max(Math.floor(Number(membershipDays || 0)), 0),
        signScene,
        signValidityPeriod,
        periodType,
        period === null ? null : Math.max(Math.floor(Number(period || 0)), 1),
        executeTime,
      ) as Promise<PaymentProductBridgeRow[]>);
      return {
        ...pkg,
        payment_product: this.serializeRedeemPackagePaymentProduct(insertedRows[0]),
      };
    }

    const updatedRows = await (this.prisma.$queryRawUnsafe(
      `UPDATE payment_products
       SET name = $1,
           description = $2,
           type = $3,
           status = $4,
           amount = $5::numeric,
           membership_days = $6,
           sign_scene = $7,
           sign_validity_period = $8,
           period_type = $9,
           period = $10,
           execute_time = $11,
           updated_at = now()
       WHERE app_id = $12::uuid
         AND id = $13::uuid
       RETURNING *`,
      nextName,
      nextDescription,
      type,
      nextStatus,
      amount,
      Math.max(Math.floor(Number(membershipDays || 0)), 0),
      signScene,
      signValidityPeriod,
      periodType,
      period === null ? null : Math.max(Math.floor(Number(period || 0)), 1),
      executeTime,
      appId,
      existing.id,
    ) as Promise<PaymentProductBridgeRow[]>);
    return {
      ...pkg,
      payment_product: this.serializeRedeemPackagePaymentProduct(updatedRows[0] || existing),
    };
  }

  private async deactivateRedeemPackagePaymentProduct(appId: string, packageId: string) {
    const hasTable = await this.isTableAvailable('payment_products');
    if (!hasTable) {
      return;
    }
    const code = this.buildRedeemPackagePaymentCode(packageId);
    if (!code) {
      return;
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE payment_products
       SET status = 'INACTIVE', updated_at = now()
       WHERE app_id = $1::uuid AND code = $2`,
      appId,
      code,
    );
  }

  private async ensureSuperAdmin(userId: string) {
    const user = await this.ensureAdminUser(userId);
    const adminType = String(user.adminType || '').toUpperCase();
    if (adminType !== 'SUPER_ADMIN') {
      throw new ForbiddenException('super admin required');
    }
    return user;
  }

  private async ensureAdminUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, adminType: true, deletedAt: true, isActive: true },
    });
    if (!user || user.deletedAt || !user.isActive) {
      throw new NotFoundException('Admin user not found');
    }
    const role = String(user.role || '').toUpperCase();
    if (role !== 'ADMIN') {
      throw new ForbiddenException('admin required');
    }
    return user;
  }

  private async ensureWechatOpenAppSchema() {
    if (!this.wechatOpenAppSchemaEnsured) {
      this.wechatOpenAppSchemaEnsured = this.initializeWechatOpenAppSchema().catch((error) => {
        this.wechatOpenAppSchemaEnsured = null;
        throw error;
      });
    }
    await this.wechatOpenAppSchemaEnsured;
  }

  private async ensureGoogleOAuthClientSchema() {
    if (!this.googleOAuthClientSchemaEnsured) {
      this.googleOAuthClientSchemaEnsured = this.initializeGoogleOAuthClientSchema().catch((error) => {
        this.googleOAuthClientSchemaEnsured = null;
        throw error;
      });
    }
    await this.googleOAuthClientSchemaEnsured;
  }

  private async ensureGitHubOAuthAppSchema() {
    if (!this.githubOAuthAppSchemaEnsured) {
      this.githubOAuthAppSchemaEnsured = this.initializeGitHubOAuthAppSchema().catch((error) => {
        this.githubOAuthAppSchemaEnsured = null;
        throw error;
      });
    }
    await this.githubOAuthAppSchemaEnsured;
  }

  private async ensurePaymentMethodSchema() {
    if (!this.paymentMethodSchemaEnsured) {
      this.paymentMethodSchemaEnsured = this.initializePaymentMethodSchema().catch((error) => {
        this.paymentMethodSchemaEnsured = null;
        throw error;
      });
    }
    await this.paymentMethodSchemaEnsured;
  }

  private async initializeWechatOpenAppSchema() {
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS wechat_open_apps (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         name varchar(128) NOT NULL,
         app_id varchar(128) NOT NULL,
         app_secret text NOT NULL,
         is_active boolean NOT NULL DEFAULT true,
         created_by_user_id uuid NULL,
         updated_by_user_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_open_apps_name_unique
       ON wechat_open_apps(LOWER(name))`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_open_apps_appid_unique
       ON wechat_open_apps(LOWER(app_id))`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_wechat_open_apps_active
       ON wechat_open_apps(is_active, updated_at DESC)`,
    );
  }

  private async initializeGoogleOAuthClientSchema() {
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS google_oauth_clients (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         name varchar(128) NOT NULL,
         client_id varchar(255) NOT NULL,
         client_secret text NULL,
         is_active boolean NOT NULL DEFAULT true,
         created_by_user_id uuid NULL,
         updated_by_user_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_google_oauth_clients_name_unique
       ON google_oauth_clients(LOWER(name))`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_google_oauth_clients_client_id_unique
       ON google_oauth_clients(LOWER(client_id))`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_google_oauth_clients_active
       ON google_oauth_clients(is_active, updated_at DESC)`,
    );
  }

  private async initializeGitHubOAuthAppSchema() {
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS github_oauth_apps (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         name varchar(128) NOT NULL,
         client_id varchar(255) NOT NULL,
         client_secret text NOT NULL,
         is_active boolean NOT NULL DEFAULT true,
         created_by_user_id uuid NULL,
         updated_by_user_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_github_oauth_apps_name_unique
       ON github_oauth_apps(LOWER(name))`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_github_oauth_apps_client_id_unique
       ON github_oauth_apps(LOWER(client_id))`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_github_oauth_apps_active
       ON github_oauth_apps(is_active, updated_at DESC)`,
    );
  }

  private async initializePaymentMethodSchema() {
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS platform_payment_methods (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         provider_type varchar(32) NOT NULL,
         name varchar(128) NOT NULL,
         is_active boolean NOT NULL DEFAULT true,
         is_default boolean NOT NULL DEFAULT false,
         config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
         notes text NULL,
         created_by_user_id uuid NULL,
         updated_by_user_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_payment_methods_name_unique
       ON platform_payment_methods(LOWER(name))`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_platform_payment_methods_provider
       ON platform_payment_methods(provider_type, is_default DESC, is_active DESC, updated_at DESC)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_payment_methods_provider_default_unique
       ON platform_payment_methods(provider_type)
       WHERE is_default = true`,
    );
  }

  private async getWechatOpenAppRow(openAppId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM wechat_open_apps
       WHERE id = $1::uuid
       LIMIT 1`,
      openAppId,
    ) as Promise<WechatOpenAppRow[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Wechat open app not found');
    }
    return row;
  }

  private async getGoogleOAuthClientRow(clientRowId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         g.*,
         p.name AS outbound_proxy_name,
         p.protocol AS outbound_proxy_protocol,
         p.status AS outbound_proxy_status,
         p.latency_ms AS outbound_proxy_latency_ms,
         p.detected_ip AS outbound_proxy_detected_ip,
         p.region AS outbound_proxy_region
       FROM google_oauth_clients g
       LEFT JOIN outbound_proxies p ON p.id = g.outbound_proxy_id
       WHERE g.id = $1::uuid
       LIMIT 1`,
      clientRowId,
    ) as Promise<GoogleOAuthClientRow[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Google OAuth client not found');
    }
    return row;
  }

  private async getGitHubOAuthAppRow(appRowId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM github_oauth_apps
       WHERE id = $1::uuid
       LIMIT 1`,
      appRowId,
    ) as Promise<GitHubOAuthAppRow[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('GitHub OAuth app not found');
    }
    return row;
  }

  private async getPaymentMethodRow(methodId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_payment_methods
       WHERE id = $1::uuid
       LIMIT 1`,
      methodId,
    ) as Promise<PlatformPaymentMethodRow[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('payment method not found');
    }
    return row;
  }

  private async getAppleLoginCredentialRow(credentialId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, name, bundle_id, service_id, team_id, key_id, issuer_id, private_key, environment, is_active,
              created_by_user_id, updated_by_user_id, created_at, updated_at
         FROM apple_login_credentials
        WHERE id = $1::uuid
        LIMIT 1`,
      credentialId,
    ) as Promise<AppleLoginCredentialRow[]>);
    if (!rows[0]) {
      throw new NotFoundException('Apple credential not found');
    }
    return rows[0];
  }

  private normalizeAppleLoginCredentialPayload(payload: any, updating: boolean) {
    const name = String(payload.name || '').trim();
    const bundleId = String(payload.bundle_id || payload.bundleId || '').trim();
    const teamId = String(payload.team_id || payload.teamId || '').trim();
    const environment = String(payload.environment || 'PRODUCTION').trim().toUpperCase() === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION';
    const privateKey = String(payload.private_key || payload.privateKey || '').trim();
    if (!name) throw new BadRequestException('name is required');
    if (!bundleId) throw new BadRequestException('bundle_id is required');
    if (!teamId) throw new BadRequestException('team_id is required');
    if (!updating && !privateKey) throw new BadRequestException('private_key is required');
    return {
      name,
      bundle_id: bundleId,
      service_id: String(payload.service_id || payload.serviceId || '').trim() || null,
      team_id: teamId,
      key_id: String(payload.key_id || payload.keyId || '').trim() || null,
      issuer_id: String(payload.issuer_id || payload.issuerId || '').trim() || null,
      private_key: privateKey || null,
      environment,
      is_active: payload.is_active !== false,
    };
  }

  private serializeAppleLoginCredential(row: AppleLoginCredentialRow) {
    return {
      id: row.id,
      name: row.name,
      bundle_id: row.bundle_id,
      service_id: row.service_id,
      team_id: row.team_id,
      key_id: row.key_id,
      issuer_id: row.issuer_id,
      environment: row.environment,
      is_active: row.is_active,
      has_private_key: !!String(row.private_key || '').trim(),
      private_key_masked: this.maskSecret(row.private_key),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private normalizePaymentProviderType(value: unknown): PlatformPaymentMethodType {
    const normalized = String(value || '')
      .trim()
      .toUpperCase();
    if (!['ALIPAY', 'WECHAT', 'STRIPE', 'PADDLE', 'LEMONSQUEEZY', 'APPLE_IAP'].includes(normalized)) {
      throw new BadRequestException('provider_type must be ALIPAY, WECHAT, STRIPE, PADDLE, LEMONSQUEEZY or APPLE_IAP');
    }
    return normalized as PlatformPaymentMethodType;
  }

  private normalizePaymentMethodConfig(providerType: PlatformPaymentMethodType, config: Record<string, unknown>) {
    const raw = asPlainObject(config);
    if (providerType === 'ALIPAY') {
      return {
        enabled: this.parseBooleanLike(raw.enabled, true),
        sandbox_debug: this.parseBooleanLike(raw.sandbox_debug, false),
        gateway_url: String(raw.gateway_url || '').trim() || 'https://openapi.alipay.com/gateway.do',
        app_id: String(raw.app_id || '').trim(),
        private_key: String(raw.private_key || '').trim(),
        alipay_public_key: String(raw.alipay_public_key || '').trim(),
        sign_type: String(raw.sign_type || 'RSA2').trim() || 'RSA2',
        notify_url: String(raw.notify_url || '').trim(),
        return_url: String(raw.return_url || '').trim(),
        agreement_notify_url: String(raw.agreement_notify_url || '').trim(),
        agreement_return_url: String(raw.agreement_return_url || '').trim(),
      };
    }
    if (providerType === 'STRIPE') {
      return {
        enabled: this.parseBooleanLike(raw.enabled, true),
        mode: String(raw.mode || 'test').trim().toLowerCase() === 'live' ? 'live' : 'test',
        api_base_url: String(raw.api_base_url || '').trim() || 'https://api.stripe.com',
        publishable_key: String(raw.publishable_key || '').trim(),
        secret_key: String(raw.secret_key || '').trim(),
        webhook_secret: String(raw.webhook_secret || '').trim(),
        success_url: String(raw.success_url || '').trim(),
        cancel_url: String(raw.cancel_url || '').trim(),
      };
    }
    if (providerType === 'PADDLE') {
      return {
        enabled: this.parseBooleanLike(raw.enabled, true),
        mode: String(raw.mode || 'sandbox').trim().toLowerCase() === 'live' ? 'live' : 'sandbox',
        api_base_url: String(raw.api_base_url || '').trim() || 'https://sandbox-api.paddle.com',
        client_token: String(raw.client_token || '').trim(),
        api_key: String(raw.api_key || '').trim(),
        webhook_secret: String(raw.webhook_secret || '').trim(),
        default_price_id: String(raw.default_price_id || '').trim(),
        success_url: String(raw.success_url || '').trim(),
        cancel_url: String(raw.cancel_url || '').trim(),
      };
    }
    if (providerType === 'LEMONSQUEEZY') {
      return {
        enabled: this.parseBooleanLike(raw.enabled, true),
        api_base_url: String(raw.api_base_url || '').trim() || 'https://api.lemonsqueezy.com',
        store_id: String(raw.store_id || '').trim(),
        api_key: String(raw.api_key || '').trim(),
        signing_secret: String(raw.signing_secret || '').trim(),
        default_variant_id: String(raw.default_variant_id || '').trim(),
        success_url: String(raw.success_url || '').trim(),
        cancel_url: String(raw.cancel_url || '').trim(),
      };
    }
    if (providerType === 'APPLE_IAP') {
      return {
        enabled: this.parseBooleanLike(raw.enabled, true),
        environment: String(raw.environment || 'PRODUCTION').trim().toUpperCase() === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION',
        bundle_id: String(raw.bundle_id || '').trim(),
        app_apple_id: String(raw.app_apple_id || '').trim(),
        issuer_id: String(raw.issuer_id || '').trim(),
        key_id: String(raw.key_id || '').trim(),
        private_key: String(raw.private_key || '').trim(),
        root_certificates_pem: String(raw.root_certificates_pem || '').trim(),
      };
    }
    return {
      enabled: this.parseBooleanLike(raw.enabled, true),
      gateway_url: String(raw.gateway_url || '').trim() || 'https://api.mch.weixin.qq.com',
      app_id: String(raw.app_id || '').trim(),
      mch_id: String(raw.mch_id || '').trim(),
      api_key: String(raw.api_key || '').trim(),
      notify_url: String(raw.notify_url || '').trim(),
    };
  }

  private assertPaymentMethodConfig(providerType: PlatformPaymentMethodType, config: Record<string, unknown>) {
    const enabled = this.parseBooleanLike(config.enabled, true);
    if (!enabled) {
      return;
    }
    if (providerType === 'ALIPAY') {
      const appId = String(config.app_id || '').trim();
      const privateKey = String(config.private_key || '').trim();
      const alipayPublicKey = String(config.alipay_public_key || '').trim();
      if (!appId || !privateKey || !alipayPublicKey) {
        throw new BadRequestException('支付宝配置缺失：enabled=true 时必须填写 app_id / private_key / alipay_public_key');
      }
      return;
    }
    if (providerType === 'STRIPE') {
      const secretKey = String(config.secret_key || '').trim();
      const webhookSecret = String(config.webhook_secret || '').trim();
      if (!secretKey || !webhookSecret) {
        throw new BadRequestException('Stripe 配置缺失：enabled=true 时必须填写 secret_key / webhook_secret');
      }
      return;
    }
    if (providerType === 'PADDLE') {
      const apiKey = String(config.api_key || '').trim();
      const webhookSecret = String(config.webhook_secret || '').trim();
      if (!apiKey || !webhookSecret) {
        throw new BadRequestException('Paddle 配置缺失：enabled=true 时必须填写 api_key / webhook_secret');
      }
      return;
    }
    if (providerType === 'LEMONSQUEEZY') {
      const apiKey = String(config.api_key || '').trim();
      const storeId = String(config.store_id || '').trim();
      const signingSecret = String(config.signing_secret || '').trim();
      if (!apiKey || !storeId || !signingSecret) {
        throw new BadRequestException('LemonSqueezy 配置缺失：enabled=true 时必须填写 api_key / store_id / signing_secret');
      }
      return;
    }
    if (providerType === 'APPLE_IAP') {
      const bundleId = String(config.bundle_id || '').trim();
      const issuerId = String(config.issuer_id || '').trim();
      const keyId = String(config.key_id || '').trim();
      const privateKey = String(config.private_key || '').trim();
      if (!bundleId || !issuerId || !keyId || !privateKey) {
        throw new BadRequestException('Apple IAP 配置缺失：enabled=true 时必须填写 bundle_id / issuer_id / key_id / private_key');
      }
      return;
    }
    const appId = String(config.app_id || '').trim();
    const mchId = String(config.mch_id || '').trim();
    const apiKey = String(config.api_key || '').trim();
    if (!appId || !mchId || !apiKey) {
      throw new BadRequestException('微信支付配置缺失：enabled=true 时必须填写 app_id / mch_id / api_key');
    }
  }

  private serializePaymentMethod(row: PlatformPaymentMethodRow) {
    const cfg = asPlainObject(row.config_json);
    const base = {
      id: row.id,
      provider_type: row.provider_type,
      name: row.name,
      is_active: row.is_active,
      is_default: row.is_default,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (row.provider_type === 'ALIPAY') {
      return {
        ...base,
        config: {
          enabled: this.parseBooleanLike(cfg.enabled, true),
          sandbox_debug: this.parseBooleanLike(cfg.sandbox_debug, false),
          gateway_url: String(cfg.gateway_url || '').trim(),
          app_id: String(cfg.app_id || '').trim(),
          sign_type: String(cfg.sign_type || 'RSA2').trim() || 'RSA2',
          notify_url: String(cfg.notify_url || '').trim(),
          return_url: String(cfg.return_url || '').trim(),
          agreement_notify_url: String(cfg.agreement_notify_url || '').trim(),
          agreement_return_url: String(cfg.agreement_return_url || '').trim(),
          has_private_key: !!String(cfg.private_key || '').trim(),
          has_alipay_public_key: !!String(cfg.alipay_public_key || '').trim(),
          private_key_masked: this.maskSecret(cfg.private_key),
          alipay_public_key_masked: this.maskSecret(cfg.alipay_public_key),
        },
      };
    }
    if (row.provider_type === 'STRIPE') {
      return {
        ...base,
        config: {
          enabled: this.parseBooleanLike(cfg.enabled, true),
          mode: String(cfg.mode || 'test').trim(),
          api_base_url: String(cfg.api_base_url || '').trim(),
          publishable_key: String(cfg.publishable_key || '').trim(),
          success_url: String(cfg.success_url || '').trim(),
          cancel_url: String(cfg.cancel_url || '').trim(),
          has_secret_key: !!String(cfg.secret_key || '').trim(),
          has_webhook_secret: !!String(cfg.webhook_secret || '').trim(),
          secret_key_masked: this.maskSecret(cfg.secret_key),
          webhook_secret_masked: this.maskSecret(cfg.webhook_secret),
        },
      };
    }
    if (row.provider_type === 'PADDLE') {
      return {
        ...base,
        config: {
          enabled: this.parseBooleanLike(cfg.enabled, true),
          mode: String(cfg.mode || 'sandbox').trim(),
          api_base_url: String(cfg.api_base_url || '').trim(),
          client_token: String(cfg.client_token || '').trim(),
          default_price_id: String(cfg.default_price_id || '').trim(),
          success_url: String(cfg.success_url || '').trim(),
          cancel_url: String(cfg.cancel_url || '').trim(),
          has_api_key: !!String(cfg.api_key || '').trim(),
          has_webhook_secret: !!String(cfg.webhook_secret || '').trim(),
          api_key_masked: this.maskSecret(cfg.api_key),
          webhook_secret_masked: this.maskSecret(cfg.webhook_secret),
        },
      };
    }
    if (row.provider_type === 'LEMONSQUEEZY') {
      return {
        ...base,
        config: {
          enabled: this.parseBooleanLike(cfg.enabled, true),
          api_base_url: String(cfg.api_base_url || '').trim(),
          store_id: String(cfg.store_id || '').trim(),
          default_variant_id: String(cfg.default_variant_id || '').trim(),
          success_url: String(cfg.success_url || '').trim(),
          cancel_url: String(cfg.cancel_url || '').trim(),
          has_api_key: !!String(cfg.api_key || '').trim(),
          has_signing_secret: !!String(cfg.signing_secret || '').trim(),
          api_key_masked: this.maskSecret(cfg.api_key),
          signing_secret_masked: this.maskSecret(cfg.signing_secret),
        },
      };
    }
    if (row.provider_type === 'APPLE_IAP') {
      return {
        ...base,
        config: {
          enabled: this.parseBooleanLike(cfg.enabled, true),
          environment: String(cfg.environment || 'PRODUCTION').trim(),
          bundle_id: String(cfg.bundle_id || '').trim(),
          app_apple_id: String(cfg.app_apple_id || '').trim(),
          issuer_id: String(cfg.issuer_id || '').trim(),
          key_id: String(cfg.key_id || '').trim(),
          has_private_key: !!String(cfg.private_key || '').trim(),
          has_root_certificates_pem: !!String(cfg.root_certificates_pem || '').trim(),
          private_key_masked: this.maskSecret(cfg.private_key),
          root_certificates_pem_masked: this.maskSecret(cfg.root_certificates_pem),
        },
      };
    }
    return {
      ...base,
      config: {
        enabled: this.parseBooleanLike(cfg.enabled, true),
        gateway_url: String(cfg.gateway_url || '').trim(),
        app_id: String(cfg.app_id || '').trim(),
        mch_id: String(cfg.mch_id || '').trim(),
        notify_url: String(cfg.notify_url || '').trim(),
        has_api_key: !!String(cfg.api_key || '').trim(),
        api_key_masked: this.maskSecret(cfg.api_key),
      },
    };
  }

  private parseBooleanLike(value: unknown, fallback: boolean) {
    if (typeof value === 'boolean') return value;
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
    return fallback;
  }

  private normalizeOptionalUuid(value: unknown, fieldName: string) {
    const raw = String(value || '').trim();
    if (!raw) {
      return null;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
      throw new BadRequestException(`${fieldName} must be a uuid`);
    }
    return raw;
  }

  private async ensureOutboundProxyExists(proxyId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM outbound_proxies WHERE id = $1::uuid LIMIT 1`,
      proxyId,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) {
      throw new BadRequestException('选择的代理不存在');
    }
  }

  private describeNetworkFailure(error: unknown, timeoutMs: number) {
    const name = String((error as { name?: unknown })?.name || '').trim();
    const message = String((error as { message?: unknown })?.message || '').trim();
    const lower = message.toLowerCase();
    const isTimeout =
      name === 'TimeoutError' ||
      lower.includes('aborted due to timeout') ||
      lower.includes('request timed out');
    if (isTimeout) {
      return `请求超时（${timeoutMs}ms）`;
    }
    return message ? message.slice(0, 240) : 'network error';
  }

  private serializeWechatOpenApp(row: WechatOpenAppRow) {
    return {
      id: row.id,
      name: row.name,
      app_id: row.app_id,
      is_active: row.is_active,
      has_app_secret: !!row.app_secret,
      app_secret_masked: this.maskSecret(row.app_secret),
      created_by_user_id: row.created_by_user_id,
      updated_by_user_id: row.updated_by_user_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private serializeGoogleOAuthClient(row: GoogleOAuthClientRow) {
    return {
      id: row.id,
      name: row.name,
      client_id: row.client_id,
      outbound_proxy_id: row.outbound_proxy_id,
      outbound_proxy: row.outbound_proxy_id
        ? {
            id: row.outbound_proxy_id,
            name: row.outbound_proxy_name || '',
            protocol: row.outbound_proxy_protocol || '',
            status: row.outbound_proxy_status || '',
            latency_ms: row.outbound_proxy_latency_ms ?? null,
            detected_ip: row.outbound_proxy_detected_ip || null,
            region: row.outbound_proxy_region || null,
          }
        : null,
      is_active: row.is_active,
      has_client_secret: !!row.client_secret,
      client_secret_masked: this.maskSecret(row.client_secret),
      created_by_user_id: row.created_by_user_id,
      updated_by_user_id: row.updated_by_user_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private serializeGitHubOAuthApp(row: GitHubOAuthAppRow) {
    return {
      id: row.id,
      name: row.name,
      client_id: row.client_id,
      is_active: row.is_active,
      has_client_secret: !!row.client_secret,
      client_secret_masked: this.maskSecret(row.client_secret),
      created_by_user_id: row.created_by_user_id,
      updated_by_user_id: row.updated_by_user_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private maskSecret(value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.length <= 8) return `${raw.slice(0, 2)}***`;
    return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
  }

  private serializeApp(app: any) {
    const wechatConfig = pickWechatSettings(app.settings?.extraJson);
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      status: app.status,
      created_at: app.createdAt,
      updated_at: app.updatedAt,
      slug_aliases: (app.slugAliases || []).map((item: any) => (typeof item === 'string' ? item : item.slug)).filter(Boolean),
      domains: (app.domains || []).map((domain: any) => ({
        id: domain.id,
        domain: domain.domain,
        domain_type: domain.domainType,
        is_primary: domain.isPrimary,
      })),
      settings: app.settings
        ? {
            id: app.settings.id,
            app_url: app.settings.appUrl,
            brand_name: app.settings.brandName,
            sender_name: app.settings.senderName,
            sender_nickname: app.settings.senderNickname,
            wechat_redirect_uri: app.settings.wechatRedirectUri,
            wechat_open_app_ref_id: wechatConfig.wechat_open_app_ref_id,
            wechat_open_app_id: wechatConfig.wechat_open_app_id,
            wechat_open_app_secret: wechatConfig.wechat_open_app_secret,
            google_oauth_client_ref_id: wechatConfig.google_oauth_client_ref_id,
            google_client_id: wechatConfig.google_client_id,
            github_oauth_app_ref_id: wechatConfig.github_oauth_app_ref_id,
            github_client_id: wechatConfig.github_client_id,
            apple_login_credential_ref_id: wechatConfig.apple_login_credential_ref_id,
            ios_app_attest_mode: wechatConfig.ios_app_attest_mode,
            apple_app_apple_id: wechatConfig.apple_app_apple_id,
            payment_method_ref_ids: wechatConfig.payment_method_ref_ids,
            sms_template_ref_id: wechatConfig.sms_template_ref_id,
            sms_provider_ref_id: wechatConfig.sms_provider_ref_id,
            sms_signature_ref_id: wechatConfig.sms_signature_ref_id,
            alipay_notify_url: app.settings.alipayNotifyUrl,
            alipay_agreement_notify_url: app.settings.alipayAgreementNotifyUrl,
            extra_json: app.settings.extraJson,
            notes: app.settings.notes,
            email_primary_color: app.settings.emailPrimaryColor,
            email_secondary_color: app.settings.emailSecondaryColor,
            email_greeting: app.settings.emailGreeting,
            email_code_label: app.settings.emailCodeLabel,
            email_expire_text: app.settings.emailExpireText,
            email_footer_text: app.settings.emailFooterText,
          }
        : null,
    };
  }

  private parsePermissionArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((item) => typeof item === 'string');
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.filter((item) => typeof item === 'string');
        }
      } catch {
        return [];
      }
    }
    return [];
  }

  private normalizeAdminPermissions(value: unknown): string[] {
    const invalid = findInvalidPlatformAppAdminPermissions(value);
    if (invalid.length > 0) {
      throw new BadRequestException(`invalid permission keys: ${invalid.join(', ')}`);
    }

    return normalizePlatformAppAdminPermissions(value);
  }

  private async fetchAdminPermissions(appId: string, adminUserId: string): Promise<string[]> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, allowed_pages FROM admin_page_permissions
       WHERE app_id = $1::uuid AND admin_user_id = $2::uuid LIMIT 1`,
      appId,
      adminUserId,
    ) as Promise<AdminPermissionRow[]>);
    return normalizePlatformAppAdminPermissions(this.parsePermissionArray(rows[0]?.allowed_pages));
  }

  private async upsertAdminPermissions(appId: string, adminUserId: string, permissions: string[], actorUserId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, allowed_pages FROM admin_page_permissions WHERE app_id = $1::uuid AND admin_user_id = $2::uuid LIMIT 1`,
      appId,
      adminUserId,
    ) as Promise<AdminPermissionRow[]>);
    if (rows[0]) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE admin_page_permissions
         SET allowed_pages = $1::jsonb, updated_by_user_id = $2::uuid, updated_at = now()
         WHERE id = $3::uuid`,
        JSON.stringify(permissions || []),
        actorUserId,
        rows[0].id,
      );
    } else {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO admin_page_permissions (id, app_id, admin_user_id, allowed_pages, created_by_user_id, updated_by_user_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::jsonb, $4::uuid, $4::uuid)`,
        appId,
        adminUserId,
        JSON.stringify(permissions || []),
        actorUserId,
      );
    }
  }

  private resolveAnalyticsRange(query: TenantAnalyticsQuery) {
    const days = this.normalizePositiveInt(query.days, 30, 7, 365);
    const to = query.to ? this.parseDateOrThrow(query.to, 'invalid to date') : new Date();
    const from = query.from
      ? this.parseDateOrThrow(query.from, 'invalid from date')
      : new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be <= to');
    }
    const recentLimit = this.normalizePositiveInt(query.recent_limit, 20, 5, 100);
    const page = this.normalizePositiveInt(query.page, 1, 1, 100000);
    const pageSize = this.normalizePositiveInt(query.page_size, 20, 1, 100);
    const granularity = this.normalizeAnalyticsGranularity(query.granularity, days);
    const timezone = this.normalizeTimezone(query.timezone);
    return { from, to, days, recentLimit, page, pageSize, granularity, timezone };
  }

  private parseDateOrThrow(value: string, errorMessage: string): Date {
    const parsed = new Date(String(value || '').trim());
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(errorMessage);
    }
    return parsed;
  }

  private normalizePositiveInt(value: unknown, defaultValue: number, min: number, max: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return defaultValue;
    }
    const normalized = Math.floor(num);
    if (normalized < min) return min;
    if (normalized > max) return max;
    return normalized;
  }

  private normalizeAnalyticsGranularity(value: unknown, days: number): 'day' | 'week' | 'month' {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'day' || raw === 'week' || raw === 'month') {
      return raw;
    }
    if (days > 180) return 'month';
    if (days > 90) return 'week';
    return 'day';
  }

  private normalizeTimezone(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return 'Asia/Shanghai';
    return raw.slice(0, 64);
  }

  private async resolvePaymentsTableAvailability() {
    const [products, orders, agreements, deductions] = await Promise.all([
      this.isTableAvailable('payment_products'),
      this.isTableAvailable('alipay_orders'),
      this.isTableAvailable('alipay_agreements'),
      this.isTableAvailable('alipay_deductions'),
    ]);
    return { products, orders, agreements, deductions };
  }

  private async isTableAvailable(tableName: string): Promise<boolean> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT to_regclass($1)::text AS table_ref`,
      `public.${tableName}`,
    ) as Promise<Array<{ table_ref: string | null }>>);
    return !!rows[0]?.table_ref;
  }

  private normalizeSlugAliases(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const aliases = value
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean);
    const uniqueAliases = [...new Set(aliases)];
    for (const alias of uniqueAliases) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(alias)) {
        throw new BadRequestException('路由标识只能使用小写字母、数字和连字符');
      }
      if (alias === 'api') {
        throw new BadRequestException('api 不能作为路由标识');
      }
      this.assertTenantSlugAllowed(alias);
    }
    return uniqueAliases;
  }

  private async listSlugAliasesForApps(appIds: string[]) {
    const map = new Map<string, string[]>();
    const ids = [...new Set(appIds.filter(Boolean))];
    if (!ids.length || !(await this.isTableAvailable('app_slug_aliases'))) {
      return map;
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT app_id::text AS app_id, slug
       FROM app_slug_aliases
       WHERE app_id::text = ANY($1::text[])
         AND is_active = true
       ORDER BY slug ASC`,
      ids,
    ) as Promise<Array<{ app_id: string; slug: string }>>);
    rows.forEach((row) => {
      const list = map.get(row.app_id) || [];
      list.push(row.slug);
      map.set(row.app_id, list);
    });
    return map;
  }

  private async assertSlugNotUsedByAlias(slug: string) {
    if (!(await this.isTableAvailable('app_slug_aliases'))) {
      return;
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id::text AS id
       FROM app_slug_aliases
       WHERE LOWER(slug) = LOWER($1)
       LIMIT 1`,
      slug,
    ) as Promise<Array<{ id: string }>>);
    if (rows[0]) {
      throw new BadRequestException('App slug already exists');
    }
  }

  private async replaceAppSlugAliases(appId: string, primarySlug: string, value: unknown) {
    if (!(await this.isTableAvailable('app_slug_aliases'))) {
      throw new BadRequestException('路由标识数据表尚未就绪');
    }
    const aliases = this.normalizeSlugAliases(value);
    if (aliases.includes(String(primarySlug || '').trim().toLowerCase())) {
      throw new BadRequestException('附加标识不能和主标识相同');
    }
    for (const alias of aliases) {
      const appRows = await (this.prisma.$queryRawUnsafe(
        `SELECT id::text AS id
         FROM apps
         WHERE LOWER(slug) = LOWER($1)
         LIMIT 1`,
        alias,
      ) as Promise<Array<{ id: string }>>);
      if (appRows[0]) {
        throw new BadRequestException(`路由标识已被应用使用：${alias}`);
      }
      const aliasRows = await (this.prisma.$queryRawUnsafe(
        `SELECT app_id::text AS app_id
         FROM app_slug_aliases
         WHERE LOWER(slug) = LOWER($1)
           AND app_id <> $2::uuid
         LIMIT 1`,
        alias,
        appId,
      ) as Promise<Array<{ app_id: string }>>);
      if (aliasRows[0]) {
        throw new BadRequestException(`路由标识已存在：${alias}`);
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM app_slug_aliases WHERE app_id = $1::uuid`, appId);
      for (const alias of aliases) {
        await tx.$executeRawUnsafe(
          `INSERT INTO app_slug_aliases (id, app_id, slug, is_active, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2, true, now(), now())`,
          appId,
          alias,
        );
      }
    });
    clearAppSlugAliasCache();
  }

  private toFiniteInteger(value: unknown, defaultValue: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return defaultValue;
    }
    return Math.max(0, Math.floor(num));
  }

  private toFiniteNumber(value: unknown, defaultValue: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return defaultValue;
    }
    return num;
  }

  private normalizeNullableString(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const normalized = String(value).trim();
    return normalized || null;
  }

  private normalizePlaygroundPayload(value: unknown): Record<string, unknown> {
    if (!value) {
      return {};
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('payload must be an object');
    }
    return value as Record<string, unknown>;
  }

  private async resolvePlaygroundApp(appIdInput: unknown) {
    const appId = this.normalizeNullableString(appIdInput);
    if (!appId) {
      throw new BadRequestException('app_id is required');
    }
    const app = await this.prisma.app.findUnique({
      where: { id: appId },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
      },
    });
    if (!app) {
      throw new NotFoundException('app not found');
    }
    return app;
  }

  private serializeAiPlaygroundResult(route: ResolvedAiRoute, forwarded: ForwardedAiResponse) {
    const routeInfo = this.serializeAiPlaygroundRoute(route);
    if (!forwarded.stream && 'binary' in forwarded && forwarded.binary) {
      const contentType = this.normalizeNullableString(forwarded.headers?.['content-type']) || 'application/octet-stream';
      return {
        capability: route.capability,
        result_type: contentType.startsWith('audio/') ? 'audio' : 'binary',
        route: routeInfo,
        mime_type: contentType,
        bytes: forwarded.body.length,
        audio_base64: contentType.startsWith('audio/') ? forwarded.body.toString('base64') : null,
        binary_base64: forwarded.body.toString('base64'),
        response_excerpt: `${contentType} / ${forwarded.body.length} bytes`,
      };
    }

    const rawData = (!forwarded.stream && 'data' in forwarded ? forwarded.data : {}) as Record<string, unknown>;
    const audio = route.capability === 'tts' ? this.extractAiPlaygroundAudio(rawData) : null;
    const text = this.extractAiPlaygroundText(rawData);
    const images = route.capability === 'image' ? this.extractAiPlaygroundImages(rawData) : [];
    const videos = route.capability === 'video' ? this.extractAiPlaygroundVideos(rawData) : [];
    const embeddings = route.capability === 'embedding' ? this.extractAiPlaygroundEmbeddings(rawData) : [];
    const taskId = this.normalizeNullableString(rawData.task_id) || this.normalizeNullableString(rawData.id);
    const taskStatus = this.normalizeNullableString(rawData.task_status) || this.normalizeNullableString(rawData.status);
    const primaryVideo = videos[0]?.url || this.normalizeNullableString(rawData.video_url);
    const responseExcerpt = this.buildAiPlaygroundResponseExcerpt(rawData);

    return {
      capability: route.capability,
      result_type: this.resolveAiPlaygroundResultType(route.capability, { audio, text, images, videos, embeddings }),
      route: routeInfo,
      text,
      audio_base64: audio?.base64 || null,
      audio_url: audio?.url || null,
      audio_mime_type: audio?.mime_type || null,
      images,
      videos,
      video_url: primaryVideo || null,
      task_id: taskId,
      task_status: taskStatus,
      embedding_count: embeddings.length,
      embedding_dimensions: embeddings[0]?.length || 0,
      embedding_preview: embeddings[0]?.slice(0, 8) || [],
      raw_data: rawData,
      response_excerpt: responseExcerpt,
    };
  }

  private serializeAiPlaygroundRoute(route: ResolvedAiRoute) {
    return {
      app_id: route.app_id,
      app_slug: route.app_slug,
      model_id: route.model_id,
      model_key: route.model_key,
      display_name: route.display_name,
      capability: route.capability,
      source_id: route.source.id,
      source_name: route.source.name,
      provider_type: route.source.provider_type,
      upstream_model: route.upstream_model,
      endpoint_path: route.endpoint_path,
      api_type: route.api_type,
      execution_mode: route.execution_mode,
    };
  }

  private resolveAiPlaygroundResultType(
    capability: string,
    input: {
      audio: { base64?: string | null; url?: string | null; mime_type?: string | null } | null;
      text: string | null;
      images: Array<{ url?: string | null; b64_json?: string | null; mime_type?: string | null }>;
      videos: Array<{ url?: string | null; mime_type?: string | null }>;
      embeddings: number[][];
    },
  ): 'text' | 'audio' | 'image' | 'video' | 'embedding' | 'json' | 'binary' {
    if (capability === 'tts' && input.audio) {
      return 'audio';
    }
    if (capability === 'image' && input.images.length > 0) {
      return 'image';
    }
    if (capability === 'video') {
      return 'video';
    }
    if (capability === 'embedding') {
      return 'embedding';
    }
    if (input.text) {
      return 'text';
    }
    return 'json';
  }

  private buildAiPlaygroundResponseExcerpt(data: Record<string, unknown>): string {
    try {
      const json = JSON.stringify(data);
      return json.length > 4000 ? `${json.slice(0, 4000)}...` : json;
    } catch {
      return '[unserializable response]';
    }
  }

  private extractAiPlaygroundText(data: Record<string, unknown>): string | null {
    const directCandidates = [
      this.normalizeNullableString(data.text),
      this.normalizeNullableString(data.output_text),
      this.normalizeNullableString((data.output as Record<string, unknown> | undefined)?.text),
      this.normalizeNullableString((data.output as Record<string, unknown> | undefined)?.output_text),
      this.normalizeNullableString((data.choices as Array<Record<string, unknown>> | undefined)?.[0]?.text),
    ].filter((item): item is string => !!item);
    if (directCandidates[0]) {
      return directCandidates[0];
    }

    const firstChoice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (firstChoice && typeof firstChoice === 'object') {
      const message = (firstChoice as Record<string, unknown>).message;
      const resolved = this.stringifyAiTextContent(message);
      if (resolved) {
        return resolved;
      }
    }

    return this.stringifyAiTextContent(data.content) || null;
  }

  private stringifyAiTextContent(value: unknown): string | null {
    if (typeof value === 'string') {
      return value.trim() || null;
    }
    if (Array.isArray(value)) {
      const parts = value
        .map((item) => {
          if (typeof item === 'string') {
            return item.trim();
          }
          if (item && typeof item === 'object') {
            const record = item as Record<string, unknown>;
            return this.normalizeNullableString(record.text) || this.normalizeNullableString(record.content);
          }
          return null;
        })
        .filter((item): item is string => !!item);
      return parts.length > 0 ? parts.join('\n') : null;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return this.normalizeNullableString(record.text)
        || this.normalizeNullableString(record.content)
        || this.stringifyAiTextContent(record.parts)
        || this.stringifyAiTextContent(record.items)
        || null;
    }
    return null;
  }

  private extractAiPlaygroundAudio(data: Record<string, unknown>) {
    const candidates = [
      this.normalizeNullableString(data.audio_url),
      this.normalizeNullableString((data.output as Record<string, unknown> | undefined)?.audio_url),
      this.normalizeNullableString(data.audio_base64),
      this.normalizeNullableString((data.output as Record<string, unknown> | undefined)?.audio_base64),
      this.normalizeNullableString((data.data as Record<string, unknown> | undefined)?.audio_base64),
      this.normalizeNullableString(data.audio),
    ].filter((item): item is string => !!item);
    const mimeFromPayload =
      this.normalizeNullableString(data.audio_mime_type)
      || this.normalizeNullableString((data.output as Record<string, unknown> | undefined)?.audio_mime_type)
      || this.normalizeNullableString(data.mime_type);

    for (const candidate of candidates) {
      const parsedDataUrl = candidate.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
      if (parsedDataUrl) {
        return {
          base64: parsedDataUrl[2].replace(/\s+/g, ''),
          url: null,
          mime_type: parsedDataUrl[1],
        };
      }
      if (/^https?:\/\//i.test(candidate)) {
        return {
          base64: null,
          url: candidate,
          mime_type: mimeFromPayload || null,
        };
      }
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(candidate)) {
        return {
          base64: candidate.replace(/\s+/g, ''),
          url: null,
          mime_type: mimeFromPayload || 'audio/mpeg',
        };
      }
    }
    return null;
  }

  private extractAiPlaygroundImages(data: Record<string, unknown>) {
    const groups = [
      Array.isArray(data.data) ? data.data : [],
      Array.isArray(data.images) ? data.images : [],
      Array.isArray((data.output as Record<string, unknown> | undefined)?.images)
        ? ((data.output as Record<string, unknown>).images as unknown[])
        : [],
    ];
    const items: Array<{ url?: string | null; b64_json?: string | null; mime_type?: string | null }> = [];
    for (const group of groups) {
      group.forEach((entry) => {
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const record = entry as Record<string, unknown>;
        const url = this.normalizeNullableString(record.url);
        const base64 = this.normalizeNullableString(record.b64_json) || this.normalizeNullableString(record.base64);
        if (!url && !base64) {
          return;
        }
        items.push({
          url,
          b64_json: base64,
          mime_type: this.normalizeNullableString(record.mime_type) || (base64 ? 'image/png' : null),
        });
      });
    }
    return items;
  }

  private extractAiPlaygroundVideos(data: Record<string, unknown>) {
    const output: Array<{ url?: string | null; mime_type?: string | null }> = [];
    const directVideoUrl = this.normalizeNullableString(data.video_url);
    if (directVideoUrl) {
      output.push({ url: directVideoUrl, mime_type: 'video/mp4' });
    }
    const groups = [
      Array.isArray(data.data) ? data.data : [],
      Array.isArray(data.videos) ? data.videos : [],
      Array.isArray((data.output as Record<string, unknown> | undefined)?.videos)
        ? ((data.output as Record<string, unknown>).videos as unknown[])
        : [],
    ];
    for (const group of groups) {
      group.forEach((entry) => {
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const record = entry as Record<string, unknown>;
        const url = this.normalizeNullableString(record.url) || this.normalizeNullableString(record.video_url);
        if (!url) {
          return;
        }
        output.push({
          url,
          mime_type: this.normalizeNullableString(record.mime_type) || 'video/mp4',
        });
      });
    }
    return output;
  }

  private extractAiPlaygroundEmbeddings(data: Record<string, unknown>): number[][] {
    const direct = Array.isArray(data.data) ? data.data : [];
    const vectors = direct
      .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>).embedding : null))
      .filter((entry): entry is unknown[] => Array.isArray(entry))
      .map((entry) => entry.map((value) => Number(value)).filter((value) => Number.isFinite(value)));
    if (vectors.length > 0) {
      return vectors;
    }
    if (Array.isArray(data.embedding)) {
      return [data.embedding.map((value) => Number(value)).filter((value) => Number.isFinite(value))];
    }
    if (Array.isArray(data.embeddings)) {
      return (data.embeddings as unknown[])
        .filter((entry) => Array.isArray(entry))
        .map((entry) => (entry as unknown[]).map((value) => Number(value)).filter((value) => Number.isFinite(value)));
    }
    return [];
  }

  private async countSuperAdmins(appId: string): Promise<number> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count
       FROM users
       WHERE app_id = $1::uuid
         AND deleted_at IS NULL
         AND role::text = 'ADMIN'
         AND admin_type::text = 'SUPER_ADMIN'`,
      appId,
    ) as Promise<Array<{ count: bigint }>>);
    return Number(rows[0]?.count || 0);
  }

  private async countUsersByRole(appId: string, role: 'ADMIN'): Promise<number> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count
       FROM users
       WHERE app_id = $1::uuid
         AND deleted_at IS NULL
         AND role::text = $2`,
      appId,
      role,
    ) as Promise<Array<{ count: bigint }>>);
    return Number(rows[0]?.count || 0);
  }

  private async findActiveUserInApp(appId: string, userId: string) {
    return this.prisma.user.findFirst({
      where: { id: userId, appId, deletedAt: null },
    });
  }

  private async findActiveAdminActor(userId: string) {
    return this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: {
        app: { select: { slug: true } },
      },
    });
  }

  private async findUserInAppIncludingDeleted(appId: string, userId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, email, phone, phone_verified, display_name, full_name, role, admin_type, is_active, is_superuser,
              created_at, updated_at, last_login_at, deleted_at, deactivated_at, deactivated_email, deactivated_phone
       FROM users
       WHERE id = $1::uuid AND app_id = $2::uuid
       LIMIT 1`,
      userId,
      appId,
    ) as Promise<Array<Record<string, unknown>>>);
    return rows[0] || null;
  }

  private async updateTenantUserContact(appId: string, userId: string, contact: 'email' | 'phone') {
    await this.ensureAppExists(appId);
    const target = await this.findUserInAppIncludingDeleted(appId, userId);
    if (!target) {
      throw new NotFoundException('User not found');
    }
    if (target.deleted_at) {
      throw new BadRequestException('账号已注销');
    }
    const currentPhone = String(target.phone || '').trim();
    if (contact === 'phone') {
      const rows = await (this.prisma.$queryRawUnsafe(
        `UPDATE users
         SET phone = NULL,
             phone_verified = false,
             updated_at = now()
         WHERE id = $1::uuid AND app_id = $2::uuid
         RETURNING id, app_id, email, phone, phone_verified, display_name, full_name, role, admin_type, is_active, is_superuser,
                   created_at, updated_at, last_login_at, deleted_at, deactivated_at, deactivated_email, deactivated_phone`,
        userId,
        appId,
      ) as Promise<Array<Record<string, unknown>>>);
      return this.serializeManagedUser(rows[0]);
    }
    if (!currentPhone) {
      throw new BadRequestException('请先绑定手机号再解绑邮箱');
    }
    const replacementEmail = this.buildPhonePlaceholderEmail(currentPhone);
    const conflictRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
       FROM users
       WHERE app_id = $1::uuid AND id <> $2::uuid AND lower(email) = lower($3::text)
       LIMIT 1`,
      appId,
      userId,
      replacementEmail,
    ) as Promise<Array<{ id: string }>>);
    if (conflictRows.length) {
      throw new ConflictException('手机号占位邮箱已被其他账号使用');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE users
       SET deactivated_email = COALESCE(deactivated_email, email),
           email = $3,
           updated_at = now()
       WHERE id = $1::uuid AND app_id = $2::uuid
       RETURNING id, app_id, email, phone, phone_verified, display_name, full_name, role, admin_type, is_active, is_superuser,
                 created_at, updated_at, last_login_at, deleted_at, deactivated_at, deactivated_email, deactivated_phone`,
      userId,
      appId,
      replacementEmail,
    ) as Promise<Array<Record<string, unknown>>>);
    return this.serializeManagedUser(rows[0]);
  }

  private serializeManagedUser(row: Record<string, unknown> | null | undefined) {
    if (!row) {
      return null;
    }
    return {
      id: String(row.id || ''),
      app_id: String(row.app_id || ''),
      email: String(row.email || ''),
      phone: row.phone ? String(row.phone) : null,
      phone_verified: row.phone_verified === true,
      display_name: String(row.display_name || row.full_name || row.email || ''),
      role: String(row.role || 'USER'),
      admin_type: row.admin_type ? String(row.admin_type) : null,
      is_active: row.is_active === true,
      is_superuser: row.is_superuser === true,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_login_at: row.last_login_at,
      deleted_at: row.deleted_at,
      deactivated_at: row.deactivated_at,
      deactivated_email: row.deactivated_email ? String(row.deactivated_email) : null,
      deactivated_phone: row.deactivated_phone ? String(row.deactivated_phone) : null,
    };
  }

  private buildDeactivatedEmail(userId: string) {
    return `deactivated+${String(userId).replace(/[^a-zA-Z0-9-]/g, '')}@deleted.local`;
  }

  private buildPhonePlaceholderEmail(phone: string) {
    const normalized = String(phone || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    return `${normalized || `phone${Date.now()}`}@phone.local`;
  }

  private async findAppUserByIdentity(
    appId: string,
    input: { userId?: string; email?: string; phone?: string },
  ) {
    if (input.userId) {
      return this.findActiveUserInApp(appId, input.userId);
    }
    if (input.email) {
      return this.prisma.user.findFirst({
        where: {
          appId,
          deletedAt: null,
          email: { equals: input.email, mode: 'insensitive' },
        },
      });
    }
    if (input.phone) {
      return this.prisma.user.findFirst({
        where: {
          appId,
          deletedAt: null,
          phone: input.phone,
        },
      });
    }
    return null;
  }

  private roleEquals(value: unknown, expected: string): boolean {
    return String(value || '').toUpperCase() === expected.toUpperCase();
  }

  private roundTo2(value: number): number {
    return Math.round(value * 100) / 100;
  }

}
