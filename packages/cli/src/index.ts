#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createOpgClient, type OpgClient } from '@opg/sdk';

type CliConfig = {
  baseUrl: string;
  app: string;
  apiKey?: string;
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
  console.log('Next: npm install @opg/sdk');
}

async function installCodex(flags: Record<string, string>) {
  const config = readConfigFromFlags(flags);
  await mkdir('.opg', { recursive: true });
  const mcpConfig = {
    mcpServers: {
      opg: {
        command: 'npx',
        args: ['-y', '@opg/cli', 'mcp'],
        env: {
          OPG_BASE_URL: config.baseUrl,
          OPG_APP_SLUG: config.app,
          OPG_API_KEY: '${OPG_API_KEY}',
        },
      },
    },
  };
  await writeFile('.opg/codex-mcp.json', `${JSON.stringify(mcpConfig, null, 2)}\n`);
  console.log('Codex MCP config written to .opg/codex-mcp.json.');
  console.log('Keep OPG_API_KEY in your shell or project secret store; do not commit real keys.');
}

async function startMcpServer() {
  const client = await getClientFromConfig();
  const server = new McpServer({
    name: 'opg-mcp-server',
    version: '0.1.0',
  });
  const registerTool = (name: string, config: Record<string, unknown>, handler: (input: any) => Promise<any>) => {
    (server as any).registerTool(name, config, handler);
  };

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
    'opg_generate_client_code',
    {
      title: 'Generate OPG Client Code',
      description: 'Generate a concise TypeScript snippet for using @opg/sdk in the current app.',
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
  const config = await readLocalConfig();
  return createOpgClient(config);
}

function getClientFromFlags(commandArgs: string[]) {
  return createOpgClient(readConfigFromFlags(parseFlags(commandArgs)));
}

async function readLocalConfig(): Promise<CliConfig> {
  let local: Partial<CliConfig> = {};
  try {
    local = JSON.parse(await readFile(path.resolve('.opg/opg.config.json'), 'utf8')) as Partial<CliConfig>;
  } catch {
    local = {};
  }
  const envFile = await readDotEnvLocal();
  return readConfigFromFlags({
    baseUrl: process.env.OPG_BASE_URL || envFile.OPG_BASE_URL || local.baseUrl || '',
    app: process.env.OPG_APP_SLUG || envFile.OPG_APP_SLUG || local.app || '',
    apiKey: process.env.OPG_API_KEY || envFile.OPG_API_KEY || local.apiKey || '',
  });
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
  const baseUrl = flags.baseUrl || flags['base-url'] || process.env.OPG_BASE_URL || '';
  const app = flags.app || process.env.OPG_APP_SLUG || '';
  const apiKey = flags.apiKey || flags['api-key'] || process.env.OPG_API_KEY || '';
  if (!baseUrl) {
    throw new Error('Missing OPG base URL. Pass --base-url or set OPG_BASE_URL.');
  }
  if (!app) {
    throw new Error('Missing OPG app slug. Pass --app or set OPG_APP_SLUG.');
  }
  return { baseUrl, app, apiKey };
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

function buildClientExample(app: string) {
  return `import { createOpgClient } from '@opg/sdk';

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
