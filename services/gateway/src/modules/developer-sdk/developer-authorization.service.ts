import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { PRISMA_CLIENT } from '../../config/database.module';

export type DeveloperScopeKey =
  | 'sdk:read'
  | 'ai:models:read'
  | 'ai:chat:write'
  | 'ai:video:write'
  | 'upload:write'
  | 'usage:read'
  | 'database:schema:read'
  | 'database:data:read'
  | 'database:schema:write'
  | 'database:data:write';

type DeveloperGrantRow = {
  id: string;
  name: string;
  key_prefix: string;
  key_last4: string;
  key_hash: string;
  user_id: string | null;
  user_email: string | null;
  scopes_json: unknown;
  allowed_app_ids_json: unknown;
  status: string;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_by_user_id: string | null;
  created_by_email: string | null;
  created_at: Date;
  updated_at: Date;
};

type AppRow = {
  id: string;
  slug: string;
  name: string;
};

type CreateGrantInput = {
  name: string;
  userId: string;
  createdByUserId: string;
  scopes?: unknown;
  allowedAppIds?: string[];
  expiresAt?: Date | null;
};

export const DEVELOPER_SCOPE_CATALOG: Array<{ key: DeveloperScopeKey; label: string; group: string; risk: 'low' | 'medium' | 'high' }> = [
  { key: 'sdk:read', label: '读取 SDK manifest、OpenAPI、smoke-test', group: 'SDK', risk: 'low' },
  { key: 'ai:models:read', label: '读取可用 AI 模型与价格', group: 'AI', risk: 'low' },
  { key: 'ai:chat:write', label: '调用文本、图片、语音、embedding 等 AI 能力', group: 'AI', risk: 'medium' },
  { key: 'ai:video:write', label: '提交和查询视频生成任务', group: 'AI', risk: 'high' },
  { key: 'upload:write', label: '创建上传地址和上传文件', group: '文件', risk: 'medium' },
  { key: 'usage:read', label: '读取当前 app 用量与调用日志', group: '观测', risk: 'low' },
  { key: 'database:schema:read', label: '读取 app 数据库命名空间和表结构', group: '数据库', risk: 'medium' },
  { key: 'database:data:read', label: '查询 app 命名空间内数据', group: '数据库', risk: 'high' },
  { key: 'database:schema:write', label: '变更 app 命名空间内 schema', group: '数据库', risk: 'high' },
  { key: 'database:data:write', label: '写入或修改 app 命名空间内数据', group: '数据库', risk: 'high' },
];

export const DEFAULT_DEVELOPER_LOGIN_SCOPES: DeveloperScopeKey[] = [
  'sdk:read',
  'ai:models:read',
  'ai:chat:write',
  'ai:video:write',
  'upload:write',
  'usage:read',
  'database:schema:read',
  'database:data:read',
  'database:schema:write',
  'database:data:write',
];

