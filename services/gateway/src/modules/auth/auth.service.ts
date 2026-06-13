import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigType } from '@nestjs/config';
import { App, AppSetting, PrismaClient, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AiPointsService } from '../ai-chat/ai-points.service';
import { OutboundHttpClientService } from '../outbound-proxy/outbound-http-client.service';
import { RedeemService } from '../redeem/redeem.service';
import { RuntimeSettingsService } from '../runtime-settings/runtime-settings.service';
import { EmailVerificationService } from './email-verification.service';

type SafeUser = Omit<User, 'hashedPassword'>;
type AppWithSettings = App & { settings: AppSetting | null };
type WechatWebLoginConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
};

type GoogleLoginConfig = {
  clientId: string;
  clientSecret?: string | null;
  outboundProxyId?: string | null;
};

type GoogleIdTokenPayload = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  picture?: unknown;
};

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type OAuthIdentityRow = {
  id: string;
  app_id: string;
  user_id: string;
  provider: string;
  provider_subject: string;
  email: string | null;
  is_verified: boolean;
};

type GitHubLoginConfig = {
  clientId: string;
  clientSecret: string;
};

type GitHubAccessTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type GitHubUserResponse = {
  id?: number;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
};

type GitHubEmailResponse = {
  email?: string;
  primary?: boolean;
  verified?: boolean;
  visibility?: string | null;
};

type LoginProviderItem = {
  provider: 'email' | 'sms' | 'wechat' | 'google' | 'github' | 'apple' | 'ios_device' | 'app_attest';
  enabled: boolean;
  client_id?: string;
  app_id?: string;
  type?: string;
  mode?: string;
};

type WechatAccessTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  openid?: string;
  scope?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
};

type WechatUserInfoResponse = {
  openid?: string;
  nickname?: string;
  headimgurl?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
};

type WechatLoginSessionStatus = 'PENDING' | 'SCANNED' | 'CONFIRMED' | 'EXPIRED' | 'FAILED';

type WechatLoginSession = {
  sessionId: string;
  appSlug: string;
  appId: string;
  mode: 'login' | 'bind';
  bindUserId: string | null;
  state: string;
  connectUrl: string;
  qrContentUrl: string;
  uuid: string | null;
  status: WechatLoginSessionStatus;
  message: string;
  expiresAt: number;
  lastErrCode: number | null;
  authPayload: Record<string, unknown> | null;
  exchangeInFlight: boolean;
  pollInFlight: boolean;
  lastPolledAt: number;
};

type WechatIdentity = {
  openid: string;
  unionid: string | null;
  profile: WechatUserInfoResponse | null;
};

type WechatQrContentPayload = {
  qrContentUrl: string;
  uuid: string | null;
};

type WechatQrPollResult = {
  errCode: number | null;
  code: string | null;
};

type AuthTokenPayload = {
  sub?: string;
  email?: string;
  role?: string;
  sessionToken?: string;
  sid?: string;
  appSlug?: string;
  type?: string;
  iat?: number;
  refreshSessionStartedAt?: string | number;
};

type AuthSessionRow = {
  id: string;
  user_id: string;
  app_id: string;
  session_token_hash: string;
  refresh_token_hash: string;
  issued_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};

type BuildAuthResponseOptions = {
  sessionId?: string | null;
  refreshSessionStartedAt?: Date;
  provider?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
};

type UserCreateCompatInput = {
  appId: string;
  email: string;
  hashedPassword: string;
  fullName?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  role?: string;
  membershipType?: string;
  isActive?: boolean;
  sessionToken?: string | null;
  wechatOpenid?: string | null;
  wechatUnionid?: string | null;
  appleSub?: string | null;
};

type SmsProviderType = 'GENERIC_API' | 'ALIYUN_SMS';

type SmsProviderRow = {
  id: string;
  provider_type: SmsProviderType;
  name: string;
  is_active: boolean;
  is_default: boolean;
  config_json: unknown;
};

type SmsSignatureRow = {
  id: string;
  provider_id: string;
  sign_name: string;
  is_active: boolean;
  is_default: boolean;
  meta_json: unknown;
};

type SmsTemplateRow = {
  id: string;
  provider_id: string;
  template_code: string;
  template_name: string | null;
  is_active: boolean;
  is_default: boolean;
  meta_json: unknown;
};

type AppSmsRouteConfig = {
  sms_provider_ref_id?: string;
  sms_signature_ref_id?: string;
  sms_template_ref_id?: string;
};

type SmsCodeRow = {
  id: string;
  code_hash: string;
  expire_at: Date;
  attempt_count: number;
  max_attempts: number;
};

type SmsRouteConfigResolved = {
  provider: SmsProviderRow;
  signature: SmsSignatureRow;
  template: SmsTemplateRow | null;
};

type InviteCodeRow = {
  invite_code: string;
};

type InviteCodeLookupRow = {
  id: string;
  app_id: string;
  user_id: string;
  invite_code: string;
  created_at: Date;
  updated_at: Date;
};

type InviteRedemptionRow = {
  id: string;
  app_id: string;
  inviter_user_id: string;
  invitee_user_id: string;
  invite_code: string;
  reward_points: number | string;
  credited_at: Date | null;
};

