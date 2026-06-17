#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createOpgClient, createOpgPlatformClient, type OpgClient, type OpgPlatformClient } from 'opg-sdk';

type CliConfig = {
  baseUrl: string;
  app: string;
  apiKey?: string;
  platformToken?: string;
};

const args = process.argv.slice(2);
const command = args[0] || 'help';

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});

async function main() {
  if (command === 'init') {
    await initProject(parseFlags(args.slice(1)));
    return;
  }
  if (command === 'manifest') {
    console.log(JSON.stringify(await getClientFromFlags(args.slice(1)).sdk.manifest(), null, 2));
    return;
  }
  if (command === 'smoke') {
    console.log(JSON.stringify(await getClientFromFlags(args.slice(1)).sdk.smokeTest(), null, 2));
    return;
  }
  if (command === 'db' || command === 'database') {
    await runDatabaseCommand(args.slice(1));
    return;
  }
  if (command === 'platform') {
    await runPlatformCommand(args.slice(1));
    return;
  }
  if (command === 'codex' && args[1] === 'install') {
    await installCodex(parseFlags(args.slice(2)));
    return;
  }
  if (command === 'mcp') {
    await startMcpServer();
    return;
  }
  printHelp();
}

async function initProject(flags: Record<string, string>) {
  const config = readConfigFromFlags(flags);
  await mkdir('.opg', { recursive: true });
  await writeFile(
    '.opg/opg.config.json',
    `${JSON.stringify({ baseUrl: config.baseUrl, app: config.app, profile: flags.profile || 'default' }, null, 2)}\n`,
  );

  if (!existsSync('.env.local')) {
    await writeFile(
      '.env.local',
      [
        `OPG_BASE_URL=${config.baseUrl}`,
        `OPG_APP_SLUG=${config.app}`,
        `OPG_API_KEY=${config.apiKey || 'rbx_replace_me'}`,
        '',
      ].join('\n'),
    );
  }

  if (flags['skip-manifest'] !== 'true' && flags['skip-manifest'] !== '1') {
    const client = createOpgClient(config);
    try {
      const manifest = await client.sdk.manifest();
      await writeFile('.opg/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      console.warn(`Warning: could not fetch SDK manifest yet (${formatError(error)}). Run "opg manifest" after the gateway is reachable.`);
    }
  }
  await writeFile('.opg/client-example.ts', buildClientExample(config.app));

  console.log(`OPG project profile written for app ${config.app}.`);
  console.log('Next: npm install opg-sdk');
}

async function installCodex(flags: Record<string, string>) {
  const config = readConfigFromFlags(flags);
  await mkdir('.opg', { recursive: true });
  const mcpConfig = {
    mcpServers: {
      opg: {
        command: 'npx',
        args: ['-y', 'opg-dev-cli', 'mcp'],
        env: {
          OPG_BASE_URL: config.baseUrl,
          OPG_APP_SLUG: config.app,
          OPG_API_KEY: '${OPG_API_KEY}',
          OPG_PLATFORM_TOKEN: '${OPG_PLATFORM_TOKEN}',
        },
      },
    },
  };
  await writeFile('.opg/codex-mcp.json', `${JSON.stringify(mcpConfig, null, 2)}\n`);
  console.log('Codex MCP config written to .opg/codex-mcp.json.');
  console.log('Keep OPG_API_KEY in your shell or project secret store; do not commit real keys.');
}

async function runDatabaseCommand(commandArgs: string[]) {
  const subcommand = commandArgs[0] || 'manifest';
  const rest = commandArgs.slice(1);
  const flags = parseFlags(rest);
  const client = await getClientFromLocalConfigWithFlagOverrides(flags);

  if (subcommand === 'manifest') {
    printJson(await client.database.manifest());
    return;
  }
  if (subcommand === 'tables') {
    printJson(await client.database.tables());
    return;
  }
  if (subcommand === 'smoke') {
    const manifest = await client.database.manifest();
    const namespace = String((manifest as any)?.namespace || '');
    const table = `${namespace}opg_sdk_smoke_${Date.now()}`;
    const tables = await client.database.tables();
    const dryRun = await client.database.execute({
      sql: `CREATE TABLE ${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now())`,
      dryRun: true,
    });
    printJson({
      ok: true,
      manifest,
      tables,
      dry_run: dryRun,
      message: 'Database workspace is reachable. Dry-run DDL was validated and rolled back by the gateway.',
    });
    return;
  }
  if (subcommand === 'describe') {
    const table = flags.table || rest.find((item) => !item.startsWith('--')) || '';
    if (!table) {
      throw new Error('Missing table name. Use: opg db describe <table>');
    }
    printJson(await client.database.describe(table));
    return;
  }
  if (subcommand === 'query') {
    const sql = flags.sql || '';
    if (!sql) {
      throw new Error('Missing SQL. Use: opg db query --sql "SELECT * FROM app_demo__customers"');
    }
    printJson(await client.database.query({
      sql,
      params: flags.params ? JSON.parse(flags.params) : undefined,
      limit: flags.limit ? Number(flags.limit) : undefined,
    }));
    return;
  }
  if (subcommand === 'execute') {
    const sql = flags.sql || '';
    if (!sql) {
      throw new Error('Missing SQL. Use: opg db execute --sql "CREATE TABLE ..."');
    }
    printJson(await client.database.execute({
      sql,
      params: flags.params ? JSON.parse(flags.params) : undefined,
      dryRun: flags['dry-run'] === undefined ? undefined : parseBooleanFlag(flags['dry-run']),
      confirm: flags.confirm,
    }));
    return;
  }

  throw new Error(`Unknown database command: ${subcommand}`);
}

async function runPlatformCommand(commandArgs: string[]) {
  const resource = commandArgs[0] || 'apps';
  const action = commandArgs[1] || 'list';
  const flags = parseFlags(commandArgs.slice(2));
  const client = await getPlatformClientFromLocalConfigWithFlagOverrides(flags);

  if (resource === 'apps') {
    if (action === 'list') {
      printJson(await client.apps.list({ includeInactive: flags.includeInactive !== 'false' && flags['include-inactive'] !== 'false' }));
      return;
    }
    if (action === 'get') {
      const appId = flags.appId || flags['app-id'] || '';
      if (!appId) throw new Error('Missing app id. Use: opg platform apps get --app-id <id>');
      printJson(await client.apps.get(appId));
      return;
    }
    if (action === 'create') {
      printJson(await client.apps.create(parseJsonPayload(flags)));
      return;
    }
    if (action === 'update') {
      const appId = flags.appId || flags['app-id'] || '';
      if (!appId) throw new Error('Missing app id. Use: opg platform apps update --app-id <id> --json {...}');
      printJson(await client.apps.update(appId, parseJsonPayload(flags)));
      return;
    }
  }

  if (resource === 'runtime' || resource === 'runtime-settings') {
    if (action === 'get') {
      printJson(await client.runtimeSettings.get());
      return;
    }
    if (action === 'update') {
      printJson(await client.runtimeSettings.update(parseJsonPayload(flags)));
      return;
    }
  }

  if (resource === 'request') {
    const path = flags.path || '';
    if (!path) throw new Error('Missing platform path. Use: opg platform request --path /apps');
    printJson(await client.request(path, {
      method: (flags.method || 'GET').toUpperCase(),
      query: flags.query ? JSON.parse(flags.query) : undefined,
      body: flags.json ? JSON.parse(flags.json) : undefined,
    }));
    return;
  }

  throw new Error(`Unknown platform command: ${resource} ${action}`);
}

async function startMcpServer() {
  const client = await getClientFromConfig();
  const platformClient = await getPlatformClientFromConfig();
  const server = new McpServer({
    name: 'opg-mcp-server',
    version: '0.1.0',
  });
  const registerTool = (name: string, config: Record<string, unknown>, handler: (input: any) => Promise<any>) => {
    (server as any).registerTool(name, config, handler);
  };

  registerTool(
    'opg_platform_apps_list',
    {
      title: 'List OPG Platform Apps',
      description: 'List tenant apps from the global OPG platform control plane. Requires OPG_PLATFORM_TOKEN with platform admin access.',
      inputSchema: {
        includeInactive: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ includeInactive }: any) => toToolResult(await platformClient.apps.list({ includeInactive })),
  );

  registerTool(
    'opg_platform_app_create',
    {
      title: 'Create OPG Platform App',
      description: 'Create a tenant app from the global OPG platform control plane. Requires OPG_PLATFORM_TOKEN with platform admin access.',
      inputSchema: {
        payload: z.record(z.unknown()).describe('App creation payload accepted by POST /api/v1/platform-admin/apps.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ payload }: any) => toToolResult(await platformClient.apps.create(payload)),
  );

  registerTool(
    'opg_platform_app_update',
    {
      title: 'Update OPG Platform App',
      description: 'Update a tenant app by id from the global OPG platform control plane.',
      inputSchema: {
        appId: z.string().min(1),
        payload: z.record(z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, payload }: any) => toToolResult(await platformClient.apps.update(appId, payload)),
  );

  registerTool(
    'opg_platform_runtime_settings_get',
    {
      title: 'Get OPG Runtime Settings',
      description: 'Read global runtime settings such as API base URL, CORS, payments scheduler, and integration settings.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toToolResult(await platformClient.runtimeSettings.get()),
  );

  registerTool(
    'opg_platform_runtime_settings_update',
    {
      title: 'Update OPG Runtime Settings',
      description: 'Update global runtime settings. Requires OPG_PLATFORM_TOKEN with platform admin access.',
      inputSchema: {
        payload: z.record(z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ payload }: any) => toToolResult(await platformClient.runtimeSettings.update(payload)),
  );

  registerTool(
    'opg_platform_storage_providers_list',
    {
      title: 'List OPG Storage Providers',
      description: 'List global object storage providers.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toToolResult(await platformClient.storageProviders.list()),
  );

  registerTool(
    'opg_platform_storage_provider_create',
    {
      title: 'Create OPG Storage Provider',
      description: 'Create a global object storage provider.',
      inputSchema: {
        payload: z.record(z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ payload }: any) => toToolResult(await platformClient.storageProviders.create(payload)),
  );

  registerTool(
    'opg_platform_ai_sources_list',
    {
      title: 'List OPG AI Sources',
      description: 'List global AI provider sources.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toToolResult(await platformClient.ai.sources.list()),
  );

  registerTool(
    'opg_platform_ai_source_create',
    {
      title: 'Create OPG AI Source',
      description: 'Create a global AI provider source.',
      inputSchema: {
        payload: z.record(z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ payload }: any) => toToolResult(await platformClient.ai.sources.create(payload)),
  );

  registerTool(
    'opg_platform_ai_models_list',
    {
      title: 'List OPG AI Models',
      description: 'List global AI model routes and defaults.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toToolResult(await platformClient.ai.models.list()),
  );

  registerTool(
    'opg_platform_ai_model_create',
    {
      title: 'Create OPG AI Model',
      description: 'Create a global AI model route.',
      inputSchema: {
        payload: z.record(z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ payload }: any) => toToolResult(await platformClient.ai.models.create(payload)),
  );

  registerTool(
    'opg_platform_request',
    {
      title: 'Call OPG Platform API',
      description: 'Call any /api/v1/platform-admin path using OPG_PLATFORM_TOKEN. Use specific tools first when available.',
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        path: z.string().min(1).describe('Path under /api/v1/platform-admin, for example /apps or /storage/providers.'),
        query: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
        body: z.record(z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ method, path, query, body }: any) => toToolResult(await platformClient.request(path, { method, query, body })),
  );

  registerTool(
    'opg_manifest_get',
    {
      title: 'Get OPG SDK Manifest',
      description: 'Read the current app SDK manifest, routes, capabilities, install commands, and auth contract.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => toToolResult(await client.sdk.manifest()),
  );

  registerTool(
    'opg_sdk_smoke_test',
    {
      title: 'Run OPG SDK Smoke Test',
      description: 'Validate that the configured OPG app and API key can access the SDK contract. This does not spend model tokens.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => toToolResult(await client.sdk.smokeTest()),
  );

  registerTool(
    'opg_agents_list',
    {
      title: 'List OPG Agents',
      description: 'List published AI agents bound to the configured OPG app.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => toToolResult(await client.agents.list()),
  );

  registerTool(
    'opg_agents_run',
    {
      title: 'Run OPG Agent',
      description: 'Run a published OPG app agent by slug with JSON input.',
      inputSchema: {
        slug: z.string().min(1).describe('Published agent route slug.'),
        input: z.record(z.unknown()).default({}).describe('Agent input payload.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ slug, input }: any) => toToolResult(await client.agents.run(slug, input)),
  );

  registerTool(
    'opg_ai_models_list',
    {
      title: 'List OPG AI Models',
      description: 'List OpenAI-compatible models available through the configured OPG app.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => toToolResult(await client.ai.models()),
  );

  registerTool(
    'opg_ai_chat_completions',
    {
      title: 'Create OPG Chat Completion',
      description: 'Call the OPG OpenAI-compatible chat/completions route. This may spend model tokens and app points.',
      inputSchema: {
        model: z.string().min(1).describe('OPG model key or upstream-compatible model name.'),
        messages: z.array(z.record(z.unknown())).min(1).describe('OpenAI-compatible chat messages.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => toToolResult(await client.ai.chat(input)),
  );

  registerTool(
    'opg_video_submit',
    {
      title: 'Submit OPG Video Task',
      description: 'Submit an async video generation payload through OPG. This may spend provider credits and app points.',
      inputSchema: {
        payload: z.record(z.unknown()).describe('Video generation payload for /videos/generations/async.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ payload }: any) => toToolResult(await client.video.generateAsync(payload)),
  );

  registerTool(
    'opg_video_query',
    {
      title: 'Query OPG Video Task',
      description: 'Query an async video generation task by passing the provider or OPG task payload.',
      inputSchema: {
        payload: z.record(z.unknown()).describe('Task query payload for /videos/generations/tasks/query.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ payload }: any) => toToolResult(await client.video.queryTask(payload)),
  );

  registerTool(
    'opg_usage_recent',
    {
      title: 'List Recent OPG AI Usage',
      description: 'List recent AI usage logs for the configured user/app.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, page }: any) => toToolResult(await client.usage.aiLogs({ limit, page })),
  );

  registerTool(
    'opg_database_manifest_get',
    {
      title: 'Get OPG Database Manifest',
      description: 'Read the app-scoped database namespace, safety contract, limits, and apply confirmation token.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toToolResult(await client.database.manifest()),
  );

  registerTool(
    'opg_database_tables_list',
    {
      title: 'List OPG Database Tables',
      description: 'List database tables owned by the configured OPG app namespace.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toToolResult(await client.database.tables()),
  );

  registerTool(
    'opg_database_table_describe',
    {
      title: 'Describe OPG Database Table',
      description: 'Describe columns and indexes for one app-owned database table.',
      inputSchema: {
        table: z.string().min(1).describe('App-owned table name, for example app_demo__customers.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ table }: any) => toToolResult(await client.database.describe(table)),
  );

  registerTool(
    'opg_database_query',
    {
      title: 'Query OPG Database',
      description: 'Run read-only SQL against app-owned database tables. SQL must only reference the app namespace returned by opg_database_manifest_get.',
      inputSchema: {
        sql: z.string().min(1).describe('SELECT or WITH SQL.'),
        params: z.array(z.unknown()).optional().describe('Positional SQL parameters for $1, $2, ... placeholders.'),
        limit: z.number().int().min(1).max(500).default(100).describe('Maximum rows returned.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: any) => toToolResult(await client.database.query(input)),
  );

  registerTool(
    'opg_database_execute',
    {
      title: 'Execute OPG Database SQL',
      description: 'Dry-run or apply DDL/DML inside the app database namespace. Defaults to dry-run. To apply, pass dryRun=false and confirm=apply:<app-slug> from the database manifest.',
      inputSchema: {
        sql: z.string().min(1).describe('CREATE/ALTER/DROP/INSERT/UPDATE/DELETE/COMMENT SQL limited to app-owned tables.'),
        params: z.array(z.unknown()).optional().describe('Positional SQL parameters for a single statement.'),
        dryRun: z.boolean().default(true).describe('Keep true to validate inside a rolled-back transaction.'),
        confirm: z.string().optional().describe('Required as apply:<app-slug> when dryRun is false.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input: any) => toToolResult(await client.database.execute(input)),
  );

  registerTool(
    'opg_generate_client_code',
    {
      title: 'Generate OPG Client Code',
      description: 'Generate a concise TypeScript snippet for using opg-sdk in the current app.',
      inputSchema: {
        target: z.enum(['node', 'react', 'codex']).default('node'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ target }: any) => toToolResult(await client.sdk.examples(target)),
  );

  await server.connect(new StdioServerTransport());
}

function toToolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

async function getClientFromConfig() {
  return createOpgClient(await readLocalConfig());
}

async function getPlatformClientFromConfig() {
  return createOpgPlatformClient(await readLocalConfig());
}

function getClientFromFlags(commandArgs: string[]) {
  return createOpgClient(requireAppConfig(readConfigFromFlags(parseFlags(commandArgs)), 'Missing OPG app slug. Pass --app or set OPG_APP_SLUG.'));
}

async function getClientFromLocalConfigWithFlagOverrides(flags: Record<string, string>) {
  const local = await readOptionalLocalConfig();
  return createOpgClient(requireAppConfig({
    baseUrl: flags.baseUrl || flags['base-url'] || local.baseUrl,
    app: flags.app || local.app,
    apiKey: flags.apiKey || flags['api-key'] || local.apiKey,
    platformToken: flags.platformToken || flags['platform-token'] || local.platformToken,
  }, 'Missing OPG app slug. Pass --app or set OPG_APP_SLUG.'));
}

async function getPlatformClientFromLocalConfigWithFlagOverrides(flags: Record<string, string>): Promise<OpgPlatformClient> {
  const local = await readOptionalLocalConfig();
  return createOpgPlatformClient({
    baseUrl: flags.baseUrl || flags['base-url'] || local.baseUrl,
    apiKey: flags.apiKey || flags['api-key'] || local.apiKey,
    platformToken: flags.platformToken || flags['platform-token'] || local.platformToken,
  });
}

async function readLocalConfig(): Promise<CliConfig> {
  return readBaseConfig(await readOptionalLocalConfig());
}

async function readOptionalLocalConfig(): Promise<Record<string, string>> {
  let local: Partial<CliConfig> = {};
  try {
    local = JSON.parse(await readFile(path.resolve('.opg/opg.config.json'), 'utf8')) as Partial<CliConfig>;
  } catch {
    local = {};
  }
  const envFile = await readDotEnvLocal();
  return {
    baseUrl: process.env.OPG_BASE_URL || envFile.OPG_BASE_URL || local.baseUrl || '',
    app: process.env.OPG_APP_SLUG || envFile.OPG_APP_SLUG || local.app || '',
    apiKey: process.env.OPG_API_KEY || envFile.OPG_API_KEY || local.apiKey || '',
    platformToken: process.env.OPG_PLATFORM_TOKEN || envFile.OPG_PLATFORM_TOKEN || local.platformToken || '',
  };
}

async function readDotEnvLocal(): Promise<Record<string, string>> {
  try {
    const content = await readFile(path.resolve('.env.local'), 'utf8');
    const values: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const separator = trimmed.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function readConfigFromFlags(flags: Record<string, string>): CliConfig {
  return requireAppConfig(readBaseConfig(flags), 'Missing OPG app slug. Pass --app or set OPG_APP_SLUG.');
}

function readBaseConfig(flags: Record<string, string>): CliConfig {
  const baseUrl = flags.baseUrl || flags['base-url'] || process.env.OPG_BASE_URL || '';
  const app = flags.app || process.env.OPG_APP_SLUG || '';
  const apiKey = flags.apiKey || flags['api-key'] || process.env.OPG_API_KEY || '';
  const platformToken = flags.platformToken || flags['platform-token'] || process.env.OPG_PLATFORM_TOKEN || '';
  if (!baseUrl) {
    throw new Error('Missing OPG base URL. Pass --base-url or set OPG_BASE_URL.');
  }
  return { baseUrl, app, apiKey, platformToken };
}

function requireAppConfig(config: CliConfig, message: string): CliConfig {
  if (!config.app) {
    throw new Error(message);
  }
  return config;
}

function parseJsonPayload(flags: Record<string, string>) {
  const raw = flags.json || flags.body || '';
  if (!raw) {
    throw new Error('Missing JSON payload. Use --json \'{"name":"Demo","slug":"demo"}\'.');
  }
  return JSON.parse(raw);
}

function parseFlags(commandArgs: string[]) {
  const flags: Record<string, string> = {};
  for (let index = 0; index < commandArgs.length; index += 1) {
    const current = commandArgs[index];
    if (!current.startsWith('--')) {
      continue;
    }
    const [rawKey, inlineValue] = current.slice(2).split('=', 2);
    flags[rawKey] = inlineValue ?? commandArgs[index + 1] ?? '';
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  return flags;
}

function parseBooleanFlag(value: string) {
  const normalized = String(value || '').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(normalized);
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function buildClientExample(app: string) {
  return `import { createOpgClient } from 'opg-sdk';

const opg = createOpgClient({
  baseUrl: process.env.OPG_BASE_URL!,
  app: process.env.OPG_APP_SLUG || '${app}',
  apiKey: process.env.OPG_API_KEY!,
});

const models = await opg.ai.models();
console.log(models);
`;
}

function printHelp() {
  console.log(`OPG CLI

Commands:
  opg init --base-url <url> --app <slug> [--api-key <key>]
  opg init --base-url <url> --app <slug> --skip-manifest true
  opg manifest --base-url <url> --app <slug>
  opg smoke --base-url <url> --app <slug> --api-key <key>
  opg platform apps list --base-url <url> --platform-token <jwt>
  opg platform apps create --base-url <url> --platform-token <jwt> --json '{"name":"Demo","slug":"demo"}'
  opg platform runtime get --base-url <url> --platform-token <jwt>
  opg platform runtime update --base-url <url> --platform-token <jwt> --json '{"api_base_url":"https://opg.example.com"}'
  opg platform request --path /storage/providers --method GET --base-url <url> --platform-token <jwt>
  opg db smoke --base-url <url> --app <slug> --api-key <key>
  opg db manifest --base-url <url> --app <slug> --api-key <key>
  opg db tables --base-url <url> --app <slug> --api-key <key>
  opg db describe <table> --base-url <url> --app <slug> --api-key <key>
  opg db query --sql "SELECT * FROM app_demo__customers" --base-url <url> --app <slug> --api-key <key>
  opg db execute --sql "CREATE TABLE ..." --dry-run true --base-url <url> --app <slug> --api-key <key>
  opg codex install --base-url <url> --app <slug> [--api-key <key>]
  opg mcp
`);
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}