@Injectable()
export class DeveloperAuthorizationService implements OnModuleInit {
  private readonly logger = new Logger(DeveloperAuthorizationService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`developer authorization schema warmup failed: ${error?.message || error}`);
    }
  }

  async scopeCatalog() {
    return {
      items: DEVELOPER_SCOPE_CATALOG,
      default_scopes: DEFAULT_DEVELOPER_LOGIN_SCOPES,
    };
  }

  async ensureReady() {
    await this.ensureSchema();
  }

  normalizeScopes(input: unknown, fallback: DeveloperScopeKey[] = DEFAULT_DEVELOPER_LOGIN_SCOPES): DeveloperScopeKey[] {
    const raw = Array.isArray(input)
      ? input
      : typeof input === 'string'
        ? input.split(',')
        : fallback;
    const allowed = new Set(DEVELOPER_SCOPE_CATALOG.map((item) => item.key));
    const scopes = Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)))
      .filter((item): item is DeveloperScopeKey => allowed.has(item as DeveloperScopeKey));
    return scopes.length ? scopes : fallback;
  }

  async createGrant(input: CreateGrantInput) {
    await this.ensureSchema();
    const name = String(input.name || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const scopes = this.normalizeScopes(input.scopes);
    const allowedAppIds = Array.from(new Set((input.allowedAppIds || []).map((item) => String(item || '').trim()).filter(Boolean)));
    if (!allowedAppIds.length) {
      throw new BadRequestException('allowedAppIds is required');
    }
    const rawKey = `opg_dev_${randomBytes(24).toString('base64url')}`;
    const keyPrefix = rawKey.slice(0, 16);
    const keyLast4 = rawKey.slice(-4);
    const keyHash = this.hashToken(rawKey);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO developer_authorization_grants (
          name, key_prefix, key_last4, key_hash, user_id, scopes_json, allowed_app_ids_json,
          status, expires_at, created_by_user_id
        ) VALUES ($1, $2, $3, $4, $5::uuid, $6::jsonb, $7::jsonb, 'ACTIVE', $8::timestamptz, $9::uuid)
        RETURNING id, name, key_prefix, key_last4, key_hash, user_id, NULL::text AS user_email,
                  scopes_json, allowed_app_ids_json, status, last_used_at, expires_at, revoked_at,
                  created_by_user_id, NULL::text AS created_by_email, created_at, updated_at
      `,
      name.slice(0, 128),
      keyPrefix,
      keyLast4,
      keyHash,
      input.userId,
      JSON.stringify(scopes),
      JSON.stringify(allowedAppIds),
      input.expiresAt || null,
      input.createdByUserId,
    ) as Promise<DeveloperGrantRow[]>);

    return {
      ...await this.serializeGrant(rows[0]),
      key: rawKey,
    };
  }

  async listGrants() {
    await this.ensureSchema();
    const rows = await (this.prisma.$queryRawUnsafe(this.grantSelectSql('ORDER BY g.created_at DESC')) as Promise<DeveloperGrantRow[]>);
    return {
      items: await Promise.all(rows.map((row) => this.serializeGrant(row))),
      scope_catalog: DEVELOPER_SCOPE_CATALOG,
    };
  }

  async updateGrant(grantId: string, body: { name?: string; scopes?: unknown; allowed_app_ids?: unknown; allowedAppIds?: unknown; expires_at?: unknown }) {
    await this.ensureSchema();
    const existing = await this.getGrantRow(grantId);
    const name = body.name === undefined ? existing.name : String(body.name || '').trim().slice(0, 128);
    const scopes = body.scopes === undefined ? this.deserializeStringArray(existing.scopes_json) : this.normalizeScopes(body.scopes, []);
    const allowedAppIds = body.allowed_app_ids === undefined && body.allowedAppIds === undefined
      ? this.deserializeStringArray(existing.allowed_app_ids_json)
      : this.normalizeUuidArray(body.allowed_app_ids ?? body.allowedAppIds);
    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!scopes.length) {
      throw new BadRequestException('at least one scope is required');
    }
    if (!allowedAppIds.length) {
      throw new BadRequestException('at least one app is required');
    }

    await this.prisma.$executeRawUnsafe(
      `
        UPDATE developer_authorization_grants
        SET name = $1,
            scopes_json = $2::jsonb,
            allowed_app_ids_json = $3::jsonb,
            expires_at = COALESCE($4::timestamptz, expires_at),
            updated_at = now()
        WHERE id = $5::uuid
      `,
      name,
      JSON.stringify(scopes),
      JSON.stringify(allowedAppIds),
      this.normalizeOptionalDate(body.expires_at),
      grantId,
    );
    return this.getGrant(grantId);
  }

  async revokeGrant(grantId: string) {
    await this.ensureSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        UPDATE developer_authorization_grants
        SET status = 'REVOKED',
            revoked_at = now(),
            updated_at = now()
        WHERE id = $1::uuid
        RETURNING id
      `,
      grantId,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) {
      throw new NotFoundException('developer grant not found');
    }
    return this.getGrant(grantId);
  }

  async authenticateGrant(rawKey: string, appSlug: string | undefined, requiredScope?: DeveloperScopeKey | DeveloperScopeKey[]) {
    await this.ensureSchema();
    const normalized = String(rawKey || '').trim();
    if (!normalized.startsWith('opg_dev_')) {
      throw new UnauthorizedException('Invalid developer grant key');
    }
    const app = await this.resolveApp(appSlug);
    const keyPrefix = normalized.slice(0, 16);
    const rows = await (this.prisma.$queryRawUnsafe(
      `${this.grantSelectSql(`
        WHERE g.key_prefix = $1
          AND g.status = 'ACTIVE'
          AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > now())
        LIMIT 10
      `)}`,
      keyPrefix,
    ) as Promise<DeveloperGrantRow[]>);
    const tokenHash = this.hashToken(normalized);
    const grant = rows.find((row) => this.secureEquals(row.key_hash, tokenHash));
    if (!grant) {
      throw new UnauthorizedException('Invalid developer grant key');
    }
    const allowedAppIds = this.deserializeStringArray(grant.allowed_app_ids_json);
    if (!allowedAppIds.includes(app.id)) {
      throw new ForbiddenException('Developer grant is not authorized for this app');
    }
    const scopes = this.deserializeStringArray(grant.scopes_json) as DeveloperScopeKey[];
    const required = Array.isArray(requiredScope) ? requiredScope : requiredScope ? [requiredScope] : [];
    const missing = required.filter((scope) => !scopes.includes(scope));
    if (missing.length) {
      throw new ForbiddenException(`Developer grant missing scope: ${missing.join(', ')}`);
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE developer_authorization_grants SET last_used_at = now(), updated_at = now() WHERE id = $1::uuid`,
      grant.id,
    );
    return {
      id: grant.user_id,
      userId: grant.user_id,
      email: grant.user_email,
      role: 'ADMIN',
      appSlug: app.slug,
      sessionToken: null,
      authMode: 'developer_grant',
      developerGrantId: grant.id,
      developerGrantName: grant.name,
      developerScopes: scopes,
      allowedAppIds,
    };
  }

  assertActorScope(actor: any, scope: DeveloperScopeKey) {
    if (actor?.authMode !== 'developer_grant') {
      return;
    }
    const scopes = Array.isArray(actor?.developerScopes) ? actor.developerScopes : [];
    if (!scopes.includes(scope)) {
      throw new ForbiddenException(`Developer grant missing scope: ${scope}`);
    }
  }

  private async getGrant(grantId: string) {
    return this.serializeGrant(await this.getGrantRow(grantId));
  }

  private async getGrantRow(grantId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      this.grantSelectSql('WHERE g.id = $1::uuid LIMIT 1'),
      grantId,
    ) as Promise<DeveloperGrantRow[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('developer grant not found');
    }
    return row;
  }

  private async serializeGrant(row: DeveloperGrantRow) {
    const allowedAppIds = this.deserializeStringArray(row.allowed_app_ids_json);
    const apps = allowedAppIds.length ? await this.resolveAppsByIds(allowedAppIds) : [];
    return {
      id: row.id,
      name: row.name,
      key_prefix: row.key_prefix,
      key_last4: row.key_last4,
      user_id: row.user_id,
      user_email: row.user_email,
      scopes: this.deserializeStringArray(row.scopes_json),
      allowed_app_ids: allowedAppIds,
      allowed_apps: apps,
      status: row.status,
      last_used_at: row.last_used_at,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      created_by_user_id: row.created_by_user_id,
      created_by_email: row.created_by_email,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private grantSelectSql(suffix: string) {
    return `
      SELECT g.id, g.name, g.key_prefix, g.key_last4, g.key_hash, g.user_id,
             u.email AS user_email, g.scopes_json, g.allowed_app_ids_json,
             g.status, g.last_used_at, g.expires_at, g.revoked_at,
             g.created_by_user_id, cu.email AS created_by_email, g.created_at, g.updated_at
      FROM developer_authorization_grants g
      LEFT JOIN users u ON u.id = g.user_id
      LEFT JOIN users cu ON cu.id = g.created_by_user_id
      ${suffix}
    `;
  }

  private async resolveApp(appSlug?: string) {
    const slug = String(appSlug || '').trim().toLowerCase();
    if (!slug) {
      throw new BadRequestException('app is required');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, slug, name FROM apps WHERE slug = $1 LIMIT 1`,
      slug,
    ) as Promise<AppRow[]>);
    const app = rows[0];
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  private async resolveAppsByIds(appIds: string[]) {
    const rows: AppRow[] = [];
    for (const appId of appIds) {
      const result = await (this.prisma.$queryRawUnsafe(
        `SELECT id, slug, name FROM apps WHERE id = $1::uuid LIMIT 1`,
        appId,
      ) as Promise<AppRow[]>);
      if (result[0]) {
        rows.push(result[0]);
      }
    }
    return rows.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  private normalizeUuidArray(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }
    return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
  }

  private deserializeStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
      try {
        return this.deserializeStringArray(JSON.parse(value));
      } catch {
        return [];
      }
    }
    return [];
  }

  private normalizeOptionalDate(value: unknown) {
    if (value === undefined) {
      return null;
    }
    const raw = String(value || '').trim();
    if (!raw) {
      return null;
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('expires_at must be a valid date');
    }
    return date;
  }

  private hashToken(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private secureEquals(a: string, b: string) {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private async ensureSchema() {
    if (this.schemaReady) return;
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
      CREATE TABLE IF NOT EXISTS developer_authorization_grants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(128) NOT NULL,
        key_prefix varchar(32) NOT NULL,
        key_last4 varchar(8) NOT NULL,
        key_hash varchar(128) NOT NULL,
        user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        scopes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        allowed_app_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        status varchar(24) NOT NULL DEFAULT 'ACTIVE',
        last_used_at timestamptz NULL,
        expires_at timestamptz NULL,
        revoked_at timestamptz NULL,
        created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_authorization_grants_hash_unique
      ON developer_authorization_grants(key_hash)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_developer_authorization_grants_prefix_status
      ON developer_authorization_grants(key_prefix, status, expires_at)
    `);
  }
}
