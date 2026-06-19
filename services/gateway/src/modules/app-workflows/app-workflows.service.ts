import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AppFunctionsService } from '../app-functions/app-functions.service';
import { AppBlocksService } from '../app-blocks/app-blocks.service';
import { AppSchemaService } from '../app-schema/app-schema.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { AppWorkflowRow, AppWorkflowRunRow, WorkflowStepDefinition } from './app-workflows.types';

const IDENTIFIER_RE = /^[a-z][a-z0-9_]{1,78}$/;

@Injectable()
export class AppWorkflowsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AppWorkflowsService.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private redis: IORedis | null = null;
  private queueError: string | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly appSchemaService: AppSchemaService,
    private readonly appFunctionsService: AppFunctionsService,
    private readonly appBlocksService: AppBlocksService,
    private readonly realtimeEventsService: RealtimeEventsService,
  ) {}

  async onModuleInit() {
    const redisUrl = String(this.config.redis.url || process.env.REDIS_URL || '').trim();
    if (!redisUrl) {
      this.queueError = 'REDIS_URL is not configured; workflow runtime uses inline fallback';
      return;
    }
    try {
      this.redis = new IORedis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
      await this.redis.connect();
      this.queue = new Queue('opg-app-workflows', { connection: this.redis as any });
      this.worker = new Worker('opg-app-workflows', async (job) => this.runQueued(String(job.data?.run_id || ''), this.deserializeQueuedActor(job.data?.actor)), {
        connection: this.redis as any,
        concurrency: Number(process.env.OPG_WORKFLOW_WORKER_CONCURRENCY || 2),
      });
    } catch (error: any) {
      this.queueError = String(error?.message || error).slice(0, 500);
      this.logger.warn(`workflow queue unavailable; using inline fallback: ${this.queueError}`);
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
    return { queue: this.queue ? 'bullmq' : 'inline', redis_available: Boolean(this.queue), redis_error: this.queueError };
  }

  async listWorkflows(appRef: string) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, slug, name, trigger_json, steps_json, input_schema_json,
               output_schema_json, status, created_at, updated_at
        FROM app_workflows
        WHERE app_id = $1::uuid
          AND status <> 'DELETED'
        ORDER BY updated_at DESC
      `,
      app.id,
    ) as Promise<AppWorkflowRow[]>);
    return { app, items: rows.map((row) => this.serializeWorkflow(row)) };
  }

  async createWorkflow(appRef: string, actor: any, body: Record<string, unknown>) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const slug = this.normalizeIdentifier(body.slug || body.name, 'workflow slug');
    const steps = this.normalizeSteps(body.steps || body.steps_json || []);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_workflows (
          app_id, slug, name, trigger_json, steps_json, input_schema_json, output_schema_json,
          status, created_by_user_id, updated_by_user_id
        ) VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::uuid, $9::uuid)
        RETURNING id, app_id, slug, name, trigger_json, steps_json, input_schema_json,
                  output_schema_json, status, created_at, updated_at
      `,
      app.id,
      slug,
      this.optionalString(body.name || slug, 160),
      JSON.stringify(this.jsonObject(body.trigger || body.trigger_json)),
      JSON.stringify(steps),
      JSON.stringify(this.jsonObject(body.input_schema || body.input_schema_json)),
      JSON.stringify(this.jsonObject(body.output_schema || body.output_schema_json)),
      String(body.status || 'ACTIVE').toUpperCase() === 'DRAFT' ? 'DRAFT' : 'ACTIVE',
      this.actorUserId(actor),
    ) as Promise<AppWorkflowRow[]>);
    return { ok: true, app, workflow: this.serializeWorkflow(rows[0]) };
  }

  async runWorkflow(appRef: string, workflowRef: string, actor: any, body: Record<string, unknown>) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const workflow = await this.resolveWorkflow(app.id, workflowRef);
    if (workflow.status !== 'ACTIVE') throw new BadRequestException('Workflow is not active');
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_workflow_runs (app_id, workflow_id, trigger_type, input_json, status)
        VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, 'QUEUED')
        RETURNING id, app_id, workflow_id, trigger_type, input_json, output_json, status,
                  error_json, usage_json, started_at, finished_at, created_at, updated_at
      `,
      app.id,
      workflow.id,
      String(body.trigger_type || body.triggerType || 'manual').slice(0, 40),
      JSON.stringify(body.input ?? body),
    ) as Promise<AppWorkflowRunRow[]>);
    const run = rows[0];
    await this.publishRun(app.slug, run.id, 'job.queued', { workflow: workflow.slug, status: run.status });
    if (this.queue) {
      await this.queue.add('run', { run_id: run.id, actor: this.serializeQueuedActor(actor) }, { removeOnComplete: 1000, removeOnFail: 1000 });
      return { ok: true, queued: true, app, workflow: this.serializeWorkflow(workflow), run: this.serializeRun(run), runtime: this.runtimeStatus() };
    }
    const completed = await this.runQueued(run.id, actor);
    return { ok: true, queued: false, app, workflow: this.serializeWorkflow(workflow), run: this.serializeRun(completed), runtime: this.runtimeStatus() };
  }

  async listRuns(appRef: string, workflowRef: string) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const workflow = await this.resolveWorkflow(app.id, workflowRef);
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, workflow_id, trigger_type, input_json, output_json, status,
               error_json, usage_json, started_at, finished_at, created_at, updated_at
        FROM app_workflow_runs
        WHERE workflow_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 100
      `,
      workflow.id,
    ) as Promise<AppWorkflowRunRow[]>);
    return { app, workflow: this.serializeWorkflow(workflow), items: rows.map((row) => this.serializeRun(row)) };
  }

  async deleteWorkflow(appRef: string, workflowRef: string, actor: any, body: Record<string, unknown> = {}) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const workflow = await this.resolveWorkflow(app.id, workflowRef);
    const confirm = String(body.confirm || '').trim();
    if (confirm !== `delete:${workflow.slug}`) {
      throw new BadRequestException(`confirm must be delete:${workflow.slug}`);
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE app_workflows SET status = 'DELETED', updated_by_user_id = $1::uuid, updated_at = now() WHERE id = $2::uuid`,
      this.actorUserId(actor),
      workflow.id,
    );
    return { ok: true, deleted: true, app, workflow: this.serializeWorkflow({ ...workflow, status: 'DELETED' }) };
  }

  async runQueued(runId: string, actor: any = { authMode: 'workflow' }) {
    const run = await this.resolveRun(runId);
    const app = await this.appSchemaService.resolveApp(run.app_id);
    const workflow = await this.resolveWorkflow(run.app_id, run.workflow_id);
    const steps = this.normalizeSteps(workflow.steps_json);
    await this.markRun(run.id, 'RUNNING', null, null, true);
    await this.publishRun(app.slug, run.id, 'job.running', { workflow: workflow.slug, status: 'RUNNING' });
    const context: Record<string, unknown> = { input: run.input_json, steps: {} };
    try {
      for (const [index, step] of steps.entries()) {
        const stepKey = String(step.id || `step_${index + 1}`);
        const stepType = String(step.type || 'noop');
        const stepRow = await this.createStepRun(run, workflow, stepKey, stepType, step);
        const output = await this.executeStep(app.slug, actor, step, context);
        await this.completeStepRun(stepRow.id, 'SUCCEEDED', output, null);
        (context.steps as Record<string, unknown>)[stepKey] = output;
      }
      const completed = await this.markRun(run.id, 'SUCCEEDED', context, null, false, { steps: steps.length });
      await this.publishRun(app.slug, run.id, 'job.succeeded', { workflow: workflow.slug, status: 'SUCCEEDED' });
      return completed;
    } catch (error: any) {
      const errorJson = { message: String(error?.message || error).slice(0, 2000) };
      const failed = await this.markRun(run.id, 'FAILED', null, errorJson, false, {});
      await this.publishRun(app.slug, run.id, 'job.failed', { workflow: workflow.slug, status: 'FAILED', error: errorJson.message });
      return failed;
    }
  }

  private async executeStep(appSlug: string, actor: any, step: WorkflowStepDefinition, context: Record<string, unknown>) {
    const type = String(step.type || 'noop');
    const input = step.input ?? context.input;
    if (type === 'noop') return { ok: true, input };
    if (type === 'function.invoke') {
      const slug = String(step.function || step.function_slug || step.slug || '').trim();
      if (!slug) throw new BadRequestException('function.invoke step requires function');
      return this.appFunctionsService.invokeFunction(appSlug, slug, actor, { input });
    }
    if (type === 'data.query') {
      const table = String(step.table || '').trim();
      if (!table) throw new BadRequestException('data.query step requires table');
      return this.appSchemaService.listRows(appSlug, table, actor, this.jsonObject(step.query));
    }
    if (type === 'data.create') {
      const table = String(step.table || '').trim();
      if (!table) throw new BadRequestException('data.create step requires table');
      return this.appSchemaService.createRow(appSlug, table, actor, this.jsonObject(input));
    }
    if (type === 'ai.generate_text') {
      return this.appBlocksService.runAiBlock(appSlug, String(step.block || step.ai_block || step.slug || ''), actor, this.jsonObject(input));
    }
    if (type === 'video.generate') {
      return this.appBlocksService.runVideoBlock(appSlug, String(step.block || step.video_block || step.slug || ''), actor, this.jsonObject(input));
    }
    if (type === 'storage.save') {
      return this.appBlocksService.saveStorageObject(appSlug, actor, this.jsonObject(input));
    }
    throw new BadRequestException(`Unsupported workflow step type: ${type}`);
  }

  private async createStepRun(run: AppWorkflowRunRow, workflow: AppWorkflowRow, stepKey: string, stepType: string, input: unknown) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_workflow_run_steps (run_id, app_id, workflow_id, step_key, step_type, input_json, status, started_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, 'RUNNING', now())
        RETURNING id
      `,
      run.id,
      run.app_id,
      workflow.id,
      stepKey,
      stepType,
      JSON.stringify(input),
    ) as Promise<Array<{ id: string }>>);
    return rows[0];
  }

  private async completeStepRun(stepRunId: string, status: string, output: unknown, error: unknown) {
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE app_workflow_run_steps
           SET status = $1, output_json = $2::jsonb, error_json = $3::jsonb, finished_at = now(), updated_at = now()
         WHERE id = $4::uuid
      `,
      status,
      output === null ? null : JSON.stringify(output),
      error === null ? null : JSON.stringify(error),
      stepRunId,
    );
  }

  private async resolveWorkflow(appId: string, workflowRef: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, slug, name, trigger_json, steps_json, input_schema_json,
               output_schema_json, status, created_at, updated_at
        FROM app_workflows
        WHERE app_id = $1::uuid
          AND (id::text = $2 OR slug = $2)
          AND status <> 'DELETED'
        LIMIT 1
      `,
      appId,
      String(workflowRef || '').trim(),
    ) as Promise<AppWorkflowRow[]>);
    if (!rows[0]) throw new NotFoundException('Workflow not found');
    return rows[0];
  }

  private async resolveRun(runId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        SELECT id, app_id, workflow_id, trigger_type, input_json, output_json, status,
               error_json, usage_json, started_at, finished_at, created_at, updated_at
        FROM app_workflow_runs
        WHERE id = $1::uuid
        LIMIT 1
      `,
      runId,
    ) as Promise<AppWorkflowRunRow[]>);
    if (!rows[0]) throw new NotFoundException('Workflow run not found');
    return rows[0];
  }

  private async markRun(runId: string, status: string, output: unknown, error: unknown, started: boolean, usage: Record<string, unknown> = {}) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        UPDATE app_workflow_runs
           SET status = $1,
               output_json = $2::jsonb,
               error_json = $3::jsonb,
               usage_json = $4::jsonb,
               started_at = CASE WHEN $5 THEN now() ELSE started_at END,
               finished_at = CASE WHEN $6 THEN now() ELSE finished_at END,
               updated_at = now()
         WHERE id = $7::uuid
        RETURNING id, app_id, workflow_id, trigger_type, input_json, output_json, status,
                  error_json, usage_json, started_at, finished_at, created_at, updated_at
      `,
      status,
      output === null ? null : JSON.stringify(output),
      error === null ? null : JSON.stringify(error),
      JSON.stringify(usage),
      started,
      !started,
      runId,
    ) as Promise<AppWorkflowRunRow[]>);
    return rows[0];
  }

  private async publishRun(appSlug: string, runId: string, event: string, payload: Record<string, unknown>) {
    await this.realtimeEventsService.publish(`apps.${appSlug}.jobs.${runId}`, event, payload, { app_slug: appSlug, resource_id: runId });
  }

  private serializeQueuedActor(actor: any) {
    if (!actor || typeof actor !== 'object') {
      return { authMode: 'workflow' };
    }
    return {
      id: this.optionalString(actor.id || actor.userId, 80),
      userId: this.optionalString(actor.userId || actor.id, 80),
      email: this.optionalString(actor.email, 180),
      role: this.optionalString(actor.role, 40),
      appSlug: this.optionalString(actor.appSlug, 100),
      authMode: this.optionalString(actor.authMode, 40),
      apiKeyId: this.optionalString(actor.apiKeyId, 80),
      developerGrantId: this.optionalString(actor.developerGrantId, 80),
      developerGrantName: this.optionalString(actor.developerGrantName, 160),
      scopes: Array.isArray(actor.scopes) ? actor.scopes.map((item: unknown) => String(item)).slice(0, 80) : undefined,
      developerScopes: Array.isArray(actor.developerScopes) ? actor.developerScopes.map((item: unknown) => String(item)).slice(0, 80) : undefined,
      allowedAppIds: Array.isArray(actor.allowedAppIds) ? actor.allowedAppIds.map((item: unknown) => String(item)).slice(0, 200) : undefined,
    };
  }

  private deserializeQueuedActor(value: unknown) {
    const actor = this.jsonObject(value);
    return Object.keys(actor).length ? actor : { authMode: 'workflow' };
  }

  private serializeWorkflow(row: AppWorkflowRow) {
    return {
      id: row.id,
      app_id: row.app_id,
      slug: row.slug,
      name: row.name,
      trigger: this.jsonObject(row.trigger_json),
      steps: this.normalizeSteps(row.steps_json),
      input_schema: this.jsonObject(row.input_schema_json),
      output_schema: this.jsonObject(row.output_schema_json),
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private serializeRun(row: AppWorkflowRunRow) {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      trigger_type: row.trigger_type,
      input: this.jsonObject(row.input_json),
      output: row.output_json,
      status: row.status,
      error: row.error_json,
      usage: this.jsonObject(row.usage_json),
      started_at: row.started_at,
      finished_at: row.finished_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private normalizeSteps(value: unknown): WorkflowStepDefinition[] {
    if (!Array.isArray(value)) throw new BadRequestException('workflow steps must be an array');
    if (value.length > 80) throw new BadRequestException('workflow has too many steps');
    return value.map((item, index) => {
      const step = this.jsonObject(item);
      const type = String(step.type || 'noop').trim();
      if (!type) throw new BadRequestException(`workflow step ${index + 1} type is required`);
      return { ...step, type, id: String(step.id || `step_${index + 1}`) };
    });
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
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(userId) ? userId : null;
  }

  private jsonObject(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  }
}
