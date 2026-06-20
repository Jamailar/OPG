import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { createHash } from 'crypto';
import IORedis from 'ioredis';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AppSchemaService } from '../app-schema/app-schema.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { AppFunctionRow, AppFunctionRunRow, AppFunctionVersionRow } from './app-functions.types';

const IDENTIFIER_RE = /^[a-z][a-z0-9_]{1,78}$/;

@Injectable()
export class AppFunctionsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AppFunctionsService.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private redis: IORedis | null = null;
  private queueError: string | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly appSchemaService: AppSchemaService,
    private readonly realtimeEventsService: RealtimeEventsService,
  ) {}

  async onModuleInit() {
    const redisUrl = String(this.config.redis.url || process.env.REDIS_URL || '').trim();
    if (!redisUrl) {
      this.queueError = 'REDIS_URL is not configured; function runtime uses inline fallback';
      return;
    }
    try {
      this.redis = new IORedis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
      await this.redis.connect();
      this.queue = new Queue('opg-app-functions', { connection: this.redis as any });
      this.worker = new Worker('opg-app-functions', async (job) => this.runQueued(String(job.data?.run_id || '')), {
        connection: this.redis as any,
        concurrency: Number(process.env.OPG_FUNCTION_WORKER_CONCURRENCY || 4),
      });
    } catch (error: any) {
      this.queueError = String(error?.message || error).slice(0, 500);
      this.logger.warn(`function queue unavailable; using inline fallback: ${this.queueError}`);
      this.redis?.disconnect();
      this.redis = null;
      this.queue = null;
      this.worker = null;
    }
  }

  async onApplicationShutdown() {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    this.redis?.disconnect();
  }

  runtimeStatus() {
    return {
      queue: this.queue ? 'bullmq' : 'inline',
      redis_available: Boolean(this.queue),
      redis_error: this.queueError,
      supported_runtime: 'opg-js-v1',
    };
  }

  async listFunctions(appRef: string) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, slug, runtime, entrypoint, source_json, secrets_scope, trigger_json,
               status, current_version_id, created_at, updated_at
        FROM app_functions
        WHERE app_id = $1::uuid
          AND status <> 'DELETED'
        ORDER BY updated_at DESC
      `,
      app.id,
    ) as Promise<AppFunctionRow[]>);
    return { app, items: rows.map((row) => this.serializeFunction(row)) };
  }

  async createFunction(appRef: string, actor: any, body: Record<string, unknown>) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const slug = this.normalizeIdentifier(body.slug || body.name, 'function slug');
    const source = this.normalizeSource(body.source_json ?? body.source ?? { kind: 'echo' });
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_functions (
          app_id, slug, runtime, entrypoint, source_json, secrets_scope, trigger_json,
          status, created_by_user_id, updated_by_user_id
        ) VALUES ($1::uuid, $2, 'opg-js-v1', $3, $4::jsonb, $5, $6::jsonb, 'DRAFT', $7::uuid, $7::uuid)
        RETURNING id, app_id, slug, runtime, entrypoint, source_json, secrets_scope, trigger_json,
                  status, current_version_id, created_at, updated_at
      `,
      app.id,
      slug,
      String(body.entrypoint || 'handler').slice(0, 120),
      JSON.stringify(source),
      this.optionalString(body.secrets_scope, 120),
      JSON.stringify(this.jsonObject(body.trigger_json ?? body.trigger)),
      this.actorUserId(actor),
    ) as Promise<AppFunctionRow[]>);
    return { ok: true, app, function: this.serializeFunction(rows[0]) };
  }

  async deployFunction(appRef: string, functionRef: string, actor: any) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const fn = await this.resolveFunction(app.id, functionRef);
    const source = this.normalizeSource(fn.source_json);
    const sourceHash = this.sha256(JSON.stringify(source));
    const rows = await this.prisma.$transaction(async (tx) => {
      const versionRows = await (tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM app_function_versions WHERE function_id = $1::uuid`,
        fn.id,
      ) as Promise<Array<{ version: number }>>);
      const version = Number(versionRows[0]?.version || 1);
      const inserted = await (tx.$queryRawUnsafe(
        `
          INSERT INTO app_function_versions (
            function_id, app_id, version, source_hash, source_json, build_status, created_by_user_id
          ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, 'READY', $6::uuid)
          RETURNING id, function_id, app_id, version, source_hash, source_json, build_status, created_at
        `,
        fn.id,
        app.id,
        version,
        sourceHash,
        JSON.stringify(source),
        this.actorUserId(actor),
      ) as Promise<AppFunctionVersionRow[]>);
      await tx.$executeRawUnsafe(
        `UPDATE app_functions SET current_version_id = $1::uuid, status = 'ACTIVE', updated_at = now(), updated_by_user_id = $2::uuid WHERE id = $3::uuid`,
        inserted[0].id,
        this.actorUserId(actor),
        fn.id,
      );
      return inserted;
    });
    return { ok: true, app, function: this.serializeFunction({ ...fn, status: 'ACTIVE', current_version_id: rows[0].id }), version: this.serializeVersion(rows[0]) };
  }

  async invokeFunction(appRef: string, functionRef: string, actor: any, body: Record<string, unknown>) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const fn = await this.resolveFunction(app.id, functionRef);
    if (fn.status !== 'ACTIVE' || !fn.current_version_id) {
      throw new BadRequestException('Function is not deployed');
    }
    const version = await this.resolveVersion(fn.current_version_id);
    const runRows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_function_runs (
          app_id, function_id, version_id, trigger_type, input_json, status
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, 'QUEUED')
        RETURNING id, app_id, function_id, version_id, trigger_type, input_json, status,
                  output_json, error_json, usage_json, started_at, finished_at, created_at, updated_at
      `,
      app.id,
      fn.id,
      version.id,
      String(body.trigger_type || body.triggerType || 'manual').slice(0, 40),
      JSON.stringify(body.input ?? body),
    ) as Promise<AppFunctionRunRow[]>);
    const run = runRows[0];
    await this.publishRun(app.slug, run.id, 'job.queued', { function: fn.slug, status: run.status });
    if (this.queue) {
      await this.queue.add('invoke', { run_id: run.id }, { removeOnComplete: 1000, removeOnFail: 1000 });
      return { ok: true, queued: true, app, function: this.serializeFunction(fn), run: this.serializeRun(run), runtime: this.runtimeStatus() };
    }
    const completed = await this.runQueued(run.id);
    return { ok: true, queued: false, app, function: this.serializeFunction(fn), run: this.serializeRun(completed), runtime: this.runtimeStatus() };
  }

  async listRuns(appRef: string, functionRef: string) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const fn = await this.resolveFunction(app.id, functionRef);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, function_id, version_id, trigger_type, input_json, status,
               output_json, error_json, usage_json, started_at, finished_at, created_at, updated_at
        FROM app_function_runs
        WHERE function_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 100
      `,
      fn.id,
    ) as Promise<AppFunctionRunRow[]>);
    return { app, function: this.serializeFunction(fn), items: rows.map((row) => this.serializeRun(row)) };
  }

  async deleteFunction(appRef: string, functionRef: string, actor: any, body: Record<string, unknown> = {}) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const fn = await this.resolveFunction(app.id, functionRef);
    const confirm = String(body.confirm || '').trim();
    if (confirm !== `delete:${fn.slug}`) {
      throw new BadRequestException(`confirm must be delete:${fn.slug}`);
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE app_functions SET status = 'DELETED', updated_by_user_id = $1::uuid, updated_at = now() WHERE id = $2::uuid`,
      this.actorUserId(actor),
      fn.id,
    );
    return { ok: true, deleted: true, app, function: this.serializeFunction({ ...fn, status: 'DELETED' }) };
  }

  async runQueued(runId: string) {
    const run = await this.resolveRun(runId);
    const fn = await this.resolveFunction(run.app_id, run.function_id);
    const version = run.version_id ? await this.resolveVersion(run.version_id) : null;
    if (!version) throw new NotFoundException('Function version not found');
    await this.markRun(run.id, 'RUNNING', null, null, true);
    await this.appendLog(run, 'info', 'function started', { version: version.version });
    const startedAt = Date.now();
    try {
      const output = await this.executeStructuredSource(version.source_json, run.input_json);
      const completed = await this.markRun(run.id, 'SUCCEEDED', output, null, false, { duration_ms: Date.now() - startedAt });
      await this.appendLog(run, 'info', 'function succeeded', { duration_ms: Date.now() - startedAt });
      const app = await this.appSchemaService.resolveApp(run.app_id);
      await this.publishRun(app.slug, run.id, 'job.succeeded', { function: fn.slug, status: 'SUCCEEDED' });
      return completed;
    } catch (error: any) {
      const errorJson = { message: String(error?.message || error).slice(0, 2000) };
      const failed = await this.markRun(run.id, 'FAILED', null, errorJson, false, { duration_ms: Date.now() - startedAt });
      await this.appendLog(run, 'error', errorJson.message, {});
      const app = await this.appSchemaService.resolveApp(run.app_id);
      await this.publishRun(app.slug, run.id, 'job.failed', { function: fn.slug, status: 'FAILED', error: errorJson.message });
      return failed;
    }
  }

  private async executeStructuredSource(source: unknown, input: unknown) {
    const normalized = this.normalizeSource(source);
    if (normalized.kind === 'echo') {
      return { input };
    }
    if (normalized.kind === 'transform') {
      const inputObject = this.jsonObject(input);
      const output: Record<string, unknown> = {};
      const pick = Array.isArray(normalized.pick) ? normalized.pick.map((item: unknown) => String(item)) : [];
      for (const key of pick) output[key] = inputObject[key];
      Object.assign(output, this.jsonObject(normalized.set));
      return output;
    }
    throw new BadRequestException(`Unsupported function source kind: ${normalized.kind}`);
  }

  private async resolveFunction(appId: string, functionRef: string) {
    const normalized = String(functionRef || '').trim();
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, slug, runtime, entrypoint, source_json, secrets_scope, trigger_json,
               status, current_version_id, created_at, updated_at
        FROM app_functions
        WHERE app_id = $1::uuid
          AND (id::text = $2 OR slug = $2)
          AND status <> 'DELETED'
        LIMIT 1
      `,
      appId,
      normalized,
    ) as Promise<AppFunctionRow[]>);
    if (!rows[0]) throw new NotFoundException('Function not found');
    return rows[0];
  }

  private async resolveVersion(versionId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, function_id, app_id, version, source_hash, source_json, build_status, created_at
        FROM app_function_versions
        WHERE id = $1::uuid
        LIMIT 1
      `,
      versionId,
    ) as Promise<AppFunctionVersionRow[]>);
    if (!rows[0]) throw new NotFoundException('Function version not found');
    return rows[0];
  }

  private async resolveRun(runId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, function_id, version_id, trigger_type, input_json, status,
               output_json, error_json, usage_json, started_at, finished_at, created_at, updated_at
        FROM app_function_runs
        WHERE id = $1::uuid
        LIMIT 1
      `,
      runId,
    ) as Promise<AppFunctionRunRow[]>);
    if (!rows[0]) throw new NotFoundException('Function run not found');
    return rows[0];
  }

  private async markRun(runId: string, status: string, output: unknown, error: unknown, started: boolean, usage: Record<string, unknown> = {}) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        UPDATE app_function_runs
           SET status = $1,
               output_json = $2::jsonb,
               error_json = $3::jsonb,
               usage_json = $4::jsonb,
               started_at = CASE WHEN $5 THEN now() ELSE started_at END,
               finished_at = CASE WHEN $6 THEN now() ELSE finished_at END,
               updated_at = now()
         WHERE id = $7::uuid
        RETURNING id, app_id, function_id, version_id, trigger_type, input_json, status,
                  output_json, error_json, usage_json, started_at, finished_at, created_at, updated_at
      `,
      status,
      output === null ? null : JSON.stringify(output),
      error === null ? null : JSON.stringify(error),
      JSON.stringify(usage),
      started,
      !started,
      runId,
    ) as Promise<AppFunctionRunRow[]>);
    return rows[0];
  }

  private async appendLog(run: AppFunctionRunRow, level: string, message: string, data: unknown) {
    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO app_function_run_logs (run_id, app_id, level, message, data_json)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)
      `,
      run.id,
      run.app_id,
      level,
      message.slice(0, 4000),
      JSON.stringify(data || {}),
    );
  }

  private async publishRun(appSlug: string, runId: string, event: string, payload: Record<string, unknown>) {
    await this.realtimeEventsService.publish(`apps.${appSlug}.jobs.${runId}`, event, payload, { app_slug: appSlug, resource_id: runId });
  }

  private serializeFunction(row: AppFunctionRow) {
    return {
      id: row.id,
      app_id: row.app_id,
      slug: row.slug,
      runtime: row.runtime,
      entrypoint: row.entrypoint,
      source: this.jsonObject(row.source_json),
      secrets_scope: row.secrets_scope,
      trigger: this.jsonObject(row.trigger_json),
      status: row.status,
      current_version_id: row.current_version_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private serializeVersion(row: AppFunctionVersionRow) {
    return { id: row.id, version: row.version, source_hash: row.source_hash, build_status: row.build_status, created_at: row.created_at };
  }

  private serializeRun(row: AppFunctionRunRow) {
    return {
      id: row.id,
      function_id: row.function_id,
      version_id: row.version_id,
      trigger_type: row.trigger_type,
      input: this.jsonObject(row.input_json),
      status: row.status,
      output: row.output_json,
      error: row.error_json,
      usage: this.jsonObject(row.usage_json),
      started_at: row.started_at,
      finished_at: row.finished_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private normalizeSource(value: unknown) {
    const source = this.jsonObject(value);
    const kind = String(source.kind || 'echo').trim();
    if (!['echo', 'transform'].includes(kind)) {
      throw new BadRequestException('source.kind must be echo or transform');
    }
    return { ...source, kind } as Record<string, any> & { kind: string };
  }

  private normalizeIdentifier(value: unknown, label: string) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
    if (!IDENTIFIER_RE.test(normalized)) throw new BadRequestException(`Invalid ${label}`);
    return normalized;
  }

  private optionalString(value: unknown, maxLength: number) {
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  private actorUserId(actor: any) {
    const userId = String(actor?.userId || actor?.id || '').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId) ? userId : null;
  }

  private sha256(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private jsonObject(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  }
}
