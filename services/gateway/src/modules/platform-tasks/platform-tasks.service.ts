import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import { PlatformObservabilityService } from '../observability/platform-observability.service';
import { PlatformTaskQueueService } from './platform-task-queue.service';
import {
  AppendPlatformTaskEventInput,
  AppendPlatformTaskLogInput,
  CreatePlatformTaskInput,
  ListPlatformTasksInput,
  PlatformTaskHandler,
  PlatformTaskHandlerContext,
  PlatformTaskStatus,
  TransitionPlatformTaskInput,
} from './platform-tasks.types';

const TASK_STATUSES: PlatformTaskStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'retrying', 'expired'];
const TERMINAL_STATUSES = new Set<PlatformTaskStatus>(['succeeded', 'failed', 'cancelled', 'expired']);

@Injectable()
export class PlatformTasksService implements OnModuleInit {
  private readonly logger = new Logger(PlatformTasksService.name);
  private schemaReady = false;
  private schemaPromise: Promise<boolean> | null = null;
  private readonly handlers = new Map<string, PlatformTaskHandler>();

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly queueService: PlatformTaskQueueService,
    private readonly observabilityService: PlatformObservabilityService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`platform tasks schema warmup failed: ${error?.message || error}`);
    }
  }

  async getRuntime() {
    const schemaReady = await this.ensureSchema();
    return this.serialize({
      schema_ready: schemaReady,
      queue: this.queueService.getStatus(),
      registered_handlers: this.listRegisteredHandlers(),
      summary: schemaReady ? await this.getSummary() : null,
    });
  }

  registerHandler(module: string, action: string, handler: PlatformTaskHandler) {
    const key = this.handlerKey(module, action);
    this.handlers.set(key, handler);
    this.logger.log(`registered platform task handler: ${key}`);
  }

  listRegisteredHandlers() {
    return [...this.handlers.keys()].sort();
  }

  async createTask(input: CreatePlatformTaskInput, actorUserId?: string | null) {
    if (!(await this.ensureSchema())) throw new BadRequestException('platform task schema is not ready');
    const normalized = {
      app_id: this.nullableUuid(input.app_id),
      environment_key: this.requiredText(input.environment_key, 64, 'production'),
      module: this.requiredText(input.module, 64, 'platform'),
      action: this.requiredText(input.action, 96, 'run'),
      idempotency_key: this.nullableText(input.idempotency_key, 160),
      queue_name: this.requiredText(input.queue_name, 64, 'default'),
      source_type: this.nullableText(input.source_type, 64),
      source_id: this.nullableText(input.source_id, 128),
      actor_user_id: this.nullableUuid(input.actor_user_id || actorUserId),
      request_id: this.nullableText(input.request_id, 128),
      priority: this.intValue(input.priority, 0, 0, 100000),
      max_attempts: this.intValue(input.max_attempts, 1, 1, 20),
      timeout_ms: this.intValue(input.timeout_ms, 600000, 1000, 86_400_000),
      input_summary: this.objectValue(input.input_summary),
      output_summary: this.objectValue(input.output_summary),
      cost_estimate: this.objectValue(input.cost_estimate),
    };

    const rows = (await this.prisma.$queryRawUnsafe(
      `INSERT INTO platform_tasks (
         id, app_id, environment_key, module, action, status, idempotency_key, queue_name,
         source_type, source_id, actor_user_id, request_id, priority, max_attempts,
         timeout_ms, input_summary_json, output_summary_json, cost_estimate_json, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3, $4, 'queued', $5, $6,
         $7, $8, $9::uuid, $10, $11::int, $12::int,
         $13::int, $14::jsonb, $15::jsonb, $16::jsonb, now(), now()
       )
       ON CONFLICT (app_id, module, action, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO UPDATE SET updated_at = platform_tasks.updated_at
       RETURNING *, (xmax = 0) AS inserted`,
      normalized.app_id,
      normalized.environment_key,
      normalized.module,
      normalized.action,
      normalized.idempotency_key,
      normalized.queue_name,
      normalized.source_type,
      normalized.source_id,
      normalized.actor_user_id,
      normalized.request_id,
      normalized.priority,
      normalized.max_attempts,
      normalized.timeout_ms,
      JSON.stringify(normalized.input_summary),
      JSON.stringify(normalized.output_summary),
      JSON.stringify(normalized.cost_estimate),
    )) as Record<string, unknown>[];

    const task = rows[0];
    if (task && task.inserted === false) {
      return this.getTask(String(task.id));
    }
    await this.appendEvent(String(task.id), {
      event_type: 'task.created',
      stage: 'queued',
      payload: {
        module: normalized.module,
        action: normalized.action,
        queue_name: normalized.queue_name,
      },
    });
    const queueResult = await this.queueService.enqueue({
      id: String(task.id),
      module: normalized.module,
      action: normalized.action,
      queue_name: normalized.queue_name,
      priority: normalized.priority,
    });
    await this.appendEvent(String(task.id), {
      event_type: 'task.enqueued',
      stage: queueResult.backend,
      payload: queueResult,
    });
    this.observabilityService.recordAuditEventSafe({
      actor_user_id: normalized.actor_user_id,
      app_id: normalized.app_id,
      module: 'platform_tasks',
      action: 'create',
      resource_type: 'platform_task',
      resource_id: String(task.id),
      after: task,
      metadata: { task_module: normalized.module, task_action: normalized.action, queue_backend: queueResult.backend },
    });
    return this.getTask(String(task.id));
  }

  async listTasks(input: ListPlatformTasksInput = {}) {
    const paging = this.parsePaging(input.page, input.page_size, 80);
    if (!(await this.ensureSchema())) return this.paginated([], paging);
    const where: string[] = [];
    const params: unknown[] = [];
    this.addUuidFilter(where, params, 'app_id', input.app_id);
    this.addTextFilter(where, params, 'module', input.module, 64);
    this.addTextFilter(where, params, 'action', input.action, 96);
    this.addStatusFilter(where, params, input.status);
    this.addTextFilter(where, params, 'queue_name', input.queue_name, 64);
    this.addTextFilter(where, params, 'request_id', input.request_id, 128);
    this.addTextFilter(where, params, 'source_type', input.source_type, 64);
    this.addTextFilter(where, params, 'source_id', input.source_id, 128);
    this.addDaysFilter(where, params, input.days, 7);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM platform_tasks
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      ...params,
      paging.limit + 1,
      paging.offset,
    )) as Record<string, unknown>[];
    return this.serialize(this.paginated(rows, paging));
  }

  async getTask(taskId: string, appId?: string | null) {
    if (!(await this.ensureSchema())) throw new NotFoundException('platform task schema is not ready');
    const normalizedAppId = this.nullableUuid(appId);
    const appFilter = normalizedAppId ? ` AND app_id = $2::uuid` : '';
    const params = normalizedAppId ? [this.requiredUuid(taskId), normalizedAppId] : [this.requiredUuid(taskId)];
    const taskRows = (await this.prisma.$queryRawUnsafe(
      `SELECT * FROM platform_tasks WHERE id = $1::uuid${appFilter} LIMIT 1`,
      ...params,
    )) as Record<string, unknown>[];
    const task = taskRows[0];
    if (!task) throw new NotFoundException('platform task not found');
    const [events, logs] = await Promise.all([
      this.prisma.$queryRawUnsafe(
        `SELECT * FROM platform_task_events WHERE task_id = $1::uuid ORDER BY seq DESC LIMIT 80`,
        taskId,
      ) as Promise<Record<string, unknown>[]>,
      this.prisma.$queryRawUnsafe(
        `SELECT * FROM platform_task_logs WHERE task_id = $1::uuid ORDER BY seq DESC LIMIT 120`,
        taskId,
      ) as Promise<Record<string, unknown>[]>,
    ]);
    return this.serialize({
      task,
      events: events.reverse(),
      logs: logs.reverse(),
    });
  }

  async transitionTask(taskId: string, status: PlatformTaskStatus, input: TransitionPlatformTaskInput = {}, actorUserId?: string | null) {
    if (!TASK_STATUSES.includes(status)) throw new BadRequestException('invalid task status');
    const current = (await this.getTask(taskId)).task as { status?: string; app_id?: string | null };
    if (TERMINAL_STATUSES.has(String(current.status) as PlatformTaskStatus)) {
      throw new BadRequestException('terminal task cannot transition');
    }
    const progress = this.intValue(input.progress, status === 'succeeded' ? 100 : undefined, 0, 100);
    const startedAtSql = status === 'running' ? `started_at = COALESCE(started_at, now()), locked_at = now(),` : '';
    const finishedAtSql = TERMINAL_STATUSES.has(status) ? `finished_at = now(),` : '';
    const cancelledAtSql = status === 'cancelled' ? `cancelled_at = now(),` : '';
    const rows = (await this.prisma.$queryRawUnsafe(
      `UPDATE platform_tasks
          SET status = $2,
              worker_id = COALESCE($3, worker_id),
              progress = COALESCE($4::int, progress),
              output_summary_json = COALESCE($5::jsonb, output_summary_json),
              result_json = COALESCE($6::jsonb, result_json),
              error_code = $7,
              error_message = $8,
              next_retry_at = $9::timestamptz,
              ${startedAtSql}
              ${finishedAtSql}
              ${cancelledAtSql}
              updated_at = now()
        WHERE id = $1::uuid
        RETURNING *`,
      taskId,
      status,
      this.nullableText(input.worker_id, 128),
      progress,
      input.output_summary ? JSON.stringify(this.objectValue(input.output_summary)) : null,
      input.result ? JSON.stringify(this.objectValue(input.result)) : null,
      this.nullableText(input.error_code, 128),
      this.nullableText(input.error_message, 1200),
      input.next_retry_at || null,
    )) as Record<string, unknown>[];
    const task = rows[0];
    await this.appendEvent(taskId, {
      event_type: `task.${status}`,
      stage: status,
      payload: { worker_id: input.worker_id || null, progress },
    });
    this.observabilityService.recordAuditEventSafe({
      actor_user_id: actorUserId || null,
      app_id: typeof current.app_id === 'string' ? current.app_id : null,
      module: 'platform_tasks',
      action: 'transition',
      resource_type: 'platform_task',
      resource_id: taskId,
      before: current,
      after: task,
      metadata: { status },
    });
    return this.getTask(taskId);
  }

  async cancelTask(taskId: string, actorUserId?: string | null) {
    return this.transitionTask(taskId, 'cancelled', { error_code: 'CANCELLED_BY_OPERATOR' }, actorUserId);
  }

  async runTaskWorker(taskId: string, workerId = this.defaultWorkerId()) {
    if (!(await this.ensureSchema())) throw new BadRequestException('platform task schema is not ready');
    const claimed = await this.claimTaskById(taskId, workerId);
    if (!claimed) {
      await this.appendEvent(taskId, {
        event_type: 'task.worker.skipped',
        stage: 'skipped',
        payload: { worker_id: workerId, reason: 'not runnable' },
      }).catch(() => undefined);
      return this.getTask(taskId);
    }
    return this.executeClaimedTask(claimed, workerId);
  }

  async claimAndRunNext(workerId = this.defaultWorkerId()) {
    if (!(await this.ensureSchema())) return null;
    const claimed = await this.claimNextRunnableTask(workerId);
    if (!claimed) return null;
    return this.executeClaimedTask(claimed, workerId);
  }

  private async claimTaskById(taskId: string, workerId: string) {
    const rows = (await this.prisma.$queryRawUnsafe(
      `UPDATE platform_tasks
          SET status = 'running',
              attempts = attempts + 1,
              worker_id = $2,
              locked_at = now(),
              started_at = COALESCE(started_at, now()),
              updated_at = now()
        WHERE id = $1::uuid
          AND status IN ('queued', 'retrying')
          AND (next_retry_at IS NULL OR next_retry_at <= now())
        RETURNING *`,
      this.requiredUuid(taskId),
      this.requiredText(workerId, 128, this.defaultWorkerId()),
    )) as Record<string, unknown>[];
    return rows[0] || null;
  }

  private async claimNextRunnableTask(workerId: string) {
    const rows = (await this.prisma.$queryRawUnsafe(
      `WITH picked AS (
         SELECT id
           FROM platform_tasks
          WHERE status IN ('queued', 'retrying')
            AND (next_retry_at IS NULL OR next_retry_at <= now())
          ORDER BY priority DESC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE platform_tasks
          SET status = 'running',
              attempts = attempts + 1,
              worker_id = $1,
              locked_at = now(),
              started_at = COALESCE(started_at, now()),
              updated_at = now()
         FROM picked
        WHERE platform_tasks.id = picked.id
        RETURNING platform_tasks.*`,
      this.requiredText(workerId, 128, this.defaultWorkerId()),
    )) as Record<string, unknown>[];
    return rows[0] || null;
  }

  private async executeClaimedTask(task: Record<string, unknown>, workerId: string) {
    const taskId = String(task.id || '');
    const module = String(task.module || '');
    const action = String(task.action || '');
    const handler = this.handlers.get(this.handlerKey(module, action));
    const attempt = Number(task.attempts || 1);
    const maxAttempts = Number(task.max_attempts || 1);

    await this.appendEvent(taskId, {
      event_type: 'task.running',
      stage: 'running',
      payload: { worker_id: workerId, attempt, handler: handler ? this.handlerKey(module, action) : null },
    });

    if (!handler) {
      return this.finishTaskFailure(task, workerId, {
        error_code: 'UNSUPPORTED_TASK_HANDLER',
        error_message: `No platform task handler registered for ${module}.${action}`,
        retryable: false,
      });
    }

    const context: PlatformTaskHandlerContext = {
      task,
      input: this.objectValue(task.input_summary_json),
      worker_id: workerId,
      appendLog: async (message, metadata, stream = 'stdout') => {
        await this.appendLog(taskId, { message, metadata, stream });
      },
      appendEvent: async (event_type, payload, stage) => {
        await this.appendEvent(taskId, { event_type, payload, stage });
      },
      setProgress: async (progress, outputSummary) => {
        await this.updateTaskProgress(taskId, progress, outputSummary);
      },
    };

    try {
      await context.appendLog(`handler ${module}.${action} started`, { attempt, worker_id: workerId }, 'system');
      const result = await handler(context);
      await context.setProgress(100, this.objectValue(result));
      const rows = (await this.prisma.$queryRawUnsafe(
        `UPDATE platform_tasks
            SET status = 'succeeded',
                progress = 100,
                result_json = $2::jsonb,
                output_summary_json = COALESCE($3::jsonb, output_summary_json),
                error_code = NULL,
                error_message = NULL,
                locked_at = NULL,
                finished_at = now(),
                updated_at = now()
          WHERE id = $1::uuid
          RETURNING *`,
        taskId,
        JSON.stringify(this.objectValue(result)),
        JSON.stringify(this.objectValue(result)),
      )) as Record<string, unknown>[];
      await this.appendEvent(taskId, {
        event_type: 'task.succeeded',
        stage: 'succeeded',
        payload: { worker_id: workerId },
      });
      return this.getTask(taskId, typeof rows[0]?.app_id === 'string' ? String(rows[0].app_id) : undefined);
    } catch (error: any) {
      return this.finishTaskFailure(task, workerId, {
        error_code: 'HANDLER_ERROR',
        error_message: String(error?.message || error || 'handler failed').slice(0, 2000),
        retryable: attempt < maxAttempts,
      });
    }
  }

  private async finishTaskFailure(
    task: Record<string, unknown>,
    workerId: string,
    input: { error_code: string; error_message: string; retryable: boolean },
  ) {
    const taskId = String(task.id || '');
    const attempt = Number(task.attempts || 1);
    const maxAttempts = Number(task.max_attempts || 1);
    const retryable = input.retryable && attempt < maxAttempts;
    const status: PlatformTaskStatus = retryable ? 'retrying' : 'failed';
    const nextRetrySeconds = retryable ? Math.min(300, 10 * Math.max(1, attempt) ** 2) : null;
    const rows = (await this.prisma.$queryRawUnsafe(
      `UPDATE platform_tasks
          SET status = $2,
              error_code = $3,
              error_message = $4,
              next_retry_at = CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int * interval '1 second') END,
              locked_at = NULL,
              finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE finished_at END,
              updated_at = now()
        WHERE id = $1::uuid
        RETURNING *`,
      taskId,
      status,
      input.error_code,
      input.error_message,
      nextRetrySeconds,
    )) as Record<string, unknown>[];
    await this.appendLog(taskId, {
      stream: 'stderr',
      message: input.error_message,
      metadata: { worker_id: workerId, error_code: input.error_code, retryable, attempt, max_attempts: maxAttempts },
    }).catch(() => undefined);
    await this.appendEvent(taskId, {
      event_type: retryable ? 'task.retrying' : 'task.failed',
      stage: status,
      payload: { worker_id: workerId, error_code: input.error_code, retryable, next_retry_seconds: nextRetrySeconds },
    }).catch(() => undefined);
    return this.getTask(taskId, typeof rows[0]?.app_id === 'string' ? String(rows[0].app_id) : undefined);
  }

  private async updateTaskProgress(taskId: string, progress: number, outputSummary?: Record<string, unknown>) {
    const normalized = this.intValue(progress, 0, 0, 100) || 0;
    await this.prisma.$executeRawUnsafe(
      `UPDATE platform_tasks
          SET progress = $2,
              output_summary_json = COALESCE($3::jsonb, output_summary_json),
              updated_at = now()
        WHERE id = $1::uuid`,
      this.requiredUuid(taskId),
      normalized,
      outputSummary ? JSON.stringify(this.objectValue(outputSummary)) : null,
    );
  }

  async appendEvent(taskId: string, input: AppendPlatformTaskEventInput) {
    if (!(await this.ensureSchema())) return null;
    const rows = (await this.prisma.$queryRawUnsafe(
      `WITH next_seq AS (
         SELECT COALESCE(MAX(seq), 0) + 1 AS seq
           FROM platform_task_events
          WHERE task_id = $1::uuid
       )
       INSERT INTO platform_task_events (id, task_id, seq, event_type, stage, payload_json, created_at)
       SELECT gen_random_uuid(), $1::uuid, next_seq.seq, $2, $3, $4::jsonb, now()
         FROM next_seq
       RETURNING *`,
      this.requiredUuid(taskId),
      this.requiredText(input.event_type, 96, 'task.event'),
      this.nullableText(input.stage, 64),
      JSON.stringify(this.objectValue(input.payload)),
    )) as Record<string, unknown>[];
    return rows[0] || null;
  }

  async appendLog(taskId: string, input: AppendPlatformTaskLogInput) {
    if (!(await this.ensureSchema())) return null;
    const rows = (await this.prisma.$queryRawUnsafe(
      `WITH next_seq AS (
         SELECT COALESCE(MAX(seq), 0) + 1 AS seq
           FROM platform_task_logs
          WHERE task_id = $1::uuid
       )
       INSERT INTO platform_task_logs (id, task_id, seq, stream, message_redacted, metadata_json, created_at)
       SELECT gen_random_uuid(), $1::uuid, next_seq.seq, $2, $3, $4::jsonb, now()
         FROM next_seq
       RETURNING *`,
      this.requiredUuid(taskId),
      this.normalizeLogStream(input.stream),
      this.redactMessage(input.message),
      JSON.stringify(this.objectValue(input.metadata)),
    )) as Record<string, unknown>[];
    return rows[0] || null;
  }

  async recordWorkerHeartbeat(input: {
    worker_id?: string;
    kind?: string;
    queue_names?: string[];
    status?: string;
    metadata?: Record<string, unknown>;
  }) {
    if (!(await this.ensureSchema())) return null;
    const workerId = this.requiredText(input.worker_id, 128, this.defaultWorkerId());
    const rows = (await this.prisma.$queryRawUnsafe(
      `INSERT INTO platform_worker_heartbeats (
         worker_id, kind, queue_names_json, status, metadata_json, last_seen_at, created_at, updated_at
       )
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, now(), now(), now())
       ON CONFLICT (worker_id)
       DO UPDATE SET
         kind = EXCLUDED.kind,
         queue_names_json = EXCLUDED.queue_names_json,
         status = EXCLUDED.status,
         metadata_json = EXCLUDED.metadata_json,
         last_seen_at = now(),
         updated_at = now()
       RETURNING *`,
      workerId,
      this.requiredText(input.kind, 64, 'gateway'),
      JSON.stringify(Array.isArray(input.queue_names) ? input.queue_names.slice(0, 20) : []),
      this.requiredText(input.status, 32, 'online'),
      JSON.stringify(this.objectValue(input.metadata)),
    )) as Record<string, unknown>[];
    return rows[0] || null;
  }

  async getSummary() {
    if (!(await this.ensureSchema())) {
      return { by_status: [], by_module: [], recent_failures: [], workers: [] };
    }
    const [byStatus, byModule, recentFailures, workers] = await Promise.all([
      this.prisma.$queryRawUnsafe(
        `SELECT status, COUNT(*)::bigint AS count
           FROM platform_tasks
          WHERE created_at >= now() - interval '24 hours'
          GROUP BY status
          ORDER BY count DESC`,
      ) as Promise<Record<string, unknown>[]>,
      this.prisma.$queryRawUnsafe(
        `SELECT module, COUNT(*)::bigint AS count,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::bigint AS failed_count,
                MAX(updated_at) AS last_updated_at
           FROM platform_tasks
          WHERE created_at >= now() - interval '24 hours'
          GROUP BY module
          ORDER BY failed_count DESC, count DESC
          LIMIT 20`,
      ) as Promise<Record<string, unknown>[]>,
      this.prisma.$queryRawUnsafe(
        `SELECT id, app_id, module, action, status, error_code, error_message, updated_at
           FROM platform_tasks
          WHERE status IN ('failed', 'expired')
          ORDER BY updated_at DESC
          LIMIT 10`,
      ) as Promise<Record<string, unknown>[]>,
      this.prisma.$queryRawUnsafe(
        `SELECT *
           FROM platform_worker_heartbeats
          ORDER BY last_seen_at DESC
          LIMIT 30`,
      ) as Promise<Record<string, unknown>[]>,
    ]);
    return this.serialize({ by_status: byStatus, by_module: byModule, recent_failures: recentFailures, workers });
  }

  async ensureSchema(): Promise<boolean> {
    if (this.schemaReady) return true;
    if (!this.schemaPromise) {
      this.schemaPromise = this.checkSchema().finally(() => {
        this.schemaPromise = null;
      });
    }
    this.schemaReady = await this.schemaPromise;
    return this.schemaReady;
  }

  private async checkSchema(): Promise<boolean> {
    try {
      await this.prisma.$queryRawUnsafe(`SELECT 1 FROM platform_tasks LIMIT 1`);
      return true;
    } catch (error: any) {
      this.logger.warn(`platform tasks schema is not ready: ${error?.message || error}`);
      return false;
    }
  }

  private parsePaging(pageRaw?: string, pageSizeRaw?: string, defaultPageSize = 80) {
    const page = this.intValue(pageRaw, 1, 1, 100000) || 1;
    const pageSize = this.intValue(pageSizeRaw, defaultPageSize, 1, 200) || defaultPageSize;
    return { page, page_size: pageSize, limit: pageSize, offset: (page - 1) * pageSize };
  }

  private paginated(rows: Record<string, unknown>[], paging: { page: number; page_size: number; limit: number }) {
    const items = rows.slice(0, paging.limit);
    return { items, page: paging.page, page_size: paging.page_size, has_more: rows.length > paging.limit };
  }

  private addUuidFilter(where: string[], params: unknown[], column: string, value?: string) {
    const normalized = this.nullableUuid(value);
    if (!normalized) return;
    params.push(normalized);
    where.push(`${column} = $${params.length}::uuid`);
  }

  private addTextFilter(where: string[], params: unknown[], column: string, value: unknown, maxLength: number) {
    const normalized = this.nullableText(value, maxLength);
    if (!normalized) return;
    params.push(normalized);
    where.push(`${column} = $${params.length}`);
  }

  private addStatusFilter(where: string[], params: unknown[], status?: string) {
    const normalized = this.nullableText(status, 32);
    if (!normalized) return;
    if (!TASK_STATUSES.includes(normalized as PlatformTaskStatus)) throw new BadRequestException('invalid task status');
    params.push(normalized);
    where.push(`status = $${params.length}`);
  }

  private addDaysFilter(where: string[], params: unknown[], daysRaw?: string, defaultDays = 7) {
    const days = this.intValue(daysRaw, defaultDays, 1, 365);
    params.push(days);
    where.push(`created_at >= now() - ($${params.length}::int * interval '1 day')`);
  }

  private requiredText(value: unknown, maxLength: number, fallback: string) {
    const text = String(value ?? '').trim() || fallback;
    return text.slice(0, maxLength);
  }

  private nullableText(value: unknown, maxLength: number) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, maxLength) : null;
  }

  private requiredUuid(value: unknown) {
    const normalized = this.nullableUuid(value);
    if (!normalized) throw new BadRequestException('invalid uuid');
    return normalized;
  }

  private nullableUuid(value: unknown) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : null;
  }

  private intValue(value: unknown, fallback: number | undefined, min: number, max: number) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(parsed)) {
      if (fallback === undefined) return null;
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }

  private objectValue(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }

  private serialize(value: unknown): any {
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Date) return value;
    if (Array.isArray(value)) return value.map((item) => this.serialize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.serialize(item)]));
    }
    return value;
  }

  private normalizeLogStream(value: unknown) {
    const stream = String(value || 'stdout').trim().toLowerCase();
    return ['stdout', 'stderr', 'system'].includes(stream) ? stream : 'stdout';
  }

  private handlerKey(module: unknown, action: unknown) {
    return `${this.requiredText(module, 64, 'platform')}.${this.requiredText(action, 96, 'run')}`;
  }

  private redactMessage(value: unknown) {
    return String(value ?? '')
      .slice(0, 8000)
      .replace(/(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)([^"'\s,;]+)/gi, '$1$2[REDACTED]');
  }

  private defaultWorkerId() {
    return `${process.pid}@${process.env.HOSTNAME || 'gateway'}`.slice(0, 128);
  }
}