const INVITE_CODE_LENGTH = 5;
const INVITE_REWARD_POINTS = 200;
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const asPlainObject = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly maxActiveUserSessions = 5;
  private wechatOpenAppSchemaEnsured: Promise<void> | null = null;
  private googleOAuthClientSchemaEnsured: Promise<void> | null = null;
  private githubOAuthAppSchemaEnsured: Promise<void> | null = null;
  private smsVerificationSchemaEnsured: Promise<void> | null = null;
  private refreshSessionSchemaEnsured: Promise<void> | null = null;
  private readonly wechatLoginSessions = new Map<string, WechatLoginSession>();
  private readonly wechatLoginSessionTtlMs = 2 * 60 * 1000;
  private readonly wechatQrStatusPollIntervalMs = 800;
  private readonly wechatQrStatusRequestTimeoutMs = 1800;
  private readonly wechatQrContentResolveTimeoutMs = 1200;
  private readonly wechatLoginConfigCache = new Map<string, { expiresAt: number; value: WechatWebLoginConfig | null }>();
  private readonly wechatLoginConfigCacheTtlMs = 60 * 1000;
  private readonly googleLoginConfigCache = new Map<string, { expiresAt: number; value: GoogleLoginConfig | null }>();
  private readonly googleLoginConfigCacheTtlMs = 60 * 1000;
  private readonly githubLoginConfigCache = new Map<string, { expiresAt: number; value: GitHubLoginConfig | null }>();
  private readonly githubLoginConfigCacheTtlMs = 60 * 1000;
  private readonly oauthRequestTimeoutMs = 10000;
  private readonly appCacheTtlMs = 15 * 1000;
  private readonly appBySlugCache = new Map<string, { expiresAt: number; value: App }>();
  private readonly appWithSettingsBySlugCache = new Map<string, { expiresAt: number; value: AppWithSettings }>();
  private readonly appWithSettingsByIdCache = new Map<string, { expiresAt: number; value: AppWithSettings }>();
  private readonly inviteCodeCacheTtlMs = 5 * 60 * 1000;
  private readonly inviteCodeCache = new Map<string, { expiresAt: number; value: string }>();
  private readonly smsRouteCache = new Map<string, { expires_at: number; value: SmsRouteConfigResolved }>();
  private readonly smsRouteCacheTtlMs = 60 * 1000;
  private oauthSettingsCache: { expiresAt: number; value: Record<string, unknown> } | null = null;
  private lastSmsCodeCleanupAt = 0;
  private forceRawSqlUserCreate = false;
  private inviteSchemaEnsured: Promise<void> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly jwtService: JwtService,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly aiPointsService: AiPointsService,
    private readonly redeemService: RedeemService,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly outboundHttpClient: OutboundHttpClientService,
    private readonly runtimeSettingsService: RuntimeSettingsService,
  ) {}

  clearOAuthConfigCache() {
    this.wechatLoginConfigCache.clear();
    this.googleLoginConfigCache.clear();
    this.githubLoginConfigCache.clear();
    this.oauthSettingsCache = null;
  }

  async onModuleInit() {
    await Promise.allSettled([
      this.detectUserCreateSchemaMode(),
      this.ensureRefreshSessionSchema(),
      this.ensureSmsVerificationSchema(),
      this.ensureWechatOpenAppSchema(),
      this.ensureGoogleOAuthClientSchema(),
      this.ensureGitHubOAuthAppSchema(),
      this.ensureInviteSchema(),
    ]);
  }

  async login(email: string, password: string, appSlug?: string) {
    const app = await this.resolveApp(appSlug);
    const normalizedEmail = this.normalizeEmail(email);
    const user = await this.prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        appId: app.id,
        deletedAt: null,
      },
    });

    if (!user || !(await this.verifyPassword(password, user.hashedPassword))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    const sessionToken = this.generateSessionToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        sessionToken,
        lastLoginAt: new Date(),
      },
    });

    return await this.buildAuthResponse(user, app.slug, sessionToken);
  }

  async sendEmailLoginCode(email: string, appSlug?: string) {
    const app = await this.resolveApp(appSlug);
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) {
      throw new BadRequestException('email is required');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        appId: app.id,
        deletedAt: null,
      },
    });

    if (user && !user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    return this.emailVerificationService.sendCode({
      appId: app.id,
      userId: null,
      email: normalizedEmail,
      purpose: 'email_login',
      subjectLabel: '登录验证码',
    });
  }

  async loginWithEmailCode(email: string, code: string, appSlug?: string) {
    const app = await this.resolveApp(appSlug);
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) {
      throw new BadRequestException('email is required');
    }

    let user = await this.prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        appId: app.id,
        deletedAt: null,
      },
    });

    if (user && !user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    await this.emailVerificationService.verifyCode({
      appId: app.id,
      userId: null,
      email: normalizedEmail,
      purpose: 'email_login',
      code,
    });

    if (!user) {
      user = await this.createUserWithCompat({
        appId: app.id,
        email: normalizedEmail,
        hashedPassword: await this.hashPassword(this.generateSessionToken()),
        fullName: normalizedEmail.split('@')[0],
        displayName: normalizedEmail.split('@')[0],
        role: 'USER',
        membershipType: 'FREE',
        isActive: true,
      });
    }

    const sessionToken = this.generateSessionToken();
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        sessionToken,
        lastLoginAt: new Date(),
      },
    });

    return await this.buildAuthResponse(updatedUser, app.slug, sessionToken);
  }

  async register(data: { email: string; password: string; fullName?: string; inviteCode?: string }, appSlug?: string) {
    const app = await this.resolveApp(appSlug);
    const normalizedEmail = this.normalizeEmail(data.email);

    const existing = await this.prisma.user.findFirst({
      where: {
        appId: app.id,
        email: normalizedEmail,
        deletedAt: null,
      },
    });
    if (existing) {
      throw new ConflictException('Email already exists');
    }

    const hashedPassword = await this.hashPassword(data.password);
    const sessionToken = this.generateSessionToken();
    const user = await this.createUserWithCompat({
      appId: app.id,
      email: normalizedEmail,
      hashedPassword,
      fullName: data.fullName || normalizedEmail.split('@')[0],
      role: 'USER',
      isActive: true,
      membershipType: 'FREE',
      sessionToken,
    });

    await this.tryApplyInviteReward(app.id, user.id, data.inviteCode);
    return await this.buildAuthResponse(user, app.slug, sessionToken);
  }

  async refreshToken(token: string, expectedAppSlug?: string) {
    try {
      const payload = this.jwtService.verify(token, { secret: this.config.jwt.secret }) as AuthTokenPayload;
      if (payload.type !== 'refresh') {
        throw new UnauthorizedException('Invalid token type');
      }
      const { user, appSlug, authSession } = await this.validateSessionUser(payload, expectedAppSlug);
      const currentRefreshTokenHash = this.hashRefreshToken(token);
      const now = new Date();
      const refreshIssuedAt = authSession?.issued_at || user.refreshTokenIssuedAt || this.dateFromUnixSeconds(payload.iat) || now;
      const refreshLastUsedAt = authSession?.last_used_at || user.refreshTokenLastUsedAt || refreshIssuedAt;
      const refreshSessionStartedAt = this.dateFromTokenTime(payload.refreshSessionStartedAt) || refreshIssuedAt;

      if (authSession || user.currentRefreshTokenHash) {
        const expectedRefreshTokenHash = authSession?.refresh_token_hash || user.currentRefreshTokenHash;
        if (expectedRefreshTokenHash !== currentRefreshTokenHash) {
          throw new UnauthorizedException('Refresh token has been rotated');
        }
        if (now.getTime() - refreshLastUsedAt.getTime() > this.getRefreshTokenInactivityMs()) {
          throw new UnauthorizedException('Refresh token expired from inactivity');
        }
        if (now.getTime() - refreshSessionStartedAt.getTime() > this.getRefreshTokenAbsoluteMs()) {
          throw new UnauthorizedException('Refresh token expired');
        }
      }
      const authUser = await this.prisma.user.findUnique({ where: { id: user.id } });
      const activeSessionToken = authSession
        ? String(payload.sessionToken || '').trim()
        : String(user.sessionToken || '').trim();
      if (!authUser || !activeSessionToken) {
        throw new UnauthorizedException('Session has been invalidated');
      }

      return await this.buildAuthResponse(authUser, appSlug, activeSessionToken, {
        sessionId: authSession?.id || null,
        refreshSessionStartedAt,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async verifyAccessToken(token: string) {
    try {
      const payload = this.jwtService.verify(token, { secret: this.config.jwt.secret }) as AuthTokenPayload;
      return await this.validateAccessTokenPayload(payload);
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
  }

  async validateAccessTokenPayload(payload: AuthTokenPayload, expectedAppSlug?: string) {
    if (payload.type === 'refresh') {
      throw new UnauthorizedException('Invalid token type');
    }
    const { user, appSlug, authSession } = await this.validateSessionUser(payload, expectedAppSlug);
    return {
      userId: user.id,
      id: user.id,
      email: user.email,
      role: user.role,
      sessionToken: user.sessionToken,
      sessionId: authSession?.id || null,
      appSlug,
    };
  }

  async logout(userId: string, sessionId?: string | null) {
    if (sessionId) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE auth_user_sessions
            SET revoked_at = now(),
                updated_at = now()
          WHERE id = $1::uuid
            AND user_id = $2::uuid
            AND revoked_at IS NULL`,
        sessionId,
        userId,
      );
    } else {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          sessionToken: null,
          currentRefreshTokenHash: null,
          refreshTokenIssuedAt: null,
          refreshTokenLastUsedAt: null,
        },
      });
      await this.revokeAllAuthUserSessions(userId);
    }
    return { message: 'Logged out successfully' };
  }

  async getProfile(userId: string): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { app: true },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('User not found');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    const profile = this.pickUserProfile(user as SafeUser & { app: { slug: string; name: string } });
    try {
      const inviteCode = await this.ensureInviteCodeForUser(user.appId, user.id);
      if (inviteCode) {
        return {
          ...profile,
          invite_code: inviteCode,
        };
      }
    } catch (error) {
      this.logger.warn(
        `invite code hydrate failed for profile user=${user.id}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    return profile;
  }

  async sendVerificationCode(email: string, _password?: string, appSlug?: string) {
    const existing = await this.prisma.user.findFirst({
      where: {
        email: this.normalizeEmail(email),
        deletedAt: null,
      },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    return this.emailVerificationService.sendCode({
      appSlug,
      email,
      purpose: 'register',
      subjectLabel: '注册验证码',
    });
  }

  async verifyEmail(email: string, verificationCode: string, password?: string, appSlug?: string, inviteCode?: string) {
    const app = await this.resolveApp(appSlug);
    const normalizedEmail = this.normalizeEmail(email);
    const existing = await this.prisma.user.findFirst({
      where: {
        appId: app.id,
        email: normalizedEmail,
        deletedAt: null,
      },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    await this.emailVerificationService.verifyCode({
      appId: app.id,
      email: normalizedEmail,
      purpose: 'register',
      code: verificationCode,
    });

    const generatedPassword = password || `temp_${Math.random().toString(36).slice(2, 12)}`;
    const hashedPassword = await this.hashPassword(generatedPassword);
    const sessionToken = this.generateSessionToken();

    const user = await this.createUserWithCompat({
      appId: app.id,
      email: normalizedEmail,
      hashedPassword,
      fullName: normalizedEmail.split('@')[0],
      role: 'USER',
      isActive: true,
      membershipType: 'FREE',
      sessionToken,
    });

    await this.tryApplyInviteReward(app.id, user.id, inviteCode);
    return await this.buildAuthResponse(user, app.slug, sessionToken);
  }

  async forgotPassword(email: string) {
    const normalizedEmail = this.normalizeEmail(email);
    const user = await this.prisma.user.findFirst({
      where: { email: normalizedEmail, deletedAt: null },
    });

    if (!user) {
      return { message: 'If the email exists, a verification code has been sent' };
    }

    return this.emailVerificationService.sendCode({
      appId: user.appId,
      userId: user.id,
      email: normalizedEmail,
      purpose: 'password_reset',
      subjectLabel: '密码重置验证码',
    });
  }

  async resetPassword(email: string, verificationCode: string, newPassword: string) {
    const normalizedEmail = this.normalizeEmail(email);
    const user = await this.prisma.user.findFirst({
      where: { email: normalizedEmail, deletedAt: null },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid verification code');
    }
    await this.emailVerificationService.verifyCode({
      appId: user.appId,
      userId: user.id,
      email: normalizedEmail,
      purpose: 'password_reset',
      code: verificationCode,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        hashedPassword: await this.hashPassword(newPassword),
        sessionToken: this.generateSessionToken(),
        currentRefreshTokenHash: null,
        refreshTokenIssuedAt: null,
        refreshTokenLastUsedAt: null,
      },
    });
    await this.revokeAllAuthUserSessions(user.id);

    return { message: 'Password reset successfully' };
  }

  async sendSmsCode(phone: string, appSlug?: string) {
    const app = await this.resolveAppWithSettings(appSlug);
    return this.sendSmsCodeForResolvedApp(app, phone);
  }

  async sendSmsCodeForAppId(appId: string, phone: string) {
    const app = await this.resolveAppByIdWithSettings(appId);
    return this.sendSmsCodeForResolvedApp(app, phone);
  }

  normalizeSmsPhone(phone: string) {
    return this.normalizePhone(phone);
  }

  normalizeSmsPhoneVariants(phone: string) {
    return this.buildPhoneIdentityVariants(this.normalizePhone(phone));
  }

  async verifySmsCodeForAppId(appId: string, phone: string, code: string) {
    const normalizedPhone = this.normalizePhone(phone);
    const normalizedCode = this.normalizeSmsCode(code);
    await this.ensureSmsVerificationSchema();
    await this.verifySmsCode(appId, normalizedPhone, normalizedCode);
    return {
      phone: normalizedPhone,
    };
  }

  private async sendSmsCodeForResolvedApp(app: AppWithSettings, phone: string) {
    const normalizedPhone = this.normalizePhone(phone);
    await this.ensureSmsVerificationSchema();
    const [smsRoute] = await Promise.all([
      this.resolveSmsRouteConfig(app),
      this.assertSmsSendCooldown(app.id, normalizedPhone),
    ]);

    const code = this.generateVerificationCode();
    const dispatchMode = this.resolveSmsDispatchMode(smsRoute.provider);

    if (dispatchMode === 'ASYNC') {
      await this.storeSmsCode({
        appId: app.id,
        phone: normalizedPhone,
        code,
        providerId: smsRoute.provider.id,
        signatureId: smsRoute.signature.id,
      });
      void this.dispatchSmsCode(smsRoute.provider, smsRoute.signature, smsRoute.template, normalizedPhone, code).catch(async (error) => {
        this.logger.error(
          `async sms dispatch failed (app=${app.id}, phone=${normalizedPhone}, provider=${smsRoute.provider.id}): ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        );
        await this.deleteSmsCode({ appId: app.id, phone: normalizedPhone, code });
      });
    } else {
      await this.dispatchSmsCode(smsRoute.provider, smsRoute.signature, smsRoute.template, normalizedPhone, code);
      await this.storeSmsCode({
        appId: app.id,
        phone: normalizedPhone,
        code,
        providerId: smsRoute.provider.id,
        signatureId: smsRoute.signature.id,
      });
    }

    return {
      message: 'Verification code sent',
      phone: normalizedPhone,
      resend_after_seconds: 60,
      expires_in_seconds: 300,
      dispatch_mode: dispatchMode,
    };
  }

  async sendSmsCodeForAppTest(input: {
    app_id?: string;
    app_slug?: string;
    phone: string;
    code?: string;
    persist_code?: boolean;
    respect_cooldown?: boolean;
  }) {
    const appId = String(input.app_id || '').trim();
    const appSlug = String(input.app_slug || '').trim();
    let app: AppWithSettings;
    if (appId) {
      app = await this.resolveAppByIdWithSettings(appId);
    } else {
      app = await this.resolveAppWithSettings(appSlug || undefined);
    }

    const normalizedPhone = this.normalizePhone(input.phone);
    const requestedCode = String(input.code || '').trim();
    const code = requestedCode ? this.normalizeSmsCode(requestedCode) : this.generateVerificationCode();
    const persistCode = input.persist_code === true;
    const respectCooldown = input.respect_cooldown === true;

    await this.ensureSmsVerificationSchema();
    if (respectCooldown) {
      await this.assertSmsSendCooldown(app.id, normalizedPhone);
    }

    const smsRoute = await this.resolveSmsRouteConfig(app);
    await this.dispatchSmsCode(smsRoute.provider, smsRoute.signature, smsRoute.template, normalizedPhone, code);

    if (persistCode) {
      await this.storeSmsCode({
        appId: app.id,
        phone: normalizedPhone,
        code,
        providerId: smsRoute.provider.id,
        signatureId: smsRoute.signature.id,
      });
    }

    return {
      message: 'Test SMS sent',
      app_id: app.id,
      app_slug: app.slug,
      phone: normalizedPhone,
      code,
      code_persisted: persistCode,
      resend_after_seconds: respectCooldown ? 60 : 0,
      expires_in_seconds: persistCode ? 300 : 0,
      route: {
        provider_id: smsRoute.provider.id,
        provider_name: smsRoute.provider.name,
        provider_type: smsRoute.provider.provider_type,
        signature_id: smsRoute.signature.id,
        signature_name: smsRoute.signature.sign_name,
        template_id: smsRoute.template?.id || null,
        template_code:
          this.pickSmsTemplateCode(smsRoute.template, asPlainObject(smsRoute.signature.meta_json), asPlainObject(smsRoute.provider.config_json)) ||
          null,
        template_name: smsRoute.template?.template_name || null,
      },
    };
  }

  async loginWithSms(phone: string, code: string, appSlug?: string, inviteCode?: string) {
    const app = await this.resolveApp(appSlug);
    const normalizedPhone = this.normalizePhone(phone);
    const phoneVariants = this.buildPhoneIdentityVariants(normalizedPhone);
    const normalizedCode = this.normalizeSmsCode(code);
    await this.ensureSmsVerificationSchema();
    await this.verifySmsCode(app.id, normalizedPhone, normalizedCode);

    const phoneUsers = await this.prisma.user.findMany({
      where: {
        appId: app.id,
        phone: { in: phoneVariants },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    let user = this.pickPhoneLoginUser(phoneUsers, normalizedPhone);

    if (!user && phoneUsers.some((item) => !!item.deletedAt)) {
      throw new ConflictException('手机号已绑定其他账号');
    }
    if (user && !user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    if (!user) {
      const placeholderEmails = phoneVariants.map((item) => this.buildPhonePlaceholderEmail(item));
      user = await this.prisma.user.findFirst({
        where: {
          appId: app.id,
          email: { in: placeholderEmails },
          deletedAt: null,
        },
        orderBy: { createdAt: 'asc' },
      });
    }

    if (user && !user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    if (!user) {
      const placeholderEmail = this.buildPhonePlaceholderEmail(normalizedPhone);
      user = await this.createUserWithCompat({
        appId: app.id,
        email: placeholderEmail,
        hashedPassword: await this.hashPassword(this.generateSessionToken()),
        fullName: `用户${normalizedPhone.slice(-4)}`,
        displayName: `用户${normalizedPhone.slice(-4)}`,
        role: 'USER',
        membershipType: 'FREE',
        isActive: true,
      });
      await this.tryApplyInviteReward(app.id, user.id, inviteCode);
    }

    const sessionToken = this.generateSessionToken();
    let updatedUser: User;
    try {
      updatedUser = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          sessionToken,
          phone: normalizedPhone,
          phoneVerified: true,
          lastLoginAt: new Date(),
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error, ['app_id', 'phone'])) {
        throw new ConflictException('手机号已绑定其他账号');
      }
      throw error;
    }

    return await this.buildAuthResponse(updatedUser, app.slug, sessionToken);
  }

  async getWechatLoginUrl(appSlug?: string, state?: string) {
    const app = await this.resolveAppWithSettings(appSlug);
    const config = await this.resolveWechatWebLoginConfig(app);
    if (!config) {
      return {
        enabled: false,
        type: 'web',
        message: '当前租户暂未配置微信开放平台网站应用登录',
      };
    }
    this.cleanupWechatLoginSessions();
    const safeState = String(state || app.slug).trim().slice(0, 256) || app.slug;
    const url = this.buildWechatQrConnectUrl(config, safeState);
    const qrContent = await this.resolveWechatQrContentWithRetry(url);
    if (!qrContent.uuid || !qrContent.qrContentUrl) {
      throw new BadGatewayException('微信登录二维码初始化失败，请稍后重试');
    }
    const sessionId = randomUUID();
    const expiresAt = Date.now() + this.wechatLoginSessionTtlMs;
    const session: WechatLoginSession = {
      sessionId,
      appId: app.id,
      appSlug: app.slug,
      mode: 'login',
      bindUserId: null,
      state: safeState,
      connectUrl: url,
      qrContentUrl: qrContent.qrContentUrl,
      uuid: qrContent.uuid,
      status: 'PENDING',
      message: '等待扫码',
      expiresAt,
      lastErrCode: null,
      authPayload: null,
      exchangeInFlight: false,
      pollInFlight: false,
      lastPolledAt: 0,
    };
    this.wechatLoginSessions.set(sessionId, session);
    return {
      enabled: true,
      type: 'web',
      app_id: config.appId,
      redirect_uri: config.redirectUri,
      state: safeState,
      widget_script_url: 'https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js',
      session_id: sessionId,
      status: session.status,
      expires_in: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
      qr_content_url: session.qrContentUrl,
      url,
    };
  }

  async getWechatBindUrl(userId: string, state?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { app: { include: { settings: true } } },
    });
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('User not found');
    }
    const app = user.app as AppWithSettings;
    const config = await this.resolveWechatWebLoginConfig(app);
    if (!config) {
      return {
        enabled: false,
        type: 'web',
        message: '当前租户暂未配置微信开放平台网站应用登录',
      };
    }
    this.cleanupWechatLoginSessions();
    const safeState = String(state || `${app.slug}:bind`).trim().slice(0, 256) || `${app.slug}:bind`;
    const url = this.buildWechatQrConnectUrl(config, safeState);
    const qrContent = await this.resolveWechatQrContentWithRetry(url);
    if (!qrContent.uuid || !qrContent.qrContentUrl) {
      throw new BadGatewayException('微信绑定二维码初始化失败，请稍后重试');
    }
    const sessionId = randomUUID();
    const expiresAt = Date.now() + this.wechatLoginSessionTtlMs;
    const session: WechatLoginSession = {
      sessionId,
      appId: app.id,
      appSlug: app.slug,
      mode: 'bind',
      bindUserId: user.id,
      state: safeState,
      connectUrl: url,
      qrContentUrl: qrContent.qrContentUrl,
      uuid: qrContent.uuid,
      status: 'PENDING',
      message: '等待扫码',
      expiresAt,
      lastErrCode: null,
      authPayload: null,
      exchangeInFlight: false,
      pollInFlight: false,
      lastPolledAt: 0,
    };
    this.wechatLoginSessions.set(sessionId, session);
    return {
      enabled: true,
      type: 'web',
      app_id: config.appId,
      redirect_uri: config.redirectUri,
      state: safeState,
      widget_script_url: 'https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js',
      session_id: sessionId,
      status: session.status,
      expires_in: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
      qr_content_url: session.qrContentUrl,
      url,
    };
  }

  async getWechatBindStatus(userId: string, sessionId: string) {
    this.cleanupWechatLoginSessions();
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      throw new BadRequestException('session_id is required');
    }
    const session = this.wechatLoginSessions.get(normalizedSessionId);
    if (!session) {
      return {
        status: 'EXPIRED',
        message: '二维码已过期，请刷新后重试',
      };
    }
    if (session.mode !== 'bind' || session.bindUserId !== userId) {
      return {
        status: 'FAILED',
        message: '绑定会话不匹配，请刷新二维码后重试',
      };
    }
    if (Date.now() >= session.expiresAt && session.status !== 'CONFIRMED') {
      session.status = 'EXPIRED';
      session.message = '二维码已过期，请刷新后重试';
    }
    if (session.status === 'CONFIRMED' || session.status === 'EXPIRED' || session.status === 'FAILED') {
      return this.buildWechatSessionStatusResponse(session);
    }
    if (!session.uuid) {
      session.status = 'FAILED';
      session.message = '二维码状态通道不可用，请刷新后重试';
      return this.buildWechatSessionStatusResponse(session);
    }
    if (!session.exchangeInFlight) {
      this.refreshWechatLoginSessionStatus(session);
    }
    return this.buildWechatSessionStatusResponse(session);
  }

  async getWechatLoginStatus(sessionId: string, appSlug?: string) {
    this.cleanupWechatLoginSessions();
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      throw new BadRequestException('session_id is required');
    }
    const session = this.wechatLoginSessions.get(normalizedSessionId);
    if (!session) {
      return {
        status: 'EXPIRED',
        message: '二维码已过期，请刷新后重试',
      };
    }
    if (session.mode !== 'login') {
      return {
        status: 'FAILED',
        message: '登录会话不匹配，请刷新二维码后重试',
      };
    }
    if (appSlug && session.appSlug !== appSlug) {
      return {
        status: 'FAILED',
        message: '登录会话不匹配，请刷新二维码后重试',
      };
    }
    if (Date.now() >= session.expiresAt && session.status !== 'CONFIRMED') {
      session.status = 'EXPIRED';
      session.message = '二维码已过期，请刷新后重试';
    }
    if (session.status === 'CONFIRMED' && session.authPayload) {
      return this.buildWechatSessionStatusResponse(session);
    }
    if (session.status === 'EXPIRED' || session.status === 'FAILED') {
      return this.buildWechatSessionStatusResponse(session);
    }
    if (!session.uuid) {
      session.status = 'FAILED';
      session.message = '二维码状态通道不可用，请刷新后重试';
      return this.buildWechatSessionStatusResponse(session);
    }
    if (!session.exchangeInFlight) {
      this.refreshWechatLoginSessionStatus(session);
    }

    return this.buildWechatSessionStatusResponse(session);
  }

  async loginWithWechat(code: string, appSlug?: string) {
    const app = await this.resolveAppWithSettings(appSlug);
    const config = await this.resolveWechatWebLoginConfig(app);
    const normalizedCode = String(code || '').trim();
    if (!normalizedCode) {
      throw new BadRequestException('Wechat code is required');
    }
    if (!config) {
      throw new BadRequestException('当前租户未配置微信网页登录');
    }

    const { openid, unionid, profile } = await this.exchangeWechatCode(config, normalizedCode);
    let user = await this.prisma.user.findFirst({
      where: {
        appId: app.id,
        OR: [
          ...(unionid ? [{ wechatUnionid: unionid }] : []),
          { wechatOpenid: openid },
        ],
        deletedAt: null,
      },
    });

    if (!user) {
      const placeholderEmail = this.buildWechatPlaceholderEmail(unionid || openid);
      const displayName = this.normalizeWechatDisplayName(profile?.nickname);
      const randomPassword = await this.hashPassword(this.generateSessionToken());
      user = await this.createUserWithCompat({
        appId: app.id,
        email: placeholderEmail,
        hashedPassword: randomPassword,
        fullName: displayName || '微信用户',
        displayName: displayName || '微信用户',
        avatarUrl: profile?.headimgurl || null,
        role: 'USER',
        membershipType: 'FREE',
        isActive: true,
        wechatOpenid: openid,
        wechatUnionid: unionid,
        sessionToken: this.generateSessionToken(),
      });
    } else {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          wechatOpenid: openid,
          wechatUnionid: unionid,
          avatarUrl: profile?.headimgurl || user.avatarUrl,
          displayName: this.normalizeWechatDisplayName(profile?.nickname) || user.displayName,
        },
      });
      user = (await this.prisma.user.findUnique({ where: { id: user.id } })) || user;
    }

    const sessionToken = this.generateSessionToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        sessionToken,
        lastLoginAt: new Date(),
      },
    });

    return await this.buildAuthResponse(user, app.slug, sessionToken);
  }

  async loginWithGoogle(idToken: string, appSlug?: string) {
    const app = await this.resolveAppWithSettings(appSlug);
    const config = await this.resolveGoogleLoginConfig(app);
    const normalizedToken = String(idToken || '').trim();
    if (!normalizedToken) {
      throw new BadRequestException('Google id_token is required');
    }
    if (!config) {
      throw new BadRequestException('当前租户未配置 Google 登录');
    }

    const payload = await this.verifyGoogleIdToken(config, normalizedToken).catch((error) => {
      throw new UnauthorizedException(`Google 登录失败：${error instanceof Error ? error.message : 'id_token 无效'}`);
    });
    const googleSub = String(payload?.sub || '').trim();
    if (!googleSub) {
      throw new UnauthorizedException('Google 登录失败：未获取到 sub');
    }
    const rawEmail = String(payload?.email || '').trim();
    const emailVerified = payload?.email_verified === true || String(payload?.email_verified || '').toLowerCase() === 'true';
    const verifiedEmail = emailVerified && rawEmail ? this.normalizeEmail(rawEmail) : null;
    const email = verifiedEmail || this.buildGooglePlaceholderEmail(googleSub);
    const googleDisplayName = this.normalizeExternalDisplayName(String(payload?.name || '').trim());
    const displayName = googleDisplayName || 'Google 用户';
    const avatarUrl = String(payload?.picture || '').trim() || null;
    const identityMetadata = {
      email: rawEmail || null,
      email_verified: emailVerified,
      name: googleDisplayName,
      picture: avatarUrl,
    };

    const existingIdentity = await this.findOAuthIdentity(app.id, 'GOOGLE', googleSub);
    let user = existingIdentity
      ? await this.prisma.user.findFirst({
          where: { id: existingIdentity.user_id, appId: app.id, deletedAt: null },
        })
      : null;
    if (existingIdentity && !user) {
      throw new UnauthorizedException('Google 登录失败：绑定账号不可用');
    }
    if (!user && verifiedEmail) {
      user = await this.prisma.user.findFirst({
        where: { appId: app.id, email: verifiedEmail, deletedAt: null },
      });
    }
    if (user && !user.isActive) {
      throw new UnauthorizedException('Google 登录失败：账号已停用');
    }
    if (!user) {
      user = await this.createUserWithCompat({
        appId: app.id,
        email,
        hashedPassword: await this.hashPassword(this.generateSessionToken()),
        fullName: displayName,
        displayName,
        avatarUrl,
        role: 'USER',
        membershipType: 'FREE',
        isActive: true,
        sessionToken: this.generateSessionToken(),
      });
    } else {
      await this.prisma.$executeRawUnsafe(
        `UPDATE users
            SET display_name = COALESCE($3, display_name),
                avatar_url = COALESCE($4, avatar_url),
                primary_auth_provider = 'GOOGLE',
                account_type = 'REGISTERED',
                is_anonymous = false,
                updated_at = now()
          WHERE app_id = $1::uuid AND id = $2::uuid`,
        app.id,
        user.id,
        googleDisplayName,
        avatarUrl,
      );
      user = (await this.prisma.user.findUnique({ where: { id: user.id } })) || user;
    }
    await this.upsertOAuthIdentity(app.id, user.id, 'GOOGLE', googleSub, verifiedEmail, emailVerified, identityMetadata);
    const sessionToken = this.generateSessionToken();
    await this.prisma.$executeRawUnsafe(
      `UPDATE users
          SET session_token = $3,
              last_login_at = now(),
              primary_auth_provider = 'GOOGLE',
              account_type = 'REGISTERED',
              is_anonymous = false,
              updated_at = now()
        WHERE app_id = $1::uuid AND id = $2::uuid`,
      app.id,
      user.id,
      sessionToken,
    );
    const updatedUser = (await this.prisma.user.findUnique({ where: { id: user.id } })) || user;
    return await this.buildAuthResponse(updatedUser, app.slug, sessionToken, {
      provider: 'google',
    });
  }

  async loginWithWechatCallback(code: string, appSlug?: string, _state?: string) {
    return this.loginWithWechat(code, appSlug);
  }

  async loginWithGoogleCallback(
    code?: string,
    idToken?: string,
    appSlug?: string,
    redirectUri?: string,
    _state?: string,
  ) {
    const normalizedIdToken = String(idToken || '').trim();
    if (normalizedIdToken) {
      return this.loginWithGoogle(normalizedIdToken, appSlug);
    }
    const app = await this.resolveAppWithSettings(appSlug);
    const config = await this.resolveGoogleLoginConfig(app);
    const normalizedCode = String(code || '').trim();
    if (!normalizedCode) {
      throw new BadRequestException('Google code is required');
    }
    if (!config) {
      throw new BadRequestException('当前租户未配置 Google 登录');
    }
    if (!config.clientSecret) {
      throw new BadRequestException('当前 Google 凭证未配置 Client Secret，无法使用服务端回调换取令牌');
    }
    this.assertOAuthRedirectUriAllowed(app, redirectUri);
    const token = await this.fetchGoogleIdToken(config, normalizedCode, redirectUri);
    return this.loginWithGoogle(token, app.slug);
  }

  async getGoogleLoginConfig(appSlug?: string) {
    const app = await this.resolveAppWithSettings(appSlug);
    const config = await this.resolveGoogleLoginConfig(app);
    if (!config) {
      return {
        enabled: false,
        message: '当前租户暂未配置 Google 登录',
      };
    }
    return {
      enabled: true,
      client_id: config.clientId,
    };
  }

  async loginWithGitHub(code: string, appSlug?: string, redirectUri?: string) {
    const app = await this.resolveAppWithSettings(appSlug);
    const config = await this.resolveGitHubLoginConfig(app);
    const normalizedCode = String(code || '').trim();
    if (!normalizedCode) {
      throw new BadRequestException('GitHub code is required');
    }
    if (!config) {
      throw new BadRequestException('当前租户未配置 GitHub 登录');
    }
    this.assertOAuthRedirectUriAllowed(app, redirectUri);

    const accessPayload = await this.fetchGitHubAccessToken(config, normalizedCode, redirectUri);
    const accessToken = String(accessPayload.access_token || '').trim();
    if (!accessToken) {
      throw new UnauthorizedException('GitHub 登录失败：未获取到 access_token');
    }
    const profile = await this.fetchGitHubUserProfile(accessToken);
    const githubId = String(profile.id || '').trim();
    if (!githubId) {
      throw new UnauthorizedException('GitHub 登录失败：未获取到用户 ID');
    }

    const verifiedEmail = await this.resolveGitHubVerifiedEmail(accessToken, profile);
    const email = verifiedEmail ? this.normalizeEmail(verifiedEmail) : this.buildGitHubPlaceholderEmail(githubId);
    const displayName =
      this.normalizeExternalDisplayName(String(profile.name || '').trim()) ||
      this.normalizeExternalDisplayName(String(profile.login || '').trim()) ||
      'GitHub 用户';
    const avatarUrl = String(profile.avatar_url || '').trim() || null;

    let user = await this.prisma.user.findFirst({
      where: { appId: app.id, email, deletedAt: null },
    });
    if (!user) {
      user = await this.createUserWithCompat({
        appId: app.id,
        email,
        hashedPassword: await this.hashPassword(this.generateSessionToken()),
        fullName: displayName,
        displayName,
        avatarUrl,
        role: 'USER',
        membershipType: 'FREE',
        isActive: true,
        sessionToken: this.generateSessionToken(),
      });
    } else if (avatarUrl || displayName) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          displayName: displayName || user.displayName,
          avatarUrl: avatarUrl || user.avatarUrl,
        },
      });
    }
    const sessionToken = this.generateSessionToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { sessionToken, lastLoginAt: new Date() },
    });
    return await this.buildAuthResponse(user, app.slug, sessionToken);
  }

  async loginWithGitHubCallback(code: string, appSlug?: string, redirectUri?: string, _state?: string) {
    return this.loginWithGitHub(code, appSlug, redirectUri);
  }

  async getGitHubLoginConfig(appSlug?: string) {
    const app = await this.resolveAppWithSettings(appSlug);
    const config = await this.resolveGitHubLoginConfig(app);
    if (!config) {
      return {
        enabled: false,
        message: '当前租户暂未配置 GitHub 登录',
      };
    }
    return {
      enabled: true,
      client_id: config.clientId,
    };
  }

  async getLoginProviders(appSlug?: string) {
    const app = await this.resolveAppWithSettings(appSlug);
    const [wechatConfig, googleConfig, githubConfig] = await Promise.all([
      this.resolveWechatWebLoginConfig(app).catch(() => null),
      this.resolveGoogleLoginConfig(app).catch(() => null),
      this.resolveGitHubLoginConfig(app).catch(() => null),
    ]);
    const providers: LoginProviderItem[] = [
      { provider: 'email', enabled: true },
      { provider: 'sms', enabled: true },
      {
        provider: 'wechat',
        enabled: !!wechatConfig,
        type: 'web',
        app_id: wechatConfig?.appId,
      },
      {
        provider: 'google',
        enabled: !!googleConfig,
        client_id: googleConfig?.clientId,
      },
      {
        provider: 'github',
        enabled: !!githubConfig,
        client_id: githubConfig?.clientId,
      },
      { provider: 'apple', enabled: true },
      { provider: 'ios_device', enabled: true, type: 'guest' },
      { provider: 'app_attest', enabled: true, mode: 'ENFORCE_SENSITIVE' },
    ];
    return { items: providers };
  }

  private async findOAuthIdentity(appId: string, provider: string, subject: string): Promise<OAuthIdentityRow | null> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, user_id, provider, provider_subject, email, is_verified
         FROM user_identities
        WHERE app_id = $1::uuid AND provider = $2 AND provider_subject = $3
        LIMIT 1`,
      appId,
      provider,
      subject,
    ) as Promise<OAuthIdentityRow[]>);
    return rows[0] || null;
  }

  private async upsertOAuthIdentity(
    appId: string,
    userId: string,
    provider: string,
    subject: string,
    email: string | null,
    isVerified: boolean,
    metadata: Record<string, unknown>,
  ) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO user_identities (
         app_id, user_id, provider, provider_subject, email, is_verified, metadata_json
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb
       )
       ON CONFLICT (app_id, provider, provider_subject) DO UPDATE
       SET email = COALESCE(EXCLUDED.email, user_identities.email),
           is_verified = EXCLUDED.is_verified,
           metadata_json = EXCLUDED.metadata_json,
           updated_at = now()
       RETURNING user_id`,
      appId,
      userId,
      provider,
      subject,
      email,
      isVerified,
      JSON.stringify(metadata || {}),
    ) as Promise<Array<{ user_id: string }>>);
    const boundUserId = rows[0]?.user_id;
    if (boundUserId && boundUserId !== userId) {
      throw new ConflictException('Google 身份已绑定其他账号');
    }
  }

  async loginWithApple(identityToken: string, appSlug?: string) {
    const app = await this.resolveApp(appSlug);
    const appleSub = `apple_${identityToken.slice(0, 20)}`;
    let user = await this.prisma.user.findFirst({
      where: { appId: app.id, appleSub, deletedAt: null },
    });
    if (!user) {
      user = await this.createUserWithCompat({
        appId: app.id,
        email: `${appleSub}@oauth.local`,
        appleSub,
        hashedPassword: await this.hashPassword(this.generateSessionToken()),
        fullName: 'Apple 用户',
        role: 'USER',
        membershipType: 'FREE',
        isActive: true,
        sessionToken: this.generateSessionToken(),
      });
    }
    const sessionToken = this.generateSessionToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { sessionToken, lastLoginAt: new Date() },
    });
    return await this.buildAuthResponse(user, app.slug, sessionToken);
  }

  async bindWechat(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { app: { include: { settings: true } } },
    });
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('User not found');
    }
    const config = await this.resolveWechatWebLoginConfig(user.app as AppWithSettings);
    if (!config) {
      throw new BadRequestException('当前租户未配置微信网页登录');
    }
    const { openid, unionid, profile } = await this.exchangeWechatCode(config, code);
    return this.bindWechatIdentity(userId, openid, unionid, profile);
  }

  async unbindWechat(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { wechatOpenid: null, wechatUnionid: null },
    });
    return { message: 'Wechat account unbound successfully' };
  }

  async deleteAccount(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        isActive: false,
        deletedAt: new Date(),
        sessionToken: null,
        currentRefreshTokenHash: null,
        refreshTokenIssuedAt: null,
        refreshTokenLastUsedAt: null,
      },
    });
    await this.revokeAllAuthUserSessions(userId);
    return { message: 'Account deleted successfully' };
  }

  async createUserWithCompat(input: UserCreateCompatInput): Promise<User> {
    const normalizedEmail = this.normalizeEmail(input.email);
    const rawRole = String(input.role || 'USER').trim().toUpperCase() || 'USER';
    const role = rawRole === 'COACH' ? 'USER' : rawRole;
    const membershipType = String(input.membershipType || 'FREE').trim().toUpperCase() || 'FREE';
    const data = {
      appId: input.appId,
      email: normalizedEmail,
      hashedPassword: input.hashedPassword,
      fullName: input.fullName ?? null,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      role: role as 'USER' | 'ADMIN',
      membershipType: membershipType as 'FREE' | 'PREMIUM',
      isActive: input.isActive ?? true,
      sessionToken: input.sessionToken ?? null,
      wechatOpenid: input.wechatOpenid ?? null,
      wechatUnionid: input.wechatUnionid ?? null,
      appleSub: input.appleSub ?? null,
    };

    if (this.forceRawSqlUserCreate) {
      return this.createUserWithRawSql(input, normalizedEmail);
    }

    try {
      return await this.prisma.user.create({ data });
    } catch (error) {
      const mismatch = this.isUserEnumSchemaMismatch(error) || this.forceRawSqlUserCreate;
      if (mismatch) {
        this.forceRawSqlUserCreate = true;
      }
      const logMessage = `prisma user.create failed; fallback to raw SQL (email=${normalizedEmail}, app=${input.appId}, enum_mismatch=${mismatch})`;
      if (mismatch) {
        this.logger.debug(logMessage);
      } else {
        this.logger.warn(logMessage);
      }

      try {
        return await this.createUserWithRawSql(input, normalizedEmail);
      } catch (fallbackError) {
        this.logger.error(
          `raw SQL user create fallback failed (email=${normalizedEmail}, app=${input.appId}): ${
            fallbackError instanceof Error ? fallbackError.message : 'unknown'
          }`,
        );
        throw error;
      }
    }
  }

  private isUniqueConstraintError(error: unknown, fields: string[]) {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const record = error as { code?: unknown; meta?: { target?: unknown } };
    if (record.code !== 'P2002') {
      return false;
    }
    const target = record.meta?.target;
    const matchesFields = (values: string[]) =>
      fields.every((field) => values.includes(field)) ||
      (fields.includes('app_id') && fields.includes('phone') && values.includes('appId') && values.includes('phone'));
    if (Array.isArray(target)) {
      return matchesFields(target.filter((value): value is string => typeof value === 'string'));
    }
    if (typeof target === 'string') {
      return matchesFields([target]) || (target.includes('phone') && (target.includes('app_id') || target.includes('appId')));
    }
    return false;
  }

  private async createUserWithRawSql(input: UserCreateCompatInput, normalizedEmail: string): Promise<User> {
    const fallbackUserId = randomUUID();
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO users (
         id,
         app_id, email, hashed_password, full_name, display_name, avatar_url,
         is_active, session_token, wechat_openid, wechat_unionid, apple_sub,
         created_at, updated_at
       ) VALUES (
         $1::uuid,
         $2::uuid, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         now(), now()
       )
       ON CONFLICT (email, app_id) DO UPDATE
       SET
         hashed_password = EXCLUDED.hashed_password,
         full_name = COALESCE(EXCLUDED.full_name, users.full_name),
         display_name = COALESCE(EXCLUDED.display_name, users.display_name),
         avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
         is_active = TRUE,
         deleted_at = NULL,
         session_token = COALESCE(EXCLUDED.session_token, users.session_token),
         wechat_openid = COALESCE(EXCLUDED.wechat_openid, users.wechat_openid),
         wechat_unionid = COALESCE(EXCLUDED.wechat_unionid, users.wechat_unionid),
         apple_sub = COALESCE(EXCLUDED.apple_sub, users.apple_sub),
         updated_at = now()
       RETURNING id`,
      fallbackUserId,
      input.appId,
      normalizedEmail,
      input.hashedPassword,
      input.fullName ?? null,
      input.displayName ?? null,
      input.avatarUrl ?? null,
      input.isActive ?? true,
      input.sessionToken ?? null,
      input.wechatOpenid ?? null,
      input.wechatUnionid ?? null,
      input.appleSub ?? null,
    ) as Promise<Array<{ id: string }>>);

    const userId = String(rows?.[0]?.id || '').trim();
    if (!userId) {
      throw new ConflictException('Failed to create user');
    }

    const created = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!created) {
      throw new ConflictException('Failed to load created user');
    }
    return created;
  }

  private async detectUserCreateSchemaMode() {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         to_regtype('public."UserRole"')::text AS role_type,
         to_regtype('public."MembershipType"')::text AS membership_type`,
    ) as Promise<Array<{ role_type: string | null; membership_type: string | null }>>);
    const hasPrismaEnums = !!rows[0]?.role_type && !!rows[0]?.membership_type;
    if (!hasPrismaEnums) {
      this.forceRawSqlUserCreate = true;
      this.logger.log('users table is using text-compatible auth columns; user create will use raw SQL compatibility path');
    }
  }

  private isUserEnumSchemaMismatch(error: unknown): boolean {
    const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
    const pgCode = String((error as any)?.code || (error as any)?.meta?.code || '').trim();
    if (pgCode === '42704') {
      if (message.includes('userrole') || message.includes('membershiptype') || message.includes('type')) {
        return true;
      }
    }
    if (!message) {
      return false;
    }
    if (
      message.includes('type "public.userrole" does not exist') ||
      message.includes('type "public.membershiptype" does not exist') ||
      message.includes('type "userrole" does not exist') ||
      message.includes('type "membershiptype" does not exist')
    ) {
      return true;
    }
    if (
      message.includes('is of type text but expression is of type') &&
      (message.includes('userrole') || message.includes('membershiptype'))
    ) {
      return true;
    }
    return false;
  }

  private async resolveAppWithSettings(appSlug?: string): Promise<AppWithSettings> {
    const slug = appSlug || this.config.app.defaultSlug;
    const now = Date.now();
    const cached = this.appWithSettingsBySlugCache.get(slug);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const app = await this.prisma.app.findUnique({
      where: { slug },
      include: { settings: true },
    });
    if (!app) {
      throw new ConflictException(`App not found: ${slug}`);
    }
    this.appWithSettingsBySlugCache.set(slug, { expiresAt: now + this.appCacheTtlMs, value: app });
    this.appWithSettingsByIdCache.set(app.id, { expiresAt: now + this.appCacheTtlMs, value: app });
    this.appBySlugCache.set(slug, { expiresAt: now + this.appCacheTtlMs, value: app });
    return app;
  }

  private async resolveAppByIdWithSettings(appId: string): Promise<AppWithSettings> {
    const now = Date.now();
    const cached = this.appWithSettingsByIdCache.get(appId);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const app = await this.prisma.app.findUnique({
      where: { id: appId },
      include: { settings: true },
    });
    if (!app) {
      throw new ConflictException(`App not found: ${appId}`);
    }
    this.appWithSettingsByIdCache.set(appId, { expiresAt: now + this.appCacheTtlMs, value: app });
    this.appWithSettingsBySlugCache.set(app.slug, { expiresAt: now + this.appCacheTtlMs, value: app });
    this.appBySlugCache.set(app.slug, { expiresAt: now + this.appCacheTtlMs, value: app });
    return app;
  }

  private async resolveWechatWebLoginConfig(app: AppWithSettings): Promise<WechatWebLoginConfig | null> {
    const cacheKey = app.id;
    const now = Date.now();
    const cached = this.wechatLoginConfigCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    await this.ensureWechatOpenAppSchema();
    const settings = app.settings;
    const extra = settings?.extraJson && typeof settings.extraJson === 'object' && !Array.isArray(settings.extraJson)
      ? (settings.extraJson as Record<string, unknown>)
      : {};
    const selectedOpenAppId = String(extra.wechat_open_app_ref_id || '').trim();
    if (selectedOpenAppId) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT app_id, app_secret, is_active
         FROM wechat_open_apps
         WHERE id = $1::uuid
         LIMIT 1`,
        selectedOpenAppId,
      ) as Promise<Array<{ app_id: string; app_secret: string; is_active: boolean }>>);
      const selected = rows[0];
      if (selected && selected.is_active && selected.app_id && selected.app_secret) {
        const redirectUri = await this.resolveWechatRedirectUri(settings?.wechatRedirectUri, app.slug);
        if (!redirectUri) {
          this.wechatLoginConfigCache.set(cacheKey, {
            expiresAt: now + this.wechatLoginConfigCacheTtlMs,
            value: null,
          });
          return null;
        }
        const resolved = {
          appId: String(selected.app_id).trim(),
          appSecret: String(selected.app_secret).trim(),
          redirectUri,
        };
        this.wechatLoginConfigCache.set(cacheKey, {
          expiresAt: now + this.wechatLoginConfigCacheTtlMs,
          value: resolved,
        });
        return resolved;
      }
    }
    const appId = String(extra.wechat_open_app_id || '').trim();
    const appSecret = String(extra.wechat_open_app_secret || '').trim();
    const redirectUri = await this.resolveWechatRedirectUri(settings?.wechatRedirectUri, app.slug);
    if (!appId || !appSecret || !redirectUri) {
      this.wechatLoginConfigCache.set(cacheKey, {
        expiresAt: now + this.wechatLoginConfigCacheTtlMs,
        value: null,
      });
      return null;
    }
    const resolved = {
      appId,
      appSecret,
      redirectUri,
    };
    this.wechatLoginConfigCache.set(cacheKey, {
      expiresAt: now + this.wechatLoginConfigCacheTtlMs,
      value: resolved,
    });
    return resolved;
  }

  private async resolveGoogleLoginConfig(app: AppWithSettings): Promise<GoogleLoginConfig | null> {
    const cacheKey = app.id;
    const now = Date.now();
    const cached = this.googleLoginConfigCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    await this.ensureGoogleOAuthClientSchema();
    const settings = app.settings;
    const extra = settings?.extraJson && typeof settings.extraJson === 'object' && !Array.isArray(settings.extraJson)
      ? (settings.extraJson as Record<string, unknown>)
      : {};
    const selectedClientId = String(extra.google_oauth_client_ref_id || '').trim();
    if (selectedClientId) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT client_id, client_secret, outbound_proxy_id, is_active
         FROM google_oauth_clients
         WHERE id = $1::uuid
         LIMIT 1`,
        selectedClientId,
      ) as Promise<Array<{ client_id: string; client_secret: string | null; outbound_proxy_id: string | null; is_active: boolean }>>);
      const selected = rows[0];
      if (selected && selected.is_active && selected.client_id) {
        const resolved = {
          clientId: String(selected.client_id).trim(),
          clientSecret: String(selected.client_secret || '').trim() || null,
          outboundProxyId: selected.outbound_proxy_id || null,
        };
        this.googleLoginConfigCache.set(cacheKey, {
          expiresAt: now + this.googleLoginConfigCacheTtlMs,
          value: resolved,
        });
        return resolved;
      }
    }

    const clientId = String(extra.google_client_id || '').trim();
    if (!clientId) {
      this.googleLoginConfigCache.set(cacheKey, {
        expiresAt: now + this.googleLoginConfigCacheTtlMs,
        value: null,
      });
      return null;
    }
    const resolved = { clientId, outboundProxyId: null };
    this.googleLoginConfigCache.set(cacheKey, {
      expiresAt: now + this.googleLoginConfigCacheTtlMs,
      value: resolved,
    });
    return resolved;
  }

  private async resolveGitHubLoginConfig(app: AppWithSettings): Promise<GitHubLoginConfig | null> {
    const cacheKey = app.id;
    const now = Date.now();
    const cached = this.githubLoginConfigCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    await this.ensureGitHubOAuthAppSchema();
    const settings = app.settings;
    const extra = settings?.extraJson && typeof settings.extraJson === 'object' && !Array.isArray(settings.extraJson)
      ? (settings.extraJson as Record<string, unknown>)
      : {};
    const selectedAppId = String(extra.github_oauth_app_ref_id || '').trim();
    if (selectedAppId) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT client_id, client_secret, is_active
         FROM github_oauth_apps
         WHERE id = $1::uuid
         LIMIT 1`,
        selectedAppId,
      ) as Promise<Array<{ client_id: string; client_secret: string; is_active: boolean }>>);
      const selected = rows[0];
      if (selected && selected.is_active && selected.client_id && selected.client_secret) {
        const resolved = {
          clientId: String(selected.client_id).trim(),
          clientSecret: String(selected.client_secret).trim(),
        };
        this.githubLoginConfigCache.set(cacheKey, {
          expiresAt: now + this.githubLoginConfigCacheTtlMs,
          value: resolved,
        });
        return resolved;
      }
    }

    const clientId = String(extra.github_client_id || '').trim();
    const clientSecret = String(extra.github_client_secret || '').trim();
    if (!clientId || !clientSecret) {
      this.githubLoginConfigCache.set(cacheKey, {
        expiresAt: now + this.githubLoginConfigCacheTtlMs,
        value: null,
      });
      return null;
    }
    const resolved = { clientId, clientSecret };
    this.githubLoginConfigCache.set(cacheKey, {
      expiresAt: now + this.githubLoginConfigCacheTtlMs,
      value: resolved,
    });
    return resolved;
  }

  private async fetchGitHubAccessToken(
    config: GitHubLoginConfig,
    code: string,
    redirectUri?: string,
  ): Promise<GitHubAccessTokenResponse> {
    const body: Record<string, string> = {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    };
    const normalizedRedirectUri = String(redirectUri || '').trim();
    if (normalizedRedirectUri) {
      body.redirect_uri = normalizedRedirectUri;
    }
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      signal: AbortSignal.timeout(this.oauthRequestTimeoutMs),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'OPGGateway/1.0',
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as GitHubAccessTokenResponse;
    if (!response.ok || payload.error || !payload.access_token) {
      throw new UnauthorizedException(
        `GitHub 登录失败：${payload.error_description || payload.error || `access_token error ${response.status}`}`,
      );
    }
    return payload;
  }

  private async verifyGoogleIdToken(config: GoogleLoginConfig, idToken: string): Promise<GoogleIdTokenPayload> {
    const response = await this.outboundHttpClient.fetch('https://www.googleapis.com/oauth2/v3/certs', {
      method: 'GET',
      signal: AbortSignal.timeout(this.oauthRequestTimeoutMs),
      headers: {
        accept: 'application/json',
      },
    }, {
      proxyId: config.outboundProxyId,
    });
    if (!response.ok) {
      throw new UnauthorizedException(`Google 登录失败：证书不可达（${response.status}）`);
    }
    const jwks = await response.json();
    const { createLocalJWKSet, jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(
      idToken,
      createLocalJWKSet(jwks as any),
      {
        audience: config.clientId,
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
      },
    );
    return payload as GoogleIdTokenPayload;
  }

  private async fetchGoogleIdToken(config: GoogleLoginConfig, code: string, redirectUri?: string): Promise<string> {
    const body: Record<string, string> = {
      client_id: config.clientId,
      client_secret: String(config.clientSecret || ''),
      code,
      grant_type: 'authorization_code',
    };
    const normalizedRedirectUri = String(redirectUri || '').trim();
    if (normalizedRedirectUri) {
      body.redirect_uri = normalizedRedirectUri;
    }
    const response = await this.outboundHttpClient.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(this.oauthRequestTimeoutMs),
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body).toString(),
    }, {
      proxyId: config.outboundProxyId,
    });
    const payload = (await response.json()) as GoogleTokenResponse;
    const idToken = String(payload.id_token || '').trim();
    if (!response.ok || payload.error || !idToken) {
      throw new UnauthorizedException(
        `Google 登录失败：${payload.error_description || payload.error || `token error ${response.status}`}`,
      );
    }
    return idToken;
  }

  private async fetchGitHubUserProfile(accessToken: string): Promise<GitHubUserResponse> {
    const response = await fetch('https://api.github.com/user', {
      method: 'GET',
      signal: AbortSignal.timeout(this.oauthRequestTimeoutMs),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'OPGGateway/1.0',
        'x-github-api-version': '2022-11-28',
      },
    });
    const payload = (await response.json()) as GitHubUserResponse;
    if (!response.ok || !payload.id) {
      throw new UnauthorizedException(`GitHub 登录失败：user api error ${response.status}`);
    }
    return payload;
  }

  private async resolveGitHubVerifiedEmail(accessToken: string, profile: GitHubUserResponse): Promise<string | null> {
    const profileEmail = String(profile.email || '').trim();
    if (profileEmail) {
      return profileEmail;
    }
    try {
      const response = await fetch('https://api.github.com/user/emails', {
        method: 'GET',
        signal: AbortSignal.timeout(this.oauthRequestTimeoutMs),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'OPGGateway/1.0',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as GitHubEmailResponse[];
      const primary = payload.find((item) => item.primary && item.verified && item.email);
      const verified = primary || payload.find((item) => item.verified && item.email);
      return String(verified?.email || '').trim() || null;
    } catch {
      return null;
    }
  }

  private assertOAuthRedirectUriAllowed(app: AppWithSettings, redirectUri?: string | null) {
    const raw = String(redirectUri || '').trim();
    if (!raw) {
      return;
    }
    let host = '';
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        throw new BadRequestException('OAuth redirect_uri must use https');
      }
      host = parsed.host.trim().toLowerCase();
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('OAuth redirect_uri is invalid');
    }
    const allowedHosts = this.resolveOAuthRedirectAllowedHosts(app);
    if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
      throw new BadRequestException('OAuth redirect_uri host is not allowed for this tenant');
    }
  }

  private resolveOAuthRedirectAllowedHosts(app: AppWithSettings): string[] {
    const settings = app.settings;
    const extra = settings?.extraJson && typeof settings.extraJson === 'object' && !Array.isArray(settings.extraJson)
      ? (settings.extraJson as Record<string, unknown>)
      : {};
    const rawHosts = extra.oauth_redirect_hosts;
    const hosts = new Set<string>();
    const pushHost = (value: unknown) => {
      const normalized = this.normalizeOAuthRedirectHost(value);
      if (normalized) hosts.add(normalized);
    };
    if (Array.isArray(rawHosts)) {
      rawHosts.forEach(pushHost);
    } else if (typeof rawHosts === 'string') {
      rawHosts.split(/[\n,]/).forEach(pushHost);
    }
    pushHost(settings?.appUrl);
    pushHost(settings?.wechatRedirectUri);
    return [...hosts];
  }

  private normalizeOAuthRedirectHost(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      if (/^https?:\/\//i.test(raw)) {
        return new URL(raw).host.trim().toLowerCase();
      }
      const candidate = raw.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]?.trim().toLowerCase();
      if (!candidate) return '';
      return new URL(`https://${candidate}`).host.trim().toLowerCase();
    } catch {
      return '';
    }
  }

  private async resolveWechatRedirectUri(configuredRedirectUri?: string | null, appSlug?: string): Promise<string> {
    const oauthSettings = await this.getRuntimeOauthSettings();
    const fallback = this.buildDefaultWechatRedirectUri(oauthSettings);
    const configuredHost = this.normalizeWechatRedirectHost(configuredRedirectUri);
    if (!configuredHost) {
      return fallback;
    }
    try {
      const fallbackPathname = fallback ? new URL(fallback).pathname : '/wechat-login';
      const dbAllowedHosts = Array.isArray(oauthSettings.wechat_auth_allowed_redirect_hosts)
        ? oauthSettings.wechat_auth_allowed_redirect_hosts
        : [];
      const allowedHosts = dbAllowedHosts.length > 0
        ? dbAllowedHosts.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
        : Array.isArray(this.config.wechatAuth.allowedRedirectHosts)
          ? this.config.wechatAuth.allowedRedirectHosts
              .map((item) => String(item || '').trim().toLowerCase())
              .filter(Boolean)
          : [];
      if (allowedHosts.length > 0 && !allowedHosts.includes(configuredHost.toLowerCase())) {
        this.logger.warn(
          `wechat redirect host not allowed, fallback to default: ${configuredHost}`,
        );
        return fallback;
      }
      const built = new URL(`https://${configuredHost}`);
      built.pathname = appSlug ? `/${appSlug}/v1/auth/login/wechat/callback` : fallbackPathname || '/wechat-login';
      built.search = '';
      built.hash = '';
      return `${built.origin}${built.pathname}`.replace(/\/+$/, '');
    } catch {
      return fallback;
    }
  }

  private normalizeWechatRedirectUri(uri?: string | null): string {
    const raw = String(uri || '').trim();
    if (!raw) {
      return '';
    }
    try {
      const parsed = new URL(raw);
      parsed.hash = '';
      return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  private normalizeWechatRedirectHost(value?: string | null): string {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }
    try {
      if (/^https?:\/\//i.test(raw)) {
        const parsed = new URL(raw);
        return parsed.host.trim().toLowerCase();
      }
      const candidate = raw
        .replace(/^https?:\/\//i, '')
        .split(/[/?#]/)[0]
        ?.trim()
        .toLowerCase();
      if (!candidate) {
        return '';
      }
      const parsed = new URL(`https://${candidate}`);
      return parsed.host.trim().toLowerCase();
    } catch {
      return '';
    }
  }

  private buildDefaultWechatRedirectUri(oauthSettings: Record<string, unknown>): string {
    const configured = this.normalizeWechatRedirectUri(
      String(oauthSettings.wechat_auth_redirect_uri || this.config.wechatAuth.redirectUri || ''),
    );
    if (configured) {
      return configured;
    }
    return '';
  }

  private async getRuntimeOauthSettings() {
    const now = Date.now();
    if (this.oauthSettingsCache && this.oauthSettingsCache.expiresAt > now) {
      return this.oauthSettingsCache.value;
    }
    try {
      const value = await this.runtimeSettingsService.getOauthSettings();
      this.oauthSettingsCache = { expiresAt: now + 15_000, value };
      return value;
    } catch (error: any) {
      this.logger.warn(`runtime oauth settings load failed: ${error?.message || error}`);
      this.oauthSettingsCache = { expiresAt: now + 15_000, value: {} };
      return {};
    }
  }

  private buildWechatQrConnectUrl(config: WechatWebLoginConfig, state: string): string {
    const query = new URLSearchParams({
      appid: config.appId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'snsapi_login',
      state,
    });
    return `https://open.weixin.qq.com/connect/qrconnect?${query.toString()}#wechat_redirect`;
  }

  private async resolveWechatQrContent(connectUrl: string): Promise<WechatQrContentPayload> {
    const normalized = String(connectUrl || '').trim();
    if (!normalized) {
      return {
        qrContentUrl: '',
        uuid: null,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.wechatQrContentResolveTimeoutMs);
    try {
      const response = await fetch(normalized, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; OPGGatewayWechatQRParser/1.0)',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      if (!response.ok) {
        return {
          qrContentUrl: normalized,
          uuid: null,
        };
      }
      const html = await response.text();
      const directConfirm = this.extractWechatConfirmUrl(html);
      if (directConfirm) {
        return {
          qrContentUrl: directConfirm,
          uuid: this.extractUuidFromConfirmUrl(directConfirm),
        };
      }
      const uuid = this.extractWechatQrUuid(html);
      if (!uuid) {
        return {
          qrContentUrl: normalized,
          uuid: null,
        };
      }
      return {
        qrContentUrl: `https://open.weixin.qq.com/connect/confirm?uuid=${encodeURIComponent(uuid)}`,
        uuid,
      };
    } catch {
      return {
        qrContentUrl: normalized,
        uuid: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveWechatQrContentWithRetry(connectUrl: string): Promise<WechatQrContentPayload> {
    const first = await this.resolveWechatQrContent(connectUrl);
    if (first.uuid) {
      return first;
    }
    return this.resolveWechatQrContent(connectUrl);
  }

  private extractWechatConfirmUrl(html: string): string | null {
    const text = String(html || '');
    const match = text.match(/https:\/\/open\.weixin\.qq\.com\/connect\/confirm\?uuid=[A-Za-z0-9_-]+/i);
    return match?.[0] || null;
  }

  private extractUuidFromConfirmUrl(url: string): string | null {
    const normalized = String(url || '').trim();
    if (!normalized) {
      return null;
    }
    const match = normalized.match(/[?&]uuid=([A-Za-z0-9_-]{8,})/i);
    return match?.[1] || null;
  }

  private extractWechatQrUuid(html: string): string | null {
    const text = String(html || '');
    const patterns = [
      /window\.wx_code\s*=\s*["']([A-Za-z0-9_-]{8,})["']/i,
      /\/connect\/qrcode\/([A-Za-z0-9_-]{8,})/i,
      /uuid=([A-Za-z0-9_-]{8,})/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const value = String(match?.[1] || '').trim();
      if (value) {
        return value;
      }
    }
    return null;
  }

  private async fetchWechatQrScanStatus(uuid: string, lastErrCode?: number | null): Promise<WechatQrPollResult> {
    const normalizedUuid = String(uuid || '').trim();
    if (!normalizedUuid) {
      return { errCode: null, code: null };
    }
    const query = new URLSearchParams({
      uuid: normalizedUuid,
      last: String(lastErrCode || 0),
      _: String(Date.now()),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.wechatQrStatusRequestTimeoutMs);
    try {
      const response = await fetch(`https://lp.open.weixin.qq.com/connect/l/qrconnect?${query.toString()}`, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; OPGGatewayWechatQRStatus/1.0)',
          accept: 'text/plain,application/json,text/javascript,*/*',
        },
      });
      const text = await response.text();
      const errCodeMatch = text.match(/wx_errcode["']?\s*[:=]\s*["']?(\d{3})/i);
      const codeMatch = text.match(/wx_code["']?\s*[:=]\s*["']([A-Za-z0-9_-]+)["']/i);
      const errCode =
        errCodeMatch?.[1] ? Number.parseInt(errCodeMatch[1], 10) : response.status === 400 ? 402 : null;
      const code = codeMatch?.[1] || null;
      return {
        errCode: Number.isFinite(errCode as number) ? (errCode as number) : null,
        code,
      };
    } catch {
      return { errCode: null, code: null };
    } finally {
      clearTimeout(timer);
    }
  }

  private refreshWechatLoginSessionStatus(session: WechatLoginSession) {
    const now = Date.now();
    if (session.pollInFlight) {
      return;
    }
    if (now - session.lastPolledAt < this.wechatQrStatusPollIntervalMs) {
      return;
    }
    if (!session.uuid) {
      return;
    }
    if (session.status === 'CONFIRMED' || session.status === 'EXPIRED' || session.status === 'FAILED') {
      return;
    }

    session.pollInFlight = true;
    session.lastPolledAt = now;
    void this.fetchWechatQrScanStatus(session.uuid, session.lastErrCode)
      .then(async (poll) => {
        if (poll.errCode !== null) {
          session.lastErrCode = poll.errCode;
        }
        if (Date.now() >= session.expiresAt && session.status !== 'CONFIRMED') {
          session.status = 'EXPIRED';
          session.message = '二维码已过期，请刷新后重试';
          return;
        }

        if (poll.errCode === 404) {
          session.status = 'SCANNED';
          session.message = '已扫码，请在手机上确认登录';
          return;
        }

        if (poll.errCode === 405) {
          if (!poll.code) {
            session.status = 'SCANNED';
            session.message = '已扫码，请在手机上确认登录';
            return;
          }
          if (session.authPayload || session.exchangeInFlight) {
            return;
          }
          session.exchangeInFlight = true;
          try {
            if (session.mode === 'bind') {
              if (!session.bindUserId) {
                throw new UnauthorizedException('绑定会话不匹配，请刷新二维码后重试');
              }
              const app = await this.resolveAppWithSettings(session.appSlug);
              const config = await this.resolveWechatWebLoginConfig(app);
              if (!config) {
                throw new BadRequestException('当前租户未配置微信网页登录');
              }
              const identity = await this.exchangeWechatCode(config, poll.code);
              const payload = await this.bindWechatIdentity(
                session.bindUserId,
                identity.openid,
                identity.unionid,
                identity.profile,
              );
              session.authPayload = payload as unknown as Record<string, unknown>;
            } else {
              const payload = await this.loginWithWechat(poll.code, session.appSlug);
              session.authPayload = payload as unknown as Record<string, unknown>;
            }
            session.status = 'CONFIRMED';
            session.message = session.mode === 'bind' ? '微信绑定成功' : '登录成功';
          } catch (error) {
            this.logger.error(
              `wechat ${session.mode} exchange failed (session=${session.sessionId}, app=${session.appSlug}): ${
                error instanceof Error ? error.message : 'unknown'
              }`,
            );
            session.status = 'FAILED';
            session.message = session.mode === 'bind'
              ? (error instanceof Error ? error.message : '扫码已确认，但绑定失败，请刷新后重试')
              : '扫码已确认，但登录换取失败，请刷新后重试';
          } finally {
            session.exchangeInFlight = false;
          }
          return;
        }

        if (poll.errCode === 402 || poll.errCode === 403) {
          session.status = 'EXPIRED';
          session.message = '二维码已失效，请刷新后重试';
          return;
        }

        if (poll.errCode === 408 || poll.errCode === null) {
          if (session.status !== 'SCANNED') {
            session.status = 'PENDING';
            session.message = '等待扫码';
          }
          return;
        }

        session.status = 'PENDING';
        session.message = '等待扫码';
      })
      .catch((error) => {
        this.logger.warn(
          `wechat qr status refresh failed (session=${session.sessionId}, app=${session.appSlug}): ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        );
      })
      .finally(() => {
        session.pollInFlight = false;
      });
  }

  private cleanupWechatLoginSessions() {
    if (this.wechatLoginSessions.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [sessionId, session] of this.wechatLoginSessions.entries()) {
      if (session.expiresAt + 60_000 < now) {
        this.wechatLoginSessions.delete(sessionId);
      }
    }
  }

  private buildWechatSessionStatusResponse(session: WechatLoginSession) {
    const expiresIn = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    return {
      session_id: session.sessionId,
      status: session.status,
      message: session.message,
      expires_in: expiresIn,
      auth_payload: session.authPayload,
    };
  }

  private async fetchWechatAccessToken(config: WechatWebLoginConfig, code: string): Promise<WechatAccessTokenResponse> {
    const query = new URLSearchParams({
      appid: config.appId,
      secret: config.appSecret,
      code,
      grant_type: 'authorization_code',
    });
    const response = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?${query.toString()}`, {
      signal: AbortSignal.timeout(this.oauthRequestTimeoutMs),
    });
    const payload = (await response.json()) as WechatAccessTokenResponse;
    if (!response.ok || payload.errcode || !payload.access_token) {
      throw new UnauthorizedException(
        `微信登录失败：${payload.errmsg || `access_token error ${payload.errcode || response.status}`}`,
      );
    }
    return payload;
  }

  private async exchangeWechatCode(config: WechatWebLoginConfig, code: string): Promise<WechatIdentity> {
    const accessPayload = await this.fetchWechatAccessToken(config, code);
    const openid = String(accessPayload.openid || '').trim();
    const unionid = String(accessPayload.unionid || '').trim() || null;
    if (!openid) {
      throw new UnauthorizedException('微信授权失败：未获取到 openid');
    }
    return {
      openid,
      unionid,
      profile: await this.fetchWechatUserProfile(accessPayload.access_token, openid),
    };
  }

  private async bindWechatIdentity(
    userId: string,
    openid: string,
    unionid: string | null,
    profile?: WechatUserInfoResponse | null,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { app: true },
    });
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('User not found');
    }
    const conflict = await this.prisma.user.findFirst({
      where: {
        appId: user.appId,
        id: { not: userId },
        deletedAt: null,
        OR: [
          ...(unionid ? [{ wechatUnionid: unionid }] : []),
          { wechatOpenid: openid },
        ],
      },
      select: { id: true },
    });
    if (conflict) {
      throw new ConflictException('该微信已绑定其他账号');
    }
    const displayName = this.normalizeWechatDisplayName(profile?.nickname);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        wechatOpenid: openid,
        wechatUnionid: unionid,
        avatarUrl: profile?.headimgurl || user.avatarUrl,
        displayName: displayName || user.displayName,
      },
    });
    return { message: '微信绑定成功' };
  }

  private async fetchWechatUserProfile(accessToken: string | undefined, openid: string): Promise<WechatUserInfoResponse | null> {
    const normalizedAccessToken = String(accessToken || '').trim();
    if (!normalizedAccessToken) {
      return null;
    }
    const query = new URLSearchParams({
      access_token: normalizedAccessToken,
      openid,
      lang: 'zh_CN',
    });
    try {
      const response = await fetch(`https://api.weixin.qq.com/sns/userinfo?${query.toString()}`, {
        signal: AbortSignal.timeout(this.oauthRequestTimeoutMs),
      });
      const payload = (await response.json()) as WechatUserInfoResponse;
      if (!response.ok || payload.errcode) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  private normalizeWechatDisplayName(value: string | undefined): string | null {
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, 64) : null;
  }

  private buildWechatPlaceholderEmail(identity: string): string {
    const normalized = String(identity || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return `${normalized || `wx${Date.now()}`}@wechat.local`;
  }

  private buildGooglePlaceholderEmail(identity: string): string {
    const normalized = String(identity || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return `${normalized || `google${Date.now()}`}@google.local`;
  }

  private buildGitHubPlaceholderEmail(identity: string): string {
    const normalized = String(identity || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return `${normalized || `github${Date.now()}`}@github.local`;
  }

  private normalizeExternalDisplayName(value: string | undefined): string | null {
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, 64) : null;
  }

  private buildPhonePlaceholderEmail(phone: string): string {
    const normalized = String(phone || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    return `${normalized || `phone${Date.now()}`}@phone.local`;
  }

  private buildPhoneIdentityVariants(phone: string) {
    const canonical = String(phone || '').trim();
    const variants = new Set<string>();
    if (canonical) {
      variants.add(canonical);
    }

    const digits = canonical.startsWith('+') ? canonical.slice(1) : canonical;
    if (digits) {
      variants.add(digits);
    }
    if (canonical.startsWith('+')) {
      variants.add(digits);
    } else if (digits) {
      variants.add(`+${digits}`);
    }

    if (/^861[3-9]\d{9}$/.test(digits)) {
      variants.add(digits.slice(2));
      variants.add(`+${digits}`);
    }
    if (/^1[3-9]\d{9}$/.test(digits)) {
      variants.add(`+86${digits}`);
      variants.add(`86${digits}`);
    }

    return Array.from(variants).filter(Boolean);
  }

  private pickPhoneLoginUser(users: User[], normalizedPhone: string): User | null {
    const activeUsers = users.filter((user) => !user.deletedAt && user.isActive);
    return (
      activeUsers.find((user) => user.phone === normalizedPhone) ||
      activeUsers.find((user) => user.phoneVerified) ||
      activeUsers[0] ||
      users.find((user) => !user.deletedAt) ||
      null
    );
  }

  private async ensureRefreshSessionSchema() {
    if (!this.refreshSessionSchemaEnsured) {
      this.refreshSessionSchemaEnsured = this.prisma
        .$executeRawUnsafe(
          `ALTER TABLE users
           ADD COLUMN IF NOT EXISTS current_refresh_token_hash text NULL,
           ADD COLUMN IF NOT EXISTS refresh_token_issued_at timestamptz NULL,
           ADD COLUMN IF NOT EXISTS refresh_token_last_used_at timestamptz NULL`,
        )
        .then(() => undefined)
        .catch((error) => {
          this.refreshSessionSchemaEnsured = null;
          throw error;
        });
    }
    await this.refreshSessionSchemaEnsured;
  }

  private async ensureSmsVerificationSchema() {
    if (!this.smsVerificationSchemaEnsured) {
      this.smsVerificationSchemaEnsured = this.prisma
        .$executeRawUnsafe(
          `CREATE TABLE IF NOT EXISTS auth_sms_verification_codes (
             id uuid PRIMARY KEY,
             app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
             phone varchar(64) NOT NULL,
             code_hash varchar(128) NOT NULL,
             attempt_count integer NOT NULL DEFAULT 0,
             max_attempts integer NOT NULL DEFAULT 5,
             provider_id uuid NULL,
             signature_id uuid NULL,
             expire_at timestamptz NOT NULL,
             consumed_at timestamptz NULL,
             created_at timestamptz NOT NULL DEFAULT now(),
             updated_at timestamptz NOT NULL DEFAULT now()
           )`,
        )
        .then(async () => {
          await this.prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS idx_auth_sms_codes_lookup
             ON auth_sms_verification_codes(app_id, phone, created_at DESC)`,
          );
          await this.prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS idx_auth_sms_codes_expire
             ON auth_sms_verification_codes(expire_at DESC)`,
          );
        })
        .catch((error) => {
          this.smsVerificationSchemaEnsured = null;
          throw error;
        });
    }
    await this.smsVerificationSchemaEnsured;
  }

  private async assertSmsSendCooldown(appId: string, phone: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT created_at
       FROM auth_sms_verification_codes
       WHERE app_id = $1::uuid AND phone = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      appId,
      phone,
    ) as Promise<Array<{ created_at: Date }>>);
    const latest = rows[0];
    if (!latest) {
      return;
    }
    const elapsedSeconds = Math.floor((Date.now() - new Date(latest.created_at).getTime()) / 1000);
    if (elapsedSeconds < 60) {
      throw new BadRequestException(`验证码发送过于频繁，请 ${60 - elapsedSeconds} 秒后重试`);
    }
  }

  private async storeSmsCode(input: {
    appId: string;
    phone: string;
    code: string;
    providerId: string;
    signatureId: string;
  }) {
    const now = Date.now();
    const expireAt = new Date(now + 5 * 60 * 1000);
    const codeHash = this.hashSmsCode(input.appId, input.phone, input.code);
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM auth_sms_verification_codes
       WHERE app_id = $1::uuid AND phone = $2 AND consumed_at IS NULL`,
      input.appId,
      input.phone,
    );
    const nowMs = Date.now();
    if (nowMs - this.lastSmsCodeCleanupAt > 10 * 60 * 1000) {
      this.lastSmsCodeCleanupAt = nowMs;
      void this.prisma
        .$executeRawUnsafe(
          `DELETE FROM auth_sms_verification_codes
           WHERE created_at < now() - interval '7 days'`,
        )
        .catch((error) => {
          this.logger.warn(
            `auth_sms_verification_codes cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        });
    }
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO auth_sms_verification_codes (
         id, app_id, phone, code_hash, attempt_count, max_attempts, provider_id, signature_id, expire_at, consumed_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, 0, 5, $5::uuid, $6::uuid, $7, null, now(), now()
       )`,
      randomUUID(),
      input.appId,
      input.phone,
      codeHash,
      input.providerId,
      input.signatureId,
      expireAt,
    );
  }

  private async verifySmsCode(appId: string, phone: string, code: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, code_hash, expire_at, attempt_count, max_attempts
       FROM auth_sms_verification_codes
       WHERE app_id = $1::uuid
         AND phone = $2
         AND consumed_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      appId,
      phone,
    ) as Promise<SmsCodeRow[]>);
    const row = rows[0];
    if (!row) {
      throw new UnauthorizedException('验证码错误或已过期');
    }
    if (new Date(row.expire_at).getTime() <= Date.now()) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE auth_sms_verification_codes
         SET consumed_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        row.id,
      );
      throw new UnauthorizedException('验证码错误或已过期');
    }

    const codeHash = this.hashSmsCode(appId, phone, code);
    if (codeHash !== row.code_hash) {
      const nextAttempts = Number(row.attempt_count || 0) + 1;
      const maxAttempts = Math.max(1, Number(row.max_attempts || 5));
      const consumedAt = nextAttempts >= maxAttempts ? new Date() : null;
      await this.prisma.$executeRawUnsafe(
        `UPDATE auth_sms_verification_codes
         SET attempt_count = $2, consumed_at = $3, updated_at = now()
         WHERE id = $1::uuid`,
        row.id,
        nextAttempts,
        consumedAt,
      );
      throw new UnauthorizedException('验证码错误或已过期');
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE auth_sms_verification_codes
       SET consumed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      row.id,
    );
  }

  private hashSmsCode(appId: string, phone: string, code: string) {
    const secret = String(this.config.jwt.secret || '');
    return createHash('sha256').update(`${appId}:${phone}:${code}:${secret}`, 'utf8').digest('hex');
  }

  private resolveSmsDispatchMode(provider: SmsProviderRow): 'SYNC' | 'ASYNC' {
    const cfg = asPlainObject(provider.config_json);
    const modeRaw = String(cfg.dispatch_mode || '').trim().toUpperCase();
    if (modeRaw === 'ASYNC') {
      return 'ASYNC';
    }
    if (modeRaw === 'SYNC') {
      return 'SYNC';
    }
    if (this.parseBooleanLike(cfg.async_dispatch, false)) {
      return 'ASYNC';
    }
    // Default async for Aliyun to reduce response latency in auth flows.
    return provider.provider_type === 'ALIYUN_SMS' ? 'ASYNC' : 'SYNC';
  }

  private async deleteSmsCode(input: { appId: string; phone: string; code: string }) {
    const codeHash = this.hashSmsCode(input.appId, input.phone, input.code);
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM auth_sms_verification_codes
       WHERE app_id = $1::uuid
         AND phone = $2
         AND code_hash = $3
         AND consumed_at IS NULL`,
      input.appId,
      input.phone,
      codeHash,
    );
  }

  private normalizePhone(phone: string) {
    const normalized = String(phone || '')
      .trim()
      .replace(/[\s-]+/g, '');
    if (!/^\+?\d{6,20}$/.test(normalized)) {
      throw new BadRequestException('手机号格式不正确');
    }
    const hasExplicitCountryCode = normalized.startsWith('+');
    const digits = hasExplicitCountryCode ? normalized.slice(1) : normalized;
    if (hasExplicitCountryCode) {
      return `+${digits}`;
    }
    if (/^1[3-9]\d{9}$/.test(digits)) {
      return `+86${digits}`;
    }
    if (/^861[3-9]\d{9}$/.test(digits)) {
      return `+${digits}`;
    }
    return digits;
  }

  private normalizeSmsCode(code: string) {
    const normalized = String(code || '').trim();
    if (!/^\d{4,8}$/.test(normalized)) {
      throw new BadRequestException('验证码格式不正确');
    }
    return normalized;
  }

  private parseBooleanLike(value: unknown, fallback: boolean) {
    if (typeof value === 'boolean') return value;
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
    return fallback;
  }

  private parseSmsProviderType(value: unknown): SmsProviderType {
    const normalized = String(value || '')
      .trim()
      .toUpperCase();
    if (normalized !== 'GENERIC_API' && normalized !== 'ALIYUN_SMS') {
      throw new BadRequestException(`unsupported sms provider type: ${normalized || 'UNKNOWN'}`);
    }
    return normalized as SmsProviderType;
  }

  private extractAppSmsRouteConfig(extraJson: unknown): AppSmsRouteConfig {
    const raw = asPlainObject(extraJson);
    const providerId = String(raw.sms_provider_ref_id || '').trim();
    const signatureId = String(raw.sms_signature_ref_id || '').trim();
    const templateId = String(raw.sms_template_ref_id || '').trim();
    return {
      sms_provider_ref_id: providerId || undefined,
      sms_signature_ref_id: signatureId || undefined,
      sms_template_ref_id: templateId || undefined,
    };
  }

  private async resolveSmsRouteConfig(app: AppWithSettings): Promise<SmsRouteConfigResolved> {
    const appSmsConfig = this.extractAppSmsRouteConfig(app.settings?.extraJson);
    const cacheKey = this.buildSmsRouteCacheKey(app.id, appSmsConfig);
    const cached = this.smsRouteCache.get(cacheKey);
    if (cached && cached.expires_at > Date.now()) {
      return cached.value;
    }

    const relationRows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         to_regclass('public.platform_sms_providers')::text AS providers_table,
         to_regclass('public.platform_sms_signatures')::text AS signatures_table,
         to_regclass('public.platform_sms_templates')::text AS templates_table`,
    ) as Promise<Array<{ providers_table: string | null; signatures_table: string | null; templates_table: string | null }>>);
    const relation = relationRows[0];
    if (!relation?.providers_table || !relation?.signatures_table) {
      throw new BadRequestException('短信服务未配置，请先在平台后台创建短信服务和签名');
    }

    const providerRowsRaw = await (this.prisma.$queryRawUnsafe(
      `SELECT id, provider_type, name, is_active, is_default, config_json
       FROM platform_sms_providers
       WHERE is_active = true
       ORDER BY is_default DESC, updated_at DESC, created_at DESC`,
    ) as Promise<SmsProviderRow[]>);
    const providerRows = providerRowsRaw.filter((row) => this.parseBooleanLike(asPlainObject(row.config_json).enabled, true));
    if (!providerRows.length) {
      throw new BadRequestException('短信服务未启用，请在平台后台开启一个短信服务');
    }

    let template: SmsTemplateRow | null = null;
    if (relation.templates_table && appSmsConfig.sms_template_ref_id) {
      const templateRows = await (this.prisma.$queryRawUnsafe(
        `SELECT id, provider_id, template_code, template_name, is_active, is_default, meta_json
         FROM platform_sms_templates
         WHERE id = $1::uuid
         LIMIT 1`,
        appSmsConfig.sms_template_ref_id,
      ) as Promise<SmsTemplateRow[]>);
      const selectedTemplate = templateRows[0];
      if (!selectedTemplate) {
        throw new BadRequestException('当前应用配置的验证码模板不存在，请重新选择');
      }
      if (!selectedTemplate.is_active) {
        throw new BadRequestException('当前应用配置的验证码模板未启用，请重新选择');
      }
      template = selectedTemplate;
    }

    let provider: SmsProviderRow | undefined;
    if (appSmsConfig.sms_provider_ref_id) {
      provider = providerRows.find((row) => row.id === appSmsConfig.sms_provider_ref_id);
      if (!provider) {
        throw new BadRequestException('当前应用配置的短信服务不可用，请重新选择');
      }
    }
    if (!provider && template) {
      provider = providerRows.find((row) => row.id === template!.provider_id);
      if (!provider) {
        throw new BadRequestException('当前应用验证码模板所属短信服务不可用，请重新选择模板');
      }
    }
    if (!provider) {
      provider = providerRows[0];
    }

    if (template && template.provider_id !== provider.id) {
      throw new BadRequestException('验证码模板与短信服务不匹配，请重新配置应用短信模板');
    }

    let signature: SmsSignatureRow | null = null;
    if (appSmsConfig.sms_signature_ref_id) {
      const signatureRows = await (this.prisma.$queryRawUnsafe(
        `SELECT id, provider_id, sign_name, is_active, is_default, meta_json
         FROM platform_sms_signatures
         WHERE id = $1::uuid AND provider_id = $2::uuid
         LIMIT 1`,
        appSmsConfig.sms_signature_ref_id,
        provider.id,
      ) as Promise<SmsSignatureRow[]>);
      const selectedSignature = signatureRows[0];
      if (!selectedSignature) {
        throw new BadRequestException('当前应用配置的短信签名不可用，请重新选择');
      }
      if (!selectedSignature.is_active) {
        throw new BadRequestException('当前应用配置的短信签名未启用，请重新选择');
      }
      signature = selectedSignature;
    }

    if (!signature) {
      const signatureRows = await (this.prisma.$queryRawUnsafe(
        `SELECT id, provider_id, sign_name, is_active, is_default, meta_json
         FROM platform_sms_signatures
         WHERE provider_id = $1::uuid AND is_active = true
         ORDER BY is_default DESC, updated_at DESC, created_at DESC`,
        provider.id,
      ) as Promise<SmsSignatureRow[]>);
      signature = signatureRows[0] || null;
    }
    if (!signature) {
      throw new BadRequestException('短信签名未配置，请先创建并启用短信签名');
    }

    if (!template && relation.templates_table) {
      const templateRows = await (this.prisma.$queryRawUnsafe(
        `SELECT id, provider_id, template_code, template_name, is_active, is_default, meta_json
         FROM platform_sms_templates
         WHERE provider_id = $1::uuid AND is_active = true
         ORDER BY is_default DESC, updated_at DESC, created_at DESC`,
        provider.id,
      ) as Promise<SmsTemplateRow[]>);
      template = templateRows[0] || null;
    }

    const resolved = {
      provider: {
        ...provider,
        provider_type: this.parseSmsProviderType(provider.provider_type),
      } as SmsProviderRow,
      signature,
      template,
    };
    this.smsRouteCache.set(cacheKey, {
      expires_at: Date.now() + this.smsRouteCacheTtlMs,
      value: resolved,
    });
    return resolved;
  }

  private buildSmsRouteCacheKey(appId: string, routeConfig: AppSmsRouteConfig) {
    return [
      appId,
      routeConfig.sms_provider_ref_id || '-',
      routeConfig.sms_signature_ref_id || '-',
      routeConfig.sms_template_ref_id || '-',
    ].join('|');
  }

  private async dispatchSmsCode(
    provider: SmsProviderRow,
    signature: SmsSignatureRow,
    template: SmsTemplateRow | null,
    phone: string,
    code: string,
  ) {
    if (provider.provider_type === 'GENERIC_API') {
      await this.dispatchGenericApiSms(provider, signature, template, phone, code);
      return;
    }
    await this.dispatchAliyunSms(provider, signature, template, phone, code);
  }

  private async dispatchGenericApiSms(
    provider: SmsProviderRow,
    signature: SmsSignatureRow,
    template: SmsTemplateRow | null,
    phone: string,
    code: string,
  ) {
    const cfg = asPlainObject(provider.config_json);
    const endpointUrl = String(cfg.endpoint_url || '').trim();
    if (!endpointUrl) {
      throw new BadRequestException('通用短信配置缺少 endpoint_url');
    }
    const method = String(cfg.http_method || 'POST').trim().toUpperCase() === 'GET' ? 'GET' : 'POST';
    const authType = String(cfg.auth_type || 'NONE').trim().toUpperCase();
    const authHeaderName = String(cfg.auth_header_name || '').trim() || 'Authorization';
    const contentType = String(cfg.content_type || 'JSON').trim().toUpperCase() === 'FORM' ? 'FORM' : 'JSON';
    const timeoutRaw = Number(cfg.timeout_ms ?? 15000);
    const timeoutMs = Number.isFinite(timeoutRaw) ? Math.min(Math.max(Math.floor(timeoutRaw), 1000), 60000) : 15000;
    const phoneField = String(cfg.phone_field || '').trim() || 'phone';
    const codeField = String(cfg.code_field || '').trim() || 'code';
    const signField = String(cfg.sign_field || '').trim() || 'sign_name';
    const templateField = String(cfg.template_field || '').trim() || 'template_code';
    const templateCode = this.pickSmsTemplateCode(template, asPlainObject(signature.meta_json), cfg);
    const templateVars = this.pickSmsTemplateVariables(template);

    const payload: Record<string, string> = {};
    Object.entries(templateVars).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        payload[key] = String(value);
        return;
      }
      payload[key] = JSON.stringify(value);
    });
    payload[phoneField] = phone;
    payload[codeField] = code;
    if (signature.sign_name && signField) {
      payload[signField] = signature.sign_name;
    }
    if (templateCode && templateField) {
      payload[templateField] = templateCode;
    }

    const headers: Record<string, string> = {};
    if (authType === 'BEARER') {
      const token = String(cfg.auth_token || '').trim();
      if (token) {
        headers[authHeaderName] = token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
      }
    } else if (authType === 'API_KEY') {
      const apiKey = String(cfg.api_key || '').trim();
      if (apiKey) {
        headers[authHeaderName] = apiKey;
      }
    }

    let requestUrl = endpointUrl;
    let body: string | undefined;
    if (method === 'GET') {
      const url = new URL(endpointUrl);
      Object.entries(payload).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
      requestUrl = url.toString();
    } else if (contentType === 'FORM') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(payload).toString();
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload);
    }

    let response: Response;
    try {
      response = await fetch(requestUrl, {
        method,
        headers,
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.rethrowSmsDispatchFetchError(error, `通用短信服务(${provider.name})`, timeoutMs);
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw new BadRequestException(`短信服务请求失败(${response.status})${text ? `: ${text}` : ''}`);
    }
  }

  private async dispatchAliyunSms(
    provider: SmsProviderRow,
    signature: SmsSignatureRow,
    template: SmsTemplateRow | null,
    phone: string,
    code: string,
  ) {
    const cfg = asPlainObject(provider.config_json);
    const accessKeyId = String(cfg.access_key_id || '').trim();
    const accessKeySecret = String(cfg.access_key_secret || '').trim();
    if (!accessKeyId || !accessKeySecret) {
      throw new BadRequestException('阿里云短信配置缺少 access_key_id 或 access_key_secret');
    }
    const signName = String(signature.sign_name || '').trim();
    if (!signName) {
      throw new BadRequestException('阿里云短信签名为空，请检查短信签名配置');
    }
    const templateCode = this.pickSmsTemplateCode(template, asPlainObject(signature.meta_json), cfg);
    if (!templateCode) {
      throw new BadRequestException('阿里云短信模板未配置，请在模板列表中创建并启用默认模板');
    }
    const timeoutRaw = Number(cfg.timeout_ms ?? 15000);
    const timeoutMs = Number.isFinite(timeoutRaw) ? Math.min(Math.max(Math.floor(timeoutRaw), 1000), 60000) : 15000;
    const endpointUrl = String(cfg.endpoint_url || '').trim() || 'https://dysmsapi.aliyuncs.com/';
    const regionId = String(cfg.region_id || '').trim() || 'cn-hangzhou';
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    const templateVars = this.pickSmsTemplateVariables(template);
    const templateParams = {
      ...templateVars,
      code,
    };

    const query: Record<string, string> = {
      AccessKeyId: accessKeyId,
      Action: 'SendSms',
      Format: 'JSON',
      PhoneNumbers: phone,
      RegionId: regionId,
      SignName: signName,
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: randomUUID(),
      SignatureVersion: '1.0',
      TemplateCode: templateCode,
      TemplateParam: JSON.stringify(templateParams),
      Timestamp: timestamp,
      Version: '2017-05-25',
    };
    const signedUrl = this.buildAliyunSignedUrl(endpointUrl, query, accessKeySecret);
    let response: Response;
    try {
      response = await fetch(signedUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.rethrowSmsDispatchFetchError(error, `阿里云短信服务(${provider.name})`, timeoutMs);
    }
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const responseCode = String(payload.Code || payload.code || '').trim();
      const responseMessage = String(payload.Message || payload.message || '').trim();
      const detail = responseCode || responseMessage
        ? `${responseCode}${responseMessage ? ` ${responseMessage}` : ''}`
        : text.slice(0, 300);
      throw new BadRequestException(`阿里云短信请求失败(${response.status})${detail ? `：${detail}` : ''}`);
    }
    const responseCode = String(payload.Code || '').trim().toUpperCase();
    if (responseCode && responseCode !== 'OK') {
      const message = String(payload.Message || '').trim();
      throw new BadRequestException(`阿里云短信发送失败：${responseCode}${message ? ` ${message}` : ''}`);
    }
  }

  private rethrowSmsDispatchFetchError(error: unknown, providerLabel: string, timeoutMs: number): never {
    const name = String((error as { name?: unknown })?.name || '').trim();
    const message = String((error as { message?: unknown })?.message || '').trim();
    const lower = message.toLowerCase();
    const isTimeout =
      name === 'TimeoutError' ||
      lower.includes('aborted due to timeout') ||
      lower.includes('request timed out');

    if (isTimeout) {
      throw new BadGatewayException(`${providerLabel}请求超时（${timeoutMs}ms），请检查服务商连通性或调大 timeout_ms`);
    }

    const reason = message ? message.slice(0, 240) : 'network error';
    this.logger.error(`${providerLabel}网络异常: ${reason}`);
    throw new BadGatewayException(`${providerLabel}请求失败：${reason}`);
  }

  private pickSmsTemplateCode(
    template: SmsTemplateRow | null,
    signatureMeta: Record<string, unknown>,
    providerConfig: Record<string, unknown>,
  ) {
    const tableTemplate = String(template?.template_code || '').trim();
    if (tableTemplate) {
      return tableTemplate;
    }
    const signatureTemplate = String(signatureMeta.template_code || signatureMeta.templateCode || '').trim();
    if (signatureTemplate) {
      return signatureTemplate;
    }
    return String(providerConfig.template_code || providerConfig.templateCode || '').trim();
  }

  private pickSmsTemplateVariables(template: SmsTemplateRow | null): Record<string, unknown> {
    if (!template) {
      return {};
    }
    const meta = asPlainObject(template.meta_json);
    const candidates = [
      meta.variables_example,
      meta.variables_sample,
      meta.template_params_example,
      meta.template_params_sample,
      meta.template_param_example,
    ];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        return candidate as Record<string, unknown>;
      }
    }
    return {};
  }

  private buildAliyunSignedUrl(endpointUrl: string, params: Record<string, string>, accessKeySecret: string) {
    let parsed: URL;
    try {
      parsed = new URL(endpointUrl);
    } catch {
      throw new BadRequestException('阿里云 endpoint_url 非法');
    }
    parsed.hash = '';
    parsed.search = '';
    // Aliyun RPC requires strict lexicographical ordering by parameter name.
    const sortedKeys = Object.keys(params).sort();
    const canonicalizedQueryString = sortedKeys
      .map((key) => `${this.aliyunPercentEncode(key)}=${this.aliyunPercentEncode(String(params[key] ?? ''))}`)
      .join('&');
    const stringToSign = `GET&%2F&${this.aliyunPercentEncode(canonicalizedQueryString)}`;
    const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
    const query = `${canonicalizedQueryString}&Signature=${this.aliyunPercentEncode(signature)}`;
    return `${parsed.origin}${parsed.pathname || '/'}?${query}`;
  }

  private aliyunPercentEncode(value: string) {
    return encodeURIComponent(String(value || ''))
      .replace(/\+/g, '%20')
      .replace(/\*/g, '%2A')
      .replace(/%7E/g, '~');
  }

  private async ensureWechatOpenAppSchema() {
    if (!this.wechatOpenAppSchemaEnsured) {
      this.wechatOpenAppSchemaEnsured = this.prisma
        .$executeRawUnsafe(
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
        )
        .then(async () => {
          await this.prisma.$executeRawUnsafe(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_open_apps_name_unique
             ON wechat_open_apps(LOWER(name))`,
          );
          await this.prisma.$executeRawUnsafe(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_open_apps_appid_unique
             ON wechat_open_apps(LOWER(app_id))`,
          );
        })
        .catch((error) => {
          this.wechatOpenAppSchemaEnsured = null;
          throw error;
        });
    }
    await this.wechatOpenAppSchemaEnsured;
  }

  private async ensureGoogleOAuthClientSchema() {
    if (!this.googleOAuthClientSchemaEnsured) {
      this.googleOAuthClientSchemaEnsured = this.prisma
        .$executeRawUnsafe(
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
        )
        .then(async () => {
          await this.prisma.$executeRawUnsafe(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_google_oauth_clients_name_unique
             ON google_oauth_clients(LOWER(name))`,
          );
          await this.prisma.$executeRawUnsafe(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_google_oauth_clients_client_id_unique
             ON google_oauth_clients(LOWER(client_id))`,
          );
        })
        .catch((error) => {
          this.googleOAuthClientSchemaEnsured = null;
          throw error;
        });
    }
    await this.googleOAuthClientSchemaEnsured;
  }

  private async ensureGitHubOAuthAppSchema() {
    if (!this.githubOAuthAppSchemaEnsured) {
      this.githubOAuthAppSchemaEnsured = this.prisma
        .$executeRawUnsafe(
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
        )
        .then(async () => {
          await this.prisma.$executeRawUnsafe(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_github_oauth_apps_name_unique
             ON github_oauth_apps(LOWER(name))`,
          );
          await this.prisma.$executeRawUnsafe(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_github_oauth_apps_client_id_unique
             ON github_oauth_apps(LOWER(client_id))`,
          );
        })
        .catch((error) => {
          this.githubOAuthAppSchemaEnsured = null;
          throw error;
        });
    }
    await this.githubOAuthAppSchemaEnsured;
  }

  async resolveApp(appSlug?: string) {
    const slug = appSlug || this.config.app.defaultSlug;
    const now = Date.now();
    const cached = this.appBySlugCache.get(slug);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const app = await this.prisma.app.findUnique({ where: { slug } });
    if (!app) {
      throw new ConflictException(`App not found: ${slug}`);
    }
    this.appBySlugCache.set(slug, { expiresAt: now + this.appCacheTtlMs, value: app });
    return app;
  }

  async buildAuthResponse(user: User, appSlug: string, sessionToken: string, options: BuildAuthResponseOptions = {}) {
    const issuedAt = new Date();
    const sessionId = options.sessionId || randomUUID();
    const sessionStartedAt = options.refreshSessionStartedAt || issuedAt;
    let inviteCode: string | null = this.getCachedInviteCode(user.appId, user.id);
    try {
      if (!inviteCode) {
        inviteCode = await this.ensureInviteCodeForUser(user.appId, user.id);
        if (inviteCode) {
          this.setCachedInviteCode(user.appId, user.id, inviteCode);
        }
      }
    } catch (error) {
      this.logger.warn(
        `invite code lookup failed (app=${user.appId}, user=${user.id}): ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }

    const accessPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      sid: sessionId,
      sessionToken,
      appSlug,
      type: 'access',
    };
    const refreshPayload = {
      ...accessPayload,
      type: 'refresh',
      refreshSessionStartedAt: sessionStartedAt.toISOString(),
    };
    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: this.config.jwt.secret,
      expiresIn: `${this.config.jwt.refreshAbsoluteDays}d`,
    });
    await this.upsertAuthUserSession({
      sessionId,
      user,
      sessionToken,
      refreshToken,
      issuedAt,
      expiresAt: new Date(sessionStartedAt.getTime() + this.getRefreshTokenAbsoluteMs()),
      provider: options.provider,
      userAgent: options.userAgent,
      ipAddress: options.ipAddress,
    });
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        currentRefreshTokenHash: this.hashRefreshToken(refreshToken),
        refreshTokenIssuedAt: issuedAt,
        refreshTokenLastUsedAt: issuedAt,
      },
    });

    return {
      access_token: this.jwtService.sign(accessPayload, {
        secret: this.config.jwt.secret,
        expiresIn: this.config.jwt.expiresIn,
      }),
      refresh_token: refreshToken,
      token_type: 'bearer',
      invite_code: inviteCode || undefined,
      user: this.pickUserProfile(user as SafeUser),
    };
  }

  private normalizeAppSlug(raw: unknown): string | null {
    const value = String(raw || '').trim();
    if (value.toLowerCase() === 'api') {
      return null;
    }
    return value || null;
  }

  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
  }

  private hashSessionToken(token: string): string {
    return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
  }

  private async upsertAuthUserSession(input: {
    sessionId: string;
    user: Pick<User, 'id' | 'appId'>;
    sessionToken: string;
    refreshToken: string;
    issuedAt: Date;
    expiresAt: Date;
    provider?: string | null;
    userAgent?: string | null;
    ipAddress?: string | null;
  }) {
    const sessionTokenHash = this.hashSessionToken(input.sessionToken);
    const refreshTokenHash = this.hashRefreshToken(input.refreshToken);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO auth_user_sessions (
         id, user_id, app_id, session_token_hash, refresh_token_hash,
         provider, user_agent, ip_address, issued_at, last_used_at, expires_at, updated_at
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::timestamptz, $9::timestamptz, $10::timestamptz, now())
       ON CONFLICT (id) DO UPDATE SET
         refresh_token_hash = EXCLUDED.refresh_token_hash,
         last_used_at = EXCLUDED.last_used_at,
         expires_at = EXCLUDED.expires_at,
         revoked_at = NULL,
         updated_at = now()`,
      input.sessionId,
      input.user.id,
      input.user.appId,
      sessionTokenHash,
      refreshTokenHash,
      input.provider || null,
      input.userAgent || null,
      input.ipAddress || null,
      input.issuedAt,
      input.expiresAt,
    );
    await this.pruneAuthUserSessions(input.user.id, input.user.appId);
  }

  private async pruneAuthUserSessions(userId: string, appId: string) {
    await this.prisma.$executeRawUnsafe(
      `WITH ranked AS (
         SELECT id,
                row_number() OVER (ORDER BY last_used_at DESC, issued_at DESC, created_at DESC) AS rank
           FROM auth_user_sessions
          WHERE user_id = $1::uuid
            AND app_id = $2::uuid
            AND revoked_at IS NULL
            AND expires_at > now()
       )
       UPDATE auth_user_sessions
          SET revoked_at = now(),
              updated_at = now()
        WHERE id IN (SELECT id FROM ranked WHERE rank > $3)`,
      userId,
      appId,
      this.maxActiveUserSessions,
    );
  }

  async revokeAllAuthUserSessions(userId: string) {
    await this.prisma.$executeRawUnsafe(
      `UPDATE auth_user_sessions
          SET revoked_at = now(),
              updated_at = now()
        WHERE user_id = $1::uuid
          AND revoked_at IS NULL`,
      userId,
    );
  }

  private async findActiveAuthSession(sessionId: string, userId: string): Promise<AuthSessionRow | null> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, user_id, app_id, session_token_hash, refresh_token_hash,
              issued_at, last_used_at, expires_at, revoked_at
         FROM auth_user_sessions
        WHERE id = $1::uuid
          AND user_id = $2::uuid
          AND revoked_at IS NULL
          AND expires_at > now()
        LIMIT 1`,
      sessionId,
      userId,
    ) as Promise<AuthSessionRow[]>);
    return rows[0] || null;
  }

  private dateFromUnixSeconds(value: unknown): Date | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return null;
    }
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private dateFromTokenTime(value: unknown): Date | null {
    if (typeof value === 'string') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return this.dateFromUnixSeconds(value);
  }

  private getRefreshTokenInactivityMs(): number {
    return this.config.jwt.refreshInactivityDays * 24 * 60 * 60 * 1000;
  }

  private getRefreshTokenAbsoluteMs(): number {
    return this.config.jwt.refreshAbsoluteDays * 24 * 60 * 60 * 1000;
  }

  private async validateSessionUser(payload: AuthTokenPayload, expectedAppSlug?: string) {
    const userId = String(payload.sub || '').trim();
    if (!userId) {
      throw new UnauthorizedException('Invalid token subject');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        appId: true,
        email: true,
        role: true,
        isActive: true,
        deletedAt: true,
        sessionToken: true,
        currentRefreshTokenHash: true,
        refreshTokenIssuedAt: true,
        refreshTokenLastUsedAt: true,
      },
    });
    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('User not found or inactive');
    }
    let authSession: AuthSessionRow | null = null;
    const payloadSessionToken = String(payload.sessionToken || '').trim();
    const payloadSessionId = String(payload.sid || '').trim();
    if (payloadSessionId) {
      if (!payloadSessionToken) {
        throw new UnauthorizedException('Session has been invalidated');
      }
      authSession = await this.findActiveAuthSession(payloadSessionId, user.id);
      if (!authSession || authSession.app_id !== user.appId) {
        throw new UnauthorizedException('Session has been invalidated');
      }
      if (authSession.session_token_hash !== this.hashSessionToken(payloadSessionToken)) {
        throw new UnauthorizedException('Session has been invalidated');
      }
    } else if (!user.sessionToken || user.sessionToken !== payload.sessionToken) {
      throw new UnauthorizedException('Session has been invalidated');
    }
    const sessionToken = payloadSessionId ? payloadSessionToken : user.sessionToken;
    const payloadAppSlug = this.normalizeAppSlug(payload.appSlug);
    const requestedAppSlug = this.normalizeAppSlug(expectedAppSlug);
    if (requestedAppSlug && payloadAppSlug && requestedAppSlug !== payloadAppSlug) {
      throw new UnauthorizedException('Token app mismatch');
    }
    let resolvedAppSlug = payloadAppSlug || requestedAppSlug;
    if (!resolvedAppSlug) {
      resolvedAppSlug = (await this.resolveAppByIdWithSettings(user.appId)).slug;
    }
    return {
      user: {
        ...user,
        sessionToken,
      },
      appSlug: resolvedAppSlug,
      authSession,
    };
  }

  private async ensureInviteCodeForUser(appId: string, userId: string): Promise<string> {
    await this.ensureInviteSchema();
    const normalizedAppId = String(appId || '').trim();
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedAppId || !normalizedUserId) {
      throw new BadRequestException('invalid invite scope');
    }
    const cached = this.getCachedInviteCode(normalizedAppId, normalizedUserId);
    if (cached) {
      return cached;
    }

    const existingRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, user_id, invite_code, created_at, updated_at
         FROM auth_invite_codes
        WHERE app_id = $1::uuid
          AND user_id = $2::uuid
        LIMIT 1`,
      normalizedAppId,
      normalizedUserId,
    ) as Promise<InviteCodeLookupRow[]>);
    const existing = existingRows[0];
    if (existing?.invite_code) {
      const normalizedExisting = this.normalizeInviteCode(existing.invite_code);
      if (normalizedExisting.length === INVITE_CODE_LENGTH && normalizedExisting === existing.invite_code) {
        this.setCachedInviteCode(normalizedAppId, normalizedUserId, normalizedExisting);
        return normalizedExisting;
      }
      const rotated = await this.rotateInviteCodeForUser(normalizedAppId, normalizedUserId, existing.id);
      if (rotated) {
        this.setCachedInviteCode(normalizedAppId, normalizedUserId, rotated);
        return rotated;
      }
      this.setCachedInviteCode(normalizedAppId, normalizedUserId, existing.invite_code);
      return existing.invite_code;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const inviteCode = this.generateInviteCode();
      const inserted = await (this.prisma.$queryRawUnsafe(
        `INSERT INTO auth_invite_codes (
           id, app_id, user_id, invite_code, created_at, updated_at
         ) VALUES (
           gen_random_uuid(),
           $1::uuid,
           $2::uuid,
           $3,
           now(),
           now()
         )
         ON CONFLICT DO NOTHING
         RETURNING invite_code`,
        normalizedAppId,
        normalizedUserId,
        inviteCode,
      ) as Promise<InviteCodeRow[]>);
      const createdCode = this.normalizeInviteCode(inserted[0]?.invite_code);
      if (createdCode) {
        this.setCachedInviteCode(normalizedAppId, normalizedUserId, createdCode);
        return createdCode;
      }

      const retryRows = await (this.prisma.$queryRawUnsafe(
        `SELECT id, app_id, user_id, invite_code, created_at, updated_at
           FROM auth_invite_codes
          WHERE app_id = $1::uuid
            AND user_id = $2::uuid
          LIMIT 1`,
        normalizedAppId,
        normalizedUserId,
      ) as Promise<InviteCodeLookupRow[]>);
      const retryCode = this.normalizeInviteCode(retryRows[0]?.invite_code);
      if (retryCode) {
        this.setCachedInviteCode(normalizedAppId, normalizedUserId, retryCode);
        return retryCode;
      }
    }

    throw new BadRequestException('failed to generate invite code');
  }

  private async tryApplyInviteReward(appId: string, inviteeUserId: string, inviteCode?: string) {
    const normalizedInviteCode = this.normalizeInviteCode(inviteCode);
    if (!normalizedInviteCode) {
      return;
    }

    try {
      await this.ensureInviteSchema();
      const inviterRows = await (this.prisma.$queryRawUnsafe(
        `SELECT user_id
           FROM auth_invite_codes
          WHERE app_id = $1::uuid
            AND UPPER(invite_code) = UPPER($2)
          LIMIT 1`,
        appId,
        normalizedInviteCode,
      ) as Promise<Array<{ user_id: string }>>);
      const inviterUserId = String(inviterRows[0]?.user_id || '').trim();
      if (!inviterUserId || inviterUserId === inviteeUserId) {
        return;
      }

      const inserted = await (this.prisma.$queryRawUnsafe(
        `INSERT INTO auth_invite_redemptions (
           id, app_id, inviter_user_id, invitee_user_id, invite_code, reward_points, credited_at, created_at, updated_at
         ) VALUES (
           gen_random_uuid(),
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4,
           $5::integer,
           NULL,
           now(),
           now()
         )
         ON CONFLICT (app_id, invitee_user_id) DO NOTHING
         RETURNING id`,
        appId,
        inviterUserId,
        inviteeUserId,
        normalizedInviteCode,
        INVITE_REWARD_POINTS,
      ) as Promise<Array<{ id: string }>>);
      const redemptionId = String(inserted[0]?.id || '').trim();
      if (!redemptionId) {
        return;
      }

      await this.aiPointsService.creditPoints({
        app_id: appId,
        user_id: inviterUserId,
        amount: INVITE_REWARD_POINTS,
        event_type: 'invite_reward',
        reference_type: 'invite_redemption',
        reference_id: `${redemptionId}:inviter`,
        metadata: {
          role: 'inviter',
          invite_code: normalizedInviteCode,
          invitee_user_id: inviteeUserId,
        },
      });

      await this.aiPointsService.creditPoints({
        app_id: appId,
        user_id: inviteeUserId,
        amount: INVITE_REWARD_POINTS,
        event_type: 'invite_reward',
        reference_type: 'invite_redemption',
        reference_id: `${redemptionId}:invitee`,
        metadata: {
          role: 'invitee',
          invite_code: normalizedInviteCode,
          inviter_user_id: inviterUserId,
        },
      });

      await this.prisma.$executeRawUnsafe(
        `UPDATE auth_invite_redemptions
            SET credited_at = now(),
                updated_at = now()
          WHERE id = $1::uuid`,
        redemptionId,
      );

      const notificationResults = await Promise.allSettled([
        this.redeemService.pushNotificationByAppId(appId, inviterUserId, {
          type: 'invite.reward',
          title: '邀请奖励到账',
          message: `你邀请的用户已完成注册，获得 ${INVITE_REWARD_POINTS} 积分奖励。`,
          payload: {
            role: 'inviter',
            invite_code: normalizedInviteCode,
            invitee_user_id: inviteeUserId,
            points: INVITE_REWARD_POINTS,
            redemption_id: redemptionId,
          },
        }),
        this.redeemService.pushNotificationByAppId(appId, inviteeUserId, {
          type: 'invite.reward',
          title: '受邀奖励到账',
          message: `你已成功使用邀请码注册，获得 ${INVITE_REWARD_POINTS} 积分奖励。`,
          payload: {
            role: 'invitee',
            invite_code: normalizedInviteCode,
            inviter_user_id: inviterUserId,
            points: INVITE_REWARD_POINTS,
            redemption_id: redemptionId,
          },
        }),
      ]);
      notificationResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          const role = index === 0 ? 'inviter' : 'invitee';
          this.logger.warn(
            `invite reward notification failed (app=${appId}, redemption=${redemptionId}, role=${role}): ${
              result.reason instanceof Error ? result.reason.message : 'unknown'
            }`,
          );
        }
      });
    } catch (error) {
      this.logger.error(
        `invite reward failed (app=${appId}, invitee=${inviteeUserId}, code=${normalizedInviteCode}): ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    }
  }

  private async ensureInviteSchema() {
    if (!this.inviteSchemaEnsured) {
      this.inviteSchemaEnsured = this.prisma
        .$executeRawUnsafe(
          `CREATE TABLE IF NOT EXISTS auth_invite_codes (
             id uuid PRIMARY KEY,
             app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
             user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
             invite_code varchar(64) NOT NULL,
             created_at timestamptz NOT NULL DEFAULT now(),
             updated_at timestamptz NOT NULL DEFAULT now()
           )`,
        )
        .then(async () => {
          await this.prisma.$executeRawUnsafe(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_invite_codes_app_code_unique
             ON auth_invite_codes(app_id, invite_code)`,
          );
          await this.prisma.$executeRawUnsafe(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_invite_codes_app_user_unique
             ON auth_invite_codes(app_id, user_id)`,
          );
          await this.prisma.$executeRawUnsafe(
            `CREATE TABLE IF NOT EXISTS auth_invite_redemptions (
               id uuid PRIMARY KEY,
               app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
               inviter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
               invitee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
               invite_code varchar(64) NOT NULL,
               reward_points integer NOT NULL DEFAULT ${INVITE_REWARD_POINTS},
               credited_at timestamptz NULL,
               created_at timestamptz NOT NULL DEFAULT now(),
               updated_at timestamptz NOT NULL DEFAULT now()
             )`,
          );
          await this.prisma.$executeRawUnsafe(
            `ALTER TABLE auth_invite_redemptions
               ALTER COLUMN reward_points SET DEFAULT ${INVITE_REWARD_POINTS}`,
          );
          await this.prisma.$executeRawUnsafe(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_invite_redemptions_app_invitee_unique
             ON auth_invite_redemptions(app_id, invitee_user_id)`,
          );
          await this.prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS idx_auth_invite_redemptions_app_inviter_created
             ON auth_invite_redemptions(app_id, inviter_user_id, created_at DESC)`,
          );
        })
        .catch((error) => {
          this.inviteSchemaEnsured = null;
          throw error;
        });
    }

    await this.inviteSchemaEnsured;
  }

  private generateInviteCode() {
    const bytes = randomBytes(INVITE_CODE_LENGTH);
    let output = '';
    for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
      output += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length];
    }
    return output;
  }

  private normalizeInviteCode(inviteCode?: string) {
    const normalized = String(inviteCode || '').trim();
    if (!normalized) {
      return '';
    }
    return normalized.toUpperCase().slice(0, 64);
  }

  private async rotateInviteCodeForUser(appId: string, userId: string, rowId: string): Promise<string> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const nextCode = this.generateInviteCode();
      try {
        const updatedRows = await (this.prisma.$queryRawUnsafe(
          `UPDATE auth_invite_codes
              SET invite_code = $1,
                  updated_at = now()
            WHERE id = $2::uuid
              AND app_id = $3::uuid
              AND user_id = $4::uuid
          RETURNING invite_code`,
          nextCode,
          rowId,
          appId,
          userId,
        ) as Promise<InviteCodeRow[]>);
        const updatedCode = this.normalizeInviteCode(updatedRows[0]?.invite_code);
        if (updatedCode) {
          return updatedCode;
        }
      } catch (error: any) {
        if (String(error?.code || '') === '23505') {
          continue;
        }
        throw error;
      }
    }
    throw new BadRequestException('failed to rotate invite code');
  }

  private pickUserProfile(user: SafeUser & { app?: { slug: string; name: string } }) {
    return {
      id: user.id,
      app_id: user.appId,
      app_slug: user.app?.slug,
      email: user.email,
      full_name: user.fullName,
      display_name: user.displayName || user.fullName || user.email.split('@')[0],
      avatar_url: user.avatarUrl,
      role: user.role,
      admin_type: user.adminType,
      is_active: user.isActive,
      phone: user.phone,
      phone_verified: user.phoneVerified,
      wechat_openid: user.wechatOpenid,
      wechat_unionid: user.wechatUnionid,
      membership_type: user.membershipType,
      membership_expires_at: user.membershipExpiresAt,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
      last_login_at: user.lastLoginAt,
    };
  }

  generateSessionToken() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  }

  private getInviteCodeCacheKey(appId: string, userId: string) {
    return `${appId}:${userId}`;
  }

  private getCachedInviteCode(appId: string, userId: string): string | null {
    const key = this.getInviteCodeCacheKey(String(appId || '').trim(), String(userId || '').trim());
    if (!key || key === ':') {
      return null;
    }
    const cached = this.inviteCodeCache.get(key);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt <= Date.now()) {
      this.inviteCodeCache.delete(key);
      return null;
    }
    return cached.value;
  }

  private setCachedInviteCode(appId: string, userId: string, code: string) {
    const normalized = this.normalizeInviteCode(code);
    if (!normalized) {
      return;
    }
    const key = this.getInviteCodeCacheKey(String(appId || '').trim(), String(userId || '').trim());
    if (!key || key === ':') {
      return;
    }
    this.inviteCodeCache.set(key, {
      expiresAt: Date.now() + this.inviteCodeCacheTtlMs,
      value: normalized,
    });
  }

  private generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  normalizeEmail(email: string) {
    return String(email || '').trim().toLowerCase();
  }

  private preprocessPassword(password: string) {
    const digest = createHash('sha256').update(String(password || ''), 'utf8').digest();
    return digest.toString('base64');
  }

  async hashPassword(password: string) {
    return bcrypt.hash(this.preprocessPassword(password), 10);
  }

  private async verifyPassword(password: string, hashedPassword: string) {
    if (!hashedPassword) {
      return false;
    }
    try {
      if (await bcrypt.compare(this.preprocessPassword(password), hashedPassword)) {
        return true;
      }
    } catch {
      return false;
    }

    // Compatibility fallback for accounts created by early Node versions.
    try {
      return await bcrypt.compare(password, hashedPassword);
    } catch {
      return false;
    }
  }
}
