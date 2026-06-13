import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { ConfigType } from '@nestjs/config';
import { PRISMA_CLIENT } from '../../config/database.module';
import configuration from '../../config/configuration';

type AppApiKeyRow = {
  id: string;
  app_id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_last4: string;
  is_active: boolean;
  created_at: Date;
  last_used_at: Date | null;
};

type AuthenticatedApiKeyRow = {
  id: string;
  app_id: string;
  user_id: string;
  email: string;
  role: string;
  app_slug: string;
};

type AuthenticatedApiKeyUser = {
  userId: string;
  id: string;
  email: string;
  role: string;
  sessionToken: null;
  appSlug: string;
  authMode: 'api_key';
  apiKeyId: string;
};

type ApiKeyCacheEntry = {
  value: AuthenticatedApiKeyUser;
  expiresAt: number;
  lastUsedTouchAt: number;
};

const API_KEY_AUTH_CACHE_TTL_MS = 30_000;
const API_KEY_LAST_USED_TOUCH_INTERVAL_MS = 60_000;

@Injectable()
export class AppApiKeysService implements OnModuleInit {
  private readonly logger = new Logger(AppApiKeysService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;
  private readonly authCache = new Map<string, ApiKeyCacheEntry>();

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`app api keys startup warmup failed: ${error?.message || error}`);
    }
  }

  async createApiKey(appSlug: string | undefined, userId: string, name?: string) {
    const app = await this.resolveApp(appSlug);
    await this.assertUserInApp(userId, app.id);
    await this.ensureSchema();

    const rawKey = this.generateApiKey();
    const keyHash = this.hashApiKey(rawKey);
    const keyPrefix = rawKey.slice(0, 16);
    const keyLast4 = rawKey.slice(-4);
    const displayName = this.normalizeApiKeyName(name, 'App API Key');

    const inserted = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_api_keys (
          app_id, user_id, name, key_prefix, key_last4, key_hash, is_active
        ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, true)
        RETURNING id, created_at
      `,
      app.id,
      userId,
      displayName,
      keyPrefix,
      keyLast4,
      keyHash,
    ) as Promise<Array<{ id: string; created_at: Date }>>);

    const row = inserted[0];
    if (!row) {
      throw new Error('Failed to create API key');
    }

    return {
      id: row.id,
      name: displayName,
      key: rawKey,
      key_prefix: keyPrefix,
      key_last4: keyLast4,
      created_at: row.created_at,
      app_slug: app.slug,
      message: 'API key created. Please store it securely; it will only be shown once.',
    };
  }

  async ensureDefaultApiKey(appSlug: string | undefined, userId: string, name?: string) {
    const app = await this.resolveApp(appSlug);
    await this.assertUserInApp(userId, app.id);
    await this.ensureSchema();

    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, user_id, name, key_prefix, key_last4, is_active, created_at, last_used_at
        FROM app_api_keys
        WHERE app_id = $1::uuid
          AND user_id = $2::uuid
          AND is_active = true
        ORDER BY last_used_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      app.id,
      userId,
    ) as Promise<AppApiKeyRow[]>);

    const existing = rows[0];
    if (existing) {
      return {
        created: false,
        app_slug: app.slug,
        api_key: {
          id: existing.id,
          name: existing.name,
          key_prefix: existing.key_prefix,
          key_last4: existing.key_last4,
          is_active: existing.is_active,
          created_at: existing.created_at,
          last_used_at: existing.last_used_at,
        },
        message: 'Default API key already exists for this user.',
      };
    }

    const defaultName = this.normalizeApiKeyName(name, 'Default API Key');
    const created = await this.createApiKey(app.slug, userId, defaultName);
    return {
      created: true,
      app_slug: app.slug,
      key: created.key,
      api_key: {
        id: created.id,
        name: created.name,
        key_prefix: created.key_prefix,
        key_last4: created.key_last4,
        is_active: true,
        created_at: created.created_at,
        last_used_at: null,
      },
      message: 'Default API key created. Please store it securely; it will only be shown once.',
    };
  }

  async listApiKeys(appSlug: string | undefined, userId: string) {
    const app = await this.resolveApp(appSlug);
    await this.assertUserInApp(userId, app.id);
    await this.ensureSchema();

    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, user_id, name, key_prefix, key_last4, is_active, created_at, last_used_at
        FROM app_api_keys
        WHERE app_id = $1::uuid AND user_id = $2::uuid
        ORDER BY created_at DESC
      `,
      app.id,
      userId,
    ) as Promise<AppApiKeyRow[]>);

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        key_prefix: row.key_prefix,
        key_last4: row.key_last4,
        is_active: row.is_active,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
      })),
    };
  }

  async revokeApiKey(appSlug: string | undefined, userId: string, keyId: string) {
    const app = await this.resolveApp(appSlug);
    await this.assertUserInApp(userId, app.id);
    await this.ensureSchema();

    const updated = await this.prisma.$executeRawUnsafe(
      `
        UPDATE app_api_keys
        SET is_active = false,
            revoked_at = now(),
            updated_at = now()
        WHERE id = $1::uuid AND app_id = $2::uuid AND user_id = $3::uuid AND is_active = true
      `,
      keyId,
      app.id,
      userId,
    );

    if (!updated) {
      throw new NotFoundException('API key not found or already revoked');
    }

    this.evictAuthCacheByApiKeyId(keyId);
    return { message: 'API key revoked', id: keyId };
  }

  async authenticateApiKey(rawKey: string, appHint?: string) {
    await this.ensureSchema();
    const normalized = String(rawKey || '').trim();
    if (!normalized || !normalized.startsWith('rbx_')) {
      throw new UnauthorizedException('Invalid API key');
    }

    const keyHash = this.hashApiKey(normalized);
    const now = Date.now();
    const cached = this.authCache.get(keyHash);
    if (cached && cached.expiresAt > now) {
      if (appHint && String(appHint).trim() && String(appHint).trim() !== cached.value.appSlug) {
        throw new UnauthorizedException('API key does not match tenant app');
      }
      this.touchApiKeyLastUsed(cached.value.apiKeyId, cached, now);
      return cached.value;
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT k.id, k.app_id, k.user_id, u.email, u.role::text AS role, a.slug AS app_slug
        FROM app_api_keys k
        JOIN users u ON u.id = k.user_id
        JOIN apps a ON a.id = k.app_id
        WHERE k.key_hash = $1
          AND k.is_active = true
          AND u.deleted_at IS NULL
          AND u.is_active = true
        LIMIT 1
      `,
      keyHash,
    ) as Promise<AuthenticatedApiKeyRow[]>);

    const row = rows[0];
    if (!row) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (appHint && String(appHint).trim() && String(appHint).trim() !== row.app_slug) {
      throw new UnauthorizedException('API key does not match tenant app');
    }

    const authenticated: AuthenticatedApiKeyUser = {
      userId: row.user_id,
      id: row.user_id,
      email: row.email,
      role: row.role,
      sessionToken: null,
      appSlug: row.app_slug,
      authMode: 'api_key',
      apiKeyId: row.id,
    };
    const cacheEntry: ApiKeyCacheEntry = {
      value: authenticated,
      expiresAt: now + API_KEY_AUTH_CACHE_TTL_MS,
      lastUsedTouchAt: 0,
    };
    this.authCache.set(keyHash, cacheEntry);
    this.touchApiKeyLastUsed(row.id, cacheEntry, now);
    return authenticated;
  }

  private async resolveApp(appSlug?: string) {
    const slug = String(appSlug || this.config.app.defaultSlug || '')
      .trim()
      .toLowerCase();
    if (!slug) {
      throw new NotFoundException('App not found: <empty-slug>');
    }
    const app = await this.prisma.app.findUnique({ where: { slug } });
    if (!app) {
      throw new NotFoundException(`App not found: ${slug}`);
    }
    return app;
  }

  private normalizeApiKeyName(name: string | undefined, fallback: string): string {
    const normalized = String(name || '').trim() || fallback;
    if (normalized.length > 128) {
      throw new BadRequestException('name is too long (max 128)');
    }
    return normalized;
  }

  private async assertUserInApp(userId: string, appId: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        appId,
        deletedAt: null,
        isActive: true,
      },
      select: { id: true },
    });

    if (!user) {
      throw new UnauthorizedException('User does not belong to app or is inactive');
    }
  }

  private generateApiKey() {
    return `rbx_${randomBytes(24).toString('hex')}`;
  }

  private hashApiKey(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private touchApiKeyLastUsed(apiKeyId: string, cacheEntry: ApiKeyCacheEntry, now = Date.now()) {
    if (cacheEntry.lastUsedTouchAt > 0 && now - cacheEntry.lastUsedTouchAt < API_KEY_LAST_USED_TOUCH_INTERVAL_MS) {
      return;
    }
    cacheEntry.lastUsedTouchAt = now;
    void this.prisma.$executeRawUnsafe(
      `UPDATE app_api_keys SET last_used_at = now(), updated_at = now() WHERE id = $1::uuid`,
      apiKeyId,
    ).catch(() => {
      // ignore touch errors on the hot path
    });
  }

  private evictAuthCacheByApiKeyId(apiKeyId: string) {
    for (const [keyHash, entry] of this.authCache.entries()) {
      if (entry.value.apiKeyId === apiKeyId) {
        this.authCache.delete(keyHash);
      }
    }
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
      CREATE TABLE IF NOT EXISTS app_api_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name varchar(128) NOT NULL,
        key_prefix varchar(32) NOT NULL,
        key_last4 varchar(8) NOT NULL,
        key_hash varchar(128) NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        last_used_at timestamptz NULL,
        revoked_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_api_keys_key_hash_unique
      ON app_api_keys(key_hash)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_app_api_keys_app_user_created
      ON app_api_keys(app_id, user_id, created_at DESC)
    `);
  }
}
