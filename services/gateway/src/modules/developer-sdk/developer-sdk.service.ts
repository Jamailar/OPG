import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import { DEFAULT_DEVELOPER_LOGIN_SCOPES, DEVELOPER_SCOPE_CATALOG } from './developer-authorization.service';

type AppRow = {
  id: string;
  slug: string;
  name: string;
  status: string;
};

type RequestActor = {
  id?: string | null;
  userId?: string | null;
  email?: string | null;
  role?: string | null;
  appSlug?: string | null;
  authMode?: string | null;
  apiKeyId?: string | null;
};

type ManifestOptions = {
  baseUrl: string;
  routePrefix: string;
};

const SDK_MANIFEST_VERSION = '2026-06-20';

@Injectable()
export class DeveloperSdkService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async getManifest(appSlug: string | undefined, options: ManifestOptions) {
    const app = await this.resolveApp(appSlug);
    const apiBaseUrl = `${options.baseUrl.replace(/\/+$/, '')}/${app.slug}/v1`;
    const bareBaseUrl = `${options.baseUrl.replace(/\/+$/, '')}/api/v1`;

    return {
      manifest_version: SDK_MANIFEST_VERSION,
      sdk: {
        package: 'opg-sdk',
        cli_package: '@jamba/opg-cli',
        min_node_version: '22',
      },
      app: {
        id: app.id,
        slug: app.slug,
        name: app.name,
        status: app.status,
        api_base_url: apiBaseUrl,
        bare_api_base_url: bareBaseUrl,
      },
      auth: {
        supported: ['platform_browser_login', 'browser_login', 'developer_grant', 'app_api_key', 'jwt'],
        developer_grant_prefix: 'opg_dev_',
        legacy_api_key_prefix: 'rbx_',
        scopes: DEVELOPER_SCOPE_CATALOG,
        browser_login: {
          platform_session_route: '/api/v1/sdk/auth/sessions',
          session_route: '/sdk/auth/sessions',
          authorize_route: '/sdk/auth/sessions/{state}/authorize',
          token_route: '/sdk/auth/token',
          ttl_seconds: 600,
          default_scopes: DEFAULT_DEVELOPER_LOGIN_SCOPES,
        },
        headers: {
          primary: 'Authorization: Bearer <OPG_API_KEY>',
          alternate: 'x-opg-api-key: <OPG_API_KEY>',
        },
      },
      capabilities: {
        ai: ['chat', 'responses', 'embedding', 'tts', 'stt', 'image', 'video'],
        agents: true,
        upload: true,
        video_async: true,
        usage: true,
        database: {
          app_namespace: true,
          introspect: true,
          query: true,
          ddl_dry_run: true,
          ddl_apply: true,
        },
        app_schema: {
          manifest: true,
          create_table: true,
          drop_table: true,
          add_column: true,
          policy_templates: true,
        },
        data_api: {
          schema: true,
          list: true,
          get: true,
          create: true,
          update: true,
          delete: true,
        },
        functions: {
          create: true,
          deploy: true,
          invoke: true,
          runs: true,
          delete: true,
        },
        workflows: {
          create: true,
          run: true,
          runs: true,
          delete: true,
        },
        ai_blocks: {
          upsert: true,
          run: true,
        },
        video_blocks: {
          upsert: true,
          run: true,
        },
        storage_blocks: {
          save: true,
        },
        build_observability: {
          summary: true,
          events: true,
        },
        api_catalog: true,
        developer_smoke_test: true,
      },
      routes: {
        sdk_manifest: '/sdk/manifest',
        sdk_openapi: '/sdk/openapi.json',
        sdk_examples: '/sdk/examples',
        sdk_smoke_test: '/sdk/smoke-test',
        sdk_login_sessions: '/sdk/auth/sessions',
        sdk_login_authorize: '/sdk/auth/sessions/{state}/authorize',
        sdk_login_token: '/sdk/auth/token',
        database_manifest: '/sdk/database/manifest',
        database_tables: '/sdk/database/tables',
        database_table: '/sdk/database/tables/{table}',
        database_query: '/sdk/database/query',
        database_execute: '/sdk/database/execute',
        data_schema: '/data/schema',
        data_table: '/data/{table}',
        data_row: '/data/{table}/{id}',
        functions_list: '/api/v1/platform-admin/apps/{app}/functions',
        functions_runtime_status: '/api/v1/platform-admin/functions/runtime/status',
        function_invoke: '/functions/{slug}/invoke',
        workflows_list: '/api/v1/platform-admin/apps/{app}/workflows',
        workflows_runtime_status: '/api/v1/platform-admin/workflows/runtime/status',
        workflow_run: '/workflows/{slug}/run',
        schema_manifest: '/api/v1/platform-admin/apps/{app}/schema/manifest',
        schema_table: '/api/v1/platform-admin/apps/{app}/schema/tables/{table}',
        schema_policies: '/api/v1/platform-admin/apps/{app}/schema/tables/{table}/policies',
        ai_block_run: '/api/v1/platform-admin/apps/{app}/blocks/ai/{block}/run',
        video_block_run: '/api/v1/platform-admin/apps/{app}/blocks/video/{block}/run',
        storage_save: '/api/v1/platform-admin/apps/{app}/storage/save',
        build_summary: '/api/v1/platform-admin/apps/{app}/build/summary',
        build_events: '/api/v1/platform-admin/apps/{app}/build/events',
        models: '/models',
        model_pricing: '/models/pricing',
        chat_completions: '/chat/completions',
        responses: '/responses',
        embeddings: '/embeddings',
        audio_speech: '/audio/speech',
        audio_transcriptions: '/audio/transcriptions',
        images_generations: '/images/generations',
        images_edits: '/images/edits',
        videos_generations: '/videos/generations',
        videos_generations_async: '/videos/generations/async',
        videos_task_query: '/videos/generations/tasks/query',
        agents_list: '/agent',
        agent_meta: '/agent/{slug}/meta',
        agent_run: '/agent/{slug}/run',
        agent_stream: '/agent/{slug}/stream',
        upload_presigned_url: '/upload/presigned-url',
        upload_image_buffer: '/upload/image-buffer',
        upload_file_buffer: '/upload/file-buffer',
        user_api_keys: '/users/me/api-keys',
        user_ai_usage_logs: '/users/me/ai-usage-logs',
      },
      codex: {
        install_command: `npx -y @jamba/opg-cli init --base-url ${options.baseUrl}\nnpx -y @jamba/opg-cli login\nnpx -y @jamba/opg-cli app use ${app.slug}\nnpx -y @jamba/opg-cli login --app ${app.slug}\nnpx -y @jamba/opg-cli codex install`,
        mcp_server_command: 'npx',
        mcp_server_args: ['-y', '@jamba/opg-cli', 'mcp'],
        environment: ['OPG_BASE_URL', 'OPG_APP_SLUG'],
      },
    };
  }

  async getOpenApi(appSlug: string | undefined, options: ManifestOptions) {
    const manifest = await this.getManifest(appSlug, options);
    const app = manifest.app;
    const serverUrl = app.api_base_url;

    return {
      openapi: '3.1.0',
      info: {
        title: `${app.name} OPG Developer API`,
        version: SDK_MANIFEST_VERSION,
        description: 'Stable OPG SDK contract for AI apps, agents, uploads, async video tasks, and usage inspection.',
      },
      servers: [{ url: serverUrl }],
      security: [{ bearerAuth: [] }, { opgApiKey: [] }],
      paths: {
        '/sdk/manifest': { get: { operationId: 'getSdkManifest', summary: 'Read OPG SDK manifest' } },
        '/sdk/smoke-test': { post: { operationId: 'runSdkSmokeTest', summary: 'Check SDK authentication and route contract' } },
        '/sdk/database/manifest': { get: { operationId: 'getDatabaseManifest', summary: 'Read app-scoped database safety contract' } },
        '/sdk/database/tables': { get: { operationId: 'listDatabaseTables', summary: 'List app-owned database tables' } },
        '/sdk/database/tables/{table}': { get: { operationId: 'describeDatabaseTable', summary: 'Describe app-owned database table' } },
        '/sdk/database/query': { post: { operationId: 'queryDatabase', summary: 'Run read-only SQL against app-owned tables' } },
        '/sdk/database/execute': { post: { operationId: 'executeDatabaseSql', summary: 'Dry-run or apply SQL changes inside the app namespace' } },
        '/models': { get: { operationId: 'listModels', summary: 'List OpenAI-compatible models' } },
        '/chat/completions': { post: { operationId: 'createChatCompletion', summary: 'OpenAI-compatible chat completion' } },
        '/responses': { post: { operationId: 'createResponse', summary: 'OpenAI-compatible responses API' } },
        '/embeddings': { post: { operationId: 'createEmbedding', summary: 'OpenAI-compatible embeddings' } },
        '/images/generations': { post: { operationId: 'createImage', summary: 'Generate images through OPG AI Gateway' } },
        '/videos/generations/async': { post: { operationId: 'createVideoTask', summary: 'Create async video generation task' } },
        '/videos/generations/tasks/query': { post: { operationId: 'queryVideoTask', summary: 'Query async video generation task' } },
        '/agent': { get: { operationId: 'listAgents', summary: 'List published app agents' } },
        '/agent/{slug}/run': { post: { operationId: 'runAgent', summary: 'Run a published app agent' } },
        '/agent/{slug}/stream': { post: { operationId: 'streamAgent', summary: 'Stream a published app agent run' } },
        '/upload/presigned-url': { post: { operationId: 'createPresignedUploadUrl', summary: 'Create signed upload URL' } },
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
          opgApiKey: { type: 'apiKey', in: 'header', name: 'x-opg-api-key' },
        },
      },
      'x-opg-manifest': manifest,
    };
  }

  async getExamples(appSlug: string | undefined, target: string | undefined, options: ManifestOptions) {
    const manifest = await this.getManifest(appSlug, options);
    const normalizedTarget = String(target || 'node').trim().toLowerCase();
    const env = [
      `OPG_BASE_URL=${options.baseUrl.replace(/\/+$/, '')}`,
      `OPG_APP_SLUG=${manifest.app.slug}`,
      '# Run: npx -y @jamba/opg-cli login',
    ].join('\n');

    const node = `import { createOpgClient } from 'opg-sdk';

const opg = createOpgClient({
  baseUrl: process.env.OPG_BASE_URL!,
  app: process.env.OPG_APP_SLUG!,
  apiKey: process.env.OPG_API_KEY!,
});

const result = await opg.agents.run('assistant', {
  input: { prompt: 'Write a short product description.' },
});

console.log(result);`;

    const react = `import { createOpgClient } from 'opg-sdk';

const opg = createOpgClient({
  baseUrl: import.meta.env.VITE_OPG_BASE_URL,
  app: import.meta.env.VITE_OPG_APP_SLUG,
  apiKey: async () => getUserScopedToken(),
});

export async function runAssistant(prompt: string) {
  return opg.agents.run('assistant', { input: { prompt } });
}`;

    const codex = `npx -y @jamba/opg-cli init --base-url ${options.baseUrl}
npx -y @jamba/opg-cli login
npx -y @jamba/opg-cli app use ${manifest.app.slug}
npx -y @jamba/opg-cli login --app ${manifest.app.slug}
npx -y @jamba/opg-cli codex install`;

    const databaseNamespace = this.namespaceForApp(manifest.app.slug);
    const database = `opg db smoke
opg db query --sql "SELECT * FROM ${databaseNamespace}customers"
opg db execute --sql "CREATE TABLE ${databaseNamespace}customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())" --dry-run true`;

    return {
      target: normalizedTarget,
      env,
      install: 'npm install opg-sdk',
      examples: {
        node,
        react,
        codex,
        database,
      },
      selected: normalizedTarget === 'react' ? react : normalizedTarget === 'codex' ? codex : normalizedTarget === 'database' ? database : node,
    };
  }

  async runSmokeTest(appSlug: string | undefined, actor: RequestActor | undefined, options: ManifestOptions) {
    const manifest = await this.getManifest(appSlug || actor?.appSlug || undefined, options);
    const checks = [
      {
        key: 'auth',
        ok: !!actor,
        message: actor ? `authenticated as ${actor.email || actor.userId || actor.id || actor.authMode || 'actor'}` : 'missing actor',
      },
      {
        key: 'app',
        ok: !!manifest.app.slug,
        message: `${manifest.app.slug} resolved`,
      },
      {
        key: 'ai_gateway',
        ok: true,
        message: 'OpenAI-compatible AI routes are present in the SDK manifest',
      },
      {
        key: 'agents',
        ok: true,
        message: 'Agent list/run/stream routes are present in the SDK manifest',
      },
      {
        key: 'video_async',
        ok: true,
        message: 'Async video submit/query routes are present in the SDK manifest',
      },
      {
        key: 'database',
        ok: true,
        message: 'App-scoped database manifest/query/execute routes are present in the SDK manifest',
      },
    ];

    return {
      ok: checks.every((check) => check.ok),
      app: manifest.app,
      actor: actor
        ? {
            user_id: actor.userId || actor.id || null,
            email: actor.email || null,
            role: actor.role || null,
            auth_mode: actor.authMode || 'jwt',
            api_key_id: actor.apiKeyId || null,
          }
        : null,
      checks,
      next: {
        list_models: `${manifest.app.api_base_url}${manifest.routes.models}`,
        list_agents: `${manifest.app.api_base_url}${manifest.routes.agents_list}`,
        database_manifest: `${manifest.app.api_base_url}${manifest.routes.database_manifest}`,
      },
    };
  }

  private async resolveApp(appSlug?: string) {
    const normalized = String(appSlug || '').trim();
    if (!normalized) {
      throw new BadRequestException('app is required');
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, slug, name, status::text AS status FROM apps WHERE slug = $1 LIMIT 1`,
      normalized,
    ) as Promise<AppRow[]>);

    const app = rows[0];
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  private namespaceForApp(appSlug: string) {
    const normalized = appSlug
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');
    const safeSlug = normalized && /^[a-z_]/.test(normalized) ? normalized : `app_${normalized || 'default'}`;
    return `app_${safeSlug}__`;
  }
}
