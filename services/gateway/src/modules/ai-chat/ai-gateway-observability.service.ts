import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { PRISMA_CLIENT } from '../../config/database.module';
import { PlatformObservabilityService } from '../observability/platform-observability.service';
import { AiGatewayErrorClassifierService } from './ai-gateway-error-classifier.service';
import type { ResolvedAiRoute } from './ai-routing.service';

type RequestEventInput = {
  route?: ResolvedAiRoute | null;
  app_id?: string | null;
  app_slug?: string | null;
  user_id?: string | null;
  request_id?: string | null;
  usage_reference_id?: string | null;
  request_path?: string | null;
  stage: string;
  attempt_index?: number | null;
  success?: boolean | null;
  status_code?: number | null;
  error_message?: string | null;
  error_category?: string | null;
  latency_ms?: number | null;
  upstream_request_id?: string | null;
  metadata?: Record<string, unknown>;
};

type RouteHealthInput = {
  route: ResolvedAiRoute;
  success: boolean;
  status_code?: number | null;
  error_message?: string | null;
  latency_ms?: number | null;
  cooldown_until?: Date | null;
};

type AuditEventInput = {
  actor_user_id?: string | null;
  app_id?: string | null;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
};

type ListProviderHealthInput = {
  provider_type?: string;
  source_id?: string;
  model_id?: string;
  model_key?: string;
  capability?: string;
  status?: string;
  page?: string;
  page_size?: string;
};

type ListRequestEventsInput = {
  app_id?: string;
  user_id?: string;
  request_id?: string;
  usage_reference_id?: string;
  source_id?: string;
  model_id?: string;
  model_key?: string;
  capability?: string;
  stage?: string;
  success?: string;
  days?: string;
  page?: string;
  page_size?: string;
};

type ListAuditEventsInput = {
  actor_user_id?: string;
  app_id?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  days?: string;
  page?: string;
  page_size?: string;
};

