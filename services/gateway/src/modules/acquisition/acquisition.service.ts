import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';

type AppRow = {
  id: string;
  slug: string;
  name: string;
};

type SourceOptionRow = {
  id: string;
  app_id: string;
  key: string;
  label: string;
  is_active: boolean;
  allow_free_text: boolean;
  sort_order: number;
  metadata_json: unknown;
  created_at: Date;
  updated_at: Date;
};

type UserSourceRow = {
  id: string;
  app_id: string;
  user_id: string;
  source_key: string;
  source_label_snapshot: string;
  free_text: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  referrer: string | null;
  landing_path: string | null;
  session_id: string | null;
  submitted_at: Date;
  created_at: Date;
  updated_at: Date;
  user_email?: string | null;
  user_display_name?: string | null;
  user_full_name?: string | null;
};

type SummaryRow = {
  source_key: string;
  source_label: string;
  submissions: bigint | number | string;
  users: bigint | number | string;
  first_submitted_at: Date | null;
  last_submitted_at: Date | null;
};

type SourceSubmitPayload = {
  source_key?: unknown;
  free_text?: unknown;
  utm_source?: unknown;
  utm_medium?: unknown;
  utm_campaign?: unknown;
  referrer?: unknown;
  landing_path?: unknown;
  session_id?: unknown;
};

type SourceOptionPayload = {
  key?: unknown;
  label?: unknown;
  is_active?: unknown;
  allow_free_text?: unknown;
  sort_order?: unknown;
  metadata?: unknown;
};

