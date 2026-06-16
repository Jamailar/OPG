import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';

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

const SDK_MANIFEST_VERSION = '2026-06-16';

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
        package: '@opg/sdk',
        cli_package: '@opg/cli',
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
        supported: ['app_api_key', 'jwt'],
        api_key_prefix: 'rbx_',
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
        api_catalog: true,
        developer_smoke_test: true,
      },
      routes: {
        sdk_manifest: '/sdk/manifest',
        sdk_openapi: '/sdk/openapi.json',
        sdk_examples: '/sdk/examples',
        sdk_smoke_test: '/sdk/smoke-test',
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
        install_command: `npx -y @opg/cli codex install --base-url ${options.baseUrl} --app ${app.slug}`,
        mcp_server_command: 'npx',
        mcp_server_args: ['-y', '@opg/cli', 'mcp'],
        environment: ['OPG_BASE_URL', 'OPG_APP_SLUG', 'OPG_API_KEY'],
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
      'OPG_API_KEY=rbx_replace_me',
    ].join('\n');

    const node = `import { createOpgClient } from '@opg/sdk';

const opg = createOpgClient({
  baseUrl: process.env.OPG_BASE_URL!,
  app: process.env.OPG_APP_SLUG!,
  apiKey: process.env.OPG_API_KEY!,
});

const result = await opg.agents.run('assistant', {
  input: { prompt: 'Write a short product description.' },
});

console.log(result);`;

    const react = `import { createOpgClient } from '@opg/sdk';

const opg = createOpgClient({
  baseUrl: import.meta.env.VITE_OPG_BASE_URL,
  app: import.meta.env.VITE_OPG_APP_SLUG,
  apiKey: async () => getUserScopedToken(),
});

export async function runAssistant(prompt: string) {
  return opg.agents.run('assistant', { input: { prompt } });
}`;

    const codex = `npx -y @opg/cli init --base-url ${options.baseUrl} --app ${manifest.app.slug}
npx -y @opg/cli codex install --base-url ${options.baseUrl} --app ${manifest.app.slug}`;

    return {
      target: normalizedTarget,
      env,
      install: 'npm install @opg/sdk',
      examples: {
        node,
        react,
        codex,
      },
      selected: normalizedTarget === 'react' ? react : normalizedTarget === 'codex' ? codex : node,
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
}
