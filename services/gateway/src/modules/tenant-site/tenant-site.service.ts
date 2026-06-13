import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import {
  TenantSiteDownloadItem,
  TenantSiteDownloadPlatform,
  TenantSiteCookieConsentRow,
  TenantSiteCookieRegion,
  TenantSiteMessageRow,
  TenantSiteMessageStatus,
  TenantSiteMessageType,
  TenantSiteSettings,
} from './tenant-site.types';
import { UploadService } from '../upload/upload.service';

type AppRow = {
  id: string;
  slug: string;
  name: string;
  settings?: {
    appUrl?: string | null;
    brandName?: string | null;
    extraJson?: unknown;
  } | null;
};

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

@Injectable()
export class TenantSiteService implements OnModuleInit {
  private readonly logger = new Logger(TenantSiteService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly uploadService: UploadService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`tenant site startup warmup failed: ${error?.message || error}`);
    }
  }

  async getPublicSiteConfig(appSlug?: string) {
    const app = await this.resolveAppBySlug(appSlug);
    const settings = this.extractSiteSettings(app.settings?.extraJson);
    const appBase = this.normalizeNullableString(app.settings?.appUrl);
    return {
      app: {
        slug: app.slug,
        name: app.name,
        brand_name: app.settings?.brandName || app.name,
        app_url: appBase,
      },
      auth: {
        login_url: settings.login_url || appBase || null,
        app_deep_link: settings.app_deep_link || null,
        login_endpoint: `/${app.slug}/v1/auth/login`,
        register_endpoint: `/${app.slug}/v1/auth/register`,
        providers_endpoint: `/${app.slug}/v1/auth/login/providers`,
      },
      downloads: {
        macos: this.serializeDownloadItem(settings.downloads?.macos, 'Download for macOS'),
        windows: this.serializeDownloadItem(settings.downloads?.windows, 'Download for Windows'),
      },
      legal: {
        updated_at: settings.legal?.updated_at || null,
        privacy_contact: settings.legal?.privacy_contact || settings.support_email || null,
        terms_contact: settings.legal?.terms_contact || settings.support_email || null,
      },
      support_email: settings.support_email || null,
    };
  }

  async getAdminSiteSettings(appId: string) {
    const app = await this.resolveAppById(appId);
    return {
      app_id: app.id,
      app_slug: app.slug,
      settings: this.extractSiteSettings(app.settings?.extraJson),
    };
  }

  async updateAdminSiteSettings(appId: string, payload: unknown) {
    const app = await this.resolveAppById(appId);
    const existingExtra = asPlainObject(app.settings?.extraJson);
    const current = this.extractSiteSettings(existingExtra);
    const next = this.normalizeSettings(payload, current);
    const extraJson = {
      ...existingExtra,
      public_site: next,
    };

    await this.prisma.appSetting.upsert({
      where: { appId: app.id },
      create: {
        appId: app.id,
        brandName: app.name,
        extraJson: extraJson as Prisma.InputJsonValue,
      },
      update: {
        extraJson: extraJson as Prisma.InputJsonValue,
      },
    });

    return {
      app_id: app.id,
      app_slug: app.slug,
      settings: next,
    };
  }

  async createDownloadUploadUrl(appId: string, platformRaw: string, payload: unknown, actorUserId?: string) {
    const app = await this.resolveAppById(appId);
    const platform = this.normalizeDownloadPlatform(platformRaw);
    const body = asPlainObject(payload);
    const filename = this.normalizeFilename(body.filename || body.file_name);
    if (!filename) {
      throw new BadRequestException('filename is required');
    }
    const contentType =
      this.normalizeNullableString(body.content_type, 160) ||
      this.normalizeNullableString(body.contentType, 160) ||
      'application/octet-stream';
    const result = await this.uploadService.getPresignedUrl(
      actorUserId || 'platform-admin',
      filename,
      contentType,
      app.slug,
      `site-downloads/${platform}`,
      app.id,
    );

    return {
      platform,
      upload_url: result.upload_url,
      file_url: result.file_url,
      file_key: result.file_key,
      headers: result.headers,
      expires_in: 3600,
    };
  }

  async confirmDownloadUpload(appId: string, platformRaw: string, payload: unknown) {
    const app = await this.resolveAppById(appId);
    const platform = this.normalizeDownloadPlatform(platformRaw);
    const body = asPlainObject(payload);
    const fileKey = this.normalizeNullableString(body.file_key, 2048);
    const fileUrl = this.normalizeNullableString(body.file_url, 2048);
    const managedKeyFromUrl = this.uploadService.getManagedFileKey(fileUrl);
    const managedKeyFromKey = this.uploadService.getManagedFileKey(`/uploads/${fileKey || ''}`);
    const managedKey = managedKeyFromUrl || managedKeyFromKey;
    const expectedPrefix = `site-downloads/${platform}/${app.id}/`;

    if (!managedKey || !managedKey.startsWith(expectedPrefix)) {
      throw new BadRequestException('download file must be uploaded with a site download upload URL');
    }
    if (fileKey && fileKey !== managedKey) {
      throw new BadRequestException('file_key does not match file_url');
    }
    if (!fileUrl || managedKeyFromUrl !== managedKey) {
      throw new BadRequestException('file_url is required from the upload URL response');
    }

    const admin = await this.getAdminSiteSettings(app.id);
    const current = admin.settings;
    const currentDownload = current.downloads?.[platform] || {};
    const nextDownload: TenantSiteDownloadItem = this.normalizeDownloadItem(
      {
        ...currentDownload,
        label: body.label === undefined ? currentDownload.label : body.label,
        version: body.version === undefined ? currentDownload.version : body.version,
        url: fileUrl,
        file_key: managedKey,
        file_name: body.file_name || body.filename || currentDownload.file_name,
        file_size: body.file_size === undefined ? currentDownload.file_size : body.file_size,
        content_type: body.content_type || body.contentType || currentDownload.content_type,
        checksum: body.checksum === undefined ? currentDownload.checksum : body.checksum,
        updated_at:
          body.updated_at === undefined
            ? this.formatDate(new Date())
            : body.updated_at,
        minimum_os: body.minimum_os === undefined ? currentDownload.minimum_os : body.minimum_os,
        architecture: body.architecture === undefined ? currentDownload.architecture : body.architecture,
      },
      currentDownload,
    );
    const nextSettings = {
      ...current,
      downloads: {
        ...(current.downloads || {}),
        [platform]: nextDownload,
      },
    };

    return this.updateAdminSiteSettings(app.id, nextSettings);
  }

  async submitNewsletter(appSlug: string | undefined, payload: unknown, request?: any) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const body = asPlainObject(payload);
    const email = this.normalizeEmail(body.email);
    if (!email) {
      throw new BadRequestException('email is required');
    }
    const locale = this.normalizeNullableString(body.locale, 16);
    const source = this.normalizeNullableString(body.source, 128) || this.inferSource(request);
    const context = this.normalizeContext(body.context, request);
    if (this.isLikelyBotSubmission(body)) {
      return {
        message: 'Subscribed',
        item: null,
      };
    }
    await this.enforceSubmissionWindow(app.id, 'newsletter', email);

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO tenant_site_messages (
         id, app_id, type, email, name, category, subject, message, locale, source, context_json, status, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, 'newsletter', $2, NULL, NULL, NULL, NULL, $3, $4, $5::jsonb, 'new', now(), now()
       )
       ON CONFLICT (app_id, LOWER(email)) WHERE type = 'newsletter'
       DO UPDATE SET
         locale = COALESCE(EXCLUDED.locale, tenant_site_messages.locale),
         source = COALESCE(EXCLUDED.source, tenant_site_messages.source),
         context_json = tenant_site_messages.context_json || EXCLUDED.context_json,
         status = CASE WHEN tenant_site_messages.status = 'archived' THEN 'read' ELSE tenant_site_messages.status END,
         updated_at = now()
       RETURNING *`,
      app.id,
      email,
      locale,
      source,
      JSON.stringify(context),
    ) as Promise<TenantSiteMessageRow[]>);

    return {
      message: 'Subscribed',
      item: this.serializeMessage(rows[0]),
    };
  }

  async submitContact(appSlug: string | undefined, payload: unknown, request?: any) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const body = asPlainObject(payload);
    const email = this.normalizeEmail(body.email);
    const name = this.normalizeNullableString(body.name, 160);
    const message = this.normalizeNullableString(body.message, 4000);
    if (!email) {
      throw new BadRequestException('email is required');
    }
    if (!message) {
      throw new BadRequestException('message is required');
    }
    if (this.isLikelyBotSubmission(body)) {
      return {
        message: 'Message received',
        item: null,
      };
    }
    await this.enforceSubmissionWindow(app.id, 'contact', email);

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO tenant_site_messages (
         id, app_id, type, email, name, category, subject, message, locale, source, context_json, status, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, 'contact', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'new', now(), now()
       )
       RETURNING *`,
      app.id,
      email,
      name,
      this.normalizeNullableString(body.category, 80) || 'support',
      this.normalizeNullableString(body.subject, 200),
      message,
      this.normalizeNullableString(body.locale, 16),
      this.normalizeNullableString(body.source, 128) || this.inferSource(request),
      JSON.stringify(this.normalizeContext(body.context, request)),
    ) as Promise<TenantSiteMessageRow[]>);

    return {
      message: 'Message received',
      item: this.serializeMessage(rows[0]),
    };
  }

  async listAdminMessages(
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
    await this.ensureSchema();
    await this.resolveAppById(appId);
    const type = this.normalizeMessageType(options?.type);
    const status = this.normalizeMessageStatus(options?.status);
    const category = this.normalizeNullableString(options?.category, 80);
    const q = this.normalizeSearchQuery(options?.q);
    const page = Math.max(1, Math.floor(Number(options?.page || 1)));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(options?.page_size || 20))));
    const offset = (page - 1) * pageSize;
    const search = q ? `%${q}%` : '';

    const [countRows, summaryRows, rows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count
         FROM tenant_site_messages
         WHERE app_id = $1::uuid
           AND ($2::text = '' OR type = $2::text)
           AND ($3::text = '' OR status = $3::text)
           AND ($4::text = '' OR category = $4::text)
           AND (
             $5::text = ''
             OR email ILIKE $5::text
             OR name ILIKE $5::text
             OR subject ILIKE $5::text
             OR message ILIKE $5::text
           )`,
        appId,
        type || '',
        status || '',
        category || '',
        search,
      ) as Promise<Array<{ count: bigint }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT status, COUNT(*)::bigint AS count
         FROM tenant_site_messages
         WHERE app_id = $1::uuid
           AND ($2::text = '' OR type = $2::text)
           AND ($3::text = '' OR category = $3::text)
           AND (
             $4::text = ''
             OR email ILIKE $4::text
             OR name ILIKE $4::text
             OR subject ILIKE $4::text
             OR message ILIKE $4::text
           )
         GROUP BY status`,
        appId,
        type || '',
        category || '',
        search,
      ) as Promise<Array<{ status: TenantSiteMessageStatus; count: bigint }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT *
         FROM tenant_site_messages
         WHERE app_id = $1::uuid
           AND ($2::text = '' OR type = $2::text)
           AND ($3::text = '' OR status = $3::text)
           AND ($4::text = '' OR category = $4::text)
           AND (
             $5::text = ''
             OR email ILIKE $5::text
             OR name ILIKE $5::text
             OR subject ILIKE $5::text
             OR message ILIKE $5::text
           )
         ORDER BY
           CASE WHEN status = 'new' THEN 0 WHEN status = 'read' THEN 1 ELSE 2 END ASC,
           created_at DESC
         LIMIT $6 OFFSET $7`,
        appId,
        type || '',
        status || '',
        category || '',
        search,
        pageSize,
        offset,
      ) as Promise<TenantSiteMessageRow[]>),
    ]);
    const summary = summaryRows.reduce(
      (acc, row) => {
        acc[row.status] = Number(row.count || 0);
        acc.total += Number(row.count || 0);
        return acc;
      },
      { total: 0, new: 0, read: 0, archived: 0 } as Record<TenantSiteMessageStatus | 'total', number>,
    );

    return {
      total: Number(countRows[0]?.count || 0),
      page,
      page_size: pageSize,
      summary,
      items: rows.map((row) => this.serializeMessage(row)),
    };
  }

  async updateAdminMessage(appId: string, messageId: string, actorUserId: string, payload: unknown) {
    await this.ensureSchema();
    await this.resolveAppById(appId);
    const body = asPlainObject(payload);
    const status = this.normalizeMessageStatus(body.status) || 'read';
    const note = this.normalizeNullableString(body.note ?? body.admin_note, 2000);

    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE tenant_site_messages
       SET status = $3,
           admin_note = COALESCE($4, admin_note),
           handled_by_user_id = $5::uuid,
           handled_at = now(),
           updated_at = now()
       WHERE app_id = $1::uuid
         AND id = $2::uuid
       RETURNING *`,
      appId,
      messageId,
      status,
      note,
      actorUserId,
    ) as Promise<TenantSiteMessageRow[]>);
    if (!rows[0]) {
      throw new NotFoundException('message not found');
    }
    return {
      item: this.serializeMessage(rows[0]),
    };
  }

  async getCookiePolicy(appSlug: string | undefined) {
    const app = await this.resolveAppBySlug(appSlug);
    return {
      app: {
        slug: app.slug,
        name: app.name,
      },
      categories: [
        {
          key: 'essential',
          required: true,
          currently_used: true,
          retention: 'Up to 12 months',
        },
        {
          key: 'analytics',
          required: false,
          currently_used: false,
          retention: 'Not active unless enabled later',
        },
        {
          key: 'marketing',
          required: false,
          currently_used: false,
          retention: 'Not active unless enabled later',
        },
      ],
    };
  }

  async saveCookieConsent(appSlug: string | undefined, payload: unknown, request?: any) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const body = asPlainObject(payload);
    const consentId = this.normalizeConsentId(body.consent_id) || cryptoRandomId();
    const regionMode = this.normalizeCookieRegion(body.region_mode);
    const doNotSellShare = this.parseBooleanLike(body.do_not_sell_share, regionMode === 'us');
    const essential = true;
    const analytics = this.parseBooleanLike(body.analytics, false);
    const marketing = doNotSellShare ? false : this.parseBooleanLike(body.marketing, false);
    const locale = this.normalizeNullableString(body.locale, 16);
    const source = this.normalizeNullableString(body.source, 128) || this.inferSource(request);
    const context = this.normalizeContext(body.context, request);

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO tenant_site_cookie_consents (
         id, app_id, consent_id, region_mode, essential, analytics, marketing, do_not_sell_share,
         locale, source, context_json, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now(), now()
       )
       ON CONFLICT (app_id, consent_id)
       DO UPDATE SET
         region_mode = EXCLUDED.region_mode,
         essential = EXCLUDED.essential,
         analytics = EXCLUDED.analytics,
         marketing = EXCLUDED.marketing,
         do_not_sell_share = EXCLUDED.do_not_sell_share,
         locale = COALESCE(EXCLUDED.locale, tenant_site_cookie_consents.locale),
         source = COALESCE(EXCLUDED.source, tenant_site_cookie_consents.source),
         context_json = tenant_site_cookie_consents.context_json || EXCLUDED.context_json,
         updated_at = now()
       RETURNING *`,
      app.id,
      consentId,
      regionMode,
      essential,
      analytics,
      marketing,
      doNotSellShare,
      locale,
      source,
      JSON.stringify(context),
    ) as Promise<TenantSiteCookieConsentRow[]>);

    return {
      item: this.serializeCookieConsent(rows[0]),
    };
  }

  async listAdminCookieConsents(
    appId: string,
    options?: { region_mode?: string; page?: string | number; page_size?: string | number },
  ) {
    await this.ensureSchema();
    await this.resolveAppById(appId);
    const regionMode = this.normalizeOptionalCookieRegion(options?.region_mode);
    const page = Math.max(1, Math.floor(Number(options?.page || 1)));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(options?.page_size || 20))));
    const offset = (page - 1) * pageSize;

    const [countRows, summaryRows, rows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count
         FROM tenant_site_cookie_consents
         WHERE app_id = $1::uuid
           AND ($2::text = '' OR region_mode = $2::text)`,
        appId,
        regionMode || '',
      ) as Promise<Array<{ count: bigint }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE analytics)::bigint AS analytics_enabled,
           COUNT(*) FILTER (WHERE marketing)::bigint AS marketing_enabled,
           COUNT(*) FILTER (WHERE do_not_sell_share)::bigint AS do_not_sell_share,
           COUNT(*) FILTER (WHERE region_mode = 'eu')::bigint AS eu,
           COUNT(*) FILTER (WHERE region_mode = 'us')::bigint AS us,
           COUNT(*) FILTER (WHERE region_mode = 'other')::bigint AS other
         FROM tenant_site_cookie_consents
         WHERE app_id = $1::uuid`,
        appId,
      ) as Promise<Array<{
          total: bigint;
          analytics_enabled: bigint;
          marketing_enabled: bigint;
          do_not_sell_share: bigint;
          eu: bigint;
          us: bigint;
          other: bigint;
        }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT *
         FROM tenant_site_cookie_consents
         WHERE app_id = $1::uuid
           AND ($2::text = '' OR region_mode = $2::text)
         ORDER BY updated_at DESC
         LIMIT $3 OFFSET $4`,
        appId,
        regionMode || '',
        pageSize,
        offset,
      ) as Promise<TenantSiteCookieConsentRow[]>),
    ]);
    const summaryRow = summaryRows[0];

    return {
      total: Number(countRows[0]?.count || 0),
      page,
      page_size: pageSize,
      summary: {
        total: Number(summaryRow?.total || 0),
        analytics_enabled: Number(summaryRow?.analytics_enabled || 0),
        marketing_enabled: Number(summaryRow?.marketing_enabled || 0),
        do_not_sell_share: Number(summaryRow?.do_not_sell_share || 0),
        eu: Number(summaryRow?.eu || 0),
        us: Number(summaryRow?.us || 0),
        other: Number(summaryRow?.other || 0),
      },
      items: rows.map((row) => this.serializeCookieConsent(row)),
    };
  }

  private extractSiteSettings(extraJson: unknown): TenantSiteSettings {
    const extra = asPlainObject(extraJson);
    return this.normalizeSettings(extra.public_site, {});
  }

  private normalizeSettings(payload: unknown, fallback: TenantSiteSettings): TenantSiteSettings {
    const body = asPlainObject(payload);
    const downloads = asPlainObject(body.downloads);
    const legal = asPlainObject(body.legal);
    return {
      support_email:
        body.support_email === undefined ? fallback.support_email : this.normalizeEmail(body.support_email) || undefined,
      login_url:
        body.login_url === undefined ? fallback.login_url : this.normalizeNullableString(body.login_url, 2048) || undefined,
      app_deep_link:
        body.app_deep_link === undefined ? fallback.app_deep_link : this.normalizeNullableString(body.app_deep_link, 2048) || undefined,
      downloads: {
        macos: this.normalizeDownloadItem(downloads.macos, fallback.downloads?.macos),
        windows: this.normalizeDownloadItem(downloads.windows, fallback.downloads?.windows),
      },
      legal: {
        updated_at:
          legal.updated_at === undefined ? fallback.legal?.updated_at : this.normalizeNullableString(legal.updated_at, 64) || undefined,
        privacy_contact:
          legal.privacy_contact === undefined
            ? fallback.legal?.privacy_contact
            : this.normalizeEmail(legal.privacy_contact) || undefined,
        terms_contact:
          legal.terms_contact === undefined ? fallback.legal?.terms_contact : this.normalizeEmail(legal.terms_contact) || undefined,
      },
    };
  }

  private normalizeDownloadItem(payload: unknown, fallback?: TenantSiteDownloadItem): TenantSiteDownloadItem {
    const body = asPlainObject(payload);
    return {
      label: body.label === undefined ? fallback?.label : this.normalizeNullableString(body.label, 80) || undefined,
      version: body.version === undefined ? fallback?.version : this.normalizeNullableString(body.version, 80) || undefined,
      url: body.url === undefined ? fallback?.url : this.normalizeNullableString(body.url, 2048) || undefined,
      file_key:
        body.file_key === undefined ? fallback?.file_key : this.normalizeNullableString(body.file_key, 2048) || undefined,
      file_name: body.file_name === undefined ? fallback?.file_name : this.normalizeNullableString(body.file_name, 255) || undefined,
      file_size: body.file_size === undefined ? fallback?.file_size : this.normalizeNullableString(body.file_size, 80) || undefined,
      content_type:
        body.content_type === undefined
          ? fallback?.content_type
          : this.normalizeNullableString(body.content_type, 160) || undefined,
      checksum: body.checksum === undefined ? fallback?.checksum : this.normalizeNullableString(body.checksum, 160) || undefined,
      updated_at: body.updated_at === undefined ? fallback?.updated_at : this.normalizeNullableString(body.updated_at, 64) || undefined,
      minimum_os:
        body.minimum_os === undefined ? fallback?.minimum_os : this.normalizeNullableString(body.minimum_os, 120) || undefined,
      architecture:
        body.architecture === undefined ? fallback?.architecture : this.normalizeNullableString(body.architecture, 120) || undefined,
    };
  }

  private serializeDownloadItem(item: TenantSiteDownloadItem | undefined, fallbackLabel: string) {
    return {
      label: item?.label || fallbackLabel,
      version: item?.version || null,
      url: item?.url || null,
      file_name: item?.file_name || null,
      file_size: item?.file_size || null,
      content_type: item?.content_type || null,
      checksum: item?.checksum || null,
      updated_at: item?.updated_at || null,
      minimum_os: item?.minimum_os || null,
      architecture: item?.architecture || null,
      available: Boolean(item?.url),
    };
  }

  private serializeMessage(row: TenantSiteMessageRow | null | undefined) {
    if (!row) return null;
    return {
      id: row.id,
      app_id: row.app_id,
      type: row.type,
      email: row.email,
      name: row.name,
      category: row.category,
      subject: row.subject,
      message: row.message,
      locale: row.locale,
      source: row.source,
      context: asPlainObject(row.context_json),
      status: row.status,
      admin_note: row.admin_note,
      handled_by_user_id: row.handled_by_user_id,
      handled_at: this.serializeDate(row.handled_at),
      created_at: this.serializeDate(row.created_at),
      updated_at: this.serializeDate(row.updated_at),
    };
  }

  private serializeCookieConsent(row: TenantSiteCookieConsentRow | null | undefined) {
    if (!row) return null;
    return {
      id: row.id,
      app_id: row.app_id,
      consent_id: row.consent_id,
      region_mode: row.region_mode,
      essential: row.essential,
      analytics: row.analytics,
      marketing: row.marketing,
      do_not_sell_share: row.do_not_sell_share,
      locale: row.locale,
      source: row.source,
      context: asPlainObject(row.context_json),
      created_at: this.serializeDate(row.created_at),
      updated_at: this.serializeDate(row.updated_at),
    };
  }

  private async resolveAppBySlug(appSlug?: string): Promise<AppRow> {
    const slug = String(appSlug || '').trim().toLowerCase();
    if (!slug) {
      throw new BadRequestException('app slug is required');
    }
    const app = await this.prisma.app.findUnique({
      where: { slug },
      include: { settings: true },
    });
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app as AppRow;
  }

  private async resolveAppById(appId: string): Promise<AppRow> {
    const app = await this.prisma.app.findUnique({
      where: { id: appId },
      include: { settings: true },
    });
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app as AppRow;
  }

  private normalizeEmail(value: unknown): string | undefined {
    const email = String(value || '').trim().toLowerCase();
    if (!email) return undefined;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('invalid email');
    }
    return email;
  }

  private normalizeNullableString(value: unknown, maxLength = 500): string | undefined {
    const text = String(value || '').trim();
    if (!text) return undefined;
    return text.slice(0, maxLength);
  }

  private normalizeContext(value: unknown, request?: any): Record<string, unknown> {
    const context = asPlainObject(value);
    return {
      ...context,
      user_agent: this.normalizeNullableString(request?.headers?.['user-agent'], 500),
      referer: this.normalizeNullableString(request?.headers?.referer || request?.headers?.referrer, 500),
      ip_hash: this.hashValue(this.getClientIp(request)),
    };
  }

  private inferSource(request?: any): string | undefined {
    return this.normalizeNullableString(request?.headers?.origin || request?.headers?.referer, 128);
  }

  private normalizeMessageType(value: unknown): TenantSiteMessageType | '' {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'newsletter' || raw === 'contact') return raw;
    return '';
  }

  private normalizeMessageStatus(value: unknown): TenantSiteMessageStatus | '' {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'new' || raw === 'read' || raw === 'archived') return raw;
    return '';
  }

  private normalizeDownloadPlatform(value: unknown): TenantSiteDownloadPlatform {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'macos' || raw === 'windows') return raw;
    throw new BadRequestException('download platform must be macos or windows');
  }

  private normalizeFilename(value: unknown): string | undefined {
    const raw = this.normalizeNullableString(value, 255);
    if (!raw) return undefined;
    const filename = raw.split(/[\\/]/).pop()?.trim();
    return filename || undefined;
  }

  private normalizeCookieRegion(value: unknown): TenantSiteCookieRegion {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'eu' || raw === 'us') return raw;
    return 'other';
  }

  private normalizeOptionalCookieRegion(value: unknown): TenantSiteCookieRegion | '' {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'eu' || raw === 'us' || raw === 'other') return raw;
    return '';
  }

  private normalizeConsentId(value: unknown): string | undefined {
    const raw = String(value || '').trim();
    if (!raw) return undefined;
    return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || undefined;
  }

  private parseBooleanLike(value: unknown, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const raw = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(raw)) return true;
    if (['false', '0', 'no', 'off'].includes(raw)) return false;
    return fallback;
  }

  private normalizeSearchQuery(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.slice(0, 120);
  }

  private isLikelyBotSubmission(body: Record<string, unknown>) {
    return Boolean(
      this.normalizeNullableString(body.website, 2048) ||
        this.normalizeNullableString(body.company_website, 2048) ||
        this.normalizeNullableString(body.url, 2048),
    );
  }

  private async enforceSubmissionWindow(appId: string, type: TenantSiteMessageType, email: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count
       FROM tenant_site_messages
       WHERE app_id = $1::uuid
         AND type = $2
         AND LOWER(email) = LOWER($3)
         AND created_at > now() - interval '2 minutes'`,
      appId,
      type,
      email,
    ) as Promise<Array<{ count: bigint }>>);
    if (Number(rows[0]?.count || 0) >= 3) {
      throw new BadRequestException('too many submissions');
    }
  }

  private getClientIp(request?: any): string | undefined {
    const forwarded = String(request?.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim();
    return forwarded || request?.ip || request?.socket?.remoteAddress || undefined;
  }

  private hashValue(value: unknown): string | undefined {
    const raw = this.normalizeNullableString(value, 200);
    if (!raw) return undefined;
    return createHash('sha256').update(raw).digest('hex').slice(0, 24);
  }

  private serializeDate(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private formatDate(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private async ensureSchema() {
    if (this.schemaReady) return;
    if (!this.schemaPromise) {
      this.schemaPromise = this.initializeSchema().catch((error) => {
        this.schemaPromise = null;
        throw error;
      });
    }
    await this.schemaPromise;
    this.schemaReady = true;
  }

  private async initializeSchema() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS tenant_site_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        type varchar(32) NOT NULL,
        email varchar(254) NULL,
        name varchar(160) NULL,
        category varchar(80) NULL,
        subject varchar(200) NULL,
        message text NULL,
        locale varchar(16) NULL,
        source varchar(128) NULL,
        context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        status varchar(16) NOT NULL DEFAULT 'new',
        admin_note text NULL,
        handled_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        handled_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_site_newsletter_email_unique
      ON tenant_site_messages(app_id, LOWER(email))
      WHERE type = 'newsletter'
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_tenant_site_messages_app_type_status_created
      ON tenant_site_messages(app_id, type, status, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS tenant_site_cookie_consents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        consent_id varchar(80) NOT NULL,
        region_mode varchar(16) NOT NULL DEFAULT 'other',
        essential boolean NOT NULL DEFAULT true,
        analytics boolean NOT NULL DEFAULT false,
        marketing boolean NOT NULL DEFAULT false,
        do_not_sell_share boolean NOT NULL DEFAULT false,
        locale varchar(16) NULL,
        source varchar(128) NULL,
        context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_site_cookie_consents_app_consent_unique
      ON tenant_site_cookie_consents(app_id, consent_id)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_tenant_site_cookie_consents_app_region_updated
      ON tenant_site_cookie_consents(app_id, region_mode, updated_at DESC)
    `);
  }
}

function cryptoRandomId() {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 32);
}
