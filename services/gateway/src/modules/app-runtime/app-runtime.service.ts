import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AppSchemaService } from '../app-schema/app-schema.service';
import { PlatformTaskHandlerContext } from '../platform-tasks/platform-tasks.types';
import { PlatformTasksService } from '../platform-tasks/platform-tasks.service';
import { APP_RUNTIME_TEMPLATES, AppRuntimeTemplate, getAppRuntimeTemplate } from './app-runtime.templates';

type AppRef = { id: string; slug: string; name?: string | null; status?: string | null };

type ModuleDefinition = {
  key: string;
  display_name: string;
  category: string;
  resource_tables: string[];
  resource_count_sql: string;
  run_tables?: string[];
  run_summary_sql?: string;
};

const MODULE_DEFINITIONS: ModuleDefinition[] = [
  {
    key: 'ai_gateway',
    display_name: 'AI Gateway',
    category: 'ai',
    resource_tables: ['ai_app_model_routes', 'ai_app_capability_defaults'],
    resource_count_sql: `
      SELECT
        (SELECT COUNT(*)::int FROM ai_app_model_routes WHERE app_id = $1::uuid)
        + (SELECT COUNT(*)::int FROM ai_app_capability_defaults WHERE app_id = $1::uuid) AS count
    `,
    run_tables: ['ai_gateway_request_events'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             COUNT(*) FILTER (WHERE success = false)::int AS failure_count,
             MAX(created_at) AS last_run_at,
             MAX(created_at) FILTER (WHERE success = false) AS last_failure_at
        FROM ai_gateway_request_events
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'data_schema',
    display_name: 'Data Schema',
    category: 'data',
    resource_tables: ['app_data_tables'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM app_data_tables WHERE app_id = $1::uuid AND status <> 'DELETED'`,
    run_tables: ['app_schema_change_events'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             0::int AS failure_count,
             MAX(created_at) AS last_run_at,
             NULL::timestamptz AS last_failure_at
        FROM app_schema_change_events
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'app_functions',
    display_name: 'Functions',
    category: 'runtime',
    resource_tables: ['app_functions'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM app_functions WHERE app_id = $1::uuid AND status <> 'DELETED'`,
    run_tables: ['app_function_runs'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             COUNT(*) FILTER (WHERE status IN ('FAILED', 'TIMEOUT', 'CANCELED'))::int AS failure_count,
             MAX(created_at) AS last_run_at,
             MAX(created_at) FILTER (WHERE status IN ('FAILED', 'TIMEOUT', 'CANCELED')) AS last_failure_at
        FROM app_function_runs
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'app_workflows',
    display_name: 'Workflows',
    category: 'runtime',
    resource_tables: ['app_workflows'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM app_workflows WHERE app_id = $1::uuid AND status <> 'DELETED'`,
    run_tables: ['app_workflow_runs'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             COUNT(*) FILTER (WHERE status IN ('FAILED', 'TIMEOUT', 'CANCELED'))::int AS failure_count,
             MAX(created_at) AS last_run_at,
             MAX(created_at) FILTER (WHERE status IN ('FAILED', 'TIMEOUT', 'CANCELED')) AS last_failure_at
        FROM app_workflow_runs
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'app_connectors',
    display_name: 'Connectors',
    category: 'runtime',
    resource_tables: ['app_connectors'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM app_connectors WHERE app_id = $1::uuid AND status <> 'DELETED'`,
    run_tables: ['app_connector_runs'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             COUNT(*) FILTER (WHERE status IN ('FAILED', 'TIMEOUT', 'CANCELED'))::int AS failure_count,
             MAX(created_at) AS last_run_at,
             MAX(created_at) FILTER (WHERE status IN ('FAILED', 'TIMEOUT', 'CANCELED')) AS last_failure_at
        FROM app_connector_runs
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'app_blocks',
    display_name: 'AI Blocks',
    category: 'ai',
    resource_tables: ['app_ai_blocks'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM app_ai_blocks WHERE app_id = $1::uuid AND status <> 'DELETED'`,
    run_tables: ['app_ai_runs'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             COUNT(*) FILTER (WHERE status IN ('FAILED', 'ERROR'))::int AS failure_count,
             MAX(created_at) AS last_run_at,
             MAX(created_at) FILTER (WHERE status IN ('FAILED', 'ERROR')) AS last_failure_at
        FROM app_ai_runs
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'video_jobs',
    display_name: 'Video Jobs',
    category: 'ai',
    resource_tables: ['app_video_blocks'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM app_video_blocks WHERE app_id = $1::uuid AND status <> 'DELETED'`,
    run_tables: ['app_video_jobs'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             COUNT(*) FILTER (WHERE status IN ('FAILED', 'ERROR'))::int AS failure_count,
             MAX(created_at) AS last_run_at,
             MAX(created_at) FILTER (WHERE status IN ('FAILED', 'ERROR')) AS last_failure_at
        FROM app_video_jobs
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'storage',
    display_name: 'Storage',
    category: 'storage',
    resource_tables: ['app_storage_buckets', 'app_storage_files'],
    resource_count_sql: `
      SELECT
        (SELECT COUNT(*)::int FROM app_storage_buckets WHERE app_id = $1::uuid AND status <> 'DELETED')
        + (SELECT COUNT(*)::int FROM app_storage_files WHERE app_id = $1::uuid) AS count
    `,
  },
  {
    key: 'payments',
    display_name: 'Payments',
    category: 'commerce',
    resource_tables: ['payment_products'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM payment_products WHERE app_id = $1::uuid`,
    run_tables: ['alipay_orders'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             COUNT(*) FILTER (WHERE status IN ('FAILED', 'CLOSED', 'REFUNDED'))::int AS failure_count,
             MAX(created_at) AS last_run_at,
             MAX(created_at) FILTER (WHERE status IN ('FAILED', 'CLOSED', 'REFUNDED')) AS last_failure_at
        FROM alipay_orders
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'email',
    display_name: 'Email',
    category: 'comms',
    resource_tables: ['email_templates'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM email_templates WHERE app_id = $1::uuid`,
    run_tables: ['email_campaigns'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             COUNT(*) FILTER (WHERE status IN ('FAILED', 'CANCELLED'))::int AS failure_count,
             MAX(created_at) AS last_run_at,
             MAX(created_at) FILTER (WHERE status IN ('FAILED', 'CANCELLED')) AS last_failure_at
        FROM email_campaigns
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'tenant_site',
    display_name: 'Tenant Site',
    category: 'content',
    resource_tables: ['tenant_site_messages'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM tenant_site_messages WHERE app_id = $1::uuid`,
  },
  {
    key: 'auth',
    display_name: 'Auth',
    category: 'auth',
    resource_tables: ['users'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM users WHERE app_id = $1::uuid`,
  },
  {
    key: 'redeem',
    display_name: 'Redeem',
    category: 'commerce',
    resource_tables: ['entitlement_packages', 'entitlement_codes'],
    resource_count_sql: `
      SELECT
        (SELECT COUNT(*)::int FROM entitlement_packages WHERE app_id = $1::uuid)
        + (SELECT COUNT(*)::int FROM entitlement_codes WHERE app_id = $1::uuid) AS count
    `,
    run_tables: ['entitlement_code_redemptions'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             COUNT(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS failure_count,
             MAX(created_at) AS last_run_at,
             MAX(revoked_at) AS last_failure_at
        FROM entitlement_code_redemptions
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'sms',
    display_name: 'SMS',
    category: 'comms',
    resource_tables: ['platform_sms_providers', 'platform_sms_templates'],
    resource_count_sql: `
      SELECT
        (SELECT COUNT(*)::int FROM platform_sms_providers WHERE is_active = true AND $1::uuid IS NOT NULL)
        + (SELECT COUNT(*)::int FROM platform_sms_templates WHERE is_active = true AND $1::uuid IS NOT NULL) AS count
    `,
    run_tables: ['platform_sms_message_events'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             COUNT(*) FILTER (WHERE lower(status) NOT IN ('sent', 'success', 'ok'))::int AS failure_count,
             MAX(created_at) AS last_run_at,
             MAX(created_at) FILTER (WHERE lower(status) NOT IN ('sent', 'success', 'ok')) AS last_failure_at
        FROM platform_sms_message_events
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'oauth',
    display_name: 'OAuth',
    category: 'auth',
    resource_tables: ['wechat_open_apps', 'google_oauth_clients', 'github_oauth_apps', 'apple_login_credentials'],
    resource_count_sql: `
      SELECT
        (SELECT COUNT(*)::int FROM wechat_open_apps WHERE is_active = true AND $1::uuid IS NOT NULL)
        + (SELECT COUNT(*)::int FROM google_oauth_clients WHERE is_active = true AND $1::uuid IS NOT NULL)
        + (SELECT COUNT(*)::int FROM github_oauth_apps WHERE is_active = true AND $1::uuid IS NOT NULL)
        + (SELECT COUNT(*)::int FROM apple_login_credentials WHERE is_active = true AND $1::uuid IS NOT NULL) AS count
    `,
  },
  {
    key: 'behavior_analytics',
    display_name: 'Behavior Analytics',
    category: 'analytics',
    resource_tables: ['user_behavior_events'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM user_behavior_events WHERE app_id = $1::uuid AND occurred_at >= now() - interval '7 days'`,
    run_tables: ['user_behavior_events'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             0::int AS failure_count,
             MAX(occurred_at) AS last_run_at,
             NULL::timestamptz AS last_failure_at
        FROM user_behavior_events
       WHERE app_id = $1::uuid
         AND occurred_at >= now() - interval '24 hours'
    `,
  },
  {
    key: 'observability',
    display_name: 'Observability',
    category: 'operations',
    resource_tables: ['platform_request_events'],
    resource_count_sql: `SELECT COUNT(*)::int AS count FROM platform_request_events WHERE app_id = $1::uuid AND created_at >= now() - interval '7 days'`,
    run_tables: ['platform_request_events'],
    run_summary_sql: `
      SELECT COUNT(*)::int AS run_count,
             COUNT(*) FILTER (WHERE success = false)::int AS failure_count,
             MAX(created_at) AS last_run_at,
             MAX(created_at) FILTER (WHERE success = false) AS last_failure_at
        FROM platform_request_events
       WHERE app_id = $1::uuid
         AND created_at >= now() - interval '24 hours'
    `,
  },
];

@Injectable()
export class AppRuntimeService implements OnModuleInit {
  private readonly logger = new Logger(AppRuntimeService.name);
  private readonly tableCache = new Map<string, boolean>();

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly appSchemaService: AppSchemaService,
    private readonly platformTasksService: PlatformTasksService,
  ) {}

  onModuleInit() {
    this.platformTasksService.registerHandler('runtime', 'apply_template', (context) => this.handleApplyTemplateTask(context));
    this.platformTasksService.registerHandler('runtime', 'refresh_app', (context) => this.handleRefreshAppTask(context));
    this.platformTasksService.registerHandler('runtime', 'refresh_all', (context) => this.handleRefreshAllTask(context));
  }

  listTemplates() {
    return { items: APP_RUNTIME_TEMPLATES.map((template) => this.serializeTemplate(template)) };
  }

  async getGlobalOverview(query: Record<string, unknown> = {}) {
    await this.ensureRuntimeSchema();
    const limit = this.intValue(query.limit, 80, 1, 200);
    const [apps, moduleStatus, moduleCategories, taskRuntime, recentTemplates] = await Promise.all([
      this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active
           FROM apps`,
      ) as Promise<Record<string, unknown>[]>,
      this.prisma.$queryRawUnsafe(
        `SELECT status, COUNT(*)::int AS count
           FROM app_module_registry
          GROUP BY status
          ORDER BY count DESC`,
      ) as Promise<Record<string, unknown>[]>,
      this.prisma.$queryRawUnsafe(
        `SELECT category,
                COUNT(*)::int AS module_count,
                AVG(quality_score)::numeric(6,2) AS avg_quality_score,
                SUM(failure_count_24h)::int AS failures_24h
           FROM app_module_registry
          GROUP BY category
          ORDER BY failures_24h DESC, module_count DESC`,
      ) as Promise<Record<string, unknown>[]>,
      this.platformTasksService.getRuntime().catch(() => null),
      this.prisma.$queryRawUnsafe(
        `SELECT t.*, a.slug AS app_slug, a.name AS app_name
           FROM app_runtime_template_applications t
           JOIN apps a ON a.id = t.app_id
          ORDER BY t.created_at DESC
          LIMIT $1`,
        Math.min(limit, 40),
      ) as Promise<Record<string, unknown>[]>,
    ]);

    return this.serialize({
      apps: apps[0] || { total: 0, active: 0 },
      modules: {
        by_status: moduleStatus,
        by_category: moduleCategories,
      },
      task_runtime: taskRuntime,
      templates: {
        available: APP_RUNTIME_TEMPLATES.length,
        recent_applications: recentTemplates,
      },
      next_actions: [
        { action: 'refresh_all', method: 'POST', path: '/platform-admin/runtime/refresh' },
        { action: 'list_templates', method: 'GET', path: '/platform-admin/runtime/templates' },
      ],
    });
  }

  async getAppOverview(appRef: string, query: Record<string, unknown> = {}) {
    await this.ensureRuntimeSchema();
    const app = await this.resolveApp(appRef);
    const limit = this.intValue(query.limit, 80, 1, 200);
    const [modules, runs, tasks, templates] = await Promise.all([
      this.prisma.$queryRawUnsafe(
        `SELECT *
           FROM app_module_registry
          WHERE app_id = $1::uuid
          ORDER BY category ASC, module_key ASC`,
        app.id,
      ) as Promise<Record<string, unknown>[]>,
      this.recentRuns(app.id, limit),
      this.platformTasksService.listTasks({ app_id: app.id, days: '7', page_size: String(Math.min(limit, 80)) }).catch(() => ({ items: [] })),
      this.prisma.$queryRawUnsafe(
        `SELECT *
           FROM app_runtime_template_applications
          WHERE app_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT 20`,
        app.id,
      ) as Promise<Record<string, unknown>[]>,
    ]);
    return this.serialize({
      app,
      modules,
      runs,
      tasks: (tasks as any)?.items || [],
      templates,
      available_templates: APP_RUNTIME_TEMPLATES.map((template) => this.serializeTemplate(template)),
      next_actions: [
        { action: 'refresh_app', method: 'POST', path: `/platform-admin/apps/${app.id}/runtime/refresh` },
        { action: 'apply_template', method: 'POST', path: `/platform-admin/apps/${app.id}/runtime/templates/{template_key}/apply` },
      ],
    });
  }

  async queueRefreshAll(actorUserId?: string | null) {
    return this.platformTasksService.createTask({
      module: 'runtime',
      action: 'refresh_all',
      queue_name: 'platform-tasks',
      idempotency_key: `runtime-refresh-all-${new Date().toISOString().slice(0, 13)}`,
      max_attempts: 2,
      input_summary: {},
    }, actorUserId);
  }

  async queueRefreshApp(appRef: string, actorUserId?: string | null) {
    const app = await this.resolveApp(appRef);
    return this.platformTasksService.createTask({
      app_id: app.id,
      module: 'runtime',
      action: 'refresh_app',
      queue_name: 'platform-tasks',
      idempotency_key: `runtime-refresh-app-${app.id}-${new Date().toISOString().slice(0, 16)}`,
      max_attempts: 2,
      input_summary: { app_id: app.id, app_slug: app.slug },
    }, actorUserId);
  }

  async queueApplyTemplate(appRef: string, templateKey: string, actorUserId?: string | null) {
    const app = await this.resolveApp(appRef);
    const template = getAppRuntimeTemplate(templateKey);
    if (!template) throw new NotFoundException('runtime template not found');
    return this.platformTasksService.createTask({
      app_id: app.id,
      module: 'runtime',
      action: 'apply_template',
      queue_name: 'platform-tasks',
      idempotency_key: `runtime-template-${app.id}-${template.key}-${template.version}`,
      max_attempts: 2,
      input_summary: { app_id: app.id, app_slug: app.slug, template_key: template.key },
    }, actorUserId);
  }

  private async handleApplyTemplateTask(context: PlatformTaskHandlerContext) {
    const templateKey = String(context.input.template_key || '').trim();
    const appId = String(context.input.app_id || context.task.app_id || '').trim();
    if (!templateKey || !appId) throw new BadRequestException('apply_template requires app_id and template_key');
    const app = await this.resolveApp(appId);
    const template = getAppRuntimeTemplate(templateKey);
    if (!template) throw new NotFoundException('runtime template not found');
    await context.setProgress(10, { template_key: template.key });
    await context.appendLog(`applying template ${template.key}`, { app_id: app.id, app_slug: app.slug }, 'system');
    const result = await this.applyTemplate(app, template, this.nullableUuid(context.task.actor_user_id), String(context.task.id || ''));
    await context.setProgress(90, result);
    return result;
  }

  private async handleRefreshAppTask(context: PlatformTaskHandlerContext) {
    const appId = String(context.input.app_id || context.task.app_id || '').trim();
    if (!appId) throw new BadRequestException('refresh_app requires app_id');
    const app = await this.resolveApp(appId);
    await context.appendLog(`refreshing runtime modules for ${app.slug}`, { app_id: app.id }, 'system');
    const modules = await this.refreshAppModules(app, this.nullableUuid(context.task.actor_user_id));
    return { app_id: app.id, app_slug: app.slug, modules_refreshed: modules.length };
  }

  private async handleRefreshAllTask(context: PlatformTaskHandlerContext) {
    const apps = await this.prisma.$queryRawUnsafe(
      `SELECT id, slug, name, status FROM apps ORDER BY updated_at DESC LIMIT 200`,
    ) as AppRef[];
    let refreshed = 0;
    for (const [index, app] of apps.entries()) {
      await this.refreshAppModules(app, this.nullableUuid(context.task.actor_user_id));
      refreshed += 1;
      if (index % 10 === 0) {
        await context.setProgress(Math.min(95, Math.round((index / Math.max(apps.length, 1)) * 100)), { apps_refreshed: refreshed });
      }
    }
    return { apps_refreshed: refreshed };
  }

  private async applyTemplate(app: AppRef, template: AppRuntimeTemplate, actorUserId?: string | null, taskId?: string | null) {
    await this.upsertModules(app.id, template.modules, 'template', actorUserId, {
      template_key: template.key,
      template_version: template.version,
    });
    for (const block of template.creates.ai_blocks || []) {
      await this.upsertAiBlock(app.id, block);
    }
    for (const block of template.creates.video_blocks || []) {
      await this.upsertVideoBlock(app.id, block);
    }
    for (const fn of template.creates.functions || []) {
      await this.upsertFunction(app.id, fn, actorUserId);
    }
    for (const workflow of template.creates.workflows || []) {
      await this.upsertWorkflow(app.id, workflow, actorUserId);
    }
    for (const bucket of template.creates.storage_buckets || []) {
      await this.upsertStorageBucket(app.id, bucket);
    }
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO app_runtime_template_applications (
         app_id, template_key, template_version, applied_by_user_id, task_id, status,
         module_keys_json, manifest_json, created_at
       )
       VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, 'applied', $6::jsonb, $7::jsonb, now())`,
      app.id,
      template.key,
      template.version,
      this.nullableUuid(actorUserId),
      this.nullableUuid(taskId),
      JSON.stringify(template.modules),
      JSON.stringify(this.serializeTemplate(template)),
    );
    const modules = await this.refreshAppModules(app, actorUserId);
    return { template_key: template.key, template_version: template.version, app_id: app.id, app_slug: app.slug, modules_refreshed: modules.length };
  }

  private async refreshAppModules(app: AppRef, actorUserId?: string | null) {
    await this.ensureRuntimeSchema();
    const rows: Record<string, unknown>[] = [];
    for (const definition of MODULE_DEFINITIONS) {
      const resourceCount = await this.safeCount(definition.resource_tables, definition.resource_count_sql, app.id);
      const summary = definition.run_summary_sql
        ? await this.safeOne(definition.run_tables || [], definition.run_summary_sql, app.id)
        : { run_count: 0, failure_count: 0, last_run_at: null, last_failure_at: null };
      const existing = await this.getExistingModule(app.id, definition.key);
      if (resourceCount <= 0 && !existing) continue;
      const runCount = this.numberValue(summary.run_count);
      const failureCount = this.numberValue(summary.failure_count);
      const source = existing?.source === 'manual' ? 'manual' : existing?.source || 'inferred';
      const status = this.moduleStatus(resourceCount, failureCount, source);
      const qualityScore = this.qualityScore(resourceCount, runCount, failureCount);
      const health = {
        resource_count: resourceCount,
        run_count_24h: runCount,
        failure_count_24h: failureCount,
        last_run_at: summary.last_run_at || null,
        last_failure_at: summary.last_failure_at || null,
      };
      const upserted = await this.upsertModule(app.id, {
        module_key: definition.key,
        display_name: definition.display_name,
        category: definition.category,
        status,
        source,
        resource_count: resourceCount,
        run_count_24h: runCount,
        failure_count_24h: failureCount,
        quality_score: qualityScore,
        health_json: health,
        runtime_config_json: this.objectValue(existing?.runtime_config_json),
        last_run_at: summary.last_run_at || null,
        last_failure_at: summary.last_failure_at || null,
        actor_user_id: actorUserId || null,
      });
      rows.push(upserted);
    }
    return rows;
  }

  private async upsertModules(appId: string, modules: string[], source: 'template' | 'manual' | 'system' | 'inferred', actorUserId?: string | null, metadata: Record<string, unknown> = {}) {
    for (const moduleKey of modules) {
      const definition = MODULE_DEFINITIONS.find((item) => item.key === moduleKey) || {
        key: moduleKey,
        display_name: this.titleize(moduleKey),
        category: 'runtime',
      };
      await this.upsertModule(appId, {
        module_key: moduleKey,
        display_name: definition.display_name,
        category: definition.category,
        status: 'active',
        source,
        resource_count: 0,
        run_count_24h: 0,
        failure_count_24h: 0,
        quality_score: 80,
        health_json: metadata,
        runtime_config_json: metadata,
        last_run_at: null,
        last_failure_at: null,
        actor_user_id: actorUserId || null,
      });
    }
  }

  private async upsertModule(appId: string, input: Record<string, unknown>) {
    const rows = (await this.prisma.$queryRawUnsafe(
      `INSERT INTO app_module_registry (
         app_id, module_key, display_name, category, status, source, resource_count,
         run_count_24h, failure_count_24h, quality_score, runtime_config_json, health_json,
         last_run_at, last_failure_at, created_by_user_id, updated_by_user_id, created_at, updated_at
       )
       VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7::int,
         $8::int, $9::int, $10::int, $11::jsonb, $12::jsonb,
         $13::timestamptz, $14::timestamptz, $15::uuid, $15::uuid, now(), now()
       )
       ON CONFLICT (app_id, module_key)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         category = EXCLUDED.category,
         status = EXCLUDED.status,
         source = CASE WHEN app_module_registry.source = 'manual' THEN 'manual' ELSE EXCLUDED.source END,
         resource_count = EXCLUDED.resource_count,
         run_count_24h = EXCLUDED.run_count_24h,
         failure_count_24h = EXCLUDED.failure_count_24h,
         quality_score = EXCLUDED.quality_score,
         runtime_config_json = app_module_registry.runtime_config_json || EXCLUDED.runtime_config_json,
         health_json = EXCLUDED.health_json,
         last_run_at = EXCLUDED.last_run_at,
         last_failure_at = EXCLUDED.last_failure_at,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = now()
       RETURNING *`,
      appId,
      String(input.module_key),
      String(input.display_name),
      String(input.category || 'runtime'),
      String(input.status || 'active'),
      String(input.source || 'inferred'),
      this.numberValue(input.resource_count),
      this.numberValue(input.run_count_24h),
      this.numberValue(input.failure_count_24h),
      this.numberValue(input.quality_score),
      JSON.stringify(this.objectValue(input.runtime_config_json)),
      JSON.stringify(this.objectValue(input.health_json)),
      input.last_run_at || null,
      input.last_failure_at || null,
      this.nullableUuid(input.actor_user_id),
    )) as Record<string, unknown>[];
    return rows[0];
  }

  private async upsertAiBlock(appId: string, block: Record<string, unknown>) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO app_ai_blocks (
         app_id, slug, type, model_slot, prompt_template, input_schema_json,
         output_schema_json, tool_bindings_json, settings_json, status
       )
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, 'ACTIVE')
       ON CONFLICT (app_id, slug) WHERE status <> 'DELETED'
       DO UPDATE SET type = EXCLUDED.type,
                     model_slot = EXCLUDED.model_slot,
                     prompt_template = EXCLUDED.prompt_template,
                     input_schema_json = EXCLUDED.input_schema_json,
                     output_schema_json = EXCLUDED.output_schema_json,
                     tool_bindings_json = EXCLUDED.tool_bindings_json,
                     settings_json = EXCLUDED.settings_json,
                     status = 'ACTIVE',
                     updated_at = now()`,
      appId,
      this.identifier(block.slug, 'ai block slug'),
      String(block.type || 'text_generation').slice(0, 40),
      this.optionalString(block.model_slot, 80),
      this.optionalString(block.prompt_template, 20000),
      JSON.stringify(this.objectValue(block.input_schema_json)),
      JSON.stringify(this.objectValue(block.output_schema_json)),
      JSON.stringify(Array.isArray(block.tool_bindings_json) ? block.tool_bindings_json : []),
      JSON.stringify(this.objectValue(block.settings_json)),
    );
  }

  private async upsertVideoBlock(appId: string, block: Record<string, unknown>) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO app_video_blocks (
         app_id, slug, provider_slot, input_schema_json, output_schema_json, settings_json, status
       )
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, 'ACTIVE')
       ON CONFLICT (app_id, slug) WHERE status <> 'DELETED'
       DO UPDATE SET provider_slot = EXCLUDED.provider_slot,
                     input_schema_json = EXCLUDED.input_schema_json,
                     output_schema_json = EXCLUDED.output_schema_json,
                     settings_json = EXCLUDED.settings_json,
                     status = 'ACTIVE',
                     updated_at = now()`,
      appId,
      this.identifier(block.slug, 'video block slug'),
      this.optionalString(block.provider_slot, 80),
      JSON.stringify(this.objectValue(block.input_schema_json)),
      JSON.stringify(this.objectValue(block.output_schema_json)),
      JSON.stringify(this.objectValue(block.settings_json)),
    );
  }

  private async upsertFunction(appId: string, fn: Record<string, unknown>, actorUserId?: string | null) {
    const source = this.objectValue(fn.source_json);
    const sourceHash = this.sha256(JSON.stringify(source));
    const slug = this.identifier(fn.slug, 'function slug');
    const functionRows = (await this.prisma.$queryRawUnsafe(
      `INSERT INTO app_functions (
         app_id, slug, runtime, entrypoint, source_json, secrets_scope, trigger_json,
         status, created_by_user_id, updated_by_user_id
       )
       VALUES ($1::uuid, $2, 'opg-js-v1', $3, $4::jsonb, $5, $6::jsonb, 'DRAFT', $7::uuid, $7::uuid)
       ON CONFLICT (app_id, slug) WHERE status <> 'DELETED'
       DO UPDATE SET entrypoint = EXCLUDED.entrypoint,
                     source_json = EXCLUDED.source_json,
                     secrets_scope = EXCLUDED.secrets_scope,
                     trigger_json = EXCLUDED.trigger_json,
                     updated_by_user_id = EXCLUDED.updated_by_user_id,
                     updated_at = now()
       RETURNING id`,
      appId,
      slug,
      String(fn.entrypoint || 'handler').slice(0, 120),
      JSON.stringify(source),
      this.optionalString(fn.secrets_scope, 120),
      JSON.stringify(this.objectValue(fn.trigger_json)),
      this.nullableUuid(actorUserId),
    )) as Array<{ id: string }>;
    const functionId = functionRows[0]?.id;
    if (!functionId) return;
    const currentRows = (await this.prisma.$queryRawUnsafe(
      `SELECT v.source_hash
         FROM app_functions f
         LEFT JOIN app_function_versions v ON v.id = f.current_version_id
        WHERE f.id = $1::uuid
        LIMIT 1`,
      functionId,
    )) as Array<{ source_hash?: string | null }>;
    if (currentRows[0]?.source_hash !== sourceHash) {
      const versionRows = (await this.prisma.$queryRawUnsafe(
        `WITH next_version AS (
           SELECT COALESCE(MAX(version), 0) + 1 AS version
             FROM app_function_versions
            WHERE function_id = $1::uuid
         )
         INSERT INTO app_function_versions (
           function_id, app_id, version, source_hash, source_json, build_status, created_by_user_id
         )
         SELECT $1::uuid, $2::uuid, next_version.version, $3, $4::jsonb, 'READY', $5::uuid
           FROM next_version
         RETURNING id`,
        functionId,
        appId,
        sourceHash,
        JSON.stringify(source),
        this.nullableUuid(actorUserId),
      )) as Array<{ id: string }>;
      await this.prisma.$executeRawUnsafe(
        `UPDATE app_functions
            SET current_version_id = $1::uuid,
                status = 'ACTIVE',
                updated_by_user_id = $2::uuid,
                updated_at = now()
          WHERE id = $3::uuid`,
        versionRows[0].id,
        this.nullableUuid(actorUserId),
        functionId,
      );
    } else {
      await this.prisma.$executeRawUnsafe(
        `UPDATE app_functions SET status = 'ACTIVE', updated_at = now() WHERE id = $1::uuid`,
        functionId,
      );
    }
  }

  private async upsertWorkflow(appId: string, workflow: Record<string, unknown>, actorUserId?: string | null) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO app_workflows (
         app_id, slug, name, trigger_json, steps_json, input_schema_json, output_schema_json,
         status, created_by_user_id, updated_by_user_id
       )
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, 'ACTIVE', $8::uuid, $8::uuid)
       ON CONFLICT (app_id, slug) WHERE status <> 'DELETED'
       DO UPDATE SET name = EXCLUDED.name,
                     trigger_json = EXCLUDED.trigger_json,
                     steps_json = EXCLUDED.steps_json,
                     input_schema_json = EXCLUDED.input_schema_json,
                     output_schema_json = EXCLUDED.output_schema_json,
                     status = 'ACTIVE',
                     updated_by_user_id = EXCLUDED.updated_by_user_id,
                     updated_at = now()`,
      appId,
      this.identifier(workflow.slug, 'workflow slug'),
      this.optionalString(workflow.name, 160),
      JSON.stringify(this.objectValue(workflow.trigger_json)),
      JSON.stringify(Array.isArray(workflow.steps_json) ? workflow.steps_json : []),
      JSON.stringify(this.objectValue(workflow.input_schema_json)),
      JSON.stringify(this.objectValue(workflow.output_schema_json)),
      this.nullableUuid(actorUserId),
    );
  }

  private async upsertStorageBucket(appId: string, bucket: Record<string, unknown>) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO app_storage_buckets (app_id, slug, policy_json, quota_json, status, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, 'ACTIVE', now(), now())
       ON CONFLICT (app_id, slug) WHERE status <> 'DELETED'
       DO UPDATE SET policy_json = EXCLUDED.policy_json,
                     quota_json = EXCLUDED.quota_json,
                     status = 'ACTIVE',
                     updated_at = now()`,
      appId,
      this.identifier(bucket.slug, 'storage bucket slug'),
      JSON.stringify(this.objectValue(bucket.policy_json)),
      JSON.stringify(this.objectValue(bucket.quota_json)),
    );
  }

  private async recentRuns(appId: string, limit: number) {
    const candidates = [
      {
        table: 'app_function_runs',
        sql: `SELECT 'function' AS source, id::text AS id, status, created_at, finished_at, error_json AS error FROM app_function_runs WHERE app_id = $1::uuid ORDER BY created_at DESC LIMIT $2`,
      },
      {
        table: 'app_workflow_runs',
        sql: `SELECT 'workflow' AS source, id::text AS id, status, created_at, finished_at, error_json AS error FROM app_workflow_runs WHERE app_id = $1::uuid ORDER BY created_at DESC LIMIT $2`,
      },
      {
        table: 'app_connector_runs',
        sql: `SELECT 'connector' AS source, id::text AS id, status, created_at, finished_at, error_json AS error FROM app_connector_runs WHERE app_id = $1::uuid ORDER BY created_at DESC LIMIT $2`,
      },
      {
        table: 'app_ai_runs',
        sql: `SELECT 'ai' AS source, id::text AS id, status, created_at, finished_at, error_json AS error FROM app_ai_runs WHERE app_id = $1::uuid ORDER BY created_at DESC LIMIT $2`,
      },
      {
        table: 'app_video_jobs',
        sql: `SELECT 'video' AS source, id::text AS id, status, created_at, updated_at AS finished_at, error_json AS error FROM app_video_jobs WHERE app_id = $1::uuid ORDER BY created_at DESC LIMIT $2`,
      },
    ];
    const chunks: Record<string, unknown>[][] = [];
    for (const candidate of candidates) {
      if (await this.tableExists(candidate.table)) {
        chunks.push(await this.prisma.$queryRawUnsafe(candidate.sql, appId, limit) as Record<string, unknown>[]);
      }
    }
    return chunks.flat().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, limit);
  }

  private async getExistingModule(appId: string, moduleKey: string) {
    if (!(await this.tableExists('app_module_registry'))) return null;
    const rows = await this.prisma.$queryRawUnsafe(
      `SELECT * FROM app_module_registry WHERE app_id = $1::uuid AND module_key = $2 LIMIT 1`,
      appId,
      moduleKey,
    ) as Record<string, unknown>[];
    return rows[0] || null;
  }

  private async safeCount(tables: string[], sql: string, appId: string) {
    const row = await this.safeOne(tables, sql, appId);
    return this.numberValue(row.count);
  }

  private async safeOne(tables: string[], sql: string, appId: string) {
    for (const table of tables) {
      if (!(await this.tableExists(table))) return {};
    }
    const rows = await this.prisma.$queryRawUnsafe(sql, appId) as Record<string, unknown>[];
    return rows[0] || {};
  }

  private async ensureRuntimeSchema() {
    if (!(await this.tableExists('app_module_registry'))) {
      throw new BadRequestException('app runtime schema is not ready');
    }
  }

  private async tableExists(table: string) {
    if (this.tableCache.has(table)) return this.tableCache.get(table) === true;
    const rows = await this.prisma.$queryRawUnsafe(
      `SELECT to_regclass($1)::text AS name`,
      `public.${table}`,
    ) as Array<{ name: string | null }>;
    const exists = Boolean(rows[0]?.name);
    this.tableCache.set(table, exists);
    return exists;
  }

  private async resolveApp(appRef: string): Promise<AppRef> {
    const app = await this.appSchemaService.resolveApp(appRef);
    return { id: app.id, slug: app.slug, name: app.name, status: (app as any).status };
  }

  private serializeTemplate(template: AppRuntimeTemplate) {
    return {
      key: template.key,
      version: template.version,
      name: template.name,
      category: template.category,
      summary: template.summary,
      modules: template.modules,
      creates: {
        ai_blocks: template.creates.ai_blocks?.length || 0,
        video_blocks: template.creates.video_blocks?.length || 0,
        functions: template.creates.functions?.length || 0,
        workflows: template.creates.workflows?.length || 0,
        storage_buckets: template.creates.storage_buckets?.length || 0,
      },
    };
  }

  private moduleStatus(resourceCount: number, failureCount: number, source?: unknown) {
    if (failureCount > 0) return 'warning';
    if (resourceCount <= 0 && ['template', 'manual'].includes(String(source || ''))) return 'warning';
    if (resourceCount <= 0) return 'disabled';
    return 'active';
  }

  private qualityScore(resourceCount: number, runCount: number, failureCount: number) {
    if (resourceCount <= 0) return 0;
    if (runCount <= 0) return 80;
    const failureRate = failureCount / Math.max(runCount, 1);
    return Math.max(30, Math.min(100, Math.round(95 - failureRate * 65)));
  }

  private identifier(value: unknown, label: string) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
    if (!/^[a-z][a-z0-9_]{1,78}$/.test(normalized)) throw new BadRequestException(`invalid ${label}`);
    return normalized;
  }

  private titleize(value: string) {
    return value.split('_').filter(Boolean).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ');
  }

  private objectValue(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }

  private numberValue(value: unknown) {
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private intValue(value: unknown, fallback: number, min: number, max: number) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  private optionalString(value: unknown, maxLength: number) {
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  private nullableUuid(value: unknown) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : null;
  }

  private sha256(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private serialize(value: unknown): any {
    if (typeof value === 'bigint') return Number(value);
    if (Array.isArray(value)) return value.map((item) => this.serialize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.serialize(item)]));
    }
    return value;
  }
}
