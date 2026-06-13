import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';

type RuntimeSettingsRow = {
  id: string;
  platform_app_id: string | null;
  api_base_url: string | null;
  admin_frontend_url: string | null;
  cors_origins_json: unknown;
  session_policy_json: unknown;
  payments_scheduler_json: unknown;
  ai_gateway_tuning_json: unknown;
  oauth_settings_json: unknown;
  integration_settings_json: unknown;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type RuntimeSettingsPayload = {
  api_base_url?: unknown;
  admin_frontend_url?: unknown;
  cors_origins?: unknown;
  session_policy?: unknown;
  payments_scheduler?: unknown;
  ai_gateway_tuning?: unknown;
  oauth_settings?: unknown;
  integration_settings?: unknown;
};

type StorageProviderType = 'ALIYUN_OSS' | 'S3' | 'R2';

type StorageProviderRow = {
  id: string;
  provider_type: StorageProviderType;
  name: string;
  is_active: boolean;
  is_default: boolean;
  config_json: unknown;
  secret_json_encrypted: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ResolvedStorageProviderConfig = {
  id: string;
  provider_type: StorageProviderType;
  name: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
  cdn_base_url?: string;
  cdn_auth_enabled?: boolean;
  cdn_auth_window_seconds?: number;
  timeout_ms?: number;
  access_key_id?: string;
  access_key_secret?: string;
  cdn_auth_key?: string;
};

type StorageProviderPayload = {
  provider_type?: unknown;
  name?: unknown;
  is_active?: unknown;
  is_default?: unknown;
  config?: unknown;
  secrets?: unknown;
  notes?: unknown;
};

type PlatformApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes_json: unknown;
  status: string;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type PlatformApiKeyPayload = {
  name?: unknown;
  scopes?: unknown;
  expires_at?: unknown;
};

type SmtpProviderRow = {
  id: string;
  name: string;
  is_active: boolean;
  is_default: boolean;
  config_json: unknown;
  secret_json_encrypted: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ResolvedSmtpProviderConfig = {
  id: string;
  name: string;
  host?: string;
  port?: number;
  secure?: boolean;
  from_email?: string;
  from_name?: string;
  username?: string;
  password?: string;
};

type SmtpProviderPayload = {
  name?: unknown;
  is_active?: unknown;
  is_default?: unknown;
  config?: unknown;
  secrets?: unknown;
  notes?: unknown;
};

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

@Injectable()
export class RuntimeSettingsService implements OnModuleInit {
  private readonly logger = new Logger(RuntimeSettingsService.name);
  private schemaPromise: Promise<void> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`runtime settings schema warmup failed: ${error?.message || error}`);
    }
  }

  async getAdminRuntimeSettings() {
    await this.ensureSchema();
    const row = await this.getOrCreateSingletonRow();
    return this.serializeAdminSettings(row);
  }

  async updateAdminRuntimeSettings(actorUserId: string, payload: RuntimeSettingsPayload) {
    await this.ensureSchema();
    const existing = await this.getOrCreateSingletonRow();
    const normalized = this.normalizePayload(payload, existing);

    const rows = (await this.prisma.$queryRawUnsafe(
      `UPDATE platform_runtime_settings
       SET api_base_url = $2,
           admin_frontend_url = $3,
           cors_origins_json = $4::jsonb,
           session_policy_json = $5::jsonb,
           payments_scheduler_json = $6::jsonb,
           ai_gateway_tuning_json = $7::jsonb,
           oauth_settings_json = $8::jsonb,
           integration_settings_json = $9::jsonb,
           updated_by_user_id = $10::uuid,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      existing.id,
      normalized.apiBaseUrl,
      normalized.adminFrontendUrl,
      JSON.stringify(normalized.corsOrigins),
      JSON.stringify(normalized.sessionPolicy),
      JSON.stringify(normalized.paymentsScheduler),
      JSON.stringify(normalized.aiGatewayTuning),
      JSON.stringify(normalized.oauthSettings),
      JSON.stringify(normalized.integrationSettings),
      actorUserId,
    )) as RuntimeSettingsRow[];

    return this.serializeAdminSettings(rows[0]);
  }

  async getPublicRuntimeConfig() {
    await this.ensureSchema();
    const row = await this.findSingletonRow();
    const corsOrigins = this.normalizeStringArray(row?.cors_origins_json);
    return {
      api_base_url: row?.api_base_url || null,
      admin_frontend_url: row?.admin_frontend_url || null,
      platform_app_slug: this.config.app.platformSlug,
      default_app_slug: this.config.app.defaultSlug,
      admin_portal_mode: 'platform',
      cors_configured: corsOrigins.length > 0,
      source: row ? 'db' : 'env',
    };
  }

  async getConfiguredCorsOrigins() {
    await this.ensureSchema();
    const row = await this.findSingletonRow();
    return this.normalizeStringArray(row?.cors_origins_json);
  }

  async getAiGatewayTuning() {
    await this.ensureSchema();
    const row = await this.findSingletonRow();
    return asPlainObject(row?.ai_gateway_tuning_json);
  }

  async getOauthSettings() {
    await this.ensureSchema();
    const row = await this.findSingletonRow();
    return asPlainObject(row?.oauth_settings_json);
  }

  async getIntegrationSettings() {
    await this.ensureSchema();
    const row = await this.findSingletonRow();
    return asPlainObject(row?.integration_settings_json);
  }

  async getConfigSourceSummary() {
    const corsOrigins = await this.getConfiguredCorsOrigins();
    return {
      database: 'env',
      redis: 'env',
      jwt: 'env',
      secrets: process.env.PLATFORM_SECRETS_KEY || process.env.OUTBOUND_PROXY_ENCRYPTION_KEY ? 'env' : 'missing',
      cors: corsOrigins.length > 0 ? 'db' : 'env',
      runtimeSettings: corsOrigins.length > 0 ? 'db' : 'default',
    };
  }

  async listStorageProviders() {
    await this.ensureSchema();
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_storage_providers
       ORDER BY provider_type ASC, is_default DESC, is_active DESC, updated_at DESC`,
    )) as StorageProviderRow[];
    return {
      items: rows.map((row) => this.serializeStorageProvider(row)),
    };
  }

  async createStorageProvider(actorUserId: string, payload: StorageProviderPayload) {
    await this.ensureSchema();
    const providerType = this.normalizeStorageProviderType(payload.provider_type);
    const name = String(payload.name || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const config = this.normalizeStorageProviderConfig(providerType, payload.config || {});
    const secrets = this.normalizeStorageProviderSecrets(providerType, payload.secrets || {});
    this.assertStorageProviderComplete(providerType, config, secrets);
    const isActive = payload.is_active !== false;
    const isDefault = payload.is_default !== false;
    const notes = String(payload.notes || '').trim() || null;

    if (isDefault) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE platform_storage_providers
         SET is_default = false, updated_at = now()
         WHERE is_default = true`,
      );
    }

    const rows = (await this.prisma.$queryRawUnsafe(
      `INSERT INTO platform_storage_providers (
         id, provider_type, name, is_active, is_default, config_json, secret_json_encrypted,
         notes, created_by_user_id, updated_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, $8::uuid
       )
       RETURNING *`,
      providerType,
      name,
      isActive,
      isDefault,
      JSON.stringify(config),
      this.encryptSecretJson(secrets),
      notes,
      actorUserId,
    )) as StorageProviderRow[];

    return this.serializeStorageProvider(rows[0]);
  }

  async updateStorageProvider(providerId: string, actorUserId: string, payload: StorageProviderPayload) {
    await this.ensureSchema();
    const existing = await this.getStorageProviderRow(providerId);
    const providerType = this.normalizeStorageProviderType(payload.provider_type || existing.provider_type);
    const name = payload.name === undefined ? existing.name : String(payload.name || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const isActive = payload.is_active === undefined ? existing.is_active : payload.is_active !== false;
    const isDefault = payload.is_default === undefined ? existing.is_default : payload.is_default !== false;
    const notes = payload.notes === undefined ? existing.notes : String(payload.notes || '').trim() || null;
    const existingConfig = asPlainObject(existing.config_json);
    const existingSecrets = this.decryptSecretJson(existing.secret_json_encrypted);
    const config = this.normalizeStorageProviderConfig(providerType, {
      ...existingConfig,
      ...asPlainObject(payload.config),
    });
    const incomingSecrets = this.normalizeStorageProviderSecrets(providerType, payload.secrets || {}, true);
    const secrets = {
      ...existingSecrets,
      ...incomingSecrets,
    };
    this.assertStorageProviderComplete(providerType, config, secrets);

    if (isDefault) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE platform_storage_providers
         SET is_default = false, updated_at = now()
         WHERE id <> $1::uuid`,
        providerId,
      );
    }

    const rows = (await this.prisma.$queryRawUnsafe(
      `UPDATE platform_storage_providers
       SET provider_type = $2,
           name = $3,
           is_active = $4,
           is_default = $5,
           config_json = $6::jsonb,
           secret_json_encrypted = $7,
           notes = $8,
           updated_by_user_id = $9::uuid,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      providerId,
      providerType,
      name,
      isActive,
      isDefault,
      JSON.stringify(config),
      this.encryptSecretJson(secrets),
      notes,
      actorUserId,
    )) as StorageProviderRow[];

    return this.serializeStorageProvider(rows[0]);
  }

  async deleteStorageProvider(providerId: string) {
    await this.ensureSchema();
    await this.getStorageProviderRow(providerId);
    await this.prisma.$executeRawUnsafe(`DELETE FROM platform_storage_providers WHERE id = $1::uuid`, providerId);
    return { success: true };
  }

  async testStorageProvider(providerId: string) {
    await this.ensureSchema();
    const provider = await this.resolveStorageProviderConfig(providerId);
    if (!provider) {
      throw new BadRequestException('storage provider not found');
    }
    const missing = this.getStorageProviderMissingFields(provider.provider_type, provider);
    return {
      ok: missing.length === 0,
      provider_type: provider.provider_type,
      provider_id: provider.id,
      message: missing.length === 0 ? '配置字段完整' : `缺少字段：${missing.join(', ')}`,
    };
  }

  async resolveDefaultStorageProviderConfig() {
    await this.ensureSchema();
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_storage_providers
       WHERE is_active = true
       ORDER BY is_default DESC, updated_at DESC
       LIMIT 1`,
    )) as StorageProviderRow[];
    return this.resolveStorageProviderRow(rows[0]);
  }

  async listSmtpProviders() {
    await this.ensureSchema();
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_smtp_providers
       ORDER BY is_default DESC, is_active DESC, updated_at DESC`,
    )) as SmtpProviderRow[];
    return {
      items: rows.map((row) => this.serializeSmtpProvider(row)),
    };
  }

  async createSmtpProvider(actorUserId: string, payload: SmtpProviderPayload) {
    await this.ensureSchema();
    const name = String(payload.name || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const config = this.normalizeSmtpProviderConfig(payload.config || {});
    const secrets = this.normalizeSmtpProviderSecrets(payload.secrets || {});
    this.assertSmtpProviderComplete(config, secrets);
    const isActive = payload.is_active !== false;
    const isDefault = payload.is_default !== false;
    const notes = String(payload.notes || '').trim() || null;

    if (isDefault) {
      await this.prisma.$executeRawUnsafe(`UPDATE platform_smtp_providers SET is_default = false, updated_at = now()`);
    }

    const rows = (await this.prisma.$queryRawUnsafe(
      `INSERT INTO platform_smtp_providers (
         id, name, is_active, is_default, config_json, secret_json_encrypted, notes, created_by_user_id, updated_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, $6, $7::uuid, $7::uuid
       )
       RETURNING *`,
      name,
      isActive,
      isDefault,
      JSON.stringify(config),
      this.encryptSecretJson(secrets),
      notes,
      actorUserId,
    )) as SmtpProviderRow[];

    return this.serializeSmtpProvider(rows[0]);
  }

  async updateSmtpProvider(providerId: string, actorUserId: string, payload: SmtpProviderPayload) {
    await this.ensureSchema();
    const existing = await this.getSmtpProviderRow(providerId);
    const name = payload.name === undefined ? existing.name : String(payload.name || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const isActive = payload.is_active === undefined ? existing.is_active : payload.is_active !== false;
    const isDefault = payload.is_default === undefined ? existing.is_default : payload.is_default !== false;
    const notes = payload.notes === undefined ? existing.notes : String(payload.notes || '').trim() || null;
    const config = this.normalizeSmtpProviderConfig({
      ...asPlainObject(existing.config_json),
      ...asPlainObject(payload.config),
    });
    const secrets = {
      ...this.decryptSecretJson(existing.secret_json_encrypted),
      ...this.normalizeSmtpProviderSecrets(payload.secrets || {}, true),
    };
    this.assertSmtpProviderComplete(config, secrets);

    if (isDefault) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE platform_smtp_providers
         SET is_default = false, updated_at = now()
         WHERE id <> $1::uuid`,
        providerId,
      );
    }

    const rows = (await this.prisma.$queryRawUnsafe(
      `UPDATE platform_smtp_providers
       SET name = $2,
           is_active = $3,
           is_default = $4,
           config_json = $5::jsonb,
           secret_json_encrypted = $6,
           notes = $7,
           updated_by_user_id = $8::uuid,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      providerId,
      name,
      isActive,
      isDefault,
      JSON.stringify(config),
      this.encryptSecretJson(secrets),
      notes,
      actorUserId,
    )) as SmtpProviderRow[];

    return this.serializeSmtpProvider(rows[0]);
  }

  async deleteSmtpProvider(providerId: string) {
    await this.ensureSchema();
    await this.getSmtpProviderRow(providerId);
    await this.prisma.$executeRawUnsafe(`DELETE FROM platform_smtp_providers WHERE id = $1::uuid`, providerId);
    return { success: true };
  }

  async testSmtpProvider(providerId: string) {
    await this.ensureSchema();
    const provider = await this.resolveSmtpProviderConfig(providerId);
    if (!provider) {
      throw new BadRequestException('smtp provider not found');
    }
    const missing = ['host', 'from_email', 'username', 'password'].filter((key) => !String((provider as any)[key] || '').trim());
    return {
      ok: missing.length === 0,
      provider_id: provider.id,
      message: missing.length === 0 ? '配置字段完整' : `缺少字段：${missing.join(', ')}`,
    };
  }

  async resolveDefaultSmtpProviderConfig() {
    await this.ensureSchema();
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_smtp_providers
       WHERE is_active = true
       ORDER BY is_default DESC, updated_at DESC
       LIMIT 1`,
    )) as SmtpProviderRow[];
    return this.resolveSmtpProviderRow(rows[0]);
  }

  async listPlatformApiKeys() {
    await this.ensureSchema();
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT id, name, key_prefix, key_hash, scopes_json, status, last_used_at, expires_at, revoked_at,
              created_by_user_id, created_at, updated_at
       FROM platform_api_keys
       ORDER BY created_at DESC`,
    )) as PlatformApiKeyRow[];
    return {
      items: rows.map((row) => this.serializePlatformApiKey(row)),
    };
  }

  async createPlatformApiKey(actorUserId: string, payload: PlatformApiKeyPayload) {
    await this.ensureSchema();
    const name = String(payload.name || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const scopes = this.normalizeApiKeyScopes(payload.scopes);
    const expiresAt = this.normalizeOptionalDate(payload.expires_at);
    const token = `opg_${randomBytes(24).toString('base64url')}`;
    const prefix = token.slice(0, 12);
    const hash = this.hashApiKey(token);

    const rows = (await this.prisma.$queryRawUnsafe(
      `INSERT INTO platform_api_keys (
         id, name, key_prefix, key_hash, scopes_json, status, expires_at, created_by_user_id
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4::jsonb, 'ACTIVE', $5::timestamptz, $6::uuid
       )
       RETURNING id, name, key_prefix, key_hash, scopes_json, status, last_used_at, expires_at, revoked_at,
                 created_by_user_id, created_at, updated_at`,
      name,
      prefix,
      hash,
      JSON.stringify(scopes),
      expiresAt,
      actorUserId,
    )) as PlatformApiKeyRow[];

    return {
      ...this.serializePlatformApiKey(rows[0]),
      token,
    };
  }

  async revokePlatformApiKey(apiKeyId: string) {
    await this.ensureSchema();
    const rows = (await this.prisma.$queryRawUnsafe(
      `UPDATE platform_api_keys
       SET status = 'REVOKED',
           revoked_at = now(),
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id, name, key_prefix, key_hash, scopes_json, status, last_used_at, expires_at, revoked_at,
                 created_by_user_id, created_at, updated_at`,
      apiKeyId,
    )) as PlatformApiKeyRow[];
    if (!rows[0]) {
      throw new BadRequestException('platform api key not found');
    }
    return this.serializePlatformApiKey(rows[0]);
  }

  async validatePlatformApiKey(token: string, requiredScope: string) {
    await this.ensureSchema();
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) {
      return false;
    }
    const prefix = normalizedToken.slice(0, 12);
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT id, name, key_prefix, key_hash, scopes_json, status, last_used_at, expires_at, revoked_at,
              created_by_user_id, created_at, updated_at
       FROM platform_api_keys
       WHERE key_prefix = $1
         AND status = 'ACTIVE'
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 10`,
      prefix,
    )) as PlatformApiKeyRow[];

    const tokenHash = this.hashApiKey(normalizedToken);
    const matched = rows.find((row) => this.secureEquals(row.key_hash, tokenHash) && this.apiKeyHasScope(row.scopes_json, requiredScope));
    if (!matched) {
      return false;
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE platform_api_keys SET last_used_at = now(), updated_at = now() WHERE id = $1::uuid`,
      matched.id,
    );
    return true;
  }

  private async ensureSchema() {
    if (!this.schemaPromise) {
      this.schemaPromise = this.initializeSchema().catch((error) => {
        this.schemaPromise = null;
        throw error;
      });
    }
    await this.schemaPromise;
  }

  private async initializeSchema() {
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS platform_runtime_settings (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         singleton_key varchar(32) NOT NULL DEFAULT 'platform',
         platform_app_id uuid NULL,
         api_base_url text NULL,
         admin_frontend_url text NULL,
         cors_origins_json jsonb NOT NULL DEFAULT '[]'::jsonb,
         session_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
         payments_scheduler_json jsonb NOT NULL DEFAULT '{}'::jsonb,
         ai_gateway_tuning_json jsonb NOT NULL DEFAULT '{}'::jsonb,
         oauth_settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
         integration_settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
         created_by_user_id uuid NULL,
         updated_by_user_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_runtime_settings_singleton
       ON platform_runtime_settings(singleton_key)`,
    );
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE platform_runtime_settings
       ADD COLUMN IF NOT EXISTS oauth_settings_json jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE platform_runtime_settings
       ADD COLUMN IF NOT EXISTS integration_settings_json jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS platform_storage_providers (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         provider_type varchar(32) NOT NULL,
         name varchar(128) NOT NULL,
         is_active boolean NOT NULL DEFAULT true,
         is_default boolean NOT NULL DEFAULT false,
         config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
         secret_json_encrypted text NULL,
         notes text NULL,
         created_by_user_id uuid NULL,
         updated_by_user_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_storage_providers_name_unique
       ON platform_storage_providers(LOWER(name))`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_platform_storage_providers_type
       ON platform_storage_providers(provider_type, is_default DESC, is_active DESC, updated_at DESC)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_storage_providers_default_unique
       ON platform_storage_providers(provider_type)
       WHERE is_default = true`,
    );
    await this.prisma.$executeRawUnsafe(
      `WITH ranked AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at DESC, created_at DESC) AS rn
         FROM platform_storage_providers
         WHERE is_default = true
       )
       UPDATE platform_storage_providers p
       SET is_default = false, updated_at = now()
       FROM ranked r
       WHERE p.id = r.id AND r.rn > 1`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_storage_providers_global_default_unique
       ON platform_storage_providers((is_default))
       WHERE is_default = true`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS platform_api_keys (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         name varchar(128) NOT NULL,
         key_prefix varchar(24) NOT NULL,
         key_hash varchar(128) NOT NULL,
         scopes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
         status varchar(24) NOT NULL DEFAULT 'ACTIVE',
         last_used_at timestamptz NULL,
         expires_at timestamptz NULL,
         revoked_at timestamptz NULL,
         created_by_user_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_api_keys_hash_unique
       ON platform_api_keys(key_hash)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_platform_api_keys_prefix_status
       ON platform_api_keys(key_prefix, status, expires_at)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS platform_smtp_providers (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         name varchar(128) NOT NULL,
         is_active boolean NOT NULL DEFAULT true,
         is_default boolean NOT NULL DEFAULT false,
         config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
         secret_json_encrypted text NULL,
         notes text NULL,
         created_by_user_id uuid NULL,
         updated_by_user_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_smtp_providers_name_unique
       ON platform_smtp_providers(LOWER(name))`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_smtp_providers_default_unique
       ON platform_smtp_providers((is_default))
       WHERE is_default = true`,
    );
  }

  private async findSingletonRow() {
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_runtime_settings
       WHERE singleton_key = 'platform'
       LIMIT 1`,
    )) as RuntimeSettingsRow[];
    return rows[0] || null;
  }

  private async getOrCreateSingletonRow() {
    const existing = await this.findSingletonRow();
    if (existing) {
      return existing;
    }

    const platformApp = await this.prisma.app.findUnique({
      where: { slug: this.config.app.platformSlug },
      select: { id: true },
    });

    const rows = (await this.prisma.$queryRawUnsafe(
      `INSERT INTO platform_runtime_settings (singleton_key, platform_app_id)
       VALUES ('platform', $1::uuid)
       ON CONFLICT (singleton_key) DO UPDATE
       SET updated_at = platform_runtime_settings.updated_at
       RETURNING *`,
      platformApp?.id || null,
    )) as RuntimeSettingsRow[];
    return rows[0];
  }

  private async getStorageProviderRow(providerId: string) {
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_storage_providers
       WHERE id = $1::uuid
       LIMIT 1`,
      providerId,
    )) as StorageProviderRow[];
    if (!rows[0]) {
      throw new BadRequestException('storage provider not found');
    }
    return rows[0];
  }

  private async getSmtpProviderRow(providerId: string) {
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_smtp_providers
       WHERE id = $1::uuid
       LIMIT 1`,
      providerId,
    )) as SmtpProviderRow[];
    if (!rows[0]) {
      throw new BadRequestException('smtp provider not found');
    }
    return rows[0];
  }

  private async resolveStorageProviderConfig(providerId: string) {
    const row = await this.getStorageProviderRow(providerId);
    return this.resolveStorageProviderRow(row);
  }

  private resolveStorageProviderRow(row?: StorageProviderRow | null): ResolvedStorageProviderConfig | null {
    if (!row) {
      return null;
    }
    const config = asPlainObject(row.config_json);
    const secrets = this.decryptSecretJson(row.secret_json_encrypted);
    return {
      id: row.id,
      provider_type: row.provider_type,
      name: row.name,
      endpoint: this.stringValue(config.endpoint),
      bucket: this.stringValue(config.bucket),
      region: this.stringValue(config.region),
      cdn_base_url: this.stringValue(config.cdn_base_url),
      cdn_auth_enabled: Boolean(config.cdn_auth_enabled),
      cdn_auth_window_seconds: this.numberValue(config.cdn_auth_window_seconds),
      timeout_ms: this.numberValue(config.timeout_ms),
      access_key_id: this.stringValue(secrets.access_key_id),
      access_key_secret: this.stringValue(secrets.access_key_secret),
      cdn_auth_key: this.stringValue(secrets.cdn_auth_key),
    };
  }

  private async resolveSmtpProviderConfig(providerId: string) {
    const row = await this.getSmtpProviderRow(providerId);
    return this.resolveSmtpProviderRow(row);
  }

  private resolveSmtpProviderRow(row?: SmtpProviderRow | null): ResolvedSmtpProviderConfig | null {
    if (!row) {
      return null;
    }
    const config = asPlainObject(row.config_json);
    const secrets = this.decryptSecretJson(row.secret_json_encrypted);
    return {
      id: row.id,
      name: row.name,
      host: this.stringValue(config.host),
      port: this.numberValue(config.port),
      secure: config.secure === undefined ? undefined : Boolean(config.secure),
      from_email: this.stringValue(config.from_email),
      from_name: this.stringValue(config.from_name),
      username: this.stringValue(secrets.username),
      password: this.stringValue(secrets.password),
    };
  }

  private serializeStorageProvider(row: StorageProviderRow) {
    const secrets = this.decryptSecretJson(row.secret_json_encrypted);
    const secretStatus = Object.fromEntries(
      Object.keys(secrets).map((key) => {
        const value = String(secrets[key] || '');
        return [key, value ? { configured: true, last_four: value.slice(-4) } : { configured: false, last_four: '' }];
      }),
    );
    return {
      id: row.id,
      provider_type: row.provider_type,
      name: row.name,
      is_active: row.is_active,
      is_default: row.is_default,
      config: asPlainObject(row.config_json),
      secret_status: secretStatus,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
      updated_by_user_id: row.updated_by_user_id,
    };
  }

  private serializePlatformApiKey(row: PlatformApiKeyRow) {
    return {
      id: row.id,
      name: row.name,
      key_prefix: row.key_prefix,
      scopes: this.normalizeApiKeyScopes(row.scopes_json),
      status: row.status,
      last_used_at: row.last_used_at,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private serializeSmtpProvider(row: SmtpProviderRow) {
    const secrets = this.decryptSecretJson(row.secret_json_encrypted);
    return {
      id: row.id,
      name: row.name,
      is_active: row.is_active,
      is_default: row.is_default,
      config: asPlainObject(row.config_json),
      secret_status: {
        username: { configured: Boolean(secrets.username), last_four: String(secrets.username || '').slice(-4) },
        password: { configured: Boolean(secrets.password), last_four: String(secrets.password || '').slice(-4) },
      },
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
      updated_by_user_id: row.updated_by_user_id,
    };
  }

  private normalizePayload(payload: RuntimeSettingsPayload, existing: RuntimeSettingsRow) {
    return {
      apiBaseUrl:
        payload.api_base_url === undefined
          ? existing.api_base_url
          : this.normalizeOptionalUrl(payload.api_base_url, 'api_base_url'),
      adminFrontendUrl:
        payload.admin_frontend_url === undefined
          ? existing.admin_frontend_url
          : this.normalizeOptionalUrl(payload.admin_frontend_url, 'admin_frontend_url'),
      corsOrigins:
        payload.cors_origins === undefined
          ? this.normalizeStringArray(existing.cors_origins_json)
          : this.normalizeCorsOrigins(payload.cors_origins),
      sessionPolicy:
        payload.session_policy === undefined
          ? asPlainObject(existing.session_policy_json)
          : this.normalizeSessionPolicy(payload.session_policy),
      paymentsScheduler:
        payload.payments_scheduler === undefined
          ? asPlainObject(existing.payments_scheduler_json)
          : this.normalizePaymentsScheduler(payload.payments_scheduler),
      aiGatewayTuning:
        payload.ai_gateway_tuning === undefined
          ? asPlainObject(existing.ai_gateway_tuning_json)
          : this.normalizeAiGatewayTuning(payload.ai_gateway_tuning),
      oauthSettings:
        payload.oauth_settings === undefined
          ? asPlainObject(existing.oauth_settings_json)
          : this.normalizeOauthSettings(payload.oauth_settings),
      integrationSettings:
        payload.integration_settings === undefined
          ? asPlainObject(existing.integration_settings_json)
          : this.normalizeIntegrationSettings(payload.integration_settings),
    };
  }

  private serializeAdminSettings(row: RuntimeSettingsRow) {
    const corsOrigins = this.normalizeStringArray(row.cors_origins_json);
    return {
      id: row.id,
      platform_app_id: row.platform_app_id,
      api_base_url: row.api_base_url,
      admin_frontend_url: row.admin_frontend_url,
      cors_origins: corsOrigins,
      session_policy: asPlainObject(row.session_policy_json),
      payments_scheduler: asPlainObject(row.payments_scheduler_json),
      ai_gateway_tuning: asPlainObject(row.ai_gateway_tuning_json),
      oauth_settings: asPlainObject(row.oauth_settings_json),
      integration_settings: asPlainObject(row.integration_settings_json),
      config_sources: {
        database: 'env',
        redis: 'env',
        jwt: 'env',
        secrets: process.env.PLATFORM_SECRETS_KEY || process.env.OUTBOUND_PROXY_ENCRYPTION_KEY ? 'env' : 'missing',
        cors: corsOrigins.length > 0 ? 'db' : 'env',
        runtime_settings: 'db',
      },
      created_at: row.created_at,
      updated_at: row.updated_at,
      updated_by_user_id: row.updated_by_user_id,
    };
  }

  private normalizeOptionalUrl(value: unknown, fieldName: string) {
    const text = String(value || '').trim();
    if (!text) {
      return null;
    }
    try {
      const url = new URL(text);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('invalid protocol');
      }
      return url.toString().replace(/\/$/, '');
    } catch {
      throw new BadRequestException(`${fieldName} must be a valid http(s) URL`);
    }
  }

  private normalizeCorsOrigins(value: unknown) {
    const items = Array.isArray(value)
      ? value
      : String(value || '')
          .split(',')
          .map((item) => item.trim());
    const origins = Array.from(
      new Set(
        items
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .map((origin) => {
            if (origin === '*') {
              return origin;
            }
            try {
              const url = new URL(origin);
              if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                throw new Error('invalid protocol');
              }
              return url.origin;
            } catch {
              throw new BadRequestException(`Invalid CORS origin: ${origin}`);
            }
          }),
      ),
    );
    if (origins.length > 50) {
      throw new BadRequestException('cors_origins supports at most 50 entries');
    }
    return origins;
  }

  private normalizeStringArray(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  private normalizeSessionPolicy(value: unknown) {
    const raw = asPlainObject(value);
    const next: Record<string, unknown> = {};
    this.copyBoundedInteger(raw, next, 'access_token_ttl_minutes', 5, 1440);
    this.copyBoundedInteger(raw, next, 'refresh_inactivity_days', 1, 3650);
    this.copyBoundedInteger(raw, next, 'refresh_absolute_days', 1, 3650);
    return next;
  }

  private normalizePaymentsScheduler(value: unknown) {
    const raw = asPlainObject(value);
    const next: Record<string, unknown> = {};
    if (raw.enabled !== undefined) {
      next.enabled = raw.enabled === true || String(raw.enabled).trim().toLowerCase() === 'true';
    }
    if (raw.admin_test_disabled !== undefined) {
      next.admin_test_disabled =
        raw.admin_test_disabled === true || String(raw.admin_test_disabled).trim().toLowerCase() === 'true';
    }
    if (raw.allow_local_return_url !== undefined) {
      next.allow_local_return_url =
        raw.allow_local_return_url === true || String(raw.allow_local_return_url).trim().toLowerCase() === 'true';
    }
    this.copyOptionalUrl(raw, next, 'api_base_url');
    this.copyOptionalUrl(raw, next, 'user_web_base_url');
    this.copyOptionalUrl(raw, next, 'payment_return_base_url');
    this.copyBoundedInteger(raw, next, 'interval_ms', 60_000, 86_400_000);
    this.copyBoundedInteger(raw, next, 'batch_size', 1, 500);
    return next;
  }

  private normalizeAiGatewayTuning(value: unknown) {
    const raw = asPlainObject(value);
    const next: Record<string, unknown> = {};
    const integerFields: Array<[string, number, number]> = [
      ['max_user_concurrency', 1, 512],
      ['max_source_concurrency', 1, 2048],
      ['max_api_key_concurrency', 0, 10000],
      ['max_account_concurrency', 0, 10000],
      ['user_rpm', 0, 1_000_000],
      ['source_rpm', 0, 1_000_000],
      ['api_key_rpm', 0, 1_000_000],
      ['account_rpm', 0, 1_000_000],
      ['cooldown_failure_threshold', 1, 1000],
      ['cooldown_ms', 0, 3_600_000],
      ['sticky_ttl_ms', 0, 86_400_000],
      ['upstream_header_timeout_ms', 1000, 600_000],
      ['upstream_stream_header_timeout_ms', 1000, 600_000],
      ['request_body_max_bytes', 1024, 209_715_200],
      ['response_text_max_bytes', 1024, 104_857_600],
      ['usage_workers', 1, 32],
      ['usage_queue_size', 1, 100_000],
      ['image_upstream_timeout_ms', 30_000, 3_600_000],
      ['video_upstream_timeout_ms', 60_000, 7_200_000],
    ];
    for (const [field, min, max] of integerFields) {
      this.copyBoundedInteger(raw, next, field, min, max);
    }
    if (raw.redis_limits_enabled !== undefined) {
      next.redis_limits_enabled =
        raw.redis_limits_enabled === true || String(raw.redis_limits_enabled).trim() === '1';
    }
    if (raw.throttle_fail_open !== undefined) {
      next.throttle_fail_open =
        raw.throttle_fail_open === true || String(raw.throttle_fail_open).trim() === '1';
    }
    if (raw.trace_log !== undefined) {
      next.trace_log =
        raw.trace_log === true || String(raw.trace_log).trim() === '1';
    }
    if (raw.redis_prefix !== undefined) {
      const prefix = String(raw.redis_prefix || '').trim().replace(/[^a-zA-Z0-9:_-]/g, '');
      if (prefix) {
        next.redis_prefix = prefix.slice(0, 64);
      }
    }
    if (raw.voice_clone_model_key !== undefined) {
      const modelKey = String(raw.voice_clone_model_key || '').trim();
      if (modelKey) {
        next.voice_clone_model_key = modelKey.slice(0, 255);
      }
    }
    if (raw.usage_queue_overflow !== undefined) {
      const overflow = String(raw.usage_queue_overflow || '').trim().toLowerCase();
      next.usage_queue_overflow = overflow === 'drop' ? 'drop' : 'sync';
    }
    return next;
  }

  private normalizeOauthSettings(value: unknown) {
    const raw = asPlainObject(value);
    const next: Record<string, unknown> = {};
    this.copyOptionalUrl(raw, next, 'wechat_auth_redirect_uri');
    const hosts = raw.wechat_auth_allowed_redirect_hosts;
    if (hosts !== undefined) {
      next.wechat_auth_allowed_redirect_hosts = this.normalizeHostList(hosts);
    }
    return next;
  }

  private normalizeIntegrationSettings(value: unknown) {
    const raw = asPlainObject(value);
    const next: Record<string, unknown> = {};
    if (raw.feedback_admin_actor_user_id !== undefined) {
      const actorId = String(raw.feedback_admin_actor_user_id || '').trim();
      if (actorId) {
        this.assertUuid(actorId, 'feedback_admin_actor_user_id');
        next.feedback_admin_actor_user_id = actorId;
      }
    }
    return next;
  }

  private normalizeStorageProviderType(value: unknown): StorageProviderType {
    const normalized = String(value || 'ALIYUN_OSS').trim().toUpperCase();
    if (normalized === 'ALIYUN_OSS' || normalized === 'S3' || normalized === 'R2') {
      return normalized;
    }
    throw new BadRequestException('unsupported storage provider type');
  }

  private normalizeStorageProviderConfig(providerType: StorageProviderType, value: unknown) {
    const raw = asPlainObject(value);
    const next: Record<string, unknown> = {};
    for (const key of ['endpoint', 'bucket', 'region', 'cdn_base_url']) {
      const text = String(raw[key] || '').trim();
      if (text) next[key] = text;
    }
    if (raw.cdn_auth_enabled !== undefined) {
      next.cdn_auth_enabled = raw.cdn_auth_enabled === true || String(raw.cdn_auth_enabled).trim().toLowerCase() === 'true';
    }
    this.copyBoundedInteger(raw, next, 'timeout_ms', 30_000, 900_000);
    this.copyBoundedInteger(raw, next, 'cdn_auth_window_seconds', 30, 3600);
    if (providerType === 'ALIYUN_OSS' && next.endpoint) {
      next.endpoint = String(next.endpoint).replace(/^https?:\/\//i, '').replace(/\/+$/g, '');
    }
    return next;
  }

  private normalizeStorageProviderSecrets(_providerType: StorageProviderType, value: unknown, allowEmpty = false) {
    const raw = asPlainObject(value);
    const next: Record<string, unknown> = {};
    for (const key of ['access_key_id', 'access_key_secret', 'cdn_auth_key']) {
      const text = String(raw[key] || '').trim();
      if (text || !allowEmpty) {
        next[key] = text;
      }
    }
    return next;
  }

  private assertStorageProviderComplete(providerType: StorageProviderType, config: Record<string, unknown>, secrets: Record<string, unknown>) {
    const missing = this.getStorageProviderMissingFields(providerType, {
      ...config,
      ...secrets,
    });
    if (missing.length > 0) {
      throw new BadRequestException(`storage provider missing required fields: ${missing.join(', ')}`);
    }
  }

  private getStorageProviderMissingFields(providerType: StorageProviderType, value: Record<string, unknown>) {
    const required: Array<[string, unknown]> = [
      ['bucket', value.bucket],
      ['access_key_id', value.access_key_id],
      ['access_key_secret', value.access_key_secret],
    ];
    if (providerType === 'ALIYUN_OSS') {
      required.unshift(['endpoint', value.endpoint]);
    }
    if (providerType === 'S3') {
      required.unshift(['region_or_endpoint', value.region || value.endpoint]);
    }
    if (providerType === 'R2') {
      required.unshift(['endpoint', value.endpoint]);
    }
    return required.filter(([, fieldValue]) => !String(fieldValue || '').trim()).map(([key]) => key);
  }

  private normalizeSmtpProviderConfig(value: unknown) {
    const raw = asPlainObject(value);
    const next: Record<string, unknown> = {};
    for (const key of ['host', 'from_email', 'from_name']) {
      const text = String(raw[key] || '').trim();
      if (text) next[key] = text;
    }
    this.copyBoundedInteger(raw, next, 'port', 1, 65535);
    if (raw.secure !== undefined) {
      next.secure = raw.secure === true || String(raw.secure).trim().toLowerCase() === 'true';
    }
    return next;
  }

  private normalizeSmtpProviderSecrets(value: unknown, allowEmpty = false) {
    const raw = asPlainObject(value);
    const next: Record<string, unknown> = {};
    for (const key of ['username', 'password']) {
      const text = String(raw[key] || '').trim();
      if (text || !allowEmpty) {
        next[key] = text;
      }
    }
    return next;
  }

  private assertSmtpProviderComplete(config: Record<string, unknown>, secrets: Record<string, unknown>) {
    const required = [
      ['host', config.host],
      ['port', config.port],
      ['from_email', config.from_email],
      ['username', secrets.username],
      ['password', secrets.password],
    ];
    const missing = required.filter(([, value]) => !String(value || '').trim()).map(([key]) => key);
    if (missing.length > 0) {
      throw new BadRequestException(`smtp provider missing required fields: ${missing.join(', ')}`);
    }
  }

  private encryptSecretJson(value: Record<string, unknown>) {
    const plaintext = JSON.stringify(value || {});
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.resolveSecretsKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  private decryptSecretJson(value: string | null | undefined): Record<string, unknown> {
    const raw = String(value || '').trim();
    if (!raw) {
      return {};
    }
    try {
      const [version, ivBase64, tagBase64, encryptedBase64] = raw.split(':');
      if (version !== 'v1' || !ivBase64 || !tagBase64 || !encryptedBase64) {
        return {};
      }
      const decipher = createDecipheriv('aes-256-gcm', this.resolveSecretsKey(), Buffer.from(ivBase64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagBase64, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedBase64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return asPlainObject(JSON.parse(decrypted));
    } catch {
      return {};
    }
  }

  private resolveSecretsKey() {
    const secret = process.env.PLATFORM_SECRETS_KEY || process.env.OUTBOUND_PROXY_ENCRYPTION_KEY || this.config.jwt.secret;
    return createHash('sha256').update(secret).digest();
  }

  private hashApiKey(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private secureEquals(a: string, b: string) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(left, right);
  }

  private normalizeApiKeyScopes(value: unknown) {
    const raw = Array.isArray(value) ? value : ['feedback:admin'];
    const scopes = Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)));
    return scopes.length > 0 ? scopes : ['feedback:admin'];
  }

  private apiKeyHasScope(value: unknown, requiredScope: string) {
    const scopes = this.normalizeApiKeyScopes(value);
    return scopes.includes('*') || scopes.includes(requiredScope);
  }

  private normalizeOptionalDate(value: unknown) {
    const text = String(value || '').trim();
    if (!text) {
      return null;
    }
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('expires_at must be a valid date');
    }
    return date.toISOString();
  }

  private stringValue(value: unknown) {
    return String(value || '').trim() || undefined;
  }

  private numberValue(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private copyBoundedInteger(raw: Record<string, unknown>, next: Record<string, unknown>, key: string, min: number, max: number) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') {
      return;
    }
    const parsed = Number.parseInt(String(raw[key]).trim(), 10);
    if (!Number.isFinite(parsed)) {
      throw new BadRequestException(`${key} must be an integer`);
    }
    next[key] = Math.min(max, Math.max(min, parsed));
  }

  private copyOptionalUrl(raw: Record<string, unknown>, next: Record<string, unknown>, key: string) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') {
      return;
    }
    try {
      const url = new URL(String(raw[key]).trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('invalid protocol');
      }
      next[key] = url.toString().replace(/\/$/, '');
    } catch {
      throw new BadRequestException(`${key} must be a valid http(s) URL`);
    }
  }

  private assertUuid(value: string, fieldName: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new BadRequestException(`${fieldName} must be a valid UUID`);
    }
  }

  private normalizeHostList(value: unknown) {
    const items = Array.isArray(value)
      ? value
      : String(value || '')
          .split(/[\n,]/)
          .map((item) => item.trim());
    return Array.from(
      new Set(
        items
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .map((item) => {
            try {
              const host = /^https?:\/\//i.test(item)
                ? new URL(item).host
                : new URL(`https://${item.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]}`).host;
              return host.trim().toLowerCase();
            } catch {
              throw new BadRequestException(`Invalid host: ${item}`);
            }
          }),
      ),
    ).slice(0, 50);
  }
}