@Injectable()
export class AiGatewayObservabilityService implements OnModuleInit {
  private readonly logger = new Logger(AiGatewayObservabilityService.name);
  private schemaReady = false;
  private schemaPromise: Promise<boolean> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly errorClassifier: AiGatewayErrorClassifierService,
    private readonly platformObservability: PlatformObservabilityService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`AI gateway observability schema warmup failed: ${error?.message || error}`);
    }
  }

  async recordRequestEvent(input: RequestEventInput): Promise<void> {
    if (!(await this.ensureSchema())) return;
    const route = input.route || null;
    const statusCode = this.normalizeNullableInt(input.status_code);
    const errorMessage = this.normalizeNullableString(input.error_message, 1200);
    const errorCategory = this.normalizeNullableString(input.error_category, 64)
      || (errorMessage || statusCode ? this.errorClassifier.classify({ status: statusCode, message: errorMessage }) : null);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO ai_gateway_request_events (
         id, app_id, app_slug, user_id, request_id, usage_reference_id, request_path,
         route_key, global_model_id, model_key, capability, source_id, source_name, provider_type, api_key_id,
         stage, attempt_index, success, status_code, error_category, error_message, latency_ms,
         upstream_request_id, metadata_json, created_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3::uuid, $4, $5, $6,
         $7, $8::uuid, $9, $10, $11::uuid, $12, $13, $14::uuid,
         $15, $16::int, $17, $18::int, $19, $20, $21::int,
         $22, $23::jsonb, now()
       )`,
      this.normalizeNullableUuid(input.app_id || route?.app_id),
      this.normalizeNullableString(input.app_slug || route?.app_slug, 64),
      this.normalizeNullableUuid(input.user_id),
      this.normalizeNullableString(input.request_id, 128),
      this.normalizeNullableString(input.usage_reference_id, 128),
      this.normalizeNullableString(input.request_path, 255),
      this.normalizeNullableString(route?.route_key, 96),
      this.normalizeNullableUuid(route?.model_id),
      this.normalizeNullableString(route?.model_key, 128),
      this.normalizeNullableString(route?.capability, 32),
      this.normalizeNullableUuid(route?.source.id),
      this.normalizeNullableString(route?.source.name, 128),
      this.normalizeNullableString(route?.source.provider_type, 64),
      this.normalizeNullableUuid(route?.source.api_key_id),
      this.normalizeRequiredString(input.stage, 64, 'unknown'),
      this.normalizeNullableInt(input.attempt_index),
      input.success === undefined || input.success === null ? null : input.success === true,
      statusCode,
      errorCategory,
      errorMessage,
      this.normalizeNullableInt(input.latency_ms),
      this.normalizeNullableString(input.upstream_request_id, 128),
      JSON.stringify(this.normalizeMetadata(input.metadata)),
    );
    this.platformObservability.recordRequestEventSafe({
      request_id: input.request_id,
      app_id: input.app_id || route?.app_id || null,
      app_slug: input.app_slug || route?.app_slug || null,
      actor_user_id: input.user_id || null,
      module: 'ai.gateway',
      operation: route?.capability ? `${route.capability}.${input.stage}` : input.stage,
      resource_type: route?.model_key ? 'ai_model' : 'ai_request',
      resource_id: route?.model_key || input.usage_reference_id || null,
      stage: input.stage,
      request_path: input.request_path || null,
      success: input.success === undefined || input.success === null ? null : input.success === true,
      status_code: statusCode,
      error_category: errorCategory,
      error_message: errorMessage,
      latency_ms: this.normalizeNullableInt(input.latency_ms),
      metadata: {
        usage_reference_id: input.usage_reference_id || null,
        route_key: route?.route_key || null,
        model_id: route?.model_id || null,
        model_key: route?.model_key || null,
        capability: route?.capability || null,
        source_id: route?.source.id || null,
        source_name: route?.source.name || null,
        provider_type: route?.source.provider_type || null,
        upstream_request_id: input.upstream_request_id || null,
        ...(input.metadata || {}),
      },
    });
  }

  recordRequestEventSafe(input: RequestEventInput): void {
    void this.recordRequestEvent(input).catch((error: any) => {
      this.logger.warn(`failed to record AI request event: ${error?.message || error}`);
    });
  }

  async recordRouteHealth(input: RouteHealthInput): Promise<void> {
    if (!(await this.ensureSchema())) return;
    const route = input.route;
    const statusCode = this.normalizeNullableInt(input.status_code);
    const errorMessage = this.normalizeNullableString(input.error_message, 1200);
    const errorCategory = input.success
      ? null
      : this.errorClassifier.classify({ status: statusCode, message: errorMessage });
    const routeKey = this.normalizeRequiredString(route.route_key, 96, 'default');
    const apiKeyId = this.normalizeNullableUuid(route.source.api_key_id);
    const status = input.success ? 'healthy' : (input.cooldown_until ? 'cooling_down' : 'degraded');
    const latencyMs = this.normalizeNullableInt(input.latency_ms);
    const updated = await this.prisma.$executeRawUnsafe(
      `UPDATE ai_provider_health
       SET source_name = $6,
           provider_type = $7,
           status = $8,
           consecutive_failures = CASE WHEN $8 = 'healthy' THEN 0 ELSE consecutive_failures + 1 END,
           cooldown_until = $10::timestamptz,
           last_status_code = $11::int,
           last_error_category = $12,
           last_error_message = $13,
           success_count = success_count + $14::bigint,
           error_count = error_count + $15::bigint,
           latency_sum_ms = latency_sum_ms + $16::bigint,
           latency_sample_count = latency_sample_count + $17::bigint,
           last_success_at = COALESCE($18::timestamptz, last_success_at),
           last_failure_at = COALESCE($19::timestamptz, last_failure_at),
           updated_at = now()
       WHERE source_id = $1::uuid
         AND global_model_id = $2::uuid
         AND route_key = $3
         AND capability = $4
         AND COALESCE(api_key_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
      route.source.id,
      route.model_id,
      routeKey,
      route.capability,
      apiKeyId,
      route.source.name,
      route.source.provider_type,
      status,
      input.success ? 0 : 1,
      input.cooldown_until || null,
      statusCode,
      errorCategory,
      errorMessage,
      input.success ? 1 : 0,
      input.success ? 0 : 1,
      latencyMs || 0,
      latencyMs === null ? 0 : 1,
      input.success ? new Date() : null,
      input.success ? null : new Date(),
    );
    if (updated > 0) {
      return;
    }

    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO ai_provider_health (
           source_id, global_model_id, route_key, capability, api_key_id, source_name, provider_type,
           status, consecutive_failures, cooldown_until, last_status_code, last_error_category,
           last_error_message, success_count, error_count, latency_sum_ms, latency_sample_count,
           last_success_at, last_failure_at, updated_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7,
           $8, $9, $10::timestamptz, $11::int, $12, $13, $14, $15, $16, $17,
           $18::timestamptz, $19::timestamptz, now()
         )`,
        route.source.id,
        route.model_id,
        routeKey,
        route.capability,
        apiKeyId,
        route.source.name,
        route.source.provider_type,
        status,
        input.success ? 0 : 1,
        input.cooldown_until || null,
        statusCode,
        errorCategory,
        errorMessage,
        input.success ? 1 : 0,
        input.success ? 0 : 1,
        latencyMs || 0,
        latencyMs === null ? 0 : 1,
        input.success ? new Date() : null,
        input.success ? null : new Date(),
      );
    } catch (error: any) {
      if (String(error?.code || '') !== '23505') {
        throw error;
      }
      await this.recordRouteHealth(input);
    }
  }

  recordRouteHealthSafe(input: RouteHealthInput): void {
    void this.recordRouteHealth(input).catch((error: any) => {
      this.logger.warn(`failed to record AI provider health: ${error?.message || error}`);
    });
  }

  async recordAuditEvent(input: AuditEventInput): Promise<void> {
    if (!(await this.ensureSchema())) return;
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO ai_audit_events (
         id, actor_user_id, app_id, action, resource_type, resource_id,
         before_hash, after_hash, metadata_json, created_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, now()
       )`,
      this.normalizeNullableUuid(input.actor_user_id),
      this.normalizeNullableUuid(input.app_id),
      this.normalizeRequiredString(input.action, 96, 'unknown'),
      this.normalizeRequiredString(input.resource_type, 64, 'unknown'),
      this.normalizeNullableString(input.resource_id, 128),
      this.hashSnapshot(input.before),
      this.hashSnapshot(input.after),
      JSON.stringify(this.normalizeMetadata(input.metadata)),
    );
    this.platformObservability.recordAuditEventSafe({
      actor_user_id: input.actor_user_id || null,
      app_id: input.app_id || null,
      module: 'ai.config',
      action: input.action,
      resource_type: input.resource_type,
      resource_id: input.resource_id || null,
      before: input.before,
      after: input.after,
      metadata: input.metadata,
    });
  }

  recordAuditEventSafe(input: AuditEventInput): void {
    void this.recordAuditEvent(input).catch((error: any) => {
      this.logger.warn(`failed to record AI audit event: ${error?.message || error}`);
    });
  }

  async listProviderHealth(input: ListProviderHealthInput = {}) {
    const paging = this.parsePaging(input.page, input.page_size, 100);
    if (!(await this.ensureSchema())) {
      return this.paginated([], paging);
    }
    const where: string[] = [];
    const params: unknown[] = [];
    this.addUuidFilter(where, params, 'h.source_id', input.source_id);
    this.addUuidFilter(where, params, 'h.global_model_id', input.model_id);
    this.addTextFilter(where, params, 'm.model_key', input.model_key, 128);
    this.addTextFilter(where, params, 'h.provider_type', input.provider_type, 64);
    this.addTextFilter(where, params, 'h.capability', input.capability, 32);
    this.addTextFilter(where, params, 'h.status', input.status, 32);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT
         h.source_id,
         h.global_model_id AS model_id,
         m.model_key,
         m.display_name AS model_name,
         h.route_key,
         h.capability,
         h.api_key_id,
         h.source_name,
         h.provider_type,
         s.is_active AS source_is_active,
         h.status,
         h.consecutive_failures,
         h.cooldown_until,
         h.last_status_code,
         h.last_error_category,
         h.last_error_message,
         h.success_count,
         h.error_count,
         CASE WHEN h.latency_sample_count > 0 THEN round((h.latency_sum_ms::numeric / h.latency_sample_count::numeric), 2) ELSE NULL END AS avg_latency_ms,
         h.last_success_at,
         h.last_failure_at,
         h.updated_at
       FROM ai_provider_health h
       LEFT JOIN ai_global_models m ON m.id = h.global_model_id
       LEFT JOIN ai_global_sources s ON s.id = h.source_id
       ${whereSql}
       ORDER BY
         CASE h.status WHEN 'cooling_down' THEN 0 WHEN 'degraded' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END,
         h.updated_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      ...params,
      paging.limit + 1,
      paging.offset,
    )) as Record<string, unknown>[];
    return this.paginated(rows, paging);
  }

  async listRequestEvents(input: ListRequestEventsInput = {}) {
    const paging = this.parsePaging(input.page, input.page_size, 100);
    if (!(await this.ensureSchema())) {
      return this.paginated([], paging);
    }
    const where: string[] = [];
    const params: unknown[] = [];
    this.addUuidFilter(where, params, 'app_id', input.app_id);
    this.addUuidFilter(where, params, 'user_id', input.user_id);
    this.addUuidFilter(where, params, 'source_id', input.source_id);
    this.addUuidFilter(where, params, 'global_model_id', input.model_id);
    this.addTextFilter(where, params, 'request_id', input.request_id, 128);
    this.addTextFilter(where, params, 'usage_reference_id', input.usage_reference_id, 128);
    this.addTextFilter(where, params, 'model_key', input.model_key, 128);
    this.addTextFilter(where, params, 'capability', input.capability, 32);
    this.addTextFilter(where, params, 'stage', input.stage, 64);
    this.addBooleanFilter(where, params, 'success', input.success);
    this.addDaysFilter(where, params, 'created_at', input.days, 14);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT
         id,
         app_id,
         app_slug,
         user_id,
         request_id,
         usage_reference_id,
         request_path,
         route_key,
         global_model_id AS model_id,
         model_key,
         capability,
         source_id,
         source_name,
         provider_type,
         api_key_id,
         stage,
         attempt_index,
         success,
         status_code,
         error_category,
         error_message,
         latency_ms,
         upstream_request_id,
         metadata_json,
         created_at
       FROM ai_gateway_request_events
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      ...params,
      paging.limit + 1,
      paging.offset,
    )) as Record<string, unknown>[];
    return this.paginated(rows, paging);
  }

  async listAuditEvents(input: ListAuditEventsInput = {}) {
    const paging = this.parsePaging(input.page, input.page_size, 100);
    if (!(await this.ensureSchema())) {
      return this.paginated([], paging);
    }
    const where: string[] = [];
    const params: unknown[] = [];
    this.addUuidFilter(where, params, 'actor_user_id', input.actor_user_id);
    this.addUuidFilter(where, params, 'app_id', input.app_id);
    this.addTextFilter(where, params, 'action', input.action, 96);
    this.addTextFilter(where, params, 'resource_type', input.resource_type, 64);
    this.addTextFilter(where, params, 'resource_id', input.resource_id, 128);
    this.addDaysFilter(where, params, 'created_at', input.days, 30);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT
         id,
         actor_user_id,
         app_id,
         action,
         resource_type,
         resource_id,
         before_hash,
         after_hash,
         metadata_json,
         created_at
       FROM ai_audit_events
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      ...params,
      paging.limit + 1,
      paging.offset,
    )) as Record<string, unknown>[];
    return this.paginated(rows, paging);
  }

  private async ensureSchema(): Promise<boolean> {
    if (this.schemaReady) return true;
    if (this.schemaPromise) {
      await this.schemaPromise;
      return this.schemaReady;
    }
    this.schemaPromise = this.initSchema();
    try {
      this.schemaReady = await this.schemaPromise;
      return this.schemaReady;
    } finally {
      this.schemaPromise = null;
    }
  }

  private async initSchema(): Promise<boolean> {
    if (!(await this.arePrerequisiteTablesReady())) {
      return false;
    }
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_source_api_keys
      ADD COLUMN IF NOT EXISTS status varchar(32) NOT NULL DEFAULT 'active'
    `);
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_source_api_keys
      ADD COLUMN IF NOT EXISTS disabled_reason text NULL
    `);
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_source_api_keys
      ADD COLUMN IF NOT EXISTS disabled_until timestamptz NULL
    `);
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_source_api_keys
      ADD COLUMN IF NOT EXISTS last_error_category varchar(64) NULL
    `);
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_source_api_keys
      ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0
    `);
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_source_api_keys
      ADD COLUMN IF NOT EXISTS success_count bigint NOT NULL DEFAULT 0
    `);
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE ai_global_source_api_keys
      ADD COLUMN IF NOT EXISTS error_count bigint NOT NULL DEFAULT 0
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_gateway_request_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NULL REFERENCES apps(id) ON DELETE CASCADE,
        app_slug varchar(64) NULL,
        user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        request_id varchar(128) NULL,
        usage_reference_id varchar(128) NULL,
        request_path varchar(255) NULL,
        route_key varchar(96) NULL,
        global_model_id uuid NULL REFERENCES ai_global_models(id) ON DELETE SET NULL,
        model_key varchar(128) NULL,
        capability varchar(32) NULL,
        source_id uuid NULL REFERENCES ai_global_sources(id) ON DELETE SET NULL,
        source_name varchar(128) NULL,
        provider_type varchar(64) NULL,
        api_key_id uuid NULL REFERENCES ai_global_source_api_keys(id) ON DELETE SET NULL,
        stage varchar(64) NOT NULL,
        attempt_index integer NULL,
        success boolean NULL,
        status_code integer NULL,
        error_category varchar(64) NULL,
        error_message text NULL,
        latency_ms integer NULL,
        upstream_request_id varchar(128) NULL,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_gateway_request_events_request
      ON ai_gateway_request_events(app_id, request_id, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_gateway_request_events_usage_reference
      ON ai_gateway_request_events(usage_reference_id, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_gateway_request_events_source_created
      ON ai_gateway_request_events(source_id, created_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_provider_health (
        source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE CASCADE,
        global_model_id uuid NOT NULL REFERENCES ai_global_models(id) ON DELETE CASCADE,
        route_key varchar(96) NOT NULL,
        capability varchar(32) NOT NULL,
        api_key_id uuid NULL REFERENCES ai_global_source_api_keys(id) ON DELETE SET NULL,
        source_name varchar(128) NOT NULL,
        provider_type varchar(64) NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'unknown',
        consecutive_failures integer NOT NULL DEFAULT 0,
        cooldown_until timestamptz NULL,
        last_status_code integer NULL,
        last_error_category varchar(64) NULL,
        last_error_message text NULL,
        success_count bigint NOT NULL DEFAULT 0,
        error_count bigint NOT NULL DEFAULT 0,
        latency_sum_ms bigint NOT NULL DEFAULT 0,
        latency_sample_count bigint NOT NULL DEFAULT 0,
        last_success_at timestamptz NULL,
        last_failure_at timestamptz NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_health_unique
      ON ai_provider_health(source_id, global_model_id, route_key, capability, COALESCE(api_key_id, '00000000-0000-0000-0000-000000000000'::uuid))
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_provider_health_status
      ON ai_provider_health(status, updated_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        app_id uuid NULL REFERENCES apps(id) ON DELETE CASCADE,
        action varchar(96) NOT NULL,
        resource_type varchar(64) NOT NULL,
        resource_id varchar(128) NULL,
        before_hash varchar(64) NULL,
        after_hash varchar(64) NULL,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_audit_events_resource
      ON ai_audit_events(resource_type, resource_id, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_ai_audit_events_actor
      ON ai_audit_events(actor_user_id, created_at DESC)
    `);
    return true;
  }

  private async arePrerequisiteTablesReady(): Promise<boolean> {
    const requiredTables = [
      'apps',
      'users',
      'ai_global_sources',
      'ai_global_models',
      'ai_global_source_api_keys',
    ];
    for (const tableName of requiredTables) {
      const rows = (await this.prisma.$queryRawUnsafe(
        `SELECT to_regclass($1::text)::text AS table_name`,
        tableName,
      )) as Array<{ table_name: string | null }>;
      if (!rows[0]?.table_name) {
        return false;
      }
    }
    return true;
  }

  private hashSnapshot(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    return createHash('sha256').update(this.stableStringify(this.redact(value))).digest('hex');
  }

  private redact(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.includes('key') || normalizedKey.includes('secret') || normalizedKey.includes('token') || normalizedKey.includes('credential')) {
        output[key] = item ? '[redacted]' : item;
      } else {
        output[key] = this.redact(item);
      }
    }
    return output;
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    if (!value || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`).join(',')}}`;
  }

  private normalizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!value || typeof value !== 'object') {
      return {};
    }
    return this.redact(value) as Record<string, unknown>;
  }

  private normalizeNullableUuid(value: unknown): string | null {
    const normalized = String(value || '').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)
      ? normalized
      : null;
  }

  private normalizeNullableString(value: unknown, maxLength: number): string | null {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  private normalizeRequiredString(value: unknown, maxLength: number, fallback: string): string {
    return (this.normalizeNullableString(value, maxLength) || fallback).slice(0, maxLength);
  }

  private normalizeNullableInt(value: unknown): number | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private parsePaging(pageValue: unknown, pageSizeValue: unknown, maxPageSize: number): { page: number; limit: number; offset: number } {
    const page = Math.max(1, this.normalizeNullableInt(pageValue) || 1);
    const limit = Math.min(maxPageSize, Math.max(1, this.normalizeNullableInt(pageSizeValue) || 50));
    return {
      page,
      limit,
      offset: (page - 1) * limit,
    };
  }

  private paginated(rows: Record<string, unknown>[], paging: { page: number; limit: number }) {
    const hasMore = rows.length > paging.limit;
    return {
      items: rows.slice(0, paging.limit),
      page: paging.page,
      page_size: paging.limit,
      has_more: hasMore,
    };
  }

  private addUuidFilter(where: string[], params: unknown[], column: string, value: unknown): void {
    const normalized = this.normalizeNullableUuid(value);
    if (!normalized) return;
    params.push(normalized);
    where.push(`${column} = $${params.length}::uuid`);
  }

  private addTextFilter(where: string[], params: unknown[], column: string, value: unknown, maxLength: number): void {
    const normalized = this.normalizeNullableString(value, maxLength);
    if (!normalized) return;
    params.push(normalized);
    where.push(`${column} = $${params.length}`);
  }

  private addBooleanFilter(where: string[], params: unknown[], column: string, value: unknown): void {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!['true', 'false'].includes(normalized)) return;
    params.push(normalized === 'true');
    where.push(`${column} = $${params.length}`);
  }

  private addDaysFilter(where: string[], params: unknown[], column: string, value: unknown, defaultDays: number): void {
    const days = Math.min(90, Math.max(1, this.normalizeNullableInt(value) || defaultDays));
    params.push(days);
    where.push(`${column} >= now() - ($${params.length}::int * interval '1 day')`);
  }
}
