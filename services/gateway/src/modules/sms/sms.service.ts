import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { App, AppSetting, PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomUUID } from 'crypto';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import {
  SmsDispatchMode,
  SmsDispatchResult,
  SmsProviderRow,
  SmsProviderType,
  SmsRouteConfigResolved,
  SmsSendPurpose,
  SmsSignatureRow,
  SmsTemplateRow,
} from './sms.types';

type AppWithSettings = App & { settings: AppSetting | null };
type SmsCodeRow = {
  id: string;
  code_hash: string;
  expire_at: Date;
  attempt_count: number;
  max_attempts: number;
};

type AppSmsRouteConfig = {
  sms_provider_ref_id?: string;
  sms_signature_ref_id?: string;
  sms_template_ref_id?: string;
};

const SUPPORTED_SMS_PROVIDER_TYPES: SmsProviderType[] = [
  'GENERIC_API',
  'ALIYUN_SMS',
  'TENCENT_SMS',
  'HUAWEI_SMS',
  'VOLCENGINE_SMS',
  'TWILIO_SMS',
  'VONAGE_SMS',
  'MESSAGEBIRD_SMS',
  'PLIVO_SMS',
  'AWS_SNS',
];

const SMS_PROVIDER_CATALOG: Array<{
  provider_type: SmsProviderType;
  label: string;
  region: 'CN' | 'GLOBAL';
  mode_default: SmsDispatchMode;
  required_config: string[];
  optional_config: string[];
}> = [
  {
    provider_type: 'GENERIC_API',
    label: '通用 HTTP API',
    region: 'GLOBAL',
    mode_default: 'SYNC',
    required_config: ['endpoint_url'],
    optional_config: ['http_method', 'auth_type', 'auth_header_name', 'auth_token', 'api_key', 'content_type', 'phone_field', 'code_field', 'sign_field', 'template_field'],
  },
  {
    provider_type: 'ALIYUN_SMS',
    label: '阿里云短信',
    region: 'CN',
    mode_default: 'ASYNC',
    required_config: ['access_key_id', 'access_key_secret'],
    optional_config: ['endpoint_url', 'region_id'],
  },
  {
    provider_type: 'TENCENT_SMS',
    label: '腾讯云短信',
    region: 'CN',
    mode_default: 'ASYNC',
    required_config: ['secret_id', 'secret_key', 'sdk_app_id'],
    optional_config: ['endpoint_url', 'region_id'],
  },
  {
    provider_type: 'HUAWEI_SMS',
    label: '华为云短信',
    region: 'CN',
    mode_default: 'ASYNC',
    required_config: ['endpoint_url', 'app_key', 'app_secret', 'sender'],
    optional_config: ['status_callback'],
  },
  {
    provider_type: 'VOLCENGINE_SMS',
    label: '火山引擎短信',
    region: 'CN',
    mode_default: 'ASYNC',
    required_config: ['access_key_id', 'access_key_secret', 'sms_account'],
    optional_config: ['endpoint_url', 'region_id'],
  },
  {
    provider_type: 'TWILIO_SMS',
    label: 'Twilio',
    region: 'GLOBAL',
    mode_default: 'ASYNC',
    required_config: ['account_sid', 'auth_token', 'from'],
    optional_config: ['messaging_service_sid'],
  },
  {
    provider_type: 'VONAGE_SMS',
    label: 'Vonage',
    region: 'GLOBAL',
    mode_default: 'ASYNC',
    required_config: ['api_key', 'api_secret', 'from'],
    optional_config: ['endpoint_url'],
  },
  {
    provider_type: 'MESSAGEBIRD_SMS',
    label: 'MessageBird',
    region: 'GLOBAL',
    mode_default: 'ASYNC',
    required_config: ['access_key', 'originator'],
    optional_config: ['endpoint_url'],
  },
  {
    provider_type: 'PLIVO_SMS',
    label: 'Plivo',
    region: 'GLOBAL',
    mode_default: 'ASYNC',
    required_config: ['auth_id', 'auth_token', 'src'],
    optional_config: ['endpoint_url'],
  },
  {
    provider_type: 'AWS_SNS',
    label: 'AWS SNS',
    region: 'GLOBAL',
    mode_default: 'ASYNC',
    required_config: ['access_key_id', 'secret_access_key', 'region_id'],
    optional_config: ['sender_id'],
  },
];

const asPlainObject = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

