import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { App, AppSetting, PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import * as nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { EmailDeliveryService } from '../email-delivery/email-delivery.service';
import { ResolvedSmtpProviderConfig, RuntimeSettingsService } from '../runtime-settings/runtime-settings.service';

type AppWithSettings = App & { settings: AppSetting | null };
type EmailVerificationPurpose =
  | 'register'
  | 'email_login'
  | 'password_reset'
  | 'password_change'
  | 'email_change';

type EmailVerificationRow = {
  id: string;
  app_id: string;
  user_id: string | null;
  email: string;
  purpose: string;
  code_hash: string;
  payload_json: unknown;
  attempt_count: number;
  max_attempts: number;
  expire_at: Date;
  consumed_at: Date | null;
  created_at: Date;
};

const EMAIL_CODE_LENGTH = 6;
const EMAIL_CODE_TTL_SECONDS = 10 * 60;
const EMAIL_CODE_MAX_ATTEMPTS = 6;
const EMAIL_CODE_COOLDOWN_SECONDS = 60;
const APP_SETTINGS_CACHE_TTL_MS = 60 * 1000;

type AppSettingsCacheEntry = {
  value: AppWithSettings;
  expiresAt: number;
};

@Injectable()
export class EmailVerificationService implements OnModuleInit {
  private readonly logger = new Logger(EmailVerificationService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;
  private readonly appSettingsCache = new Map<string, AppSettingsCacheEntry>();
  private transporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly emailDeliveryService: EmailDeliveryService,
    private readonly runtimeSettingsService: RuntimeSettingsService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`email verification startup warmup failed: ${error?.message || error}`);
    }
  }

  async sendCode(input: {
    appSlug?: string;
    appId?: string;
    userId?: string | null;
    email: string;
    purpose: EmailVerificationPurpose;
    subjectLabel?: string;
    payload?: Record<string, unknown>;
  }) {
    await this.ensureSchema();
    const app = input.appId
      ? await this.resolveAppByIdWithSettings(input.appId)
      : await this.resolveAppWithSettings(input.appSlug);
    const email = this.normalizeEmail(input.email);
    if (!email) {
      throw new BadRequestException('email is required');
    }

    await this.assertCooldown(app.id, email, input.purpose, input.userId || null);
    const code = this.generateCode();
    await this.storeCode({
      appId: app.id,
      userId: input.userId || null,
      email,
      purpose: input.purpose,
      code,
      payload: input.payload || {},
    });
    this.dispatchVerificationEmail(app, email, code, input.subjectLabel || '验证码');

    return {
      message: 'Verification code sent to your email',
    };
  }

  async verifyCode(input: {
    appSlug?: string;
    appId?: string;
    userId?: string | null;
    email: string;
    purpose: EmailVerificationPurpose;
    code: string;
  }) {
    await this.ensureSchema();
    const app = input.appId
      ? await this.resolveAppByIdWithSettings(input.appId)
      : await this.resolveAppWithSettings(input.appSlug);
    const email = this.normalizeEmail(input.email);
    const code = this.normalizeCode(input.code);
    if (!email || !code) {
      throw new UnauthorizedException('Invalid verification code');
    }

    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM auth_email_verification_codes
        WHERE app_id = $1::uuid
          AND email = $2::text
          AND purpose = $3::text
          AND ($4::uuid IS NULL OR user_id = $4::uuid)
          AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      app.id,
      email,
      input.purpose,
      input.userId || null,
    )) as EmailVerificationRow[];
    const row = rows[0];
    if (!row || row.expire_at.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid verification code');
    }
    if (row.attempt_count >= row.max_attempts) {
      throw new UnauthorizedException('Invalid verification code');
    }

    const expectedHash = this.hashCode(app.id, email, input.purpose, code);
    if (expectedHash !== row.code_hash) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE auth_email_verification_codes
            SET attempt_count = attempt_count + 1,
                updated_at = now()
          WHERE id = $1::uuid`,
        row.id,
      );
      throw new UnauthorizedException('Invalid verification code');
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE auth_email_verification_codes
          SET consumed_at = now(),
              updated_at = now()
        WHERE id = $1::uuid`,
      row.id,
    );

    return {
      app,
      payload: this.parseObject(row.payload_json),
    };
  }

  private async ensureSchema() {
    if (this.schemaReady) {
      return;
    }
    if (this.schemaPromise) {
      await this.schemaPromise;
      return;
    }
    this.schemaPromise = this.initSchema();
    try {
      await this.schemaPromise;
      this.schemaReady = true;
    } finally {
      this.schemaPromise = null;
    }
  }

  private async initSchema() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS auth_email_verification_codes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid NULL REFERENCES users(id) ON DELETE CASCADE,
        email varchar(320) NOT NULL,
        purpose varchar(32) NOT NULL,
        code_hash varchar(128) NOT NULL,
        payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        attempt_count integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT ${EMAIL_CODE_MAX_ATTEMPTS},
        expire_at timestamptz NOT NULL,
        consumed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_auth_email_verification_lookup
      ON auth_email_verification_codes(app_id, email, purpose, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_auth_email_verification_expire
      ON auth_email_verification_codes(expire_at DESC)
    `);
  }

  private async assertCooldown(appId: string, email: string, purpose: EmailVerificationPurpose, userId: string | null) {
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT created_at
         FROM auth_email_verification_codes
        WHERE app_id = $1::uuid
          AND email = $2::text
          AND purpose = $3::text
          AND ($4::uuid IS NULL OR user_id = $4::uuid)
        ORDER BY created_at DESC
        LIMIT 1`,
      appId,
      email,
      purpose,
      userId,
    )) as Array<{ created_at: Date }>;
    const latest = rows[0]?.created_at;
    if (!latest) {
      return;
    }
    const elapsedSeconds = Math.floor((Date.now() - latest.getTime()) / 1000);
    if (elapsedSeconds < EMAIL_CODE_COOLDOWN_SECONDS) {
      throw new BadRequestException(`验证码发送过于频繁，请 ${EMAIL_CODE_COOLDOWN_SECONDS - elapsedSeconds} 秒后重试`);
    }
  }

  private async storeCode(input: {
    appId: string;
    userId: string | null;
    email: string;
    purpose: EmailVerificationPurpose;
    code: string;
    payload: Record<string, unknown>;
  }) {
    await this.prisma.$executeRawUnsafe(
      `UPDATE auth_email_verification_codes
          SET consumed_at = COALESCE(consumed_at, now()),
              updated_at = now()
        WHERE app_id = $1::uuid
          AND email = $2::text
          AND purpose = $3::text
          AND ($4::uuid IS NULL OR user_id = $4::uuid)
          AND consumed_at IS NULL`,
      input.appId,
      input.email,
      input.purpose,
      input.userId,
    );

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO auth_email_verification_codes (
         app_id, user_id, email, purpose, code_hash, payload_json, attempt_count, max_attempts, expire_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::jsonb, 0, $7::integer, now() + ($8::text)::interval
       )`,
      input.appId,
      input.userId,
      input.email,
      input.purpose,
      this.hashCode(input.appId, input.email, input.purpose, input.code),
      JSON.stringify(input.payload || {}),
      EMAIL_CODE_MAX_ATTEMPTS,
      `${EMAIL_CODE_TTL_SECONDS} seconds`,
    );
  }

  private async sendVerificationEmail(app: AppWithSettings, toEmail: string, code: string, subjectLabel: string) {
    const brandName = app.settings?.brandName || app.name || app.slug || 'App';
    const senderName = app.settings?.senderName || app.settings?.senderNickname || brandName;
    const subject = `[${brandName}] ${subjectLabel}: ${code}`;
    const html = this.buildVerificationHtml(app, code);
    const text = `${brandName} ${subjectLabel}: ${code}`;

    try {
      await this.emailDeliveryService.sendAppNotificationEmail(app.id, toEmail, {
        subject,
        html,
        text,
      });
      return;
    } catch (error) {
      this.logger.warn(
        `app notification email sender failed app=${app.slug}: ${
          error instanceof Error ? error.message : 'unknown error'
        }; falling back to SMTP`,
      );
    }

    await this.sendHtmlViaSmtp({
      toEmail,
      subject,
      html,
      senderName,
    });
  }

  private dispatchVerificationEmail(app: AppWithSettings, toEmail: string, code: string, subjectLabel: string) {
    queueMicrotask(() => {
      void this.sendVerificationEmail(app, toEmail, code, subjectLabel).catch((error) => {
        this.logger.error(
          `async verification email dispatch failed app=${app.slug} email=${toEmail}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      });
    });
  }

  private buildVerificationHtml(app: AppWithSettings, code: string) {
    const brandName = app.settings?.brandName || app.name || app.slug || 'App';
    const greeting = app.settings?.emailGreeting || '您好，';
    const codeLabel = (app.settings?.emailCodeLabel || '您正在使用 {app_name} 邮箱验证码。请使用以下验证码完成操作：')
      .replace('{app_name}', brandName);
    const expireText = app.settings?.emailExpireText || '该验证码将在 10 分钟后失效。';
    const footerText = (app.settings?.emailFooterText || '© {app_name} · 此邮件由系统自动发送，请勿回复')
      .replace('{app_name}', brandName);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;color:#111111;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:32px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
        <tr><td style="padding:28px 28px 24px;">
          <p style="margin:0 0 20px;color:#6b7280;font-size:14px;line-height:1.5;">${this.escapeHtml(brandName)}</p>
          <h1 style="margin:0 0 24px;color:#111111;font-size:22px;font-weight:700;line-height:1.3;">邮箱验证码</h1>
          <p style="margin:0 0 12px;color:#111111;font-size:15px;line-height:1.7;">${this.escapeHtml(greeting)}</p>
          <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.7;">${this.escapeHtml(codeLabel)}</p>
          <div style="margin:0 0 24px;padding:18px 20px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;text-align:center;">
            <div style="color:#111111;font-size:30px;font-weight:700;letter-spacing:6px;font-family:'Courier New',monospace;">${this.escapeHtml(code)}</div>
          </div>
          <p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.7;">${this.escapeHtml(expireText)}</p>
          <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">如果不是你本人操作，请忽略此邮件。</p>
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">${this.escapeHtml(footerText)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  private async sendHtmlViaSmtp(input: {
    toEmail: string;
    subject: string;
    html: string;
    senderName: string;
  }) {
    const smtpProvider = await this.runtimeSettingsService.resolveDefaultSmtpProviderConfig().catch(() => null);
    const host = String(smtpProvider?.host || this.config.smtp.host || '').trim();
    const port = Number(smtpProvider?.port || this.config.smtp.port || 465);
    const user = String(smtpProvider?.username || this.config.smtp.user || '').trim();
    const password = String(smtpProvider?.password || this.config.smtp.password || '').trim();
    const fromEmail = String(smtpProvider?.from_email || user).trim();
    const fromName = String(smtpProvider?.from_name || input.senderName).trim();
    try {
      const transporter = smtpProvider ? this.createTransporter(smtpProvider) : this.getTransporter();
      await transporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to: input.toEmail,
        subject: input.subject,
        html: input.html,
      });
    } catch (error) {
      this.logger.error(`send verification email failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new BadGatewayException('Failed to send verification email');
    }
  }

  private normalizeEmail(email: string): string {
    return String(email || '').trim().toLowerCase();
  }

  private normalizeCode(code: string): string {
    const normalized = String(code || '').trim();
    return /^\d{6}$/.test(normalized) ? normalized : '';
  }

  private generateCode(): string {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  private hashCode(appId: string, email: string, purpose: EmailVerificationPurpose, code: string): string {
    return createHash('sha256')
      .update(`${appId}:${email}:${purpose}:${code}:${this.config.jwt.secret}`, 'utf8')
      .digest('hex');
  }

  private parseObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private escapeHtml(value: string): string {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  private async resolveAppWithSettings(appSlug?: string): Promise<AppWithSettings> {
    const slug = appSlug || this.config.app.defaultSlug;
    const cacheKey = `slug:${slug}`;
    const cached = this.readAppSettingsCache(cacheKey);
    if (cached) {
      return cached;
    }
    const app = await this.prisma.app.findUnique({
      where: { slug },
      include: { settings: true },
    });
    if (!app) {
      throw new ConflictException(`App not found: ${slug}`);
    }
    this.writeAppSettingsCache(cacheKey, app);
    this.writeAppSettingsCache(`id:${app.id}`, app);
    return app;
  }

  private async resolveAppByIdWithSettings(appId: string): Promise<AppWithSettings> {
    const cacheKey = `id:${appId}`;
    const cached = this.readAppSettingsCache(cacheKey);
    if (cached) {
      return cached;
    }
    const app = await this.prisma.app.findUnique({
      where: { id: appId },
      include: { settings: true },
    });
    if (!app) {
      throw new ConflictException(`App not found: ${appId}`);
    }
    this.writeAppSettingsCache(cacheKey, app);
    this.writeAppSettingsCache(`slug:${app.slug}`, app);
    return app;
  }

  private getTransporter() {
    if (this.transporter) {
      return this.transporter;
    }
    const host = String(this.config.smtp.host || '').trim();
    const port = Number(this.config.smtp.port || 465);
    const user = String(this.config.smtp.user || '').trim();
    const password = String(this.config.smtp.password || '').trim();
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      auth: {
        user,
        pass: password,
      },
      tls: {
        servername: host,
      },
    });
    return this.transporter;
  }

  private createTransporter(provider: ResolvedSmtpProviderConfig) {
    const host = String(provider.host || '').trim();
    const port = Number(provider.port || 465);
    return nodemailer.createTransport({
      host,
      port,
      secure: provider.secure === undefined ? port === 465 : Boolean(provider.secure),
      requireTLS: provider.secure === undefined ? port !== 465 : !provider.secure,
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      auth: {
        user: String(provider.username || '').trim(),
        pass: String(provider.password || '').trim(),
      },
      tls: {
        servername: host,
      },
    });
  }

  private readAppSettingsCache(key: string): AppWithSettings | null {
    const cached = this.appSettingsCache.get(key);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt <= Date.now()) {
      this.appSettingsCache.delete(key);
      return null;
    }
    return cached.value;
  }

  private writeAppSettingsCache(key: string, value: AppWithSettings) {
    this.appSettingsCache.set(key, {
      value,
      expiresAt: Date.now() + APP_SETTINGS_CACHE_TTL_MS,
    });
  }
}