@Injectable()
export class AcquisitionService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async listSourceOptionsByAppSlug(appSlug?: string) {
    const app = await this.resolveAppBySlug(appSlug);
    return this.listSourceOptionsByAppId(app.id, { activeOnly: true });
  }

  async listSourceOptionsByAppId(appId: string, options?: { activeOnly?: boolean }) {
    await this.ensureAppExists(appId);
    const activeOnly = options?.activeOnly === true;
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, key, label, is_active, allow_free_text, sort_order, metadata_json, created_at, updated_at
       FROM app_acquisition_source_options
       WHERE app_id = $1::uuid
         AND ($2::boolean = false OR is_active = true)
       ORDER BY sort_order ASC, created_at ASC`,
      appId,
      activeOnly,
    ) as Promise<SourceOptionRow[]>);
    return { items: rows.map((row) => this.serializeOption(row)) };
  }

  async createSourceOption(appId: string, payload: SourceOptionPayload) {
    await this.ensureAppExists(appId);
    const key = this.normalizeKey(payload.key);
    const label = this.cleanText(payload.label, 120);
    if (!key) {
      throw new BadRequestException('来源标识不能为空');
    }
    if (!label) {
      throw new BadRequestException('来源名称不能为空');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_acquisition_source_options (
         id, app_id, key, label, is_active, allow_free_text, sort_order, metadata_json, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::text, $3::text, $4::boolean, $5::boolean, $6::int, $7::jsonb, now(), now()
       )
       RETURNING id, app_id, key, label, is_active, allow_free_text, sort_order, metadata_json, created_at, updated_at`,
      appId,
      key,
      label,
      this.normalizeBoolean(payload.is_active, true),
      this.normalizeBoolean(payload.allow_free_text, false),
      this.normalizeInteger(payload.sort_order, 0),
      JSON.stringify(this.normalizeMetadata(payload.metadata)),
    ) as Promise<SourceOptionRow[]>);
    return { item: this.serializeOption(rows[0]) };
  }

  async updateSourceOption(appId: string, optionId: string, payload: SourceOptionPayload) {
    await this.ensureAppExists(appId);
    const existing = await this.getSourceOptionById(appId, optionId);
    const key = payload.key === undefined ? existing.key : this.normalizeKey(payload.key);
    const label = payload.label === undefined ? existing.label : this.cleanText(payload.label, 120);
    if (!key) {
      throw new BadRequestException('来源标识不能为空');
    }
    if (!label) {
      throw new BadRequestException('来源名称不能为空');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE app_acquisition_source_options
       SET key = $3::text,
           label = $4::text,
           is_active = $5::boolean,
           allow_free_text = $6::boolean,
           sort_order = $7::int,
           metadata_json = $8::jsonb,
           updated_at = now()
       WHERE app_id = $1::uuid
         AND id = $2::uuid
       RETURNING id, app_id, key, label, is_active, allow_free_text, sort_order, metadata_json, created_at, updated_at`,
      appId,
      optionId,
      key,
      label,
      payload.is_active === undefined ? existing.is_active : this.normalizeBoolean(payload.is_active, true),
      payload.allow_free_text === undefined ? existing.allow_free_text : this.normalizeBoolean(payload.allow_free_text, false),
      payload.sort_order === undefined ? existing.sort_order : this.normalizeInteger(payload.sort_order, 0),
      JSON.stringify(payload.metadata === undefined ? existing.metadata_json || {} : this.normalizeMetadata(payload.metadata)),
    ) as Promise<SourceOptionRow[]>);
    return { item: this.serializeOption(rows[0]) };
  }

  async deleteSourceOption(appId: string, optionId: string) {
    await this.ensureAppExists(appId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `DELETE FROM app_acquisition_source_options
       WHERE app_id = $1::uuid
         AND id = $2::uuid
       RETURNING id`,
      appId,
      optionId,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) {
      throw new NotFoundException('Source option not found');
    }
    return { deleted: true };
  }

  async getMySourceByAppSlug(appSlug: string | undefined, userId: string) {
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT s.*
       FROM user_acquisition_sources s
       WHERE s.app_id = $1::uuid
         AND s.user_id = $2::uuid
       LIMIT 1`,
      app.id,
      userId,
    ) as Promise<UserSourceRow[]>);
    return { item: rows[0] ? this.serializeUserSource(rows[0]) : null };
  }

  async submitMySourceByAppSlug(appSlug: string | undefined, userId: string, payload: SourceSubmitPayload, request?: any) {
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    const sourceKey = this.normalizeKey(payload.source_key);
    if (!sourceKey) {
      throw new BadRequestException('来源不能为空');
    }
    const option = await this.getSourceOptionByKey(app.id, sourceKey);
    if (!option.is_active) {
      throw new BadRequestException('来源不可用');
    }
    const freeText = this.cleanText(payload.free_text, 240);
    if (freeText && !option.allow_free_text) {
      throw new BadRequestException('该来源不支持自定义说明');
    }
    const normalized = {
      freeText,
      utmSource: this.cleanText(payload.utm_source, 120),
      utmMedium: this.cleanText(payload.utm_medium, 120),
      utmCampaign: this.cleanText(payload.utm_campaign, 180),
      referrer: this.cleanText(payload.referrer, 2000),
      landingPath: this.cleanText(payload.landing_path, 500),
      sessionId: this.cleanText(payload.session_id, 128),
      userAgent: this.cleanText(request?.headers?.['user-agent'], 512),
      ipHash: this.hashIp(this.pickIpAddress(request)),
    };

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO user_acquisition_sources (
         id, app_id, user_id, source_key, source_label_snapshot, free_text,
         utm_source, utm_medium, utm_campaign, referrer, landing_path, session_id,
         submitted_at, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
         $6::text, $7::text, $8::text, $9::text, $10::text, $11::text,
         now(), now(), now()
       )
       ON CONFLICT (app_id, user_id) DO UPDATE
       SET source_key = EXCLUDED.source_key,
           source_label_snapshot = EXCLUDED.source_label_snapshot,
           free_text = EXCLUDED.free_text,
           utm_source = EXCLUDED.utm_source,
           utm_medium = EXCLUDED.utm_medium,
           utm_campaign = EXCLUDED.utm_campaign,
           referrer = EXCLUDED.referrer,
           landing_path = EXCLUDED.landing_path,
           session_id = EXCLUDED.session_id,
           submitted_at = now(),
           updated_at = now()
       RETURNING *`,
      app.id,
      userId,
      option.key,
      option.label,
      normalized.freeText,
      normalized.utmSource,
      normalized.utmMedium,
      normalized.utmCampaign,
      normalized.referrer,
      normalized.landingPath,
      normalized.sessionId,
    ) as Promise<UserSourceRow[]>);

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO user_acquisition_source_events (
         id, app_id, user_id, source_key, source_label_snapshot, free_text,
         utm_source, utm_medium, utm_campaign, referrer, landing_path, session_id,
         ip_hash, user_agent, created_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
         $6::text, $7::text, $8::text, $9::text, $10::text, $11::text,
         $12::text, $13::text, now()
       )`,
      app.id,
      userId,
      option.key,
      option.label,
      normalized.freeText,
      normalized.utmSource,
      normalized.utmMedium,
      normalized.utmCampaign,
      normalized.referrer,
      normalized.landingPath,
      normalized.sessionId,
      normalized.ipHash,
      normalized.userAgent,
    );

    return {
      message: '来源已保存',
      item: this.serializeUserSource(rows[0]),
    };
  }

  async getSummaryByAppId(appId: string, options?: { from?: string; to?: string }) {
    await this.ensureAppExists(appId);
    const range = this.resolveRange(options);
    const [overviewRows, sourceRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS total, COUNT(DISTINCT user_id)::bigint AS users
         FROM user_acquisition_sources
         WHERE app_id = $1::uuid
           AND submitted_at >= $2::timestamptz
           AND submitted_at <= $3::timestamptz`,
        appId,
        range.from,
        range.to,
      ) as Promise<Array<{ total: bigint; users: bigint }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           source_key,
           source_label_snapshot AS source_label,
           COUNT(*)::bigint AS submissions,
           COUNT(DISTINCT user_id)::bigint AS users,
           MIN(submitted_at) AS first_submitted_at,
           MAX(submitted_at) AS last_submitted_at
         FROM user_acquisition_sources
         WHERE app_id = $1::uuid
           AND submitted_at >= $2::timestamptz
           AND submitted_at <= $3::timestamptz
         GROUP BY source_key, source_label_snapshot
         ORDER BY submissions DESC, users DESC, source_label ASC`,
        appId,
        range.from,
        range.to,
      ) as Promise<SummaryRow[]>),
    ]);
    return {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
      total: this.toNumber(overviewRows[0]?.total),
      users: this.toNumber(overviewRows[0]?.users),
      by_source: sourceRows.map((row) => ({
        source_key: row.source_key,
        source_label: row.source_label,
        submissions: this.toNumber(row.submissions),
        users: this.toNumber(row.users),
        first_submitted_at: row.first_submitted_at?.toISOString() || null,
        last_submitted_at: row.last_submitted_at?.toISOString() || null,
      })),
    };
  }

  async listUserSourcesByAppId(
    appId: string,
    options?: { source_key?: string; from?: string; to?: string; page?: string | number; page_size?: string | number; q?: string },
  ) {
    await this.ensureAppExists(appId);
    const range = this.resolveRange(options);
    const sourceKey = this.normalizeKey(options?.source_key, true);
    const q = this.cleanText(options?.q, 120);
    const page = Math.max(1, Math.floor(Number(options?.page || 1)));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(options?.page_size || 20))));
    const offset = (page - 1) * pageSize;
    const [countRows, rows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count
         FROM user_acquisition_sources s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.app_id = $1::uuid
           AND s.submitted_at >= $2::timestamptz
           AND s.submitted_at <= $3::timestamptz
           AND ($4::text = '' OR s.source_key = $4::text)
           AND (
             $5::text = ''
             OR u.email ILIKE '%' || $5::text || '%'
             OR u.display_name ILIKE '%' || $5::text || '%'
             OR u.full_name ILIKE '%' || $5::text || '%'
             OR s.free_text ILIKE '%' || $5::text || '%'
           )`,
        appId,
        range.from,
        range.to,
        sourceKey,
        q,
      ) as Promise<Array<{ count: bigint }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           s.*,
           u.email AS user_email,
           u.display_name AS user_display_name,
           u.full_name AS user_full_name
         FROM user_acquisition_sources s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.app_id = $1::uuid
           AND s.submitted_at >= $2::timestamptz
           AND s.submitted_at <= $3::timestamptz
           AND ($4::text = '' OR s.source_key = $4::text)
           AND (
             $5::text = ''
             OR u.email ILIKE '%' || $5::text || '%'
             OR u.display_name ILIKE '%' || $5::text || '%'
             OR u.full_name ILIKE '%' || $5::text || '%'
             OR s.free_text ILIKE '%' || $5::text || '%'
           )
         ORDER BY s.submitted_at DESC
         LIMIT $6 OFFSET $7`,
        appId,
        range.from,
        range.to,
        sourceKey,
        q,
        pageSize,
        offset,
      ) as Promise<UserSourceRow[]>),
    ]);
    return {
      total: this.toNumber(countRows[0]?.count),
      page,
      page_size: pageSize,
      items: rows.map((row) => this.serializeUserSource(row)),
    };
  }

  private async resolveAppBySlug(appSlug?: string): Promise<AppRow> {
    const slug = String(appSlug || '').trim().toLowerCase();
    if (!slug || slug === 'api') {
      throw new NotFoundException('App not found');
    }
    const app = await this.prisma.app.findUnique({ where: { slug }, select: { id: true, slug: true, name: true } });
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  private async ensureAppExists(appId: string): Promise<AppRow> {
    const id = String(appId || '').trim();
    if (!id) {
      throw new NotFoundException('App not found');
    }
    const app = await this.prisma.app.findUnique({ where: { id }, select: { id: true, slug: true, name: true } });
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  private async ensureUserInApp(appId: string, userId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
       FROM users
       WHERE app_id = $1::uuid
         AND id = $2::uuid
         AND deleted_at IS NULL
       LIMIT 1`,
      appId,
      userId,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) {
      throw new NotFoundException('User not found');
    }
  }

  private async getSourceOptionById(appId: string, optionId: string): Promise<SourceOptionRow> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, key, label, is_active, allow_free_text, sort_order, metadata_json, created_at, updated_at
       FROM app_acquisition_source_options
       WHERE app_id = $1::uuid
         AND id = $2::uuid
       LIMIT 1`,
      appId,
      optionId,
    ) as Promise<SourceOptionRow[]>);
    if (!rows[0]) {
      throw new NotFoundException('Source option not found');
    }
    return rows[0];
  }

  private async getSourceOptionByKey(appId: string, sourceKey: string): Promise<SourceOptionRow> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, key, label, is_active, allow_free_text, sort_order, metadata_json, created_at, updated_at
       FROM app_acquisition_source_options
       WHERE app_id = $1::uuid
         AND key = $2::text
       LIMIT 1`,
      appId,
      sourceKey,
    ) as Promise<SourceOptionRow[]>);
    if (!rows[0]) {
      throw new BadRequestException('来源不存在');
    }
    return rows[0];
  }

  private resolveRange(options?: { from?: string; to?: string }) {
    const to = this.parseDate(options?.to) || new Date();
    const from = this.parseDate(options?.from) || new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('开始时间不能晚于结束时间');
    }
    return { from, to };
  }

  private parseDate(value?: string): Date | null {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('日期格式不正确');
    }
    return parsed;
  }

  private normalizeKey(value: unknown, allowEmpty = false) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return allowEmpty ? '' : '';
    const normalized = raw.replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 64);
    return normalized;
  }

  private cleanText(value: unknown, maxLength: number) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.slice(0, maxLength);
  }

  private normalizeBoolean(value: unknown, fallback: boolean) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const raw = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(raw)) return true;
    if (['false', '0', 'no', 'off'].includes(raw)) return false;
    return fallback;
  }

  private normalizeInteger(value: unknown, fallback: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.floor(parsed));
  }

  private normalizeMetadata(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private pickIpAddress(request?: any) {
    const forwarded = String(request?.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim();
    return forwarded || String(request?.ip || request?.socket?.remoteAddress || '').trim();
  }

  private hashIp(value: string) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return createHash('sha256').update(raw).digest('hex');
  }

  private toNumber(value: unknown) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private serializeOption(row: SourceOptionRow) {
    return {
      id: row.id,
      app_id: row.app_id,
      key: row.key,
      label: row.label,
      is_active: row.is_active,
      allow_free_text: row.allow_free_text,
      sort_order: Number(row.sort_order || 0),
      metadata: row.metadata_json || {},
      created_at: row.created_at?.toISOString?.() || row.created_at,
      updated_at: row.updated_at?.toISOString?.() || row.updated_at,
    };
  }

  private serializeUserSource(row: UserSourceRow) {
    return {
      id: row.id,
      app_id: row.app_id,
      user_id: row.user_id,
      user_email: row.user_email || null,
      user_display_name: row.user_display_name || row.user_full_name || row.user_email || null,
      source_key: row.source_key,
      source_label: row.source_label_snapshot,
      free_text: row.free_text || null,
      utm_source: row.utm_source || null,
      utm_medium: row.utm_medium || null,
      utm_campaign: row.utm_campaign || null,
      referrer: row.referrer || null,
      landing_path: row.landing_path || null,
      session_id: row.session_id || null,
      submitted_at: row.submitted_at?.toISOString?.() || row.submitted_at,
      created_at: row.created_at?.toISOString?.() || row.created_at,
      updated_at: row.updated_at?.toISOString?.() || row.updated_at,
    };
  }
}