@Injectable()
export class SmsService implements OnModuleInit {
  private readonly logger = new Logger(SmsService.name);
  private smsSchemaEnsured: Promise<void> | null = null;
  private readonly routeCache = new Map<string, { expires_at: number; value: SmsRouteConfigResolved }>();
  private readonly routeCacheTtlMs = 60 * 1000;
  private lastCodeCleanupAt = 0;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
  ) {}

  async onModuleInit() {
    await this.ensureSmsSchema();
  }

  getProviderCatalog() {
    return { items: SMS_PROVIDER_CATALOG };
  }

  async listProviders() {
    await this.ensureSmsSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_sms_providers
       ORDER BY is_default DESC, is_active DESC, updated_at DESC, created_at DESC`,
    ) as Promise<SmsProviderRow[]>);
    return { items: rows.map((row) => this.serializeProvider(row)) };
  }

  async createProvider(actorUserId: string, payload: {
    provider_type?: string;
    name?: string;
    is_active?: boolean;
    is_default?: boolean;
    notes?: string;
    config?: Record<string, unknown>;
  }) {
    await this.ensureSmsSchema();
    const providerType = this.parseProviderType(payload.provider_type);
    const name = String(payload.name || '').trim();
    if (!name) throw new BadRequestException('name is required');
    const configJson = this.normalizeProviderConfig(providerType, payload.config || {});
    this.assertProviderConfig(providerType, configJson);
    const isActive = payload.is_active !== false;
    const isDefault = !!payload.is_default;
    const notes = String(payload.notes || '').trim() || null;

    const dupRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM platform_sms_providers WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      name,
    ) as Promise<Array<{ id: string }>>);
    if (dupRows.length > 0) throw new BadRequestException('短信服务名称已存在');

    if (isDefault) {
      await this.prisma.$executeRawUnsafe(`UPDATE platform_sms_providers SET is_default = false, updated_at = now()`);
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO platform_sms_providers (
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
    ) as Promise<SmsProviderRow[]>);
    this.routeCache.clear();
    await this.recordConfigAudit('provider.create', actorUserId, rows[0].id, rows[0].provider_type, { name, is_active: isActive, is_default: isDefault });
    return this.serializeProvider(rows[0]);
  }

  async updateProvider(providerId: string, actorUserId: string, payload: {
    provider_type?: string;
    name?: string;
    is_active?: boolean;
    is_default?: boolean;
    notes?: string;
    config?: Record<string, unknown>;
  }) {
    await this.ensureSmsSchema();
    const existing = await this.getProviderRow(providerId);
    const providerType = this.parseProviderType(payload.provider_type || existing.provider_type);
    const name = payload.name === undefined ? existing.name : String(payload.name || '').trim();
    if (!name) throw new BadRequestException('name is required');
    const isActive = payload.is_active === undefined ? existing.is_active : !!payload.is_active;
    const isDefault = payload.is_default === undefined ? existing.is_default : !!payload.is_default;
    const notes = payload.notes === undefined ? existing.notes : String(payload.notes || '').trim() || null;
    const mergedConfig = this.mergeProviderConfigForUpdate(providerType, existing.config_json, payload.config);
    this.assertProviderConfig(providerType, mergedConfig);

    const dupRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM platform_sms_providers WHERE LOWER(name) = LOWER($1) AND id <> $2::uuid LIMIT 1`,
      name,
      providerId,
    ) as Promise<Array<{ id: string }>>);
    if (dupRows.length > 0) throw new BadRequestException('短信服务名称已存在');

    if (isDefault) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE platform_sms_providers SET is_default = false, updated_at = now() WHERE id <> $1::uuid`,
        providerId,
      );
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE platform_sms_providers
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
      providerId,
      providerType,
      name,
      isActive,
      isDefault,
      JSON.stringify(mergedConfig),
      notes,
      actorUserId,
    ) as Promise<SmsProviderRow[]>);
    this.routeCache.clear();
    await this.recordConfigAudit('provider.update', actorUserId, providerId, providerType, { name, is_active: isActive, is_default: isDefault });
    return this.serializeProvider(rows[0]);
  }

  async deleteProvider(providerId: string, actorUserId: string) {
    await this.ensureSmsSchema();
    const provider = await this.getProviderRow(providerId);
    const refs = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM platform_sms_signatures WHERE provider_id = $1::uuid LIMIT 1`,
      providerId,
    ) as Promise<Array<{ id: string }>>);
    if (refs.length > 0) throw new BadRequestException('该短信服务下仍有关联签名，请先删除签名');
    const templateRefs = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM platform_sms_templates WHERE provider_id = $1::uuid LIMIT 1`,
      providerId,
    ) as Promise<Array<{ id: string }>>);
    if (templateRefs.length > 0) throw new BadRequestException('该短信服务下仍有关联模板，请先删除模板');
    await this.prisma.$executeRawUnsafe(`DELETE FROM platform_sms_providers WHERE id = $1::uuid`, providerId);
    this.routeCache.clear();
    await this.recordConfigAudit('provider.delete', actorUserId, provider.id, provider.provider_type, { name: provider.name });
    return { success: true };
  }

  async testProvider(payload: { provider_id?: string; timeout_ms?: number }) {
    await this.ensureSmsSchema();
    const providerId = String(payload.provider_id || '').trim();
    if (!providerId) throw new BadRequestException('provider_id is required');
    const provider = await this.getProviderRow(providerId);
    const cfg = asPlainObject(provider.config_json);
    const endpointUrl = this.resolveProviderHealthUrl(provider.provider_type, cfg);
    const timeoutMs = this.clampTimeout(payload.timeout_ms ?? cfg.timeout_ms ?? 10000);
    const startedAt = Date.now();
    try {
      const response = await fetch(endpointUrl, {
        method: provider.provider_type === 'GENERIC_API' && String(cfg.http_method || 'POST').toUpperCase() !== 'GET' ? 'POST' : 'GET',
        headers: provider.provider_type === 'GENERIC_API' ? { 'Content-Type': 'application/json' } : undefined,
        body: provider.provider_type === 'GENERIC_API' && String(cfg.http_method || 'POST').toUpperCase() !== 'GET' ? JSON.stringify({ dry_run: true }) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        provider_id: provider.id,
        provider_type: provider.provider_type,
        provider_name: provider.name,
        ok: response.ok || [400, 401, 403, 405].includes(response.status),
        status_code: response.status,
        elapsed_ms: Date.now() - startedAt,
        test_url: endpointUrl,
      };
    } catch (error) {
      return {
        provider_id: provider.id,
        provider_type: provider.provider_type,
        provider_name: provider.name,
        ok: false,
        status_code: null,
        elapsed_ms: Date.now() - startedAt,
        test_url: endpointUrl,
        error_message: this.describeNetworkFailure(error, timeoutMs),
      };
    }
  }

  async listSignatures(query: { provider_id?: string }) {
    await this.ensureSmsSchema();
    const providerId = String(query.provider_id || '').trim();
    if (providerId) {
      await this.getProviderRow(providerId);
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT * FROM platform_sms_signatures
         WHERE provider_id = $1::uuid
         ORDER BY is_default DESC, is_active DESC, updated_at DESC, created_at DESC`,
        providerId,
      ) as Promise<SmsSignatureRow[]>);
      return { items: rows.map((row) => this.serializeSignature(row)) };
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM platform_sms_signatures ORDER BY updated_at DESC, created_at DESC`,
    ) as Promise<SmsSignatureRow[]>);
    return { items: rows.map((row) => this.serializeSignature(row)) };
  }

  async createSignature(actorUserId: string, payload: {
    provider_id?: string;
    sign_name?: string;
    name?: string;
    is_active?: boolean;
    is_default?: boolean;
    notes?: string;
    meta?: Record<string, unknown>;
  }) {
    await this.ensureSmsSchema();
    const providerId = String(payload.provider_id || '').trim();
    if (!providerId) throw new BadRequestException('provider_id is required');
    const provider = await this.getProviderRow(providerId);
    const signName = String(payload.sign_name || payload.name || '').trim();
    if (!signName) throw new BadRequestException('sign_name is required');
    const isActive = payload.is_active !== false;
    const isDefault = !!payload.is_default;
    const notes = String(payload.notes || '').trim() || null;
    const metaJson = asPlainObject(payload.meta);
    const dupRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM platform_sms_signatures WHERE provider_id = $1::uuid AND LOWER(sign_name) = LOWER($2) LIMIT 1`,
      providerId,
      signName,
    ) as Promise<Array<{ id: string }>>);
    if (dupRows.length > 0) throw new BadRequestException('该短信签名已存在');
    if (isDefault) {
      await this.prisma.$executeRawUnsafe(`UPDATE platform_sms_signatures SET is_default = false, updated_at = now() WHERE provider_id = $1::uuid`, providerId);
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO platform_sms_signatures (
         id, provider_id, sign_name, is_active, is_default, notes, meta_json, created_by_user_id, updated_by_user_id
       ) VALUES (
         gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::jsonb, $7::uuid, $7::uuid
       )
       RETURNING *`,
      providerId,
      signName,
      isActive,
      isDefault,
      notes,
      JSON.stringify(metaJson),
      actorUserId,
    ) as Promise<SmsSignatureRow[]>);
    this.routeCache.clear();
    await this.recordConfigAudit('signature.create', actorUserId, providerId, provider.provider_type, { signature_id: rows[0].id, sign_name: signName });
    return this.serializeSignature(rows[0]);
  }

  async updateSignature(signatureId: string, actorUserId: string, payload: {
    provider_id?: string;
    sign_name?: string;
    name?: string;
    is_active?: boolean;
    is_default?: boolean;
    notes?: string;
    meta?: Record<string, unknown>;
  }) {
    await this.ensureSmsSchema();
    const existing = await this.getSignatureRow(signatureId);
    const providerId = payload.provider_id === undefined ? existing.provider_id : String(payload.provider_id || '').trim();
    if (!providerId) throw new BadRequestException('provider_id is required');
    const provider = await this.getProviderRow(providerId);
    const signName = payload.sign_name === undefined && payload.name === undefined ? existing.sign_name : String(payload.sign_name || payload.name || '').trim();
    if (!signName) throw new BadRequestException('sign_name is required');
    const isActive = payload.is_active === undefined ? existing.is_active : !!payload.is_active;
    const isDefault = payload.is_default === undefined ? existing.is_default : !!payload.is_default;
    const notes = payload.notes === undefined ? existing.notes : String(payload.notes || '').trim() || null;
    const metaJson = payload.meta === undefined ? asPlainObject(existing.meta_json) : asPlainObject(payload.meta);
    const dupRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM platform_sms_signatures
       WHERE provider_id = $1::uuid AND LOWER(sign_name) = LOWER($2) AND id <> $3::uuid
       LIMIT 1`,
      providerId,
      signName,
      signatureId,
    ) as Promise<Array<{ id: string }>>);
    if (dupRows.length > 0) throw new BadRequestException('该短信签名已存在');
    if (isDefault) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE platform_sms_signatures SET is_default = false, updated_at = now()
         WHERE provider_id = $1::uuid AND id <> $2::uuid`,
        providerId,
        signatureId,
      );
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE platform_sms_signatures
       SET provider_id = $2::uuid,
           sign_name = $3,
           is_active = $4,
           is_default = $5,
           notes = $6,
           meta_json = $7::jsonb,
           updated_by_user_id = $8::uuid,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      signatureId,
      providerId,
      signName,
      isActive,
      isDefault,
      notes,
      JSON.stringify(metaJson),
      actorUserId,
    ) as Promise<SmsSignatureRow[]>);
    this.routeCache.clear();
    await this.recordConfigAudit('signature.update', actorUserId, providerId, provider.provider_type, { signature_id: signatureId, sign_name: signName });
    return this.serializeSignature(rows[0]);
  }

  async deleteSignature(signatureId: string, actorUserId: string) {
    await this.ensureSmsSchema();
    const signature = await this.getSignatureRow(signatureId);
    const provider = await this.getProviderRow(signature.provider_id);
    await this.prisma.$executeRawUnsafe(`DELETE FROM platform_sms_signatures WHERE id = $1::uuid`, signatureId);
    this.routeCache.clear();
    await this.recordConfigAudit('signature.delete', actorUserId, signature.provider_id, provider.provider_type, { signature_id: signatureId, sign_name: signature.sign_name });
    return { success: true };
  }

  async listTemplates(query: { provider_id?: string }) {
    await this.ensureSmsSchema();
    const providerId = String(query.provider_id || '').trim();
    if (providerId) {
      await this.getProviderRow(providerId);
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT * FROM platform_sms_templates
         WHERE provider_id = $1::uuid
         ORDER BY is_default DESC, is_active DESC, updated_at DESC, created_at DESC`,
        providerId,
      ) as Promise<SmsTemplateRow[]>);
      return { items: rows.map((row) => this.serializeTemplate(row)) };
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM platform_sms_templates ORDER BY updated_at DESC, created_at DESC`,
    ) as Promise<SmsTemplateRow[]>);
    return { items: rows.map((row) => this.serializeTemplate(row)) };
  }

  async createTemplate(actorUserId: string, payload: {
    provider_id?: string;
    template_code?: string;
    code?: string;
    template_name?: string;
    name?: string;
    is_active?: boolean;
    is_default?: boolean;
    notes?: string;
    meta?: Record<string, unknown>;
  }) {
    await this.ensureSmsSchema();
    const providerId = String(payload.provider_id || '').trim();
    if (!providerId) throw new BadRequestException('provider_id is required');
    const provider = await this.getProviderRow(providerId);
    const templateCode = String(payload.template_code || payload.code || '').trim();
    if (!templateCode) throw new BadRequestException('template_code is required');
    const templateName = String(payload.template_name || payload.name || '').trim() || null;
    const isActive = payload.is_active !== false;
    const isDefault = !!payload.is_default;
    const notes = String(payload.notes || '').trim() || null;
    const metaJson = asPlainObject(payload.meta);
    const dupRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM platform_sms_templates WHERE provider_id = $1::uuid AND LOWER(template_code) = LOWER($2) LIMIT 1`,
      providerId,
      templateCode,
    ) as Promise<Array<{ id: string }>>);
    if (dupRows.length > 0) throw new BadRequestException('该短信模板已存在');
    if (isDefault) {
      await this.prisma.$executeRawUnsafe(`UPDATE platform_sms_templates SET is_default = false, updated_at = now() WHERE provider_id = $1::uuid`, providerId);
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO platform_sms_templates (
         id, provider_id, template_code, template_name, is_active, is_default, notes, meta_json, created_by_user_id, updated_by_user_id
       ) VALUES (
         gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid, $8::uuid
       )
       RETURNING *`,
      providerId,
      templateCode,
      templateName,
      isActive,
      isDefault,
      notes,
      JSON.stringify(metaJson),
      actorUserId,
    ) as Promise<SmsTemplateRow[]>);
    this.routeCache.clear();
    await this.recordConfigAudit('template.create', actorUserId, providerId, provider.provider_type, { template_id: rows[0].id, template_code: templateCode });
    return this.serializeTemplate(rows[0]);
  }

  async updateTemplate(templateId: string, actorUserId: string, payload: {
    provider_id?: string;
    template_code?: string;
    code?: string;
    template_name?: string;
    name?: string;
    is_active?: boolean;
    is_default?: boolean;
    notes?: string;
    meta?: Record<string, unknown>;
  }) {
    await this.ensureSmsSchema();
    const existing = await this.getTemplateRow(templateId);
    const providerId = payload.provider_id === undefined ? existing.provider_id : String(payload.provider_id || '').trim();
    if (!providerId) throw new BadRequestException('provider_id is required');
    const provider = await this.getProviderRow(providerId);
    const templateCode = payload.template_code === undefined && payload.code === undefined ? existing.template_code : String(payload.template_code || payload.code || '').trim();
    if (!templateCode) throw new BadRequestException('template_code is required');
    const templateName = payload.template_name === undefined && payload.name === undefined ? existing.template_name : String(payload.template_name || payload.name || '').trim() || null;
    const isActive = payload.is_active === undefined ? existing.is_active : !!payload.is_active;
    const isDefault = payload.is_default === undefined ? existing.is_default : !!payload.is_default;
    const notes = payload.notes === undefined ? existing.notes : String(payload.notes || '').trim() || null;
    const metaJson = payload.meta === undefined ? asPlainObject(existing.meta_json) : asPlainObject(payload.meta);
    const dupRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM platform_sms_templates
       WHERE provider_id = $1::uuid AND LOWER(template_code) = LOWER($2) AND id <> $3::uuid
       LIMIT 1`,
      providerId,
      templateCode,
      templateId,
    ) as Promise<Array<{ id: string }>>);
    if (dupRows.length > 0) throw new BadRequestException('该短信模板已存在');
    if (isDefault) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE platform_sms_templates SET is_default = false, updated_at = now()
         WHERE provider_id = $1::uuid AND id <> $2::uuid`,
        providerId,
        templateId,
      );
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE platform_sms_templates
       SET provider_id = $2::uuid,
           template_code = $3,
           template_name = $4,
           is_active = $5,
           is_default = $6,
           notes = $7,
           meta_json = $8::jsonb,
           updated_by_user_id = $9::uuid,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      templateId,
      providerId,
      templateCode,
      templateName,
      isActive,
      isDefault,
      notes,
      JSON.stringify(metaJson),
      actorUserId,
    ) as Promise<SmsTemplateRow[]>);
    this.routeCache.clear();
    await this.recordConfigAudit('template.update', actorUserId, providerId, provider.provider_type, { template_id: templateId, template_code: templateCode });
    return this.serializeTemplate(rows[0]);
  }

  async deleteTemplate(templateId: string, actorUserId: string) {
    await this.ensureSmsSchema();
    const template = await this.getTemplateRow(templateId);
    const provider = await this.getProviderRow(template.provider_id);
    await this.prisma.$executeRawUnsafe(`DELETE FROM platform_sms_templates WHERE id = $1::uuid`, templateId);
    this.routeCache.clear();
    await this.recordConfigAudit('template.delete', actorUserId, template.provider_id, provider.provider_type, { template_id: templateId, template_code: template.template_code });
    return { success: true };
  }

  async sendSmsCode(appSlug: string | undefined, phone: string) {
    const app = await this.resolveAppWithSettings(appSlug);
    return this.sendSmsCodeForResolvedApp(app, phone, 'login');
  }

  async sendSmsCodeForAppId(appId: string, phone: string, purpose: SmsSendPurpose = 'verification') {
    const app = await this.resolveAppByIdWithSettings(appId);
    return this.sendSmsCodeForResolvedApp(app, phone, purpose);
  }

  async sendSmsCodeForAppTest(input: {
    app_id?: string;
    app_slug?: string;
    phone: string;
    code?: string;
    persist_code?: boolean;
    respect_cooldown?: boolean;
  }) {
    const app = input.app_id ? await this.resolveAppByIdWithSettings(input.app_id) : await this.resolveAppWithSettings(input.app_slug || undefined);
    const normalizedPhone = this.normalizePhone(input.phone);
    const requestedCode = String(input.code || '').trim();
    const code = requestedCode ? this.normalizeSmsCode(requestedCode) : this.generateVerificationCode();
    await this.ensureSmsSchema();
    if (input.respect_cooldown === true) {
      await this.assertSmsSendCooldown(app.id, normalizedPhone);
    }
    const route = await this.resolveSmsRouteConfig(app);
    const traceId = randomUUID();
    await this.dispatchAndAudit({
      appId: app.id,
      phone: normalizedPhone,
      code,
      route,
      traceId,
      purpose: 'test',
    });
    if (input.persist_code === true) {
      await this.storeSmsCode({
        appId: app.id,
        phone: normalizedPhone,
        code,
        providerId: route.provider.id,
        signatureId: route.signature.id,
      });
    }
    return {
      message: 'Verification code sent',
      phone: normalizedPhone,
      dispatch_mode: this.resolveDispatchMode(route.provider),
      persisted: input.persist_code === true,
      provider_id: route.provider.id,
      provider_name: route.provider.name,
      provider_type: route.provider.provider_type,
      signature_id: route.signature.id,
      signature_name: route.signature.sign_name,
      template_id: route.template?.id || null,
      template_code: this.pickTemplateCode(route.template, asPlainObject(route.signature.meta_json), asPlainObject(route.provider.config_json)) || null,
      template_name: route.template?.template_name || null,
      trace_id: traceId,
    };
  }

  async verifySmsCodeForAppId(appId: string, phone: string, code: string) {
    const normalizedPhone = this.normalizePhone(phone);
    const normalizedCode = this.normalizeSmsCode(code);
    await this.ensureSmsSchema();
    await this.verifySmsCode(appId, normalizedPhone, normalizedCode);
    return { phone: normalizedPhone };
  }

  normalizeSmsPhone(phone: string) {
    return this.normalizePhone(phone);
  }

  normalizeSmsPhoneVariants(phone: string) {
    return this.buildPhoneIdentityVariants(this.normalizePhone(phone));
  }

  normalizeSmsVerificationCode(code: string) {
    return this.normalizeSmsCode(code);
  }

  async listEvents(query: {
    app_id?: string;
    provider_id?: string;
    provider_type?: string;
    status?: string;
    trace_id?: string;
    phone?: string;
    page?: string | number;
    page_size?: string | number;
  }) {
    await this.ensureSmsSchema();
    const pageSize = this.clampInteger(query.page_size, 20, 1, 100);
    const page = this.clampInteger(query.page, 1, 1, 100000);
    const offset = (page - 1) * pageSize;
    const where: string[] = [];
    const params: unknown[] = [];
    const push = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (query.app_id) push('app_id = ?::uuid', String(query.app_id).trim());
    if (query.provider_id) push('provider_id = ?::uuid', String(query.provider_id).trim());
    if (query.provider_type) push('provider_type = ?', String(query.provider_type).trim().toUpperCase());
    if (query.status) push('status = ?', String(query.status).trim().toUpperCase());
    if (query.trace_id) push('trace_id = ?', String(query.trace_id).trim());
    if (query.phone) push('phone_hash = ?', this.hashPhone(this.normalizePhone(String(query.phone))));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_sms_message_events
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      ...params,
      pageSize,
      offset,
    ) as Promise<Array<Record<string, unknown>>>);
    const totalRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM platform_sms_message_events ${whereSql}`,
      ...params,
    ) as Promise<Array<{ count: number }>>);
    return {
      items: rows.map((row) => this.serializeEvent(row)),
      page,
      page_size: pageSize,
      total: Number(totalRows[0]?.count || 0),
    };
  }

  async getSummary(query: { app_id?: string; hours?: string | number }) {
    await this.ensureSmsSchema();
    const hours = this.clampInteger(query.hours, 24, 1, 24 * 30);
    const appId = String(query.app_id || '').trim();
    const params: unknown[] = [hours];
    const appClause = appId ? `AND app_id = $2::uuid` : '';
    if (appId) params.push(appId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT provider_type,
              status,
              COUNT(*)::int AS count,
              COALESCE(ROUND(AVG(duration_ms))::int, 0) AS avg_duration_ms,
              COALESCE(MAX(duration_ms), 0)::int AS max_duration_ms
       FROM platform_sms_message_events
       WHERE created_at >= now() - ($1::int * interval '1 hour')
         ${appClause}
       GROUP BY provider_type, status
       ORDER BY provider_type ASC, status ASC`,
      ...params,
    ) as Promise<Array<Record<string, unknown>>>);
    return { hours, items: rows };
  }

  private async sendSmsCodeForResolvedApp(app: AppWithSettings, phone: string, purpose: SmsSendPurpose) {
    const normalizedPhone = this.normalizePhone(phone);
    await this.ensureSmsSchema();
    const [route] = await Promise.all([
      this.resolveSmsRouteConfig(app),
      this.assertSmsSendCooldown(app.id, normalizedPhone),
    ]);
    const code = this.generateVerificationCode();
    const dispatchMode = this.resolveDispatchMode(route.provider);
    const traceId = randomUUID();
    if (dispatchMode === 'ASYNC') {
      await this.storeSmsCode({
        appId: app.id,
        phone: normalizedPhone,
        code,
        providerId: route.provider.id,
        signatureId: route.signature.id,
      });
      void this.dispatchAndAudit({
        appId: app.id,
        phone: normalizedPhone,
        code,
        route,
        traceId,
        purpose,
      }).catch(async (error) => {
        this.logger.error(`async sms dispatch failed app=${app.id} provider=${route.provider.id} trace=${traceId}: ${error instanceof Error ? error.message : 'unknown'}`);
        await this.deleteSmsCode({ appId: app.id, phone: normalizedPhone, code });
      });
    } else {
      await this.dispatchAndAudit({
        appId: app.id,
        phone: normalizedPhone,
        code,
        route,
        traceId,
        purpose,
      });
      await this.storeSmsCode({
        appId: app.id,
        phone: normalizedPhone,
        code,
        providerId: route.provider.id,
        signatureId: route.signature.id,
      });
    }
    return {
      message: 'Verification code sent',
      phone: normalizedPhone,
      resend_after_seconds: 60,
      expires_in_seconds: 300,
      dispatch_mode: dispatchMode,
      trace_id: traceId,
    };
  }

  private async dispatchAndAudit(input: {
    appId: string;
    phone: string;
    code: string;
    route: SmsRouteConfigResolved;
    traceId: string;
    purpose: SmsSendPurpose;
  }) {
    const startedAt = Date.now();
    try {
      const result = await this.dispatchSmsCode(input.route.provider, input.route.signature, input.route.template, input.phone, input.code);
      await this.recordMessageEvent({
        appId: input.appId,
        phone: input.phone,
        route: input.route,
        traceId: input.traceId,
        purpose: input.purpose,
        status: 'SUCCESS',
        durationMs: Date.now() - startedAt,
        result,
      });
      return result;
    } catch (error) {
      await this.recordMessageEvent({
        appId: input.appId,
        phone: input.phone,
        route: input.route,
        traceId: input.traceId,
        purpose: input.purpose,
        status: 'FAILED',
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  private async dispatchSmsCode(
    provider: SmsProviderRow,
    signature: SmsSignatureRow,
    template: SmsTemplateRow | null,
    phone: string,
    code: string,
  ): Promise<SmsDispatchResult> {
    switch (provider.provider_type) {
      case 'GENERIC_API':
        return this.dispatchGenericApi(provider, signature, template, phone, code);
      case 'ALIYUN_SMS':
        return this.dispatchAliyun(provider, signature, template, phone, code);
      case 'TENCENT_SMS':
        return this.dispatchTencent(provider, signature, template, phone, code);
      case 'HUAWEI_SMS':
        return this.dispatchHuawei(provider, signature, template, phone, code);
      case 'VOLCENGINE_SMS':
        return this.dispatchVolcengine(provider, signature, template, phone, code);
      case 'TWILIO_SMS':
        return this.dispatchTwilio(provider, template, phone, code);
      case 'VONAGE_SMS':
        return this.dispatchVonage(provider, template, phone, code);
      case 'MESSAGEBIRD_SMS':
        return this.dispatchMessageBird(provider, template, phone, code);
      case 'PLIVO_SMS':
        return this.dispatchPlivo(provider, template, phone, code);
      case 'AWS_SNS':
        return this.dispatchAwsSns(provider, template, phone, code);
      default:
        throw new BadRequestException(`unsupported sms provider type: ${(provider as SmsProviderRow).provider_type}`);
    }
  }

  private async dispatchGenericApi(provider: SmsProviderRow, signature: SmsSignatureRow, template: SmsTemplateRow | null, phone: string, code: string): Promise<SmsDispatchResult> {
    const cfg = asPlainObject(provider.config_json);
    const endpointUrl = String(cfg.endpoint_url || '').trim();
    if (!endpointUrl) throw new BadRequestException('通用短信配置缺少 endpoint_url');
    const method = String(cfg.http_method || 'POST').trim().toUpperCase() === 'GET' ? 'GET' : 'POST';
    const contentType = String(cfg.content_type || 'JSON').trim().toUpperCase() === 'FORM' ? 'FORM' : 'JSON';
    const timeoutMs = this.clampTimeout(cfg.timeout_ms ?? 15000);
    const payload = this.buildTemplatePayload(provider, signature, template, phone, code);
    const headers = this.buildGenericHeaders(cfg);
    let requestUrl = endpointUrl;
    let body: string | undefined;
    if (method === 'GET') {
      const url = new URL(endpointUrl);
      Object.entries(payload).forEach(([key, value]) => url.searchParams.set(key, value));
      requestUrl = url.toString();
    } else if (contentType === 'FORM') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(payload).toString();
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload);
    }
    const response = await this.fetchOrThrow(requestUrl, {
      method,
      headers,
      body: method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(timeoutMs),
    }, `通用短信服务(${provider.name})`, timeoutMs);
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw new BadRequestException(`短信服务请求失败(${response.status})${text ? `: ${text}` : ''}`);
    }
    return { ok: true, status_code: response.status, request_url: requestUrl };
  }

  private async dispatchAliyun(provider: SmsProviderRow, signature: SmsSignatureRow, template: SmsTemplateRow | null, phone: string, code: string): Promise<SmsDispatchResult> {
    const cfg = asPlainObject(provider.config_json);
    const accessKeyId = String(cfg.access_key_id || '').trim();
    const accessKeySecret = String(cfg.access_key_secret || '').trim();
    if (!accessKeyId || !accessKeySecret) throw new BadRequestException('阿里云短信配置缺少 access_key_id 或 access_key_secret');
    const signName = String(signature.sign_name || '').trim();
    const templateCode = this.pickTemplateCode(template, asPlainObject(signature.meta_json), cfg);
    if (!signName || !templateCode) throw new BadRequestException('阿里云短信签名或模板未配置');
    const endpointUrl = String(cfg.endpoint_url || '').trim() || 'https://dysmsapi.aliyuncs.com/';
    const templateParams = { ...this.pickTemplateVariables(template), code };
    const query: Record<string, string> = {
      AccessKeyId: accessKeyId,
      Action: 'SendSms',
      Format: 'JSON',
      PhoneNumbers: phone,
      RegionId: String(cfg.region_id || '').trim() || 'cn-hangzhou',
      SignName: signName,
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: randomUUID(),
      SignatureVersion: '1.0',
      TemplateCode: templateCode,
      TemplateParam: JSON.stringify(templateParams),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2017-05-25',
    };
    const signedUrl = this.buildAliyunSignedUrl(endpointUrl, query, accessKeySecret);
    const timeoutMs = this.clampTimeout(cfg.timeout_ms ?? 15000);
    const response = await this.fetchOrThrow(signedUrl, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) }, `阿里云短信服务(${provider.name})`, timeoutMs);
    const payload = await this.parseJsonResponse(response);
    if (!response.ok) {
      throw new BadRequestException(`阿里云短信请求失败(${response.status})：${this.pickProviderError(payload)}`);
    }
    const responseCode = String(payload.Code || '').trim().toUpperCase();
    if (responseCode && responseCode !== 'OK') {
      throw new BadRequestException(`阿里云短信发送失败：${responseCode}${payload.Message ? ` ${payload.Message}` : ''}`);
    }
    return { ok: true, status_code: response.status, response_code: responseCode || 'OK', raw_response: payload };
  }

  private async dispatchTencent(provider: SmsProviderRow, signature: SmsSignatureRow, template: SmsTemplateRow | null, phone: string, code: string): Promise<SmsDispatchResult> {
    const cfg = asPlainObject(provider.config_json);
    const secretId = String(cfg.secret_id || '').trim();
    const secretKey = String(cfg.secret_key || '').trim();
    const sdkAppId = String(cfg.sdk_app_id || '').trim();
    const templateId = this.pickTemplateCode(template, asPlainObject(signature.meta_json), cfg);
    if (!secretId || !secretKey || !sdkAppId || !templateId) throw new BadRequestException('腾讯云短信配置缺少 secret_id / secret_key / sdk_app_id / template');
    const host = 'sms.tencentcloudapi.com';
    const endpoint = String(cfg.endpoint_url || '').trim() || `https://${host}`;
    const body = JSON.stringify({
      SmsSdkAppId: sdkAppId,
      SignName: signature.sign_name,
      TemplateId: templateId,
      TemplateParamSet: this.resolveOrderedTemplateParams(template, code),
      PhoneNumberSet: [phone],
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const hashedRequestPayload = createHash('sha256').update(body).digest('hex');
    const canonicalRequest = ['POST', '/', '', `content-type:application/json; charset=utf-8\nhost:${host}\n`, 'content-type;host', hashedRequestPayload].join('\n');
    const credentialScope = `${date}/sms/tc3_request`;
    const stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    const secretDate = createHmac('sha256', `TC3${secretKey}`).update(date).digest();
    const secretService = createHmac('sha256', secretDate).update('sms').digest();
    const secretSigning = createHmac('sha256', secretService).update('tc3_request').digest();
    const signatureHex = createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
    const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signatureHex}`;
    const timeoutMs = this.clampTimeout(cfg.timeout_ms ?? 15000);
    const response = await this.fetchOrThrow(endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        'X-TC-Action': 'SendSms',
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': '2021-01-11',
        'X-TC-Region': String(cfg.region_id || '').trim() || 'ap-guangzhou',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    }, `腾讯云短信服务(${provider.name})`, timeoutMs);
    const payload = await this.parseJsonResponse(response);
    if (!response.ok || payload.Response?.Error) {
      throw new BadRequestException(`腾讯云短信发送失败：${this.pickProviderError(payload.Response?.Error || payload)}`);
    }
    return { ok: true, status_code: response.status, raw_response: payload };
  }

  private async dispatchHuawei(provider: SmsProviderRow, signature: SmsSignatureRow, template: SmsTemplateRow | null, phone: string, code: string): Promise<SmsDispatchResult> {
    const cfg = asPlainObject(provider.config_json);
    const endpointUrl = String(cfg.endpoint_url || '').trim();
    const appKey = String(cfg.app_key || '').trim();
    const appSecret = String(cfg.app_secret || '').trim();
    const sender = String(cfg.sender || '').trim();
    const templateId = this.pickTemplateCode(template, asPlainObject(signature.meta_json), cfg);
    if (!endpointUrl || !appKey || !appSecret || !sender || !templateId) throw new BadRequestException('华为云短信配置缺少 endpoint_url / app_key / app_secret / sender / template');
    const nonce = randomUUID().replace(/-/g, '');
    const created = new Date().toISOString();
    const digest = createHash('sha256').update(Buffer.concat([Buffer.from(nonce), Buffer.from(created), Buffer.from(appSecret)])).digest('base64');
    const headers = {
      Authorization: `WSSE realm="SDP",profile="UsernameToken",type="Appkey"`,
      'X-WSSE': `UsernameToken Username="${appKey}",PasswordDigest="${digest}",Nonce="${nonce}",Created="${created}"`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    const params = new URLSearchParams({
      from: sender,
      to: phone,
      templateId,
      templateParas: JSON.stringify(this.resolveOrderedTemplateParams(template, code)),
      signature: signature.sign_name,
    });
    const callback = String(cfg.status_callback || '').trim();
    if (callback) params.set('statusCallback', callback);
    const timeoutMs = this.clampTimeout(cfg.timeout_ms ?? 15000);
    const response = await this.fetchOrThrow(endpointUrl, { method: 'POST', headers, body: params.toString(), signal: AbortSignal.timeout(timeoutMs) }, `华为云短信服务(${provider.name})`, timeoutMs);
    const payload = await this.parseJsonResponse(response);
    if (!response.ok || (payload.code && String(payload.code) !== '000000')) {
      throw new BadRequestException(`华为云短信发送失败：${this.pickProviderError(payload)}`);
    }
    return { ok: true, status_code: response.status, response_code: String(payload.code || ''), raw_response: payload };
  }

  private async dispatchVolcengine(provider: SmsProviderRow, signature: SmsSignatureRow, template: SmsTemplateRow | null, phone: string, code: string): Promise<SmsDispatchResult> {
    const cfg = asPlainObject(provider.config_json);
    const accessKeyId = String(cfg.access_key_id || '').trim();
    const secretKey = String(cfg.access_key_secret || '').trim();
    const smsAccount = String(cfg.sms_account || '').trim();
    const templateId = this.pickTemplateCode(template, asPlainObject(signature.meta_json), cfg);
    if (!accessKeyId || !secretKey || !smsAccount || !templateId) throw new BadRequestException('火山引擎短信配置缺少 access_key_id / access_key_secret / sms_account / template');
    const endpoint = String(cfg.endpoint_url || '').trim() || 'https://sms.volcengineapi.com';
    const region = String(cfg.region_id || '').trim() || 'cn-north-1';
    const body = JSON.stringify({
      SmsAccount: smsAccount,
      Sign: signature.sign_name,
      TemplateID: templateId,
      TemplateParam: JSON.stringify({ ...this.pickTemplateVariables(template), code }),
      PhoneNumbers: phone,
    });
    const url = new URL(endpoint);
    url.searchParams.set('Action', 'SendSms');
    url.searchParams.set('Version', '2020-01-01');
    const timeoutMs = this.clampTimeout(cfg.timeout_ms ?? 15000);
    const headers = this.buildAwsV4Headers({
      method: 'POST',
      url,
      body,
      accessKeyId,
      secretKey,
      region,
      service: 'volcSMS',
      contentType: 'application/json',
    });
    const response = await this.fetchOrThrow(url.toString(), { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) }, `火山引擎短信服务(${provider.name})`, timeoutMs);
    const payload = await this.parseJsonResponse(response);
    if (!response.ok || payload.ResponseMetadata?.Error) {
      throw new BadRequestException(`火山引擎短信发送失败：${this.pickProviderError(payload.ResponseMetadata?.Error || payload)}`);
    }
    return { ok: true, status_code: response.status, raw_response: payload };
  }

  private async dispatchTwilio(provider: SmsProviderRow, template: SmsTemplateRow | null, phone: string, code: string): Promise<SmsDispatchResult> {
    const cfg = asPlainObject(provider.config_json);
    const sid = String(cfg.account_sid || '').trim();
    const token = String(cfg.auth_token || '').trim();
    if (!sid || !token) throw new BadRequestException('Twilio 配置缺少 account_sid 或 auth_token');
    const endpoint = String(cfg.endpoint_url || '').trim() || `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
    const bodyText = this.renderTemplateMessage(template, code);
    const form = new URLSearchParams({ To: phone, Body: bodyText });
    const from = String(cfg.from || '').trim();
    const messagingServiceSid = String(cfg.messaging_service_sid || '').trim();
    if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
    else if (from) form.set('From', from);
    else throw new BadRequestException('Twilio 配置缺少 from 或 messaging_service_sid');
    const timeoutMs = this.clampTimeout(cfg.timeout_ms ?? 15000);
    const response = await this.fetchOrThrow(endpoint, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    }, `Twilio短信服务(${provider.name})`, timeoutMs);
    const payload = await this.parseJsonResponse(response);
    if (!response.ok) throw new BadRequestException(`Twilio短信发送失败：${this.pickProviderError(payload)}`);
    return { ok: true, status_code: response.status, provider_message_id: String(payload.sid || ''), raw_response: payload };
  }

  private async dispatchVonage(provider: SmsProviderRow, template: SmsTemplateRow | null, phone: string, code: string): Promise<SmsDispatchResult> {
    const cfg = asPlainObject(provider.config_json);
    const apiKey = String(cfg.api_key || '').trim();
    const apiSecret = String(cfg.api_secret || '').trim();
    const from = String(cfg.from || '').trim();
    if (!apiKey || !apiSecret || !from) throw new BadRequestException('Vonage 配置缺少 api_key / api_secret / from');
    const endpoint = String(cfg.endpoint_url || '').trim() || 'https://rest.nexmo.com/sms/json';
    const timeoutMs = this.clampTimeout(cfg.timeout_ms ?? 15000);
    const response = await this.fetchOrThrow(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, api_secret: apiSecret, from, to: phone.replace(/^\+/, ''), text: this.renderTemplateMessage(template, code) }),
      signal: AbortSignal.timeout(timeoutMs),
    }, `Vonage短信服务(${provider.name})`, timeoutMs);
    const payload = await this.parseJsonResponse(response);
    const first = Array.isArray(payload.messages) ? payload.messages[0] : null;
    if (!response.ok || (first && String(first.status) !== '0')) throw new BadRequestException(`Vonage短信发送失败：${this.pickProviderError(first || payload)}`);
    return { ok: true, status_code: response.status, provider_message_id: String(first?.['message-id'] || ''), raw_response: payload };
  }

  private async dispatchMessageBird(provider: SmsProviderRow, template: SmsTemplateRow | null, phone: string, code: string): Promise<SmsDispatchResult> {
    const cfg = asPlainObject(provider.config_json);
    const accessKey = String(cfg.access_key || '').trim();
    const originator = String(cfg.originator || cfg.from || '').trim();
    if (!accessKey || !originator) throw new BadRequestException('MessageBird 配置缺少 access_key 或 originator');
    const endpoint = String(cfg.endpoint_url || '').trim() || 'https://rest.messagebird.com/messages';
    const timeoutMs = this.clampTimeout(cfg.timeout_ms ?? 15000);
    const response = await this.fetchOrThrow(endpoint, {
      method: 'POST',
      headers: { Authorization: `AccessKey ${accessKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ originator, recipients: [phone.replace(/^\+/, '')], body: this.renderTemplateMessage(template, code) }),
      signal: AbortSignal.timeout(timeoutMs),
    }, `MessageBird短信服务(${provider.name})`, timeoutMs);
    const payload = await this.parseJsonResponse(response);
    if (!response.ok) throw new BadRequestException(`MessageBird短信发送失败：${this.pickProviderError(payload)}`);
    return { ok: true, status_code: response.status, provider_message_id: String(payload.id || ''), raw_response: payload };
  }

  private async dispatchPlivo(provider: SmsProviderRow, template: SmsTemplateRow | null, phone: string, code: string): Promise<SmsDispatchResult> {
    const cfg = asPlainObject(provider.config_json);
    const authId = String(cfg.auth_id || '').trim();
    const authToken = String(cfg.auth_token || '').trim();
    const src = String(cfg.src || cfg.from || '').trim();
    if (!authId || !authToken || !src) throw new BadRequestException('Plivo 配置缺少 auth_id / auth_token / src');
    const endpoint = String(cfg.endpoint_url || '').trim() || `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/Message/`;
    const timeoutMs = this.clampTimeout(cfg.timeout_ms ?? 15000);
    const response = await this.fetchOrThrow(endpoint, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${authId}:${authToken}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ src, dst: phone.replace(/^\+/, ''), text: this.renderTemplateMessage(template, code) }),
      signal: AbortSignal.timeout(timeoutMs),
    }, `Plivo短信服务(${provider.name})`, timeoutMs);
    const payload = await this.parseJsonResponse(response);
    if (!response.ok) throw new BadRequestException(`Plivo短信发送失败：${this.pickProviderError(payload)}`);
    const messageUuid = Array.isArray(payload.message_uuid) ? payload.message_uuid[0] : payload.message_uuid;
    return { ok: true, status_code: response.status, provider_message_id: String(messageUuid || ''), raw_response: payload };
  }

  private async dispatchAwsSns(provider: SmsProviderRow, template: SmsTemplateRow | null, phone: string, code: string): Promise<SmsDispatchResult> {
    const cfg = asPlainObject(provider.config_json);
    const accessKeyId = String(cfg.access_key_id || '').trim();
    const secretKey = String(cfg.secret_access_key || cfg.access_key_secret || '').trim();
    const region = String(cfg.region_id || '').trim();
    if (!accessKeyId || !secretKey || !region) throw new BadRequestException('AWS SNS 配置缺少 access_key_id / secret_access_key / region_id');
    const endpoint = String(cfg.endpoint_url || '').trim() || `https://sns.${region}.amazonaws.com/`;
    const url = new URL(endpoint);
    const form = new URLSearchParams({
      Action: 'Publish',
      Version: '2010-03-31',
      PhoneNumber: phone,
      Message: this.renderTemplateMessage(template, code),
    });
    const senderId = String(cfg.sender_id || '').trim();
    if (senderId) {
      form.set('MessageAttributes.entry.1.Name', 'AWS.SNS.SMS.SenderID');
      form.set('MessageAttributes.entry.1.Value.DataType', 'String');
      form.set('MessageAttributes.entry.1.Value.StringValue', senderId);
    }
    const body = form.toString();
    const headers = this.buildAwsV4Headers({
      method: 'POST',
      url,
      body,
      accessKeyId,
      secretKey,
      region,
      service: 'sns',
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
    });
    const timeoutMs = this.clampTimeout(cfg.timeout_ms ?? 15000);
    const response = await this.fetchOrThrow(url.toString(), { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) }, `AWS SNS短信服务(${provider.name})`, timeoutMs);
    const text = await response.text();
    if (!response.ok) throw new BadRequestException(`AWS SNS短信发送失败(${response.status})：${text.slice(0, 300)}`);
    return { ok: true, status_code: response.status, raw_response: text.slice(0, 1000) };
  }

  private async resolveSmsRouteConfig(app: AppWithSettings): Promise<SmsRouteConfigResolved> {
    const routeConfig = this.extractAppSmsRouteConfig(app.settings?.extraJson);
    const cacheKey = [app.id, routeConfig.sms_provider_ref_id || '-', routeConfig.sms_signature_ref_id || '-', routeConfig.sms_template_ref_id || '-'].join('|');
    const cached = this.routeCache.get(cacheKey);
    if (cached && cached.expires_at > Date.now()) return cached.value;

    const providerRowsRaw = await (this.prisma.$queryRawUnsafe(
      `SELECT id, provider_type, name, is_active, is_default, config_json, notes, created_by_user_id, updated_by_user_id, created_at, updated_at
       FROM platform_sms_providers
       WHERE is_active = true
       ORDER BY is_default DESC, updated_at DESC, created_at DESC`,
    ) as Promise<SmsProviderRow[]>);
    const providerRows = providerRowsRaw
      .filter((row) => this.parseBooleanLike(asPlainObject(row.config_json).enabled, true))
      .map((row) => ({ ...row, provider_type: this.parseProviderType(row.provider_type) }));
    if (!providerRows.length) throw new BadRequestException('短信服务未启用，请在平台后台开启一个短信服务');

    let template: SmsTemplateRow | null = null;
    if (routeConfig.sms_template_ref_id) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT * FROM platform_sms_templates WHERE id = $1::uuid LIMIT 1`,
        routeConfig.sms_template_ref_id,
      ) as Promise<SmsTemplateRow[]>);
      template = rows[0] || null;
      if (!template) throw new BadRequestException('当前应用配置的验证码模板不存在，请重新选择');
      if (!template.is_active) throw new BadRequestException('当前应用配置的验证码模板未启用，请重新选择');
    }

    let provider: SmsProviderRow | undefined;
    if (routeConfig.sms_provider_ref_id) {
      provider = providerRows.find((row) => row.id === routeConfig.sms_provider_ref_id);
      if (!provider) throw new BadRequestException('当前应用配置的短信服务不可用，请重新选择');
    }
    if (!provider && template) {
      provider = providerRows.find((row) => row.id === template!.provider_id);
      if (!provider) throw new BadRequestException('当前应用验证码模板所属短信服务不可用，请重新选择模板');
    }
    if (!provider) provider = providerRows[0];
    if (template && template.provider_id !== provider.id) throw new BadRequestException('验证码模板与短信服务不匹配，请重新配置应用短信模板');

    let signature: SmsSignatureRow | null = null;
    if (routeConfig.sms_signature_ref_id) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT * FROM platform_sms_signatures WHERE id = $1::uuid AND provider_id = $2::uuid LIMIT 1`,
        routeConfig.sms_signature_ref_id,
        provider.id,
      ) as Promise<SmsSignatureRow[]>);
      signature = rows[0] || null;
      if (!signature) throw new BadRequestException('当前应用配置的短信签名不可用，请重新选择');
      if (!signature.is_active) throw new BadRequestException('当前应用配置的短信签名未启用，请重新选择');
    }
    if (!signature) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT * FROM platform_sms_signatures
         WHERE provider_id = $1::uuid AND is_active = true
         ORDER BY is_default DESC, updated_at DESC, created_at DESC`,
        provider.id,
      ) as Promise<SmsSignatureRow[]>);
      signature = rows[0] || null;
    }
    if (!signature) throw new BadRequestException('短信签名未配置，请先创建并启用短信签名');

    if (!template) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT * FROM platform_sms_templates
         WHERE provider_id = $1::uuid AND is_active = true
         ORDER BY is_default DESC, updated_at DESC, created_at DESC`,
        provider.id,
      ) as Promise<SmsTemplateRow[]>);
      template = rows[0] || null;
    }
    const resolved = { provider, signature, template };
    this.routeCache.set(cacheKey, { expires_at: Date.now() + this.routeCacheTtlMs, value: resolved });
    return resolved;
  }

  private async ensureSmsSchema() {
    if (!this.smsSchemaEnsured) {
      this.smsSchemaEnsured = this.initializeSmsSchema().catch((error) => {
        this.smsSchemaEnsured = null;
        throw error;
      });
    }
    await this.smsSchemaEnsured;
  }

  private async initializeSmsSchema() {
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS platform_sms_providers (
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
    await this.prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_providers_name_unique ON platform_sms_providers(LOWER(name))`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_platform_sms_providers_type ON platform_sms_providers(provider_type, is_default DESC, is_active DESC, updated_at DESC)`);
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_providers_default_unique
       ON platform_sms_providers((is_default))
       WHERE is_default = true`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS platform_sms_signatures (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         provider_id uuid NOT NULL REFERENCES platform_sms_providers(id) ON DELETE RESTRICT,
         sign_name varchar(128) NOT NULL,
         is_active boolean NOT NULL DEFAULT true,
         is_default boolean NOT NULL DEFAULT false,
         notes text NULL,
         meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
         created_by_user_id uuid NULL,
         updated_by_user_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_signatures_name_unique ON platform_sms_signatures(provider_id, LOWER(sign_name))`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_platform_sms_signatures_provider ON platform_sms_signatures(provider_id, is_default DESC, is_active DESC, updated_at DESC)`);
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_signatures_default_unique
       ON platform_sms_signatures(provider_id)
       WHERE is_default = true`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS platform_sms_templates (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         provider_id uuid NOT NULL REFERENCES platform_sms_providers(id) ON DELETE RESTRICT,
         template_code varchar(128) NOT NULL,
         template_name varchar(128) NULL,
         is_active boolean NOT NULL DEFAULT true,
         is_default boolean NOT NULL DEFAULT false,
         notes text NULL,
         meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
         created_by_user_id uuid NULL,
         updated_by_user_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_templates_code_unique ON platform_sms_templates(provider_id, LOWER(template_code))`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_platform_sms_templates_provider ON platform_sms_templates(provider_id, is_default DESC, is_active DESC, updated_at DESC)`);
    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_sms_templates_default_unique
       ON platform_sms_templates(provider_id)
       WHERE is_default = true`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS auth_sms_verification_codes (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         app_id uuid NOT NULL,
         phone varchar(32) NOT NULL,
         code_hash varchar(128) NOT NULL,
         provider_id uuid NULL,
         signature_id uuid NULL,
         expire_at timestamptz NOT NULL,
         consumed_at timestamptz NULL,
         attempt_count integer NOT NULL DEFAULT 0,
         max_attempts integer NOT NULL DEFAULT 5,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_auth_sms_codes_lookup ON auth_sms_verification_codes(app_id, phone, created_at DESC)`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_auth_sms_codes_expire ON auth_sms_verification_codes(expire_at DESC)`);
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS platform_sms_message_events (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         trace_id varchar(64) NOT NULL,
         app_id uuid NULL,
         purpose varchar(32) NOT NULL,
         provider_id uuid NULL,
         provider_type varchar(32) NOT NULL,
         provider_name varchar(128) NULL,
         signature_id uuid NULL,
         signature_name varchar(128) NULL,
         template_id uuid NULL,
         template_code varchar(128) NULL,
         dispatch_mode varchar(16) NOT NULL,
         phone_hash varchar(128) NULL,
         phone_masked varchar(32) NULL,
         status varchar(32) NOT NULL,
         status_code integer NULL,
         response_code varchar(128) NULL,
         response_message text NULL,
         provider_message_id varchar(255) NULL,
         duration_ms integer NOT NULL DEFAULT 0,
         error_json jsonb NULL,
         response_json jsonb NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_platform_sms_events_created ON platform_sms_message_events(created_at DESC)`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_platform_sms_events_app ON platform_sms_message_events(app_id, created_at DESC)`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_platform_sms_events_provider ON platform_sms_message_events(provider_id, created_at DESC)`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_platform_sms_events_trace ON platform_sms_message_events(trace_id)`);
  }

  private normalizeProviderConfig(providerType: SmsProviderType, config: Record<string, unknown>) {
    const raw = asPlainObject(config);
    const timeoutMs = this.clampTimeout(raw.timeout_ms ?? 10000);
    const dispatchModeRaw = String(raw.dispatch_mode || '').trim().toUpperCase();
    const dispatchMode = dispatchModeRaw === 'SYNC' || dispatchModeRaw === 'ASYNC' ? dispatchModeRaw : this.defaultDispatchMode(providerType);
    const base = {
      enabled: this.parseBooleanLike(raw.enabled, true),
      timeout_ms: timeoutMs,
      dispatch_mode: dispatchMode,
    };
    if (providerType === 'GENERIC_API') {
      const methodRaw = String(raw.http_method || 'POST').trim().toUpperCase();
      const authTypeRaw = String(raw.auth_type || 'NONE').trim().toUpperCase();
      return {
        ...base,
        endpoint_url: String(raw.endpoint_url || '').trim(),
        http_method: methodRaw === 'GET' ? 'GET' : 'POST',
        auth_type: authTypeRaw === 'BEARER' || authTypeRaw === 'API_KEY' ? authTypeRaw : 'NONE',
        auth_header_name: String(raw.auth_header_name || '').trim() || 'Authorization',
        auth_token: String(raw.auth_token || '').trim(),
        api_key: String(raw.api_key || '').trim(),
        content_type: String(raw.content_type || 'JSON').trim().toUpperCase() === 'FORM' ? 'FORM' : 'JSON',
        phone_field: String(raw.phone_field || '').trim() || 'phone',
        code_field: String(raw.code_field || '').trim() || 'code',
        sign_field: String(raw.sign_field || '').trim() || 'sign_name',
        template_field: String(raw.template_field || '').trim() || 'template_code',
      };
    }
    const shared = {
      ...base,
      endpoint_url: String(raw.endpoint_url || '').trim(),
      region_id: String(raw.region_id || '').trim(),
      access_key_id: String(raw.access_key_id || '').trim(),
      access_key_secret: String(raw.access_key_secret || '').trim(),
      secret_id: String(raw.secret_id || '').trim(),
      secret_key: String(raw.secret_key || '').trim(),
      sdk_app_id: String(raw.sdk_app_id || '').trim(),
      app_key: String(raw.app_key || '').trim(),
      app_secret: String(raw.app_secret || '').trim(),
      sender: String(raw.sender || '').trim(),
      sms_account: String(raw.sms_account || '').trim(),
      account_sid: String(raw.account_sid || '').trim(),
      auth_token: String(raw.auth_token || '').trim(),
      from: String(raw.from || '').trim(),
      messaging_service_sid: String(raw.messaging_service_sid || '').trim(),
      api_key: String(raw.api_key || '').trim(),
      api_secret: String(raw.api_secret || '').trim(),
      access_key: String(raw.access_key || '').trim(),
      originator: String(raw.originator || '').trim(),
      auth_id: String(raw.auth_id || '').trim(),
      src: String(raw.src || '').trim(),
      secret_access_key: String(raw.secret_access_key || '').trim(),
      sender_id: String(raw.sender_id || '').trim(),
      status_callback: String(raw.status_callback || '').trim(),
    };
    if (providerType === 'ALIYUN_SMS') return { ...shared, endpoint_url: shared.endpoint_url || 'https://dysmsapi.aliyuncs.com/', region_id: shared.region_id || 'cn-hangzhou' };
    if (providerType === 'TENCENT_SMS') return { ...shared, endpoint_url: shared.endpoint_url || 'https://sms.tencentcloudapi.com', region_id: shared.region_id || 'ap-guangzhou' };
    if (providerType === 'VOLCENGINE_SMS') return { ...shared, endpoint_url: shared.endpoint_url || 'https://sms.volcengineapi.com', region_id: shared.region_id || 'cn-north-1' };
    if (providerType === 'VONAGE_SMS') return { ...shared, endpoint_url: shared.endpoint_url || 'https://rest.nexmo.com/sms/json' };
    if (providerType === 'MESSAGEBIRD_SMS') return { ...shared, endpoint_url: shared.endpoint_url || 'https://rest.messagebird.com/messages' };
    return shared;
  }

  private mergeProviderConfigForUpdate(providerType: SmsProviderType, existingConfig: unknown, payloadConfig: unknown) {
    const existing = asPlainObject(existingConfig);
    const incoming = asPlainObject(payloadConfig);
    const preserveSecret = (key: string) => {
      if (Object.prototype.hasOwnProperty.call(incoming, key) && !String(incoming[key] || '').trim()) {
        delete incoming[key];
      }
    };
    [
      'auth_token',
      'api_key',
      'access_key_secret',
      'secret_key',
      'app_secret',
      'account_sid',
      'api_secret',
      'access_key',
      'auth_id',
      'secret_access_key',
    ].forEach(preserveSecret);
    return this.normalizeProviderConfig(providerType, { ...existing, ...incoming });
  }

  private assertProviderConfig(providerType: SmsProviderType, config: Record<string, unknown>) {
    if (!this.parseBooleanLike(config.enabled, true)) return;
    const required = SMS_PROVIDER_CATALOG.find((item) => item.provider_type === providerType)?.required_config || [];
    const missing = required.filter((field) => !String(config[field] || '').trim());
    if (missing.length > 0) {
      throw new BadRequestException(`${this.providerLabel(providerType)}配置缺失：enabled=true 时必须填写 ${missing.join(' / ')}`);
    }
  }

  private serializeProvider(row: SmsProviderRow) {
    const cfg = asPlainObject(row.config_json);
    return {
      id: row.id,
      provider_type: row.provider_type,
      provider_label: this.providerLabel(row.provider_type),
      name: row.name,
      is_active: row.is_active,
      is_default: row.is_default,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
      config: this.maskProviderConfig(row.provider_type, cfg),
    };
  }

  private serializeSignature(row: SmsSignatureRow) {
    return {
      id: row.id,
      provider_id: row.provider_id,
      sign_name: row.sign_name,
      is_active: row.is_active,
      is_default: row.is_default,
      notes: row.notes,
      meta: asPlainObject(row.meta_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private serializeTemplate(row: SmsTemplateRow) {
    return {
      id: row.id,
      provider_id: row.provider_id,
      template_code: row.template_code,
      template_name: row.template_name,
      is_active: row.is_active,
      is_default: row.is_default,
      notes: row.notes,
      meta: asPlainObject(row.meta_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private serializeEvent(row: Record<string, unknown>) {
    return {
      ...row,
      phone_hash: undefined,
    };
  }

  private maskProviderConfig(providerType: SmsProviderType, cfg: Record<string, unknown>) {
    const config = { ...cfg };
    const secretFields = [
      'auth_token',
      'api_key',
      'api_secret',
      'access_key_secret',
      'secret_key',
      'app_secret',
      'account_sid',
      'access_key',
      'auth_id',
      'secret_access_key',
    ];
    for (const field of secretFields) {
      const value = String(config[field] || '').trim();
      if (value) {
        config[`has_${field}`] = true;
        config[`${field}_masked`] = this.maskSecret(value);
      }
      delete config[field];
    }
    if (!config.dispatch_mode) config.dispatch_mode = this.defaultDispatchMode(providerType);
    return config;
  }

  private async getProviderRow(providerId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM platform_sms_providers WHERE id = $1::uuid LIMIT 1`,
      providerId,
    ) as Promise<SmsProviderRow[]>);
    if (!rows[0]) throw new BadRequestException('sms provider not found');
    return { ...rows[0], provider_type: this.parseProviderType(rows[0].provider_type) };
  }

  private async getSignatureRow(signatureId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM platform_sms_signatures WHERE id = $1::uuid LIMIT 1`,
      signatureId,
    ) as Promise<SmsSignatureRow[]>);
    if (!rows[0]) throw new BadRequestException('sms signature not found');
    return rows[0];
  }

  private async getTemplateRow(templateId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM platform_sms_templates WHERE id = $1::uuid LIMIT 1`,
      templateId,
    ) as Promise<SmsTemplateRow[]>);
    if (!rows[0]) throw new BadRequestException('sms template not found');
    return rows[0];
  }

  private async storeSmsCode(input: { appId: string; phone: string; code: string; providerId: string; signatureId: string }) {
    const codeHash = this.hashSmsCode(input.appId, input.phone, input.code);
    const nowMs = Date.now();
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM auth_sms_verification_codes
       WHERE app_id = $1::uuid AND phone = $2 AND consumed_at IS NULL`,
      input.appId,
      input.phone,
    );
    if (nowMs - this.lastCodeCleanupAt > 10 * 60 * 1000) {
      this.lastCodeCleanupAt = nowMs;
      void this.prisma.$executeRawUnsafe(
        `DELETE FROM auth_sms_verification_codes
         WHERE expire_at < now() - interval '1 day' OR consumed_at < now() - interval '1 day'`,
      ).catch((error) => this.logger.warn(`auth_sms_verification_codes cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`));
    }
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO auth_sms_verification_codes (
         app_id, phone, code_hash, provider_id, signature_id, expire_at, max_attempts
       ) VALUES (
         $1::uuid, $2, $3, $4::uuid, $5::uuid, now() + interval '5 minutes', 5
       )`,
      input.appId,
      input.phone,
      codeHash,
      input.providerId,
      input.signatureId,
    );
  }

  private async verifySmsCode(appId: string, phone: string, code: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, code_hash, expire_at, attempt_count, max_attempts
       FROM auth_sms_verification_codes
       WHERE app_id = $1::uuid AND phone = $2 AND consumed_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      appId,
      phone,
    ) as Promise<SmsCodeRow[]>);
    const row = rows[0];
    if (!row || row.expire_at.getTime() < Date.now()) {
      if (row) {
        await this.prisma.$executeRawUnsafe(`UPDATE auth_sms_verification_codes SET consumed_at = now(), updated_at = now() WHERE id = $1::uuid`, row.id);
      }
      throw new UnauthorizedException('验证码错误或已过期');
    }
    if (row.code_hash !== this.hashSmsCode(appId, phone, code)) {
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
    await this.prisma.$executeRawUnsafe(`UPDATE auth_sms_verification_codes SET consumed_at = now(), updated_at = now() WHERE id = $1::uuid`, row.id);
  }

  private async deleteSmsCode(input: { appId: string; phone: string; code: string }) {
    const codeHash = this.hashSmsCode(input.appId, input.phone, input.code);
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM auth_sms_verification_codes
       WHERE app_id = $1::uuid AND phone = $2 AND code_hash = $3 AND consumed_at IS NULL`,
      input.appId,
      input.phone,
      codeHash,
    );
  }

  private async assertSmsSendCooldown(appId: string, phone: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT created_at
       FROM auth_sms_verification_codes
       WHERE app_id = $1::uuid AND phone = $2 AND consumed_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      appId,
      phone,
    ) as Promise<Array<{ created_at: Date }>>);
    const latest = rows[0]?.created_at?.getTime?.() || 0;
    if (latest && Date.now() - latest < 60 * 1000) {
      throw new BadRequestException('验证码发送过于频繁，请稍后再试');
    }
  }

  private async recordMessageEvent(input: {
    appId: string;
    phone: string;
    route: SmsRouteConfigResolved;
    traceId: string;
    purpose: SmsSendPurpose;
    status: 'SUCCESS' | 'FAILED';
    durationMs: number;
    result?: SmsDispatchResult;
    error?: unknown;
  }) {
    const templateCode = this.pickTemplateCode(input.route.template, asPlainObject(input.route.signature.meta_json), asPlainObject(input.route.provider.config_json));
    const errorJson = input.error ? {
      name: String((input.error as { name?: unknown })?.name || ''),
      message: String((input.error as { message?: unknown })?.message || input.error || '').slice(0, 1000),
    } : null;
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform_sms_message_events (
         trace_id, app_id, purpose, provider_id, provider_type, provider_name,
         signature_id, signature_name, template_id, template_code, dispatch_mode,
         phone_hash, phone_masked, status, status_code, response_code, response_message,
         provider_message_id, duration_ms, error_json, response_json
       ) VALUES (
         $1, $2::uuid, $3, $4::uuid, $5, $6, $7::uuid, $8, $9::uuid, $10, $11,
         $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21::jsonb
       )`,
      input.traceId,
      input.appId,
      input.purpose,
      input.route.provider.id,
      input.route.provider.provider_type,
      input.route.provider.name,
      input.route.signature.id,
      input.route.signature.sign_name,
      input.route.template?.id || null,
      templateCode || null,
      this.resolveDispatchMode(input.route.provider),
      this.hashPhone(input.phone),
      this.maskPhone(input.phone),
      input.status,
      input.result?.status_code ?? null,
      input.result?.response_code ?? null,
      input.result?.response_message ?? null,
      input.result?.provider_message_id ?? null,
      Math.max(0, Math.floor(input.durationMs || 0)),
      errorJson ? JSON.stringify(errorJson) : null,
      input.result?.raw_response === undefined ? null : JSON.stringify(this.truncateJson(input.result.raw_response)),
    );
  }

  private async recordConfigAudit(action: string, actorUserId: string, providerId: string | null, providerType: string | null, detail: Record<string, unknown>) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform_sms_message_events (
         trace_id, app_id, purpose, provider_id, provider_type, provider_name,
         signature_id, signature_name, template_id, template_code, dispatch_mode,
         phone_hash, phone_masked, status, duration_ms, response_json
       ) VALUES (
         $1, NULL, $2, $3::uuid, $4, NULL, NULL, NULL, NULL, NULL, 'SYNC',
         NULL, NULL, 'CONFIG', 0, $5::jsonb
       )`,
      randomUUID(),
      action,
      providerId,
      providerType || 'CONFIG',
      JSON.stringify({ actor_user_id: actorUserId, ...detail }),
    ).catch((error) => this.logger.warn(`sms config audit failed: ${error instanceof Error ? error.message : 'unknown error'}`));
  }

  private resolveDispatchMode(provider: SmsProviderRow): SmsDispatchMode {
    const cfg = asPlainObject(provider.config_json);
    const raw = String(cfg.dispatch_mode || '').trim().toUpperCase();
    if (raw === 'ASYNC') return 'ASYNC';
    if (raw === 'SYNC') return 'SYNC';
    if (this.parseBooleanLike(cfg.async_dispatch, false)) return 'ASYNC';
    return this.defaultDispatchMode(provider.provider_type);
  }

  private defaultDispatchMode(providerType: SmsProviderType): SmsDispatchMode {
    return providerType === 'GENERIC_API' ? 'SYNC' : 'ASYNC';
  }

  private parseProviderType(value: unknown): SmsProviderType {
    const normalized = String(value || '').trim().toUpperCase() as SmsProviderType;
    if (!SUPPORTED_SMS_PROVIDER_TYPES.includes(normalized)) {
      throw new BadRequestException(`provider_type must be one of: ${SUPPORTED_SMS_PROVIDER_TYPES.join(', ')}`);
    }
    return normalized;
  }

  private providerLabel(providerType: SmsProviderType) {
    return SMS_PROVIDER_CATALOG.find((item) => item.provider_type === providerType)?.label || providerType;
  }

  private resolveProviderHealthUrl(providerType: SmsProviderType, cfg: Record<string, unknown>) {
    const endpoint = String(cfg.endpoint_url || '').trim();
    if (endpoint) return endpoint;
    if (providerType === 'ALIYUN_SMS') return 'https://dysmsapi.aliyuncs.com/';
    if (providerType === 'TENCENT_SMS') return 'https://sms.tencentcloudapi.com';
    if (providerType === 'VOLCENGINE_SMS') return 'https://sms.volcengineapi.com';
    if (providerType === 'TWILIO_SMS') return 'https://api.twilio.com';
    if (providerType === 'VONAGE_SMS') return 'https://rest.nexmo.com';
    if (providerType === 'MESSAGEBIRD_SMS') return 'https://rest.messagebird.com';
    if (providerType === 'PLIVO_SMS') return 'https://api.plivo.com';
    if (providerType === 'AWS_SNS') return `https://sns.${String(cfg.region_id || 'us-east-1')}.amazonaws.com/`;
    return endpoint || 'https://example.com';
  }

  private buildTemplatePayload(provider: SmsProviderRow, signature: SmsSignatureRow, template: SmsTemplateRow | null, phone: string, code: string) {
    const cfg = asPlainObject(provider.config_json);
    const templateVars = this.pickTemplateVariables(template);
    const payload: Record<string, string> = {};
    Object.entries(templateVars).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      payload[key] = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
    });
    const phoneField = String(cfg.phone_field || '').trim() || 'phone';
    const codeField = String(cfg.code_field || '').trim() || 'code';
    const signField = String(cfg.sign_field || '').trim() || 'sign_name';
    const templateField = String(cfg.template_field || '').trim() || 'template_code';
    payload[phoneField] = phone;
    payload[codeField] = code;
    if (signature.sign_name && signField) payload[signField] = signature.sign_name;
    const templateCode = this.pickTemplateCode(template, asPlainObject(signature.meta_json), cfg);
    if (templateCode && templateField) payload[templateField] = templateCode;
    return payload;
  }

  private buildGenericHeaders(cfg: Record<string, unknown>) {
    const headers: Record<string, string> = {};
    const authType = String(cfg.auth_type || 'NONE').trim().toUpperCase();
    const authHeaderName = String(cfg.auth_header_name || '').trim() || 'Authorization';
    if (authType === 'BEARER') {
      const token = String(cfg.auth_token || '').trim();
      if (token) headers[authHeaderName] = token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
    } else if (authType === 'API_KEY') {
      const apiKey = String(cfg.api_key || '').trim();
      if (apiKey) headers[authHeaderName] = apiKey;
    }
    return headers;
  }

  private renderTemplateMessage(template: SmsTemplateRow | null, code: string) {
    const meta = asPlainObject(template?.meta_json);
    const raw = String(meta.message_template || meta.message || meta.body || '').trim() || 'Your verification code is {{code}}.';
    return raw.replace(/\{\{\s*code\s*\}\}/g, code).replace(/\$\{code\}/g, code);
  }

  private resolveOrderedTemplateParams(template: SmsTemplateRow | null, code: string) {
    const vars = { ...this.pickTemplateVariables(template), code };
    const meta = asPlainObject(template?.meta_json);
    const order = Array.isArray(meta.variable_order) ? meta.variable_order.map((item) => String(item)).filter(Boolean) : [];
    if (order.length > 0) return order.map((key) => String(vars[key] ?? ''));
    return Object.keys(vars).sort().map((key) => String(vars[key] ?? ''));
  }

  private pickTemplateCode(template: SmsTemplateRow | null, signatureMeta: Record<string, unknown>, providerConfig: Record<string, unknown>) {
    return String(template?.template_code || signatureMeta.template_code || signatureMeta.templateCode || providerConfig.template_code || providerConfig.templateCode || '').trim();
  }

  private pickTemplateVariables(template: SmsTemplateRow | null): Record<string, unknown> {
    const meta = asPlainObject(template?.meta_json);
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
    const canonicalizedQueryString = Object.keys(params).sort()
      .map((key) => `${this.aliyunPercentEncode(key)}=${this.aliyunPercentEncode(String(params[key] ?? ''))}`)
      .join('&');
    const stringToSign = `GET&%2F&${this.aliyunPercentEncode(canonicalizedQueryString)}`;
    const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
    return `${parsed.origin}${parsed.pathname || '/'}?${canonicalizedQueryString}&Signature=${this.aliyunPercentEncode(signature)}`;
  }

  private aliyunPercentEncode(value: string) {
    return encodeURIComponent(String(value || '')).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
  }

  private buildAwsV4Headers(input: {
    method: string;
    url: URL;
    body: string;
    accessKeyId: string;
    secretKey: string;
    region: string;
    service: string;
    contentType: string;
  }) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(input.body).digest('hex');
    const canonicalUri = input.url.pathname || '/';
    const canonicalQuery = Array.from(input.url.searchParams.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    const host = input.url.host;
    const canonicalHeaders = `content-type:${input.contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [input.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    const signingKey = this.getAwsSignatureKey(input.secretKey, dateStamp, input.region, input.service);
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    return {
      Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'Content-Type': input.contentType,
      Host: host,
      'X-Amz-Content-Sha256': payloadHash,
      'X-Amz-Date': amzDate,
    };
  }

  private getAwsSignatureKey(secretKey: string, dateStamp: string, regionName: string, serviceName: string) {
    const kDate = createHmac('sha256', `AWS4${secretKey}`).update(dateStamp).digest();
    const kRegion = createHmac('sha256', kDate).update(regionName).digest();
    const kService = createHmac('sha256', kRegion).update(serviceName).digest();
    return createHmac('sha256', kService).update('aws4_request').digest();
  }

  private async fetchOrThrow(url: string, init: RequestInit, label: string, timeoutMs: number) {
    try {
      return await fetch(url, init);
    } catch (error) {
      this.rethrowFetchError(error, label, timeoutMs);
    }
  }

  private rethrowFetchError(error: unknown, label: string, timeoutMs: number): never {
    const name = String((error as { name?: unknown })?.name || '').trim();
    const message = String((error as { message?: unknown })?.message || '').trim();
    const lower = message.toLowerCase();
    if (name === 'TimeoutError' || lower.includes('aborted due to timeout') || lower.includes('request timed out')) {
      throw new BadGatewayException(`${label}请求超时（${timeoutMs}ms），请检查服务商连通性或调大 timeout_ms`);
    }
    const reason = message ? message.slice(0, 240) : 'network error';
    this.logger.error(`${label}网络异常: ${reason}`);
    throw new BadGatewayException(`${label}请求失败：${reason}`);
  }

  private async parseJsonResponse(response: Response): Promise<Record<string, any>> {
    const text = await response.text();
    try {
      return JSON.parse(text) as Record<string, any>;
    } catch {
      return text ? { raw: text.slice(0, 1000) } : {};
    }
  }

  private pickProviderError(payload: any) {
    const raw = payload && typeof payload === 'object' ? payload : {};
    return String(raw.Message || raw.message || raw.Code || raw.code || raw.err_msg || raw.error_text || raw.raw || 'unknown error').slice(0, 500);
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

  private async resolveAppWithSettings(appSlug?: string) {
    const slug = String(appSlug || process.env.DEFAULT_APP_SLUG || 'default').trim();
    const app = await this.prisma.app.findUnique({ where: { slug }, include: { settings: true } });
    if (!app) throw new BadRequestException(`App not found: ${slug}`);
    return app;
  }

  private async resolveAppByIdWithSettings(appId: string) {
    const app = await this.prisma.app.findUnique({ where: { id: appId }, include: { settings: true } });
    if (!app) throw new BadRequestException(`App not found: ${appId}`);
    return app;
  }

  private normalizePhone(phone: string) {
    const normalized = String(phone || '').trim().replace(/[\s-]+/g, '');
    if (!/^\+?\d{6,20}$/.test(normalized)) throw new BadRequestException('手机号格式不正确');
    const hasExplicitCountryCode = normalized.startsWith('+');
    const digits = hasExplicitCountryCode ? normalized.slice(1) : normalized;
    if (hasExplicitCountryCode) return `+${digits}`;
    if (/^1[3-9]\d{9}$/.test(digits)) return `+86${digits}`;
    if (/^861[3-9]\d{9}$/.test(digits)) return `+${digits}`;
    return digits;
  }

  private buildPhoneIdentityVariants(phone: string) {
    const normalized = this.normalizePhone(phone);
    const variants = new Set([normalized]);
    if (normalized.startsWith('+86')) variants.add(normalized.slice(3));
    if (/^1[3-9]\d{9}$/.test(normalized)) variants.add(`+86${normalized}`);
    return Array.from(variants);
  }

  private normalizeSmsCode(code: string) {
    const normalized = String(code || '').trim();
    if (!/^\d{4,8}$/.test(normalized)) throw new BadRequestException('验证码格式不正确');
    return normalized;
  }

  private generateVerificationCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  private hashSmsCode(appId: string, phone: string, code: string) {
    const secret = String(this.config.jwt.secret || '');
    return createHash('sha256').update(`${appId}:${phone}:${code}:${secret}`, 'utf8').digest('hex');
  }

  private hashPhone(phone: string) {
    const secret = String(this.config.jwt.secret || '');
    return createHash('sha256').update(`${phone}:${secret}`, 'utf8').digest('hex');
  }

  private maskPhone(phone: string) {
    const digits = phone.replace(/[^\d+]/g, '');
    if (digits.length <= 7) return `${digits.slice(0, 2)}***`;
    return `${digits.slice(0, 4)}****${digits.slice(-3)}`;
  }

  private maskSecret(value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.length <= 8) return `${raw.slice(0, 2)}****`;
    return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
  }

  private parseBooleanLike(value: unknown, fallback: boolean) {
    if (typeof value === 'boolean') return value;
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
    return fallback;
  }

  private clampTimeout(value: unknown) {
    const timeoutRaw = Number(value ?? 10000);
    return Number.isFinite(timeoutRaw) ? Math.min(Math.max(Math.floor(timeoutRaw), 1000), 60000) : 10000;
  }

  private clampInteger(value: unknown, fallback: number, min: number, max: number) {
    const parsed = Number(value ?? fallback);
    return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), min), max) : fallback;
  }

  private describeNetworkFailure(error: unknown, timeoutMs: number) {
    const name = String((error as { name?: unknown })?.name || '').trim();
    const message = String((error as { message?: unknown })?.message || '').trim();
    if (name === 'TimeoutError' || message.toLowerCase().includes('timeout')) {
      return `请求超时（${timeoutMs}ms）`;
    }
    return message || 'network error';
  }

  private truncateJson(value: unknown) {
    const raw = JSON.stringify(value);
    if (raw.length <= 3000) return value;
    return { truncated: true, preview: raw.slice(0, 3000) };
  }
}
