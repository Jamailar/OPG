import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AuthService } from '../auth/auth.service';
import { AiPointsService } from '../ai-chat/ai-points.service';
import { AiDebugAuthService } from '../ai-chat/guards/ai-debug-auth.service';
import { AiAgentRuntimeService } from './ai-agent-runtime.service';
import {
  AGENT_TOOL_PACKS,
  AgentAppBindingRow,
  AgentAuthPolicy,
  AgentOutputMode,
  AgentRunRow,
  AgentScope,
  AgentStatus,
  AgentToolBindingRow,
  AgentToolPackKey,
  AgentVersionRow,
  AgentVisibility,
  AgentRow,
  AppRow,
  RequestActor,
} from './ai-agents.types';

@Injectable()
export class AiAgentsService implements OnModuleInit {
  private readonly logger = new Logger(AiAgentsService.name);
  private schemaEnsured: Promise<void> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly authService: AuthService,
    private readonly aiPointsService: AiPointsService,
    private readonly aiDebugAuthService: AiDebugAuthService,
    private readonly aiAgentRuntimeService: AiAgentRuntimeService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`ai agents startup warmup failed: ${error?.message || error}`);
    }
  }

  async listPlatformAgents() {
    await this.ensureSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM ai_agents
        ORDER BY updated_at DESC, created_at DESC`,
    ) as Promise<AgentRow[]>);
    const items = await Promise.all(rows.map((row) => this.serializeAgentSummary(row)));
    return { items };
  }

  async getPlatformAgent(agentId: string) {
    await this.ensureSchema();
    const agent = await this.getAgentRow(agentId);
    return this.serializeAgentDetail(agent);
  }

  async createPlatformAgent(actorUserId: string, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const slug = this.normalizeSlug(payload.slug, 'slug');
    const name = this.normalizeRequiredString(payload.name, 'name', 128);
    const description = this.normalizeOptionalString(payload.description, 2000);
    const scope = this.normalizeScope(payload.scope);
    const ownerAppId = scope === 'app'
      ? this.normalizeRequiredString(payload.owner_app_id, 'owner_app_id', 64)
      : null;
    const visibility = this.normalizeVisibility(payload.visibility);
    const versionInput = this.normalizeVersionInput(payload);

    if (ownerAppId) {
      await this.getAppById(ownerAppId);
    }

    const existing = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM ai_agents WHERE LOWER(slug) = LOWER($1) LIMIT 1`,
      slug,
    ) as Promise<Array<{ id: string }>>);
    if (existing[0]?.id) {
      throw new BadRequestException(`agent slug already exists: ${slug}`);
    }

    const agentId = randomUUID();
    const versionId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO ai_agents (
           id, slug, name, description, scope, owner_app_id, status, visibility, latest_version_id, published_version_id,
           created_by_user_id, updated_by_user_id, created_at, updated_at
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6::uuid, 'draft', $7, $8::uuid, NULL,
           $9::uuid, $9::uuid, now(), now()
         )`,
        agentId,
        slug,
        name,
        description,
        scope,
        ownerAppId,
        visibility,
        versionId,
        actorUserId,
      );
      await this.insertVersion(tx, {
        id: versionId,
        agentId,
        versionNumber: 1,
        actorUserId,
        input: versionInput,
      });
    });

    return this.getPlatformAgent(agentId);
  }

  async updatePlatformAgent(agentId: string, actorUserId: string, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const agent = await this.getAgentRow(agentId);
    const currentVersion = agent.latest_version_id
      ? await this.getVersionRow(agent.latest_version_id)
      : null;
    if (!currentVersion) {
      throw new NotFoundException('latest agent version not found');
    }

    const slug = payload.slug === undefined ? agent.slug : this.normalizeSlug(payload.slug, 'slug');
    const name = payload.name === undefined ? agent.name : this.normalizeRequiredString(payload.name, 'name', 128);
    const description = payload.description === undefined
      ? agent.description
      : this.normalizeOptionalString(payload.description, 2000);
    const scope = payload.scope === undefined
      ? this.normalizeScope(agent.scope)
      : this.normalizeScope(payload.scope);
    const ownerAppId = scope === 'app'
      ? (
          payload.owner_app_id === undefined
            ? this.normalizeOptionalString(agent.owner_app_id, 64)
            : this.normalizeRequiredString(payload.owner_app_id, 'owner_app_id', 64)
        )
      : null;
    const visibility = payload.visibility === undefined
      ? this.normalizeVisibility(agent.visibility)
      : this.normalizeVisibility(payload.visibility);
    const versionInput = this.normalizeVersionInput(payload, currentVersion);

    if (ownerAppId) {
      await this.getAppById(ownerAppId);
    }

    if (slug !== agent.slug) {
      const existing = await (this.prisma.$queryRawUnsafe(
        `SELECT id FROM ai_agents WHERE LOWER(slug) = LOWER($1) AND id <> $2::uuid LIMIT 1`,
        slug,
        agentId,
      ) as Promise<Array<{ id: string }>>);
      if (existing[0]?.id) {
        throw new BadRequestException(`agent slug already exists: ${slug}`);
      }
    }

    const nextVersionNumber = currentVersion.version_number + 1;
    const versionId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE ai_agents
            SET slug = $2,
                name = $3,
                description = $4,
                scope = $5,
                owner_app_id = $6::uuid,
                visibility = $7,
                latest_version_id = $8::uuid,
                updated_by_user_id = $9::uuid,
                updated_at = now()
          WHERE id = $1::uuid`,
        agentId,
        slug,
        name,
        description,
        scope,
        ownerAppId,
        visibility,
        versionId,
        actorUserId,
      );
      await this.insertVersion(tx, {
        id: versionId,
        agentId,
        versionNumber: nextVersionNumber,
        actorUserId,
        input: versionInput,
      });
    });

    return this.getPlatformAgent(agentId);
  }

  async publishPlatformAgent(agentId: string, actorUserId: string) {
    await this.ensureSchema();
    const agent = await this.getAgentRow(agentId);
    if (!agent.latest_version_id) {
      throw new BadRequestException('agent has no latest version');
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_agents
          SET published_version_id = latest_version_id,
              status = 'published',
              updated_by_user_id = $2::uuid,
              updated_at = now()
        WHERE id = $1::uuid`,
      agentId,
      actorUserId,
    );
    return this.getPlatformAgent(agentId);
  }

  async archivePlatformAgent(agentId: string, actorUserId: string) {
    await this.ensureSchema();
    await this.getAgentRow(agentId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_agents
          SET status = 'archived',
              updated_by_user_id = $2::uuid,
              updated_at = now()
        WHERE id = $1::uuid`,
      agentId,
      actorUserId,
    );
    return this.getPlatformAgent(agentId);
  }

  async deletePlatformAgent(agentId: string) {
    await this.ensureSchema();
    await this.getAgentRow(agentId);
    await this.prisma.$executeRawUnsafe(`DELETE FROM ai_agents WHERE id = $1::uuid`, agentId);
    return { deleted: true, agent_id: agentId };
  }

  async listToolCatalog() {
    await this.ensureSchema();
    return this.aiAgentRuntimeService.listToolCatalog();
  }

  async listAppAgentBindings(appId: string) {
    await this.ensureSchema();
    await this.getAppById(appId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT b.*, a.slug AS agent_slug, a.name AS agent_name, a.status AS agent_status, a.published_version_id
         FROM ai_agent_app_bindings b
         JOIN ai_agents a ON a.id = b.agent_id
        WHERE b.app_id = $1::uuid
        ORDER BY a.updated_at DESC, a.created_at DESC`,
      appId,
    ) as Promise<Array<AgentAppBindingRow & {
      agent_slug: string;
      agent_name: string;
      agent_status: string;
      published_version_id: string | null;
    }>>);
    return {
      items: rows.map((row) => ({
        id: row.id,
        app_id: row.app_id,
        agent_id: row.agent_id,
        agent_slug: row.agent_slug,
        agent_name: row.agent_name,
        agent_status: row.agent_status,
        route_slug: row.route_slug,
        is_enabled: row.is_enabled,
        auth_policy: this.normalizeAuthPolicy(row.auth_policy),
        points_cost: this.toFiniteDecimal2(row.points_cost, 0),
        model_override: row.model_override,
        system_prompt_override: row.system_prompt_override,
        tool_override_json: this.parseJsonObject(row.tool_override_json),
        published_version_id: row.published_version_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    };
  }

  async upsertAppAgentBinding(appId: string, agentId: string, actorUserId: string, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const app = await this.getAppById(appId);
    const agent = await this.getAgentRow(agentId);
    const normalizedScope = this.normalizeScope(agent.scope);
    const ownerAppId = this.normalizeOptionalString(agent.owner_app_id, 64);
    if (normalizedScope === 'app' && ownerAppId && ownerAppId !== app.id) {
      throw new ForbiddenException('app-scoped agent can only bind to its owner app');
    }

    const routeSlug = payload.route_slug === undefined
      ? agent.slug
      : this.normalizeSlug(payload.route_slug, 'route_slug');
    const isEnabled = payload.is_enabled === undefined ? true : Boolean(payload.is_enabled);
    const authPolicy = this.normalizeAuthPolicy(payload.auth_policy);
    const pointsCost = this.normalizeNonNegativeDecimal(payload.points_cost, 'points_cost');
    const modelOverride = this.normalizeOptionalString(payload.model_override, 255);
    const systemPromptOverride = this.normalizeOptionalString(payload.system_prompt_override, 8000);
    const toolOverrideJson = this.parseJsonObject(payload.tool_override_json ?? {});

    const bindingId = randomUUID();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO ai_agent_app_bindings (
         id, app_id, agent_id, route_slug, is_enabled, auth_policy, points_cost, model_override,
         system_prompt_override, tool_override_json, created_by_user_id, updated_by_user_id, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::numeric, $8, $9, $10::jsonb, $11::uuid, $11::uuid, now(), now()
       )
       ON CONFLICT (app_id, agent_id)
       DO UPDATE SET
         route_slug = EXCLUDED.route_slug,
         is_enabled = EXCLUDED.is_enabled,
         auth_policy = EXCLUDED.auth_policy,
         points_cost = EXCLUDED.points_cost,
         model_override = EXCLUDED.model_override,
         system_prompt_override = EXCLUDED.system_prompt_override,
         tool_override_json = EXCLUDED.tool_override_json,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = now()`,
      bindingId,
      app.id,
      agent.id,
      routeSlug,
      isEnabled,
      authPolicy,
      pointsCost,
      modelOverride,
      systemPromptOverride,
      JSON.stringify(toolOverrideJson),
      actorUserId,
    );

    return this.listAppAgentBindings(appId);
  }

  async deleteAppAgentBinding(appId: string, agentId: string) {
    await this.ensureSchema();
    await this.getAppById(appId);
    await this.getAgentRow(agentId);
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM ai_agent_app_bindings WHERE app_id = $1::uuid AND agent_id = $2::uuid`,
      appId,
      agentId,
    );
    return { deleted: true, app_id: appId, agent_id: agentId };
  }

  async listPublishedAgentsForApp(appSlug: string) {
    await this.ensureSchema();
    const app = await this.getAppBySlug(appSlug);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT b.*, a.slug AS agent_slug, a.name AS agent_name, a.description AS agent_description, a.scope, a.visibility
         FROM ai_agent_app_bindings b
         JOIN ai_agents a ON a.id = b.agent_id
        WHERE b.app_id = $1::uuid
          AND b.is_enabled = true
          AND a.status = 'published'
          AND a.published_version_id IS NOT NULL
          AND (a.scope = 'global' OR a.owner_app_id = $1::uuid)
        ORDER BY a.updated_at DESC`,
      app.id,
    ) as Promise<Array<AgentAppBindingRow & {
      agent_slug: string;
      agent_name: string;
      agent_description: string | null;
      scope: string;
      visibility: string;
    }>>);
    return {
      items: rows.map((row) => ({
        slug: row.route_slug,
        agent_slug: row.agent_slug,
        name: row.agent_name,
        description: row.agent_description,
        visibility: row.visibility,
        scope: row.scope,
        auth_policy: row.auth_policy,
      })),
    };
  }

  async getAgentMetaForApp(appSlug: string, routeSlug: string) {
    await this.ensureSchema();
    const resolved = await this.resolvePublishedAgentForApp(appSlug, routeSlug);
    return this.serializeAppAgentMeta(resolved.app, resolved.agent, resolved.version, resolved.binding);
  }

  async runAgentForApp(request: any, appSlug: string, routeSlug: string, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const resolved = await this.resolvePublishedAgentForApp(appSlug, routeSlug);
    const actor = await this.resolveRequestActor(request, resolved.app.slug, this.normalizeAuthPolicy(resolved.binding.auth_policy));
    const runId = randomUUID();
    const inputText = this.normalizeRequiredString(payload.input, 'input', 20000);
    const variables = this.parseJsonObject(payload.variables ?? {});
    const debug = payload.debug === true;

    if (this.toFiniteDecimal2(resolved.binding.points_cost, 0) > 0 && !actor.userId) {
      throw new ForbiddenException('points-charged agent requires authenticated user');
    }

    await this.insertRun({
      id: runId,
      appId: resolved.app.id,
      userId: actor.userId,
      agentId: resolved.agent.id,
      agentVersionId: resolved.version.id,
      bindingId: resolved.binding.id,
      status: 'running',
      requestId: this.resolveRequestId(request),
      requestPath: request?.originalUrl || request?.url || `/${resolved.app.slug}/v1/agent/${routeSlug}/run`,
      routeSlug: resolved.binding.route_slug,
      modelKey: this.resolveRunModelKey(resolved.version, resolved.binding),
      outputMode: this.normalizeOutputMode(resolved.version.output_mode),
      authPolicy: this.normalizeAuthPolicy(resolved.binding.auth_policy),
      inputText,
      inputJson: payload,
      observability: this.buildRunObservability(request, resolved, actor, 'run'),
    });

    try {
      const entryFee = this.toFiniteDecimal2(resolved.binding.points_cost, 0);
      if (entryFee > 0 && actor.userId) {
        await this.aiPointsService.consumePoints({
          app_id: resolved.app.id,
          user_id: actor.userId,
          cost: entryFee,
          event_type: 'agent_run_entry',
          reference_type: 'ai_agent_run',
          reference_id: runId,
          metadata: {
            agent_id: resolved.agent.id,
            agent_slug: resolved.agent.slug,
            route_slug: resolved.binding.route_slug,
          },
        });
      }

      const runResult = await this.aiAgentRuntimeService.execute({
        app: resolved.app,
        actor,
        agent: resolved.agent,
        version: resolved.version,
        binding: resolved.binding,
      }, {
        runId,
        inputText,
        inputJson: payload,
        variables,
      });

      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_agent_runs
            SET status = 'completed',
                output_text = $2,
                output_json = $3::jsonb,
                total_prompt_tokens = $4,
                total_completion_tokens = $5,
                total_tool_calls = $6,
                points_charged = $7::numeric,
                rmb_cost = $8::numeric,
                duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) * 1000))::integer,
                model_key = COALESCE($9, model_key),
                completed_at = now(),
                updated_at = now()
          WHERE id = $1::uuid`,
        runId,
        runResult.output_text,
        JSON.stringify(runResult.output_json),
        runResult.total_prompt_tokens,
        runResult.total_completion_tokens,
        runResult.total_tool_calls,
        this.toFiniteDecimal2(entryFee, 0),
        0,
        runResult.model_key,
      );

      return {
        run_id: runId,
        status: 'completed',
        agent: {
          id: resolved.agent.id,
          slug: resolved.binding.route_slug,
          agent_slug: resolved.agent.slug,
          name: resolved.agent.name,
          version_id: resolved.version.id,
          version_number: resolved.version.version_number,
        },
        output_text: runResult.output_text,
        output_json: runResult.output_json,
        total_tool_calls: runResult.total_tool_calls,
        usage: {
          prompt_tokens: runResult.total_prompt_tokens,
          completion_tokens: runResult.total_completion_tokens,
          total_tokens: runResult.total_prompt_tokens + runResult.total_completion_tokens,
        },
        steps: debug ? runResult.debug_steps : undefined,
      };
    } catch (error) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_agent_runs
            SET status = 'failed',
                error_json = $2::jsonb,
                error_name = $3,
                error_message = $4,
                duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) * 1000))::integer,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1::uuid`,
        runId,
        JSON.stringify(this.serializeRunError(error)),
        this.serializeRunError(error).name,
        this.serializeRunError(error).message,
      );
      throw error;
    }
  }

  async runAgentForAppStream(request: any, appSlug: string, routeSlug: string, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const resolved = await this.resolvePublishedAgentForApp(appSlug, routeSlug);
    const actor = await this.resolveRequestActor(request, resolved.app.slug, this.normalizeAuthPolicy(resolved.binding.auth_policy));
    const runId = randomUUID();
    const inputText = this.normalizeRequiredString(payload.input, 'input', 20000);
    const variables = this.parseJsonObject(payload.variables ?? {});

    if (this.toFiniteDecimal2(resolved.binding.points_cost, 0) > 0 && !actor.userId) {
      throw new ForbiddenException('points-charged agent requires authenticated user');
    }

    await this.insertRun({
      id: runId,
      appId: resolved.app.id,
      userId: actor.userId,
      agentId: resolved.agent.id,
      agentVersionId: resolved.version.id,
      bindingId: resolved.binding.id,
      status: 'running',
      requestId: this.resolveRequestId(request),
      requestPath: request?.originalUrl || request?.url || `/${resolved.app.slug}/v1/agent/${routeSlug}/stream`,
      routeSlug: resolved.binding.route_slug,
      modelKey: this.resolveRunModelKey(resolved.version, resolved.binding),
      outputMode: this.normalizeOutputMode(resolved.version.output_mode),
      authPolicy: this.normalizeAuthPolicy(resolved.binding.auth_policy),
      inputText,
      inputJson: payload,
      observability: this.buildRunObservability(request, resolved, actor, 'stream'),
    });

    const encoder = new TextEncoder();
    const entryFee = this.toFiniteDecimal2(resolved.binding.points_cost, 0);
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (event: string, data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(this.buildSseEvent(event, data)));
        };
        try {
          send('agent.run.created', {
            run_id: runId,
            agent_slug: resolved.binding.route_slug,
            app_slug: resolved.app.slug,
          });
          if (entryFee > 0 && actor.userId) {
            await this.aiPointsService.consumePoints({
              app_id: resolved.app.id,
              user_id: actor.userId,
              cost: entryFee,
              event_type: 'agent_run_entry',
              reference_type: 'ai_agent_run',
              reference_id: runId,
              metadata: {
                agent_id: resolved.agent.id,
                agent_slug: resolved.agent.slug,
                route_slug: resolved.binding.route_slug,
              },
            });
          }

          const runResult = await this.aiAgentRuntimeService.execute({
            app: resolved.app,
            actor,
            agent: resolved.agent,
            version: resolved.version,
            binding: resolved.binding,
          }, {
            runId,
            inputText,
            inputJson: payload,
            variables,
          }, {
            onEvent: async (event, data) => {
              send(event, data);
            },
          });

          await this.prisma.$executeRawUnsafe(
            `UPDATE ai_agent_runs
                SET status = 'completed',
                    output_text = $2,
                    output_json = $3::jsonb,
                    total_prompt_tokens = $4,
                    total_completion_tokens = $5,
                    total_tool_calls = $6,
                    points_charged = $7::numeric,
                    rmb_cost = $8::numeric,
                    duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) * 1000))::integer,
                    model_key = COALESCE($9, model_key),
                    completed_at = now(),
                    updated_at = now()
              WHERE id = $1::uuid`,
            runId,
            runResult.output_text,
            JSON.stringify(runResult.output_json),
            runResult.total_prompt_tokens,
            runResult.total_completion_tokens,
            runResult.total_tool_calls,
            this.toFiniteDecimal2(entryFee, 0),
            0,
            runResult.model_key,
          );

          send('agent.run.completed', {
            run_id: runId,
            output_text: runResult.output_text,
            output_json: runResult.output_json,
            total_tool_calls: runResult.total_tool_calls,
            usage: {
              prompt_tokens: runResult.total_prompt_tokens,
              completion_tokens: runResult.total_completion_tokens,
            },
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (error) {
          await this.prisma.$executeRawUnsafe(
            `UPDATE ai_agent_runs
                SET status = 'failed',
                    error_json = $2::jsonb,
                    error_name = $3,
                    error_message = $4,
                    duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) * 1000))::integer,
                    completed_at = now(),
                    updated_at = now()
              WHERE id = $1::uuid`,
            runId,
            JSON.stringify(this.serializeRunError(error)),
            this.serializeRunError(error).name,
            this.serializeRunError(error).message,
          );
          send('agent.run.failed', {
            run_id: runId,
            message: error instanceof Error ? error.message : 'unknown error',
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    });

    return {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
      body,
    };
  }

  async runPlatformAgentTest(agentId: string, actorUserId: string, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const appId = this.normalizeRequiredString(payload.app_id, 'app_id', 64);
    const inputText = this.normalizeRequiredString(payload.input, 'input', 20000);
    const variables = this.parseJsonObject(payload.variables ?? {});
    const debug = payload.debug !== false;
    const app = await this.getAppById(appId);
    const agent = await this.getAgentRow(agentId);
    const version = agent.latest_version_id ? await this.getVersionRow(agent.latest_version_id) : null;
    if (!version) {
      throw new NotFoundException('latest agent version not found');
    }
    const binding = await this.getBindingByAppAndAgent(appId, agentId);
    const actor: RequestActor = {
      userId: this.normalizeOptionalString(payload.user_id, 64),
      role: 'ADMIN',
      email: null,
      appSlug: app.slug,
    };
    const runId = randomUUID();
    await this.insertRun({
      id: runId,
      appId: app.id,
      userId: actor.userId,
      agentId: agent.id,
      agentVersionId: version.id,
      bindingId: binding.id,
      status: 'running',
      requestId: null,
      requestPath: `/api/v1/platform-admin/agents/${agent.id}/test`,
      routeSlug: binding.route_slug,
      modelKey: this.resolveRunModelKey(version, binding),
      outputMode: this.normalizeOutputMode(version.output_mode),
      authPolicy: this.normalizeAuthPolicy(binding.auth_policy),
      inputText,
      inputJson: payload,
      observability: {
        mode: 'platform_test',
        app_slug: app.slug,
        agent_slug: agent.slug,
        route_slug: binding.route_slug,
        actor_role: actor.role,
      },
    });
    try {
      const runResult = await this.aiAgentRuntimeService.execute({ app, actor, agent, version, binding }, {
        runId,
        inputText,
        inputJson: payload,
        variables,
      });
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_agent_runs
            SET status = 'completed',
                output_text = $2,
                output_json = $3::jsonb,
                total_prompt_tokens = $4,
                total_completion_tokens = $5,
                total_tool_calls = $6,
                duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) * 1000))::integer,
                model_key = COALESCE($7, model_key),
                completed_at = now(),
                updated_at = now()
          WHERE id = $1::uuid`,
        runId,
        runResult.output_text,
        JSON.stringify(runResult.output_json),
        runResult.total_prompt_tokens,
        runResult.total_completion_tokens,
        runResult.total_tool_calls,
        runResult.model_key,
      );
      return {
        run_id: runId,
        status: 'completed',
        output_text: runResult.output_text,
        output_json: runResult.output_json,
        total_tool_calls: runResult.total_tool_calls,
        usage: {
          prompt_tokens: runResult.total_prompt_tokens,
          completion_tokens: runResult.total_completion_tokens,
        },
        steps: debug ? runResult.debug_steps : undefined,
      };
    } catch (error) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_agent_runs
            SET status = 'failed',
                error_json = $2::jsonb,
                error_name = $3,
                error_message = $4,
                duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) * 1000))::integer,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1::uuid`,
        runId,
        JSON.stringify(this.serializeRunError(error)),
        this.serializeRunError(error).name,
        this.serializeRunError(error).message,
      );
      throw error;
    }
  }

  async listAgentRuns(query: {
    agent_id?: string;
    app_id?: string;
    status?: string;
    page?: number;
    page_size?: number;
  }) {
    await this.ensureSchema();
    const page = Math.max(1, Number(query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(query.page_size || 20)));
    const where: string[] = [];
    const params: unknown[] = [];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.agent_id) {
      where.push(`r.agent_id = ${push(query.agent_id)}::uuid`);
    }
    if (query.app_id) {
      where.push(`r.app_id = ${push(query.app_id)}::uuid`);
    }
    if (query.status) {
      where.push(`r.status = ${push(String(query.status).trim().toLowerCase())}`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT r.*, a.name AS agent_name, app.slug AS app_slug
         FROM ai_agent_runs r
         JOIN ai_agents a ON a.id = r.agent_id
         JOIN apps app ON app.id = r.app_id
         ${whereClause}
        ORDER BY r.created_at DESC
        LIMIT ${push(pageSize)}
       OFFSET ${push(offset)}`,
      ...params,
    ) as Promise<Array<AgentRunRow & { agent_name: string; app_slug: string }>>);
    return {
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        app_id: row.app_id,
        app_slug: row.app_slug,
        user_id: row.user_id,
        input_text: row.input_text,
        output_text: row.output_text,
        route_slug: row.route_slug,
        model_key: row.model_key,
        output_mode: row.output_mode,
        auth_policy: row.auth_policy,
        total_prompt_tokens: Number(row.total_prompt_tokens || 0),
        total_completion_tokens: Number(row.total_completion_tokens || 0),
        total_tool_calls: Number(row.total_tool_calls || 0),
        points_charged: this.toFiniteDecimal2(row.points_charged, 0),
        rmb_cost: this.toFiniteDecimal2(row.rmb_cost, 0),
        duration_ms: Number(row.duration_ms || 0),
        error_name: row.error_name,
        error_message: row.error_message,
        observability: this.parseJsonObject(row.observability_json),
        started_at: row.started_at,
        completed_at: row.completed_at,
        expires_at: row.expires_at,
        created_at: row.created_at,
      })),
      page,
      page_size: pageSize,
    };
  }

  async getAgentRunDetail(runId: string) {
    await this.ensureSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT r.*,
              a.slug AS agent_slug,
              a.name AS agent_name,
              a.status AS agent_status,
              app.slug AS app_slug,
              app.name AS app_name,
              v.version_number
         FROM ai_agent_runs r
         JOIN ai_agents a ON a.id = r.agent_id
         JOIN apps app ON app.id = r.app_id
         JOIN ai_agent_versions v ON v.id = r.agent_version_id
        WHERE r.id = $1::uuid
        LIMIT 1`,
      runId,
    ) as Promise<Array<AgentRunRow & {
      agent_slug: string;
      agent_name: string;
      agent_status: string;
      app_slug: string;
      app_name: string;
      version_number: number;
    }>>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('agent run not found');
    }
    const stepRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, step_index, kind, payload_json, latency_ms, created_at, expires_at
         FROM ai_agent_run_steps
        WHERE run_id = $1::uuid
        ORDER BY step_index ASC, created_at ASC`,
      runId,
    ) as Promise<Array<{
      id: string;
      step_index: number;
      kind: string;
      payload_json: unknown;
      latency_ms: number;
      created_at: Date;
      expires_at: Date;
    }>>);
    return {
      id: row.id,
      status: row.status,
      request_id: row.request_id,
      request_path: row.request_path,
      route_slug: row.route_slug,
      model_key: row.model_key,
      output_mode: row.output_mode,
      auth_policy: row.auth_policy,
      app: {
        id: row.app_id,
        slug: row.app_slug,
        name: row.app_name,
      },
      agent: {
        id: row.agent_id,
        slug: row.agent_slug,
        name: row.agent_name,
        status: row.agent_status,
        version_id: row.agent_version_id,
        version_number: row.version_number,
      },
      binding_id: row.binding_id,
      user_id: row.user_id,
      input_text: row.input_text,
      input_json: this.parseJsonObject(row.input_json),
      output_text: row.output_text,
      output_json: this.parseJsonObject(row.output_json),
      error: {
        name: row.error_name,
        message: row.error_message,
        detail: this.parseJsonObject(row.error_json),
      },
      usage: {
        prompt_tokens: Number(row.total_prompt_tokens || 0),
        completion_tokens: Number(row.total_completion_tokens || 0),
        total_tokens: Number(row.total_prompt_tokens || 0) + Number(row.total_completion_tokens || 0),
        tool_calls: Number(row.total_tool_calls || 0),
      },
      cost: {
        points_charged: this.toFiniteDecimal2(row.points_charged, 0),
        rmb_cost: this.toFiniteDecimal2(row.rmb_cost, 0),
      },
      duration_ms: Number(row.duration_ms || 0),
      observability: this.parseJsonObject(row.observability_json),
      started_at: row.started_at,
      completed_at: row.completed_at,
      expires_at: row.expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      steps: stepRows.map((step) => ({
        id: step.id,
        step_index: step.step_index,
        kind: step.kind,
        latency_ms: Number(step.latency_ms || 0),
        payload: this.parseJsonObject(step.payload_json),
        created_at: step.created_at,
        expires_at: step.expires_at,
      })),
    };
  }

  private async resolvePublishedAgentForApp(appSlug: string, routeSlug: string) {
    const app = await this.getAppBySlug(appSlug);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT b.*, a.slug AS agent_slug, a.name AS agent_name, a.description AS agent_description,
              a.status AS agent_status, a.scope, a.owner_app_id, a.visibility, a.latest_version_id, a.published_version_id
         FROM ai_agent_app_bindings b
         JOIN ai_agents a ON a.id = b.agent_id
        WHERE b.app_id = $1::uuid
          AND LOWER(b.route_slug) = LOWER($2)
          AND b.is_enabled = true
          AND (a.scope = 'global' OR a.owner_app_id = $1::uuid)
        LIMIT 1`,
      app.id,
      routeSlug,
    ) as Promise<Array<AgentAppBindingRow & {
      agent_slug: string;
      agent_name: string;
      agent_description: string | null;
      agent_status: string;
      scope: string;
      owner_app_id: string | null;
      visibility: string;
      latest_version_id: string | null;
      published_version_id: string | null;
    }>>);
    const binding = rows[0];
    if (!binding) {
      throw new NotFoundException('agent route not found');
    }
    if (binding.agent_status !== 'published' || !binding.published_version_id) {
      throw new NotFoundException('agent is not published');
    }
    const version = await this.getVersionRow(binding.published_version_id);
    const agent = await this.getAgentRow(binding.agent_id);
    return { app, agent, version, binding };
  }

  private async getBindingByAppAndAgent(appId: string, agentId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM ai_agent_app_bindings
        WHERE app_id = $1::uuid
          AND agent_id = $2::uuid
        LIMIT 1`,
      appId,
      agentId,
    ) as Promise<AgentAppBindingRow[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('agent binding not found for target app');
    }
    return row;
  }

  private async resolveRequestActor(request: any, appSlug: string, authPolicy: AgentAuthPolicy): Promise<RequestActor> {
    const authHeader = String(request?.headers?.authorization || '').trim();
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      if (authPolicy === 'public') {
        return { userId: null, role: null, email: null, appSlug: null };
      }
      throw new UnauthorizedException('authentication required');
    }
    const token = String(match[1] || '').trim();
    if (!token) {
      throw new UnauthorizedException('authentication required');
    }
    const debugActor = await this.aiDebugAuthService.authenticateRequest(request);
    if (debugActor) {
      const actorAppSlug = String(debugActor.appSlug || '').trim();
      if (actorAppSlug && actorAppSlug !== appSlug) {
        throw new ForbiddenException('cross-app agent invocation is not allowed');
      }
      const role = String(debugActor.role || '').toUpperCase();
      if (authPolicy === 'admin' && role !== 'ADMIN') {
        throw new ForbiddenException('admin role required');
      }
      return {
        userId: String(debugActor.userId || debugActor.id || '').trim() || null,
        role: role || null,
        email: String(debugActor.email || '').trim() || null,
        appSlug: actorAppSlug || null,
      };
    }
    const actor = await this.authService.verifyAccessToken(token);
    const actorAppSlug = String(actor.appSlug || '').trim();
    if (actorAppSlug && actorAppSlug !== appSlug) {
      throw new ForbiddenException('cross-app agent invocation is not allowed');
    }
    const role = String(actor.role || '').toUpperCase();
    if (authPolicy === 'admin' && role !== 'ADMIN') {
      throw new ForbiddenException('admin role required');
    }
    return {
      userId: String(actor.userId || actor.id || '').trim() || null,
      role: role || null,
      email: String(actor.email || '').trim() || null,
      appSlug: actorAppSlug || null,
    };
  }

  private serializeAppAgentMeta(app: AppRow, agent: AgentRow, version: AgentVersionRow, binding: AgentAppBindingRow) {
    const tools = this.listToolBindingsByVersionId(version.id);
    return Promise.resolve(tools).then((rows) => ({
      app: {
        id: app.id,
        slug: app.slug,
        name: app.name,
      },
      agent: {
        id: agent.id,
        slug: binding.route_slug,
        agent_slug: agent.slug,
        name: agent.name,
        description: agent.description,
        scope: this.normalizeScope(agent.scope),
        owner_app_id: this.normalizeOptionalString(agent.owner_app_id, 64),
        visibility: this.normalizeVisibility(agent.visibility),
        auth_policy: this.normalizeAuthPolicy(binding.auth_policy),
        output_mode: this.normalizeOutputMode(version.output_mode),
        input_schema_json: this.parseJsonObject(version.input_schema_json),
        output_schema_json: this.parseJsonObject(version.output_schema_json),
        enabled_tool_packs: this.resolveEnabledToolPacks(
          this.parseJsonObject(version.tool_policy_json),
          this.parseJsonObject(binding.tool_override_json),
        ),
        tools: rows.filter((item) => item.is_enabled).map((item) => item.tool_key),
        version_number: version.version_number,
      },
    }));
  }

  private async serializeAgentSummary(agent: AgentRow) {
    const latestVersion = agent.latest_version_id ? await this.getVersionRow(agent.latest_version_id) : null;
    const publishedVersion = agent.published_version_id ? await this.getVersionRow(agent.published_version_id) : null;
    const bindingCountRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count FROM ai_agent_app_bindings WHERE agent_id = $1::uuid`,
      agent.id,
    ) as Promise<Array<{ count: string | number }>>);
    return {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      scope: this.normalizeScope(agent.scope),
      owner_app_id: this.normalizeOptionalString(agent.owner_app_id, 64),
      status: this.normalizeStatus(agent.status),
      visibility: this.normalizeVisibility(agent.visibility),
      latest_version: latestVersion ? this.serializeVersion(latestVersion) : null,
      published_version: publishedVersion ? this.serializeVersion(publishedVersion) : null,
      binding_count: Number(bindingCountRows[0]?.count || 0),
      created_at: agent.created_at,
      updated_at: agent.updated_at,
    };
  }

  private async serializeAgentDetail(agent: AgentRow) {
    const summary = await this.serializeAgentSummary(agent);
    const latestVersion = agent.latest_version_id ? await this.getVersionRow(agent.latest_version_id) : null;
    const publishedVersion = agent.published_version_id ? await this.getVersionRow(agent.published_version_id) : null;
    const latestTools = latestVersion ? await this.listToolBindingsByVersionId(latestVersion.id) : [];
    const bindings = await (this.prisma.$queryRawUnsafe(
      `SELECT b.*, app.slug AS app_slug, app.name AS app_name
         FROM ai_agent_app_bindings b
         JOIN apps app ON app.id = b.app_id
        WHERE b.agent_id = $1::uuid
        ORDER BY app.updated_at DESC, app.created_at DESC`,
      agent.id,
    ) as Promise<Array<AgentAppBindingRow & { app_slug: string; app_name: string }>>);
    return {
      ...summary,
      latest_version_detail: latestVersion ? {
        ...this.serializeVersion(latestVersion),
        available_tool_packs: AGENT_TOOL_PACKS,
        tool_bindings: latestTools.map((item) => ({
          tool_key: item.tool_key,
          is_enabled: item.is_enabled,
          config_json: this.parseJsonObject(item.config_json),
        })),
      } : null,
      published_version_detail: publishedVersion ? this.serializeVersion(publishedVersion) : null,
      bindings: bindings.map((item) => ({
        id: item.id,
        app_id: item.app_id,
        app_slug: item.app_slug,
        app_name: item.app_name,
        route_slug: item.route_slug,
        is_enabled: item.is_enabled,
        auth_policy: this.normalizeAuthPolicy(item.auth_policy),
        points_cost: this.toFiniteDecimal2(item.points_cost, 0),
        model_override: item.model_override,
        system_prompt_override: item.system_prompt_override,
        tool_override_json: this.parseJsonObject(item.tool_override_json),
        created_at: item.created_at,
        updated_at: item.updated_at,
      })),
    };
  }

  private serializeVersion(version: AgentVersionRow) {
    return {
      id: version.id,
      version_number: version.version_number,
      system_prompt_template: version.system_prompt_template,
      developer_prompt_template: version.developer_prompt_template,
      default_model: version.default_model,
      max_steps: version.max_steps,
      max_tool_calls: version.max_tool_calls,
      timeout_ms: version.timeout_ms,
      output_mode: this.normalizeOutputMode(version.output_mode),
      input_schema_json: this.parseJsonObject(version.input_schema_json),
      output_schema_json: this.parseJsonObject(version.output_schema_json),
      tool_policy_json: this.parseJsonObject(version.tool_policy_json),
      created_at: version.created_at,
    };
  }

  private normalizeVersionInput(payload: Record<string, unknown>, fallback?: AgentVersionRow) {
    const toolBindings = Array.isArray(payload.tools)
      ? payload.tools.map((item, index) => this.normalizeToolBindingInput(item, index))
      : fallback
        ? []
        : [];
    return {
      system_prompt_template: payload.system_prompt_template === undefined
        ? (fallback?.system_prompt_template || 'You are a reusable AI agent.')
        : this.normalizeRequiredString(payload.system_prompt_template, 'system_prompt_template', 20000),
      developer_prompt_template: payload.developer_prompt_template === undefined
        ? (fallback?.developer_prompt_template || null)
        : this.normalizeOptionalString(payload.developer_prompt_template, 20000),
      default_model: payload.default_model === undefined
        ? (fallback?.default_model || null)
        : this.normalizeOptionalString(payload.default_model, 255),
      max_steps: payload.max_steps === undefined
        ? Math.max(1, fallback?.max_steps || 6)
        : this.normalizeInteger(payload.max_steps, 'max_steps', 1, 20),
      max_tool_calls: payload.max_tool_calls === undefined
        ? Math.max(0, fallback?.max_tool_calls || 8)
        : this.normalizeInteger(payload.max_tool_calls, 'max_tool_calls', 0, 50),
      timeout_ms: payload.timeout_ms === undefined
        ? Math.max(1000, fallback?.timeout_ms || 60000)
        : this.normalizeInteger(payload.timeout_ms, 'timeout_ms', 1000, 300000),
      output_mode: payload.output_mode === undefined
        ? this.normalizeOutputMode(fallback?.output_mode || 'text')
        : this.normalizeOutputMode(payload.output_mode),
      input_schema_json: payload.input_schema_json === undefined
        ? this.parseJsonObject(fallback?.input_schema_json || {})
        : this.parseJsonObject(payload.input_schema_json),
      output_schema_json: payload.output_schema_json === undefined
        ? this.parseJsonObject(fallback?.output_schema_json || {})
        : this.parseJsonObject(payload.output_schema_json),
      tool_policy_json: payload.tool_policy_json === undefined
        ? this.parseJsonObject(fallback?.tool_policy_json || {})
        : this.parseJsonObject(payload.tool_policy_json),
      tools: toolBindings,
      inherit_existing_tools: !Array.isArray(payload.tools),
    };
  }

  private normalizeToolBindingInput(raw: unknown, index: number) {
    const row = this.parseJsonObject(raw);
    const toolKey = this.normalizeRequiredString(row.tool_key, `tools[${index}].tool_key`, 128);
    if (!this.aiAgentRuntimeService.hasTool(toolKey)) {
      throw new BadRequestException(`unknown tool_key: ${toolKey}`);
    }
    return {
      tool_key: toolKey,
      is_enabled: row.is_enabled === undefined ? true : Boolean(row.is_enabled),
      config_json: this.parseJsonObject(row.config_json ?? {}),
    };
  }

  private resolveEnabledToolPacks(
    templatePolicy: Record<string, unknown>,
    bindingOverride: Record<string, unknown>,
  ): AgentToolPackKey[] {
    const bindingPacks = this.normalizeToolPacks(bindingOverride.enabled_tool_packs);
    if (bindingPacks.length > 0) {
      return bindingPacks;
    }
    return this.normalizeToolPacks(templatePolicy.enabled_tool_packs);
  }

  private normalizeToolPacks(raw: unknown): AgentToolPackKey[] {
    const values = Array.isArray(raw) ? raw : [];
    const normalized = values
      .map((item) => String(item || '').trim())
      .filter((item): item is AgentToolPackKey => AGENT_TOOL_PACKS.some((pack) => pack.key === item));
    return Array.from(new Set(normalized));
  }

  private async listToolBindingsByVersionId(versionId: string) {
    return (this.prisma.$queryRawUnsafe(
      `SELECT * FROM ai_agent_tool_bindings WHERE agent_version_id = $1::uuid ORDER BY tool_key ASC`,
      versionId,
    ) as Promise<AgentToolBindingRow[]>);
  }

  private async insertVersion(
    tx: any,
    input: {
      id: string;
      agentId: string;
      versionNumber: number;
      actorUserId: string;
      input: ReturnType<AiAgentsService['normalizeVersionInput']>;
    },
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO ai_agent_versions (
         id, agent_id, version_number, system_prompt_template, developer_prompt_template, default_model,
         max_steps, max_tool_calls, timeout_ms, output_mode, input_schema_json, output_schema_json,
         tool_policy_json, created_by_user_id, created_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::uuid, now()
       )`,
      input.id,
      input.agentId,
      input.versionNumber,
      input.input.system_prompt_template,
      input.input.developer_prompt_template,
      input.input.default_model,
      input.input.max_steps,
      input.input.max_tool_calls,
      input.input.timeout_ms,
      input.input.output_mode,
      JSON.stringify(input.input.input_schema_json),
      JSON.stringify(input.input.output_schema_json),
      JSON.stringify(input.input.tool_policy_json),
      input.actorUserId,
    );

    let toolBindings = input.input.tools;
    if (input.input.inherit_existing_tools && input.versionNumber > 1) {
      const previousRows = await tx.$queryRawUnsafe(
        `SELECT * FROM ai_agent_tool_bindings
          WHERE agent_version_id = (
            SELECT id FROM ai_agent_versions
             WHERE agent_id = $1::uuid AND version_number = $2
             LIMIT 1
          )`,
        input.agentId,
        input.versionNumber - 1,
      ) as AgentToolBindingRow[];
      toolBindings = previousRows.map((row) => ({
        tool_key: row.tool_key,
        is_enabled: row.is_enabled,
        config_json: this.parseJsonObject(row.config_json),
      }));
    }

    for (const tool of toolBindings) {
      await tx.$executeRawUnsafe(
        `INSERT INTO ai_agent_tool_bindings (
           id, agent_version_id, tool_key, is_enabled, config_json, created_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb, now(), now()
         )`,
        input.id,
        tool.tool_key,
        tool.is_enabled,
        JSON.stringify(tool.config_json),
      );
    }
  }

  private resolveRunModelKey(version: AgentVersionRow, binding: AgentAppBindingRow) {
    return this.normalizeOptionalString(binding.model_override, 255)
      || this.normalizeOptionalString(version.default_model, 255);
  }

  private buildRunObservability(
    request: any,
    resolved: {
      app: AppRow;
      agent: AgentRow;
      version: AgentVersionRow;
      binding: AgentAppBindingRow;
    },
    actor: RequestActor,
    mode: 'run' | 'stream',
  ) {
    return {
      mode,
      app_slug: resolved.app.slug,
      agent_slug: resolved.agent.slug,
      route_slug: resolved.binding.route_slug,
      agent_version_number: resolved.version.version_number,
      actor_role: actor.role,
      has_user: Boolean(actor.userId),
      request_id: this.resolveRequestId(request),
      user_agent: this.normalizeOptionalString(request?.headers?.['user-agent'], 512),
    };
  }

  private resolveRequestId(request: any) {
    return this.normalizeOptionalString(
      request?.headers?.['x-request-id'] || request?.headers?.['x-correlation-id'],
      128,
    );
  }

  private serializeRunError(error: unknown) {
    return {
      message: (error instanceof Error ? error.message : 'unknown error').slice(0, 4000),
      name: (error instanceof Error ? error.name : 'Error').slice(0, 128),
    };
  }

  private async insertRun(input: {
    id: string;
    appId: string;
    userId: string | null;
    agentId: string;
    agentVersionId: string;
    bindingId: string;
    status: string;
    requestId: string | null;
    requestPath: string;
    routeSlug: string;
    modelKey: string | null;
    outputMode: AgentOutputMode;
    authPolicy: AgentAuthPolicy;
    inputText: string;
    inputJson: Record<string, unknown>;
    observability: Record<string, unknown>;
  }) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO ai_agent_runs (
         id, app_id, user_id, agent_id, agent_version_id, binding_id, status, request_id, request_path,
         route_slug, model_key, output_mode, auth_policy, input_text, input_json, observability_json,
         started_at, created_at, updated_at, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9,
         $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, now(), now(), now(), now() + interval '7 days'
       )`,
      input.id,
      input.appId,
      input.userId,
      input.agentId,
      input.agentVersionId,
      input.bindingId,
      input.status,
      input.requestId,
      input.requestPath,
      input.routeSlug,
      input.modelKey,
      input.outputMode,
      input.authPolicy,
      input.inputText,
      JSON.stringify(input.inputJson),
      JSON.stringify(input.observability),
    );
  }

  private async getAgentRow(agentId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM ai_agents WHERE id = $1::uuid LIMIT 1`,
      agentId,
    ) as Promise<AgentRow[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('agent not found');
    }
    return row;
  }

  private async getVersionRow(versionId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM ai_agent_versions WHERE id = $1::uuid LIMIT 1`,
      versionId,
    ) as Promise<AgentVersionRow[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('agent version not found');
    }
    return row;
  }

  private async getAppById(appId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, slug, name, status::text AS status FROM apps WHERE id = $1::uuid LIMIT 1`,
      appId,
    ) as Promise<AppRow[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('app not found');
    }
    return row;
  }

  private async getAppBySlug(appSlug: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, slug, name, status::text AS status FROM apps WHERE slug = $1 LIMIT 1`,
      appSlug,
    ) as Promise<AppRow[]>);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(`app not found: ${appSlug}`);
    }
    return row;
  }

  private normalizeSlug(value: unknown, field: string) {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!normalized) {
      throw new BadRequestException(`${field} is required`);
    }
    return normalized.slice(0, 96);
  }

  private normalizeRequiredString(value: unknown, field: string, maxLength = 255) {
    const normalized = String(value || '').trim();
    if (!normalized) {
      throw new BadRequestException(`${field} is required`);
    }
    return normalized.slice(0, maxLength);
  }

  private normalizeOptionalString(value: unknown, maxLength = 255) {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  private normalizeVisibility(value: unknown): AgentVisibility {
    const normalized = String(value || 'private').trim().toLowerCase();
    if (normalized === 'private' || normalized === 'internal' || normalized === 'public') {
      return normalized;
    }
    throw new BadRequestException(`invalid visibility: ${normalized}`);
  }

  private normalizeScope(value: unknown): AgentScope {
    const normalized = String(value || 'global').trim().toLowerCase();
    if (normalized === 'global' || normalized === 'app') {
      return normalized;
    }
    throw new BadRequestException(`invalid scope: ${normalized}`);
  }

  private normalizeStatus(value: unknown): AgentStatus {
    const normalized = String(value || 'draft').trim().toLowerCase();
    if (normalized === 'draft' || normalized === 'published' || normalized === 'archived') {
      return normalized;
    }
    throw new BadRequestException(`invalid status: ${normalized}`);
  }

  private normalizeOutputMode(value: unknown): AgentOutputMode {
    const normalized = String(value || 'text').trim().toLowerCase();
    if (normalized === 'text' || normalized === 'json') {
      return normalized;
    }
    throw new BadRequestException(`invalid output_mode: ${normalized}`);
  }

  private normalizeAuthPolicy(value: unknown): AgentAuthPolicy {
    const normalized = String(value || 'user').trim().toLowerCase();
    if (normalized === 'public' || normalized === 'user' || normalized === 'admin') {
      return normalized;
    }
    throw new BadRequestException(`invalid auth_policy: ${normalized}`);
  }

  private normalizeInteger(value: unknown, field: string, min: number, max: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException(`${field} must be between ${min} and ${max}`);
    }
    return Math.floor(parsed);
  }

  private normalizeNonNegativeDecimal(value: unknown, field: string) {
    const parsed = Number(value ?? 0);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new BadRequestException(`${field} must be >= 0`);
    }
    return Math.round(parsed * 100) / 100;
  }

  private parseJsonObject(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return {};
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        return {};
      } catch {
        return {};
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private toFiniteDecimal2(value: unknown, fallback: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.round(parsed * 100) / 100;
  }

  private buildSseEvent(event: string, payload: Record<string, unknown>) {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  private async ensureSchema() {
    if (!this.schemaEnsured) {
      this.schemaEnsured = this.verifySchemaReady().catch((error) => {
        this.schemaEnsured = null;
        throw error;
      });
    }
    await this.schemaEnsured;
  }

  private async verifySchemaReady() {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT table_name, to_regclass(table_name) IS NOT NULL AS exists
         FROM (
           VALUES
             ('ai_agents'),
             ('ai_agent_versions'),
             ('ai_agent_tool_bindings'),
             ('ai_agent_app_bindings'),
             ('ai_agent_runs'),
             ('ai_agent_run_steps')
         ) AS required(table_name)`,
    ) as Promise<Array<{ table_name: string; exists: boolean }>>);
    const missing = rows.filter((row) => !row.exists).map((row) => row.table_name);
    if (missing.length > 0) {
      throw new ServiceUnavailableException(
        `AI agent schema is not ready. Run Prisma migration 20260501_131500_ai_agent_runtime_tables first. Missing tables: ${missing.join(', ')}`,
      );
    }
    const columnRows = await (this.prisma.$queryRawUnsafe(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('ai_agent_runs', 'ai_agent_run_steps')
          AND column_name IN (
            'route_slug',
            'model_key',
            'output_mode',
            'auth_policy',
            'duration_ms',
            'error_name',
            'error_message',
            'observability_json',
            'expires_at'
          )`,
    ) as Promise<Array<{ table_name: string; column_name: string }>>);
    const present = new Set(columnRows.map((row) => `${row.table_name}.${row.column_name}`));
    const requiredColumns = [
      'ai_agent_runs.route_slug',
      'ai_agent_runs.model_key',
      'ai_agent_runs.output_mode',
      'ai_agent_runs.auth_policy',
      'ai_agent_runs.duration_ms',
      'ai_agent_runs.error_name',
      'ai_agent_runs.error_message',
      'ai_agent_runs.observability_json',
      'ai_agent_runs.expires_at',
      'ai_agent_run_steps.expires_at',
    ];
    const missingColumns = requiredColumns.filter((column) => !present.has(column));
    if (missingColumns.length > 0) {
      throw new ServiceUnavailableException(
        `AI agent observability schema is not ready. Run Prisma migration 20260501_142500_ai_agent_observability_retention first. Missing columns: ${missingColumns.join(', ')}`,
      );
    }
  }
}
