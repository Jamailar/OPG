import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { PRISMA_CLIENT } from '../../config/database.module';
import {
  PLATFORM_AUDIT_EVENT_RETENTION_DAYS,
  PLATFORM_OBSERVABILITY_RETENTION_BATCH_SIZE,
  PLATFORM_REQUEST_EVENT_RETENTION_DAYS,
} from './platform-observability.constants';
import { PlatformRequestContextService } from './platform-request-context.service';

type RequestEventInput = {
  request_id?: string | null;
  trace_id?: string | null;
  app_id?: string | null;
  app_slug?: string | null;
  actor_user_id?: string | null;
  module?: string | null;
  operation?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  stage?: string | null;
  method?: string | null;
  request_path?: string | null;
  success?: boolean | null;
  status_code?: number | null;
  error_category?: string | null;
  error_message?: string | null;
  latency_ms?: number | null;
  ip_address?: string | null;
  user_agent?: string | null;
  metadata?: Record<string, unknown>;
};

type AuditEventInput = {
  request_id?: string | null;
  actor_user_id?: string | null;
  app_id?: string | null;
  app_slug?: string | null;
  module: string;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
};

type ListRequestEventsInput = {
  app_id?: string;
  actor_user_id?: string;
  request_id?: string;
  module?: string;
  operation?: string;
  resource_type?: string;
  resource_id?: string;
  success?: string;
  status_min?: string;
  days?: string;
  page?: string;
  page_size?: string;
};

type ListAuditEventsInput = {
  actor_user_id?: string;
  app_id?: string;
  module?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  days?: string;
  page?: string;
  page_size?: string;
};

@Injectable()
export class PlatformObservabilityService implements OnModuleInit {
  private readonly logger = new Logger(PlatformObservabilityService.name);
  private schemaReady = false;
  private schemaPromise: Promise<boolean> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly requestContext: PlatformRequestContextService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`platform observability schema warmup failed: ${error?.message || error}`);
    }
  }

  async isSchemaReady(): Promise<boolean> {
    return this.ensureSchema();
  }

  async recordRequestEvent(input: RequestEventInput): Promise<void> {
    if (!(await this.ensureSchema())) return;
    const context = this.requestContext.get();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform_request_events (
         id, request_id, trace_id, app_id, app_slug, actor_user_id, module, operation,
         resource_type, resource_id, stage, method, request_path, success, status_code,
         error_category, error_message, latency_ms, ip_address, user_agent, metadata_json, created_at
       )
       VALUES (
         gen_random_uuid(), $1, $2, $3::uuid, $4, $5::uuid, $6, $7,
         $8, $9, $10, $11, $12, $13, $14::int,
         $15, $16, $17::int, $18, $19, $20::jsonb, now()
       )`,
      this.normalizeNullableString(input.request_id || context?.request_id, 128),
      this.normalizeNullableString(input.trace_id || context?.trace_id, 64),
      this.normalizeNullableUuid(input.app_id),
      this.normalizeNullableString(input.app_slug, 64),
      this.normalizeNullableUuid(input.actor_user_id),
      this.normalizeRequiredString(input.module, 64, 'http'),
      this.normalizeRequiredString(input.operation, 96, 'request'),
      this.normalizeNullableString(input.resource_type, 64),
      this.normalizeNullableString(input.resource_id, 128),
      this.normalizeRequiredString(input.stage, 64, 'completed'),
      this.normalizeNullableString(input.method || context?.method, 12),
      this.normalizeNullableString(input.request_path || context?.path, 255),
      input.success === undefined || input.success === null ? null : input.success === true,
      this.normalizeNullableInt(input.status_code),
      this.normalizeNullableString(input.error_category, 64),
      this.normalizeNullableString(input.error_message, 1200),
      this.normalizeNullableInt(input.latency_ms),
      this.normalizeNullableString(input.ip_address, 64),
      this.normalizeNullableString(input.user_agent, 512),
      JSON.stringify(this.normalizeMetadata(input.metadata)),
    );
  }

  recordRequestEventSafe(input: RequestEventInput): void {
    void this.recordRequestEvent(input).catch((error: any) => {
      this.logger.warn(`failed to record platform request event: ${error?.message || error}`);
    });
  }

  async recordAuditEvent(input: AuditEventInput): Promise<void> {
    if (!(await this.ensureSchema())) return;
    const context = this.requestContext.get();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform_audit_events (
         id, request_id, actor_user_id, app_id, app_slug, module, action, resource_type,
         resource_id, before_hash, after_hash, metadata_json, created_at
       )
       VALUES (
         gen_random_uuid(), $1, $2::uuid, $3::uuid, $4, $5, $6, $7,
         $8, $9, $10, $11::jsonb, now()
       )`,
      this.normalizeNullableString(input.request_id || context?.request_id, 128),
      this.normalizeNullableUuid(input.actor_user_id),
      this.normalizeNullableUuid(input.app_id),
      this.normalizeNullableString(input.app_slug, 64),
      this.normalizeRequiredString(input.module, 64, 'platform'),
      this.normalizeRequiredString(input.action, 96, 'unknown'),
      this.normalizeRequiredString(input.resource_type, 64, 'unknown'),
      this.normalizeNullableString(input.resource_id, 128),
      this.hashSnapshot(input.before),
      this.hashSnapshot(input.after),
      JSON.stringify(this.normalizeMetadata(input.metadata)),
    );
  }

  recordAuditEventSafe(input: AuditEventInput): void {
    void this.recordAuditEvent(input).catch((error: any) => {
      this.logger.warn(`failed to record platform audit event: ${error?.message || error}`);
    });
  }

  async listRequestEvents(input: ListRequestEventsInput = {}) {
    const paging = this.parsePaging(input.page, input.page_size, 100);
    if (!(await this.ensureSchema())) {
      return this.paginated([], paging);
    }
    const where: string[] = [];
    const params: unknown[] = [];
    this.addUuidFilter(where, params, 'app_id', input.app_id);
    this.addUuidFilter(where, params, 'actor_user_id', input.actor_user_id);
    this.addTextFilter(where, params, 'request_id', input.request_id, 128);
    this.addTextFilter(where, params, 'module', input.module, 64);
    this.addTextFilter(where, params, 'operation', input.operation, 96);
    this.addTextFilter(where, params, 'resource_type', input.resource_type, 64);
    this.addTextFilter(where, params, 'resource_id', input.resource_id, 128);
    this.addBooleanFilter(where, params, 'success', input.success);
    this.addStatusMinFilter(where, params, input.status_min);
    this.addDaysFilter(where, params, 'created_at', input.days, 7);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM platform_request_events
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
    this.addTextFilter(where, params, 'module', input.module, 64);
    this.addTextFilter(where, params, 'action', input.action, 96);
    this.addTextFilter(where, params, 'resource_type', input.resource_type, 64);
    this.addTextFilter(where, params, 'resource_id', input.resource_id, 128);
    this.addDaysFilter(where, params, 'created_at', input.days, 30);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM platform_audit_events
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      ...params,
      paging.limit + 1,
      paging.offset,
    )) as Record<string, unknown>[];
    return this.paginated(rows, paging);
  }

  async getRuntimeSummary() {
    if (!(await this.ensureSchema())) {
      return {
        schema_ready: false,
        tables: [],
        retention: this.getRetentionSummary(),
        modules: [],
        recent_errors: [],
      };
    }
    const tables = await Promise.all([
      this.getTableHealth('platform_request_events'),
      this.getTableHealth('platform_audit_events'),
    ]);
    const modules = (await this.prisma.$queryRawUnsafe(
      `SELECT
         module,
         COUNT(*)::bigint AS events_count,
         SUM(CASE WHEN success = false OR status_code >= 500 THEN 1 ELSE 0 END)::bigint AS failures_count,
         SUM(CASE WHEN latency_ms >= 3000 THEN 1 ELSE 0 END)::bigint AS slow_count,
         ROUND(AVG(latency_ms)::numeric, 2) AS avg_latency_ms,
         MAX(created_at) AS last_event_at
       FROM platform_request_events
       WHERE created_at >= now() - interval '1 hour'
       GROUP BY module
       ORDER BY failures_count DESC, slow_count DESC, events_count DESC
       LIMIT 20`,
    )) as Record<string, unknown>[];
    const recentErrors = (await this.prisma.$queryRawUnsafe(
      `SELECT id, request_id, app_id, app_slug, actor_user_id, module, operation, request_path,
              status_code, error_category, error_message, latency_ms, created_at
         FROM platform_request_events
        WHERE created_at >= now() - interval '24 hours'
          AND (success = false OR status_code >= 500)
        ORDER BY created_at DESC, id DESC
        LIMIT 20`,
    )) as Record<string, unknown>[];
    return {
      schema_ready: true,
      tables,
      retention: this.getRetentionSummary(),
      modules,
      recent_errors: recentErrors,
    };
  }

  private getRetentionSummary() {
    return {
      request_event_days: PLATFORM_REQUEST_EVENT_RETENTION_DAYS,
      audit_event_days: PLATFORM_AUDIT_EVENT_RETENTION_DAYS,
      batch_size: PLATFORM_OBSERVABILITY_RETENTION_BATCH_SIZE,
    };
  }

  private async getTableHealth(tableName: 'platform_request_events' | 'platform_audit_events') {
    const existsRows = (await this.prisma.$queryRawUnsafe(
      `SELECT to_regclass($1::text)::text AS table_name`,
      tableName,
    )) as Array<{ table_name: string | null }>;
    if (!existsRows[0]?.table_name) {
      return {
        name: tableName,
        ready: false,
        estimated_rows: 0,
        latest_created_at: null,
      };
    }
    const [estimateRows, latestRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT GREATEST(c.reltuples, 0)::bigint AS estimated_rows
           FROM pg_class c
          WHERE c.oid = to_regclass($1::text)`,
        tableName,
      ) as Promise<Array<{ estimated_rows: string | number }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT created_at
           FROM ${tableName}
          ORDER BY created_at DESC
          LIMIT 1`,
      ) as Promise<Array<{ created_at: Date | string | null }>>),
    ]);
    return {
      name: tableName,
      ready: true,
      estimated_rows: Number(estimateRows[0]?.estimated_rows || 0),
      latest_created_at: latestRows[0]?.created_at || null,
    };
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
      CREATE TABLE IF NOT EXISTS platform_request_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id varchar(128) NULL,
        trace_id varchar(64) NULL,
        app_id uuid NULL REFERENCES apps(id) ON DELETE SET NULL,
        app_slug varchar(64) NULL,
        actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        module varchar(64) NOT NULL DEFAULT 'http',
        operation varchar(96) NOT NULL DEFAULT 'request',
        resource_type varchar(64) NULL,
        resource_id varchar(128) NULL,
        stage varchar(64) NOT NULL DEFAULT 'completed',
        method varchar(12) NULL,
        request_path varchar(255) NULL,
        success boolean NULL,
        status_code integer NULL,
        error_category varchar(64) NULL,
        error_message text NULL,
        latency_ms integer NULL,
        ip_address varchar(64) NULL,
        user_agent varchar(512) NULL,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_platform_request_events_request
      ON platform_request_events(request_id, created_at ASC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_platform_request_events_app_created
      ON platform_request_events(app_id, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_platform_request_events_module_created
      ON platform_request_events(module, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_platform_request_events_status_created
      ON platform_request_events(status_code, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_platform_request_events_resource
      ON platform_request_events(resource_type, resource_id, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_platform_request_events_created
      ON platform_request_events(created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS platform_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id varchar(128) NULL,
        actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        app_id uuid NULL REFERENCES apps(id) ON DELETE SET NULL,
        app_slug varchar(64) NULL,
        module varchar(64) NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_platform_audit_events_actor
      ON platform_audit_events(actor_user_id, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_platform_audit_events_app_created
      ON platform_audit_events(app_id, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_platform_audit_events_resource
      ON platform_audit_events(resource_type, resource_id, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_platform_audit_events_module_action
      ON platform_audit_events(module, action, created_at DESC)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_platform_audit_events_created
      ON platform_audit_events(created_at DESC)
    `);
    return true;
  }

  private async arePrerequisiteTablesReady(): Promise<boolean> {
    for (const tableName of ['apps', 'users']) {
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
      if (
        normalizedKey.includes('key') ||
        normalizedKey.includes('secret') ||
        normalizedKey.includes('token') ||
        normalizedKey.includes('credential') ||
        normalizedKey.includes('password')
      ) {
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
    return { page, limit, offset: (page - 1) * limit };
  }

  private paginated(rows: Record<string, unknown>[], paging: { page: number; limit: number; offset: number }) {
    const hasMore = rows.length > paging.limit;
    return {
      items: hasMore ? rows.slice(0, paging.limit) : rows,
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
    if (!normalized) return;
    if (!['true', 'false', '1', '0'].includes(normalized)) return;
    params.push(normalized === 'true' || normalized === '1');
    where.push(`${column} = $${params.length}`);
  }

  private addStatusMinFilter(where: string[], params: unknown[], value: unknown): void {
    const parsed = this.normalizeNullableInt(value);
    if (parsed === null) return;
    params.push(Math.min(599, Math.max(100, parsed)));
    where.push(`status_code >= $${params.length}::int`);
  }

  private addDaysFilter(where: string[], params: unknown[], column: string, value: unknown, fallbackDays: number): void {
    const days = Math.min(365, Math.max(1, this.normalizeNullableInt(value) || fallbackDays));
    params.push(days);
    where.push(`${column} >= now() - ($${params.length}::int * interval '1 day')`);
  }
}
