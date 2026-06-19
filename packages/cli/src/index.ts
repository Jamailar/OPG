#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createOpgClient, createOpgPlatformClient, type OpgClient, type OpgPlatformClient } from 'opg-sdk';

type CliConfig = {
  baseUrl: string;
  app?: string;
  apiKey?: string;
  platformToken?: string;
  platformRefreshToken?: string;
  profile?: string;
};

type CliCredentials = {
  currentProfile?: string;
  profiles?: Record<string, {
    baseUrl?: string;
    app?: string;
    apiKey?: string;
    platformToken?: string;
    platformRefreshToken?: string;
    apiKeyId?: string;
    grantId?: string;
    keyPrefix?: string;
    keyLast4?: string;
    updatedAt?: string;
  }>;
};

const args = process.argv.slice(2);
const command = args[0] || 'help';

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});

async function main() {
  if (isHelpRequest(args)) {
    printHelp(resolveHelpTopic(args));
    return;
  }
  if (command === 'init') {
    await initProject(parseFlags(args.slice(1)));
    return;
  }
  if (command === 'login') {
    await loginProject(parseFlags(args.slice(1)));
    return;
  }
  if (command === 'manifest') {
    const client = await getClientFromLocalConfigWithFlagOverrides(parseFlags(args.slice(1)));
    console.log(JSON.stringify(await client.sdk.manifest(), null, 2));
    return;
  }
  if (command === 'smoke') {
    const client = await getClientFromLocalConfigWithFlagOverrides(parseFlags(args.slice(1)));
    console.log(JSON.stringify(await client.sdk.smokeTest(), null, 2));
    return;
  }
  if (command === 'db' || command === 'database') {
    await runDatabaseCommand(args.slice(1));
    return;
  }
  if (command === 'schema') {
    await runSchemaCommand(args.slice(1));
    return;
  }
  if (command === 'data') {
    await runDataCommand(args.slice(1));
    return;
  }
  if (command === 'function' || command === 'functions') {
    await runFunctionCommand(args.slice(1));
    return;
  }
  if (command === 'workflow' || command === 'workflows') {
    await runWorkflowCommand(args.slice(1));
    return;
  }
  if (command === 'block' || command === 'blocks') {
    await runBlockCommand(args.slice(1));
    return;
  }
  if (command === 'app' || command === 'apps') {
    await runAppCommand(args.slice(1));
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
  process.exitCode = 1;
}

async function initProject(flags: Record<string, string>) {
  const config = readBaseConfig(flags);
  await mkdir('.opg', { recursive: true });
  await writeFile(
    '.opg/opg.config.json',
    `${JSON.stringify({ baseUrl: config.baseUrl, ...(config.app ? { app: config.app } : {}), profile: flags.profile || 'default' }, null, 2)}\n`,
  );

  if (!existsSync('.env.local')) {
    await writeFile(
      '.env.local',
      [
        `OPG_BASE_URL=${config.baseUrl}`,
        ...(config.app ? [`OPG_APP_SLUG=${config.app}`, `OPG_API_KEY=${config.apiKey || 'rbx_replace_me'}`] : []),
        '',
      ].join('\n'),
    );
  }

  if (!config.app) {
    console.log('OPG platform profile written.');
    console.log('Next: opg login');
    console.log('Then: opg app create --name "Demo App" --slug demo');
    return;
  }

  if (flags['skip-manifest'] !== 'true' && flags['skip-manifest'] !== '1') {
    const client = createOpgClient(requireAppConfig(config, 'Missing OPG app slug.'));
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

async function loginProject(flags: Record<string, string>) {
  const local = await readOptionalLocalConfig();
  const config = {
    baseUrl: flags.baseUrl || flags['base-url'] || local.baseUrl || '',
    app: flags.app || local.app || '',
    apiKey: '',
    platformToken: '',
    profile: flags.profile || local.profile || 'default',
  };
  if (!config.baseUrl) {
    throw new Error('Missing OPG base URL. Run "opg init --base-url <url> --app <slug>" first, or pass --base-url.');
  }
  const profile = flags.profile || config.profile || 'default';
  const callback = await createLocalCallbackServer(Number(flags.timeout || 120) * 1000);
  try {
    const session = await postJson<{
      state: string;
      login_url: string;
      expires_at: string;
    }>(config.app
      ? buildTenantUrl(config.baseUrl, config.app, '/sdk/auth/sessions')
      : buildApiUrl(config.baseUrl, '/sdk/auth/sessions'), {
      callback_url: callback.url,
      client: flags.client || '@jamba/opg-cli',
      profile,
      web_url: flags.webUrl || flags['web-url'] || config.baseUrl,
      scopes: parseScopesFlag(flags),
    });

    console.log(`Open this login URL to authorize OPG access:\n${session.login_url}\n`);
    if (flags.open !== 'false' && flags.open !== '0') {
      openBrowser(session.login_url);
    }

    const received = await callback.wait;
    if (received.state !== session.state) {
      throw new Error('SDK login state mismatch. Please run opg login again.');
    }

    const token = await postJson<{
      ok: boolean;
      app: { slug: string };
      profile: string;
      auth: {
        api_key?: string;
        api_key_id?: string;
        grant_id?: string;
        key_prefix?: string;
        key_last4?: string;
        platform_token?: string;
        platform_refresh_token?: string;
      };
      user?: Record<string, unknown>;
    }>(config.app
      ? buildTenantUrl(config.baseUrl, config.app, '/sdk/auth/token')
      : buildApiUrl(config.baseUrl, '/sdk/auth/token'), {
      state: received.state,
      code: received.code,
    });

    if (token.auth?.platform_token) {
      await writeLocalPlatformCredentials({
        baseUrl: config.baseUrl,
        app: config.app || local.app || '',
        profile,
        platformToken: token.auth.platform_token,
        platformRefreshToken: token.auth.platform_refresh_token,
      });
      console.log(`OPG platform login saved (${profile}).`);
      console.log('Next: opg app list or opg app create --name "Demo App" --slug demo');
    } else {
      await writeLocalLoginCredentials({
        baseUrl: config.baseUrl,
        app: token.app?.slug || config.app || '',
        profile,
        apiKey: token.auth.api_key || '',
        apiKeyId: token.auth.api_key_id,
        grantId: token.auth.grant_id,
        keyPrefix: token.auth.key_prefix,
        keyLast4: token.auth.key_last4,
      });
      console.log(`OPG SDK login saved for app ${token.app?.slug || config.app} (${profile}).`);
      console.log('Next: opg db smoke');
    }
  } finally {
    callback.close();
  }
}

async function installCodex(flags: Record<string, string>) {
  const local = await readOptionalLocalConfig();
  const config = requireAppConfig({
    baseUrl: flags.baseUrl || flags['base-url'] || local.baseUrl || '',
    app: flags.app || local.app || '',
    apiKey: flags.apiKey || flags['api-key'] || local.apiKey || '',
    platformToken: flags.platformToken || flags['platform-token'] || local.platformToken || '',
    profile: flags.profile || local.profile || 'default',
  }, 'Missing OPG app slug. Run "opg init --base-url <url> --app <slug>" first, or pass --app.');
  if (!config.baseUrl) {
    throw new Error('Missing OPG base URL. Run "opg init --base-url <url> --app <slug>" first, or pass --base-url.');
  }
  await mkdir('.opg', { recursive: true });
  const mcpConfig = {
    mcpServers: {
      opg: {
        command: 'npx',
        args: ['-y', '@jamba/opg-cli', 'mcp'],
        env: {
          OPG_BASE_URL: config.baseUrl,
          OPG_APP_SLUG: config.app,
          OPG_PLATFORM_TOKEN: '${OPG_PLATFORM_TOKEN}',
        },
      },
    },
  };
  await writeFile('.opg/codex-mcp.json', `${JSON.stringify(mcpConfig, null, 2)}\n`);
  console.log('Codex MCP config written to .opg/codex-mcp.json.');
  console.log(`Run "opg login --app ${config.app}" first so the MCP server can read the app-scoped SDK credential locally.`);
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

async function runSchemaCommand(commandArgs: string[]) {
  const resource = commandArgs[0] || 'manifest';
  const action = commandArgs[1] || '';
  const flags = parseFlags(commandArgs.slice(1));
  const local = await readOptionalLocalConfig();
  const appId = flags.appId || flags['app-id'] || flags.app || local.app || '';
  if (!appId) {
    throw new Error('Missing app id or slug. Use --app-id <id-or-slug> or run opg app use <slug>.');
  }
  const client = await getPlatformClientFromLocalConfigWithFlagOverrides(flags);

  if (resource === 'manifest') {
    printJson(await client.apps.schema.manifest(appId));
    return;
  }
  if ((resource === 'table' || resource === 'tables') && action === 'create') {
    const payload = {
      ...(flags.json ? JSON.parse(flags.json) : {}),
      ...(flags.name ? { name: flags.name } : {}),
      ...(flags.slug ? { slug: flags.slug } : {}),
      ...(flags.displayName || flags['display-name'] ? { display_name: flags.displayName || flags['display-name'] } : {}),
      ...(flags.description ? { description: flags.description } : {}),
      ...(flags.columns ? { columns: parseColumnSpecs(flags.columns) } : {}),
      ...(flags['owner-column'] || flags.ownerColumn ? { owner_column: flags['owner-column'] || flags.ownerColumn } : {}),
      ...(flags['soft-delete'] || flags.softDelete ? { soft_delete: parseBooleanFlag(flags['soft-delete'] || flags.softDelete) } : {}),
      dry_run: flags.apply ? false : flags['dry-run'] === undefined ? true : parseBooleanFlag(flags['dry-run']),
    };
    printJson(await client.apps.schema.createTable(appId, payload));
    return;
  }
  if ((resource === 'table' || resource === 'tables') && (action === 'drop' || action === 'delete')) {
    const positionals = positionalArgs(commandArgs.slice(2));
    const table = flags.table || positionals[0] || '';
    if (!table) {
      throw new Error('Missing table. Use: opg schema table drop <table> --confirm drop:<table>');
    }
    printJson(await client.apps.schema.dropTable(appId, table, {
      dry_run: flags.apply ? false : flags['dry-run'] === undefined ? true : parseBooleanFlag(flags['dry-run']),
      confirm: flags.confirm,
    }));
    return;
  }
  if ((resource === 'column' || resource === 'columns') && (action === 'add' || action === 'create')) {
    const positionals = positionalArgs(commandArgs.slice(2));
    const table = flags.table || positionals[0] || '';
    if (!table) {
      throw new Error('Missing table. Use: opg schema column add <table> --name email --type text');
    }
    const payload = {
      ...(flags.json ? JSON.parse(flags.json) : {}),
      ...(flags.name ? { name: flags.name } : {}),
      ...(flags.slug ? { slug: flags.slug } : {}),
      ...(flags.type || flags['data-type'] || flags.dataType ? { data_type: flags.type || flags['data-type'] || flags.dataType } : {}),
      ...(flags.nullable ? { nullable: parseBooleanFlag(flags.nullable) } : {}),
      ...(flags.unique ? { unique: parseBooleanFlag(flags.unique) } : {}),
      ...(flags.indexed ? { indexed: parseBooleanFlag(flags.indexed) } : {}),
      dry_run: flags.apply ? false : flags['dry-run'] === undefined ? true : parseBooleanFlag(flags['dry-run']),
    };
    printJson(await client.apps.schema.addColumn(appId, table, payload));
    return;
  }

  throw new Error(`Unknown schema command: ${resource} ${action}`);
}

async function runDataCommand(commandArgs: string[]) {
  const action = commandArgs[0] || 'schema';
  const flags = parseFlags(commandArgs.slice(1));
  const client = await getClientFromLocalConfigWithFlagOverrides(flags);

  if (action === 'schema') {
    printJson(await client.data.schema());
    return;
  }
  const positionals = positionalArgs(commandArgs.slice(1));
  const table = flags.table || positionals[0] || '';
  if (!table) {
    throw new Error('Missing table. Use: opg data list <table>');
  }
  if (action === 'list' || action === 'ls') {
    printJson(await client.data.table(table).list(parseQueryPayload(flags)));
    return;
  }
  if (action === 'get') {
    const id = flags.id || positionals[1] || '';
    if (!id) throw new Error('Missing row id. Use: opg data get <table> <id>');
    printJson(await client.data.table(table).get(id, parseQueryPayload(flags)));
    return;
  }
  if (action === 'create') {
    printJson(await client.data.table(table).create(parseJsonPayload(flags)));
    return;
  }
  if (action === 'update') {
    const id = flags.id || positionals[1] || '';
    if (!id) throw new Error('Missing row id. Use: opg data update <table> <id> --json ...');
    printJson(await client.data.table(table).update(id, parseJsonPayload(flags)));
    return;
  }
  if (action === 'delete' || action === 'rm') {
    const id = flags.id || positionals[1] || '';
    if (!id) throw new Error('Missing row id. Use: opg data delete <table> <id>');
    printJson(await client.data.table(table).delete(id));
    return;
  }

  throw new Error(`Unknown data command: ${action}`);
}

async function runFunctionCommand(commandArgs: string[]) {
  const action = commandArgs[0] || 'list';
  const flags = parseFlags(commandArgs.slice(1));
  const positionals = positionalArgs(commandArgs.slice(1));

  if (action === 'invoke' || action === 'run') {
    const slug = flags.function || flags.slug || positionals[0] || '';
    if (!slug) throw new Error('Missing function slug. Use: opg function invoke <slug> --json {...}');
    const client = await getClientFromLocalConfigWithFlagOverrides(flags);
    printJson(await client.functions.invoke(slug, parseJsonPayload(flags)));
    return;
  }

  const local = await readOptionalLocalConfig();
  const appId = flags.appId || flags['app-id'] || flags.app || local.app || '';
  if (!appId) {
    throw new Error('Missing app id or slug. Use --app-id <id-or-slug> or run opg app use <slug>.');
  }
  const client = await getPlatformClientFromLocalConfigWithFlagOverrides(flags);

  if (action === 'list' || action === 'ls') {
    printJson(await client.apps.functions.list(appId));
    return;
  }
  if (action === 'create') {
    const payload = flags.json || flags.body
      ? parseJsonPayload(flags)
      : {
          slug: flags.slug || flags.name || positionals[0] || '',
          source: flags.source ? JSON.parse(flags.source) : { kind: 'echo' },
          trigger: flags.trigger ? JSON.parse(flags.trigger) : {},
        };
    printJson(await client.apps.functions.create(appId, payload));
    return;
  }
  if (action === 'deploy') {
    const functionId = flags.functionId || flags['function-id'] || flags.function || flags.slug || positionals[0] || '';
    if (!functionId) throw new Error('Missing function id or slug. Use: opg function deploy <slug>');
    printJson(await client.apps.functions.deploy(appId, functionId));
    return;
  }
  if (action === 'runs') {
    const functionId = flags.functionId || flags['function-id'] || flags.function || flags.slug || positionals[0] || '';
    if (!functionId) throw new Error('Missing function id or slug. Use: opg function runs <slug>');
    printJson(await client.apps.functions.runs(appId, functionId));
    return;
  }

  throw new Error(`Unknown function command: ${action}`);
}

async function runWorkflowCommand(commandArgs: string[]) {
  const action = commandArgs[0] || 'list';
  const flags = parseFlags(commandArgs.slice(1));
  const positionals = positionalArgs(commandArgs.slice(1));

  if (action === 'run' || action === 'invoke') {
    const slug = flags.workflow || flags.slug || positionals[0] || '';
    if (!slug) throw new Error('Missing workflow slug. Use: opg workflow run <slug> --json {...}');
    const client = await getClientFromLocalConfigWithFlagOverrides(flags);
    printJson(await client.workflows.run(slug, parseJsonPayload(flags)));
    return;
  }

  const local = await readOptionalLocalConfig();
  const appId = flags.appId || flags['app-id'] || flags.app || local.app || '';
  if (!appId) {
    throw new Error('Missing app id or slug. Use --app-id <id-or-slug> or run opg app use <slug>.');
  }
  const client = await getPlatformClientFromLocalConfigWithFlagOverrides(flags);

  if (action === 'list' || action === 'ls') {
    printJson(await client.apps.workflows.list(appId));
    return;
  }
  if (action === 'create') {
    const payload = flags.json || flags.body
      ? parseJsonPayload(flags)
      : {
          slug: flags.slug || flags.name || positionals[0] || '',
          steps: flags.steps ? JSON.parse(flags.steps) : [{ id: 'noop', type: 'noop' }],
          trigger: flags.trigger ? JSON.parse(flags.trigger) : { type: 'manual' },
        };
    printJson(await client.apps.workflows.create(appId, payload));
    return;
  }
  if (action === 'runs') {
    const workflowId = flags.workflowId || flags['workflow-id'] || flags.workflow || flags.slug || positionals[0] || '';
    if (!workflowId) throw new Error('Missing workflow id or slug. Use: opg workflow runs <slug>');
    printJson(await client.apps.workflows.runs(appId, workflowId));
    return;
  }

  throw new Error(`Unknown workflow command: ${action}`);
}

async function runBlockCommand(commandArgs: string[]) {
  const resource = commandArgs[0] || 'ai';
  const action = commandArgs[1] || 'upsert';
  const flags = parseFlags(commandArgs.slice(2));
  const positionals = positionalArgs(commandArgs.slice(2));
  const local = await readOptionalLocalConfig();
  const appId = flags.appId || flags['app-id'] || flags.app || local.app || '';
  if (!appId) {
    throw new Error('Missing app id or slug. Use --app-id <id-or-slug> or run opg app use <slug>.');
  }
  const client = await getPlatformClientFromLocalConfigWithFlagOverrides(flags);
  if (resource === 'ai') {
    if (action === 'upsert' || action === 'create') {
      printJson(await client.apps.blocks.upsertAi(appId, parseJsonPayload(flags)));
      return;
    }
    if (action === 'run') {
      const block = flags.block || flags.slug || positionals[0] || '';
      if (!block) throw new Error('Missing AI block slug. Use: opg block ai run <slug> --json {...}');
      printJson(await client.apps.blocks.runAi(appId, block, parseJsonPayload(flags)));
      return;
    }
  }
  if (resource === 'video') {
    if (action === 'upsert' || action === 'create') {
      printJson(await client.apps.blocks.upsertVideo(appId, parseJsonPayload(flags)));
      return;
    }
    if (action === 'run') {
      const block = flags.block || flags.slug || positionals[0] || '';
      if (!block) throw new Error('Missing video block slug. Use: opg block video run <slug> --json {...}');
      printJson(await client.apps.blocks.runVideo(appId, block, parseJsonPayload(flags)));
      return;
    }
  }
  if (resource === 'storage' && action === 'save') {
    printJson(await client.apps.blocks.saveStorage(appId, parseJsonPayload(flags)));
    return;
  }
  throw new Error(`Unknown block command: ${resource} ${action}`);
}

async function runAppCommand(commandArgs: string[]) {
  const action = commandArgs[0] || 'list';
  const flags = parseFlags(commandArgs.slice(1));
  const client = await getPlatformClientFromLocalConfigWithFlagOverrides(flags);

  if (action === 'list' || action === 'ls') {
    printJson(await client.apps.list({ includeInactive: flags.includeInactive !== 'false' && flags['include-inactive'] !== 'false' }));
    return;
  }

  if (action === 'create') {
    const payload = flags.json || flags.body
      ? parseJsonPayload(flags)
      : {
          name: flags.name || flags.slug || '',
          slug: flags.slug || '',
          status: flags.status || 'ACTIVE',
        };
    if (!payload.name || !payload.slug) {
      throw new Error('Missing app name or slug. Use: opg app create --name "Demo App" --slug demo');
    }
    const created = await client.apps.create(payload);
    const app = pickAppPayload(created);
    if (app?.slug) {
      await writeProjectAppConfig({
        baseUrl: flags.baseUrl || flags['base-url'] || (await readOptionalLocalConfig()).baseUrl || '',
        app: app.slug,
        profile: flags.profile || (await readOptionalLocalConfig()).profile || 'default',
      });
    }
    printJson(created);
    if (app?.slug) {
      console.error(`Current OPG app set to ${app.slug}. Run "opg login --app ${app.slug}" to create an app-scoped SDK grant.`);
    }
    return;
  }

  if (action === 'use') {
    const app = flags.app || flags.slug || commandArgs.find((item, index) => index > 0 && !item.startsWith('--')) || '';
    if (!app) {
      throw new Error('Missing app slug. Use: opg app use <slug>');
    }
    const local = await readOptionalLocalConfig();
    await writeProjectAppConfig({
      baseUrl: flags.baseUrl || flags['base-url'] || local.baseUrl || '',
      app,
      profile: flags.profile || local.profile || 'default',
    });
    console.log(`Current OPG app set to ${app}.`);
    return;
  }

  throw new Error(`Unknown app command: ${action}`);
}

async function runPlatformCommand(commandArgs: string[]) {
  const resource = commandArgs[0] || 'apps';
  const isGenericRequest = resource === 'request';
  const action = isGenericRequest ? 'call' : commandArgs[1] || 'list';
  const flags = parseFlags(commandArgs.slice(isGenericRequest ? 1 : 2));
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

  if (resource === 'feedbacks' || resource === 'feedback') {
    const appId = requirePlatformAppId(flags);
    if (action === 'list') {
      printJson(await client.apps.feedbacks.list(appId, parseQueryPayload(flags)));
      return;
    }
    if (action === 'get') {
      const feedbackId = flags.feedbackId || flags['feedback-id'] || '';
      if (!feedbackId) throw new Error('Missing feedback id. Use: opg platform feedbacks get --app-id <id> --feedback-id <id>');
      printJson(await client.apps.feedbacks.get(appId, feedbackId));
      return;
    }
    if (action === 'update') {
      const feedbackId = flags.feedbackId || flags['feedback-id'] || '';
      if (!feedbackId) throw new Error('Missing feedback id. Use: opg platform feedbacks update --app-id <id> --feedback-id <id> --json {...}');
      printJson(await client.apps.feedbacks.update(appId, feedbackId, parseJsonPayload(flags)));
      return;
    }
    if (action === 'comment') {
      const feedbackId = flags.feedbackId || flags['feedback-id'] || '';
      if (!feedbackId) throw new Error('Missing feedback id. Use: opg platform feedbacks comment --app-id <id> --feedback-id <id> --json {...}');
      printJson(await client.apps.feedbacks.addComment(appId, feedbackId, parseJsonPayload(flags)));
      return;
    }
    if (action === 'review') {
      const feedbackId = flags.feedbackId || flags['feedback-id'] || '';
      if (!feedbackId) throw new Error('Missing feedback id. Use: opg platform feedbacks review --app-id <id> --feedback-id <id> --json {...}');
      printJson(await client.apps.feedbacks.review(appId, feedbackId, parseJsonPayload(flags)));
      return;
    }
  }

  if (resource === 'analytics') {
    const appId = requirePlatformAppId(flags);
    const query = parseQueryPayload(flags);
    if (action === 'business') {
      printJson(await client.apps.analytics.business(appId, query));
      return;
    }
    if (action === 'overview') {
      printJson(await client.apps.analytics.overview(appId, query));
      return;
    }
    if (action === 'growth') {
      printJson(await client.apps.analytics.growth(appId, query));
      return;
    }
    if (action === 'retention') {
      printJson(await client.apps.analytics.retention(appId, query));
      return;
    }
    if (action === 'profiles') {
      printJson(await client.apps.analytics.profiles(appId, query));
      return;
    }
    if (action === 'conversion') {
      printJson(await client.apps.analytics.conversion(appId, query));
      return;
    }
    if (action === 'users') {
      printJson(await client.apps.analytics.users(appId, query));
      return;
    }
  }

  if (resource === 'ai-usage' || resource === 'ai_usage') {
    const appId = requirePlatformAppId(flags);
    const query = parseQueryPayload(flags);
    if (action === 'summary') {
      printJson(await client.apps.aiUsage.summary(appId, query));
      return;
    }
    if (action === 'breakdown') {
      printJson(await client.apps.aiUsage.breakdown(appId, query));
      return;
    }
    if (action === 'logs') {
      printJson(await client.apps.aiUsage.logs(appId, query));
      return;
    }
  }

  if (resource === 'payments') {
    const appId = requirePlatformAppId(flags);
    if (action === 'products') {
      printJson(await client.apps.payments.products(appId));
      return;
    }
    if (action === 'orders') {
      printJson(await client.apps.payments.orders(appId, parseQueryPayload(flags)));
      return;
    }
    if (action === 'refund') {
      const orderId = flags.orderId || flags['order-id'] || '';
      if (!orderId) throw new Error('Missing order id. Use: opg platform payments refund --app-id <id> --order-id <id> --json {...}');
      printJson(await client.apps.payments.refundOrder(appId, orderId, flags.json ? parseJsonPayload(flags) : {}));
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
    'opg_schema_manifest_get',
    {
      title: 'Get OPG App Schema Manifest',
      description: 'Read the structured app schema registry manifest for a tenant app.',
      inputSchema: {
        appId: z.string().min(1).describe('Tenant app id or slug.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ appId }: any) => toToolResult(await platformClient.apps.schema.manifest(appId)),
  );

  registerTool(
    'opg_schema_table_create',
    {
      title: 'Create OPG App Data Table',
      description: 'Create or dry-run a structured app data table. Defaults to dry-run unless dryRun=false.',
      inputSchema: {
        appId: z.string().min(1).describe('Tenant app id or slug.'),
        payload: z.record(z.unknown()).describe('Structured table payload: name/slug, columns, owner_column, soft_delete, dry_run.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, payload }: any) => toToolResult(await platformClient.apps.schema.createTable(appId, payload)),
  );

  registerTool(
    'opg_schema_column_add',
    {
      title: 'Add OPG App Data Column',
      description: 'Add or dry-run a structured app data column. Defaults to dry-run unless dryRun=false.',
      inputSchema: {
        appId: z.string().min(1).describe('Tenant app id or slug.'),
        table: z.string().min(1).describe('Data table id or slug.'),
        payload: z.record(z.unknown()).describe('Structured column payload: name/slug, data_type, nullable, indexed, dry_run.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, table, payload }: any) => toToolResult(await platformClient.apps.schema.addColumn(appId, table, payload)),
  );

  registerTool(
    'opg_function_create',
    {
      title: 'Create OPG App Function',
      description: 'Create an app function draft with a structured handler contract.',
      inputSchema: {
        appId: z.string().min(1).describe('Tenant app id or slug.'),
        payload: z.record(z.unknown()).describe('Function payload: slug, source, trigger.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, payload }: any) => toToolResult(await platformClient.apps.functions.create(appId, payload)),
  );

  registerTool(
    'opg_function_deploy',
    {
      title: 'Deploy OPG App Function',
      description: 'Deploy the current source as a new app function version.',
      inputSchema: {
        appId: z.string().min(1).describe('Tenant app id or slug.'),
        functionId: z.string().min(1).describe('Function id or slug.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, functionId }: any) => toToolResult(await platformClient.apps.functions.deploy(appId, functionId)),
  );

  registerTool(
    'opg_function_invoke',
    {
      title: 'Invoke OPG App Function',
      description: 'Invoke a deployed app function through the app-scoped API.',
      inputSchema: {
        slug: z.string().min(1).describe('Function slug.'),
        payload: z.record(z.unknown()).describe('Invoke payload, usually { input }.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ slug, payload }: any) => toToolResult(await client.functions.invoke(slug, payload)),
  );

  registerTool(
    'opg_workflow_create',
    {
      title: 'Create OPG App Workflow',
      description: 'Create an app workflow definition with ordered steps.',
      inputSchema: {
        appId: z.string().min(1).describe('Tenant app id or slug.'),
        payload: z.record(z.unknown()).describe('Workflow payload: slug, trigger, steps.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, payload }: any) => toToolResult(await platformClient.apps.workflows.create(appId, payload)),
  );

  registerTool(
    'opg_workflow_run',
    {
      title: 'Run OPG App Workflow',
      description: 'Run a deployed app workflow through the app-scoped API.',
      inputSchema: {
        slug: z.string().min(1).describe('Workflow slug.'),
        payload: z.record(z.unknown()).describe('Run payload, usually { input }.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ slug, payload }: any) => toToolResult(await client.workflows.run(slug, payload)),
  );

  registerTool(
    'opg_ai_block_upsert',
    {
      title: 'Upsert OPG AI Block',
      description: 'Create or update an app AI block backed by OPG AI Gateway.',
      inputSchema: { appId: z.string().min(1), payload: z.record(z.unknown()) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ appId, payload }: any) => toToolResult(await platformClient.apps.blocks.upsertAi(appId, payload)),
  );

  registerTool(
    'opg_video_block_upsert',
    {
      title: 'Upsert OPG Video Block',
      description: 'Create or update an app video block backed by OPG async video gateway.',
      inputSchema: { appId: z.string().min(1), payload: z.record(z.unknown()) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ appId, payload }: any) => toToolResult(await platformClient.apps.blocks.upsertVideo(appId, payload)),
  );

  registerTool(
    'opg_storage_object_save',
    {
      title: 'Save OPG Storage Object',
      description: 'Save a small text object through the app storage registry.',
      inputSchema: { appId: z.string().min(1), payload: z.record(z.unknown()) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, payload }: any) => toToolResult(await platformClient.apps.blocks.saveStorage(appId, payload)),
  );

  registerTool(
    'opg_platform_app_feedbacks_list',
    {
      title: 'List OPG App Feedbacks',
      description: 'List user feedback issues for a tenant app. Requires OPG_PLATFORM_TOKEN and app feedback permission.',
      inputSchema: {
        appId: z.string().min(1),
        status: z.string().optional(),
        priority: z.string().optional(),
        assigneeUserId: z.string().optional(),
        q: z.string().optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ appId, status, priority, assigneeUserId, q, page, pageSize }: any) => toToolResult(await platformClient.apps.feedbacks.list(appId, {
      status,
      priority,
      assignee_user_id: assigneeUserId,
      q,
      page,
      page_size: pageSize,
    })),
  );

  registerTool(
    'opg_platform_app_feedback_get',
    {
      title: 'Get OPG App Feedback',
      description: 'Read one user feedback issue with comments for a tenant app.',
      inputSchema: {
        appId: z.string().min(1),
        feedbackId: z.string().min(1),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ appId, feedbackId }: any) => toToolResult(await platformClient.apps.feedbacks.get(appId, feedbackId)),
  );

  registerTool(
    'opg_platform_app_feedback_update',
    {
      title: 'Update OPG App Feedback',
      description: 'Update status, priority, assignee, title, or admin metadata for one tenant app feedback issue.',
      inputSchema: {
        appId: z.string().min(1),
        feedbackId: z.string().min(1),
        payload: z.record(z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, feedbackId, payload }: any) => toToolResult(await platformClient.apps.feedbacks.update(appId, feedbackId, payload)),
  );

  registerTool(
    'opg_platform_app_feedback_comment',
    {
      title: 'Comment On OPG App Feedback',
      description: 'Add an internal or public admin comment to a tenant app feedback issue.',
      inputSchema: {
        appId: z.string().min(1),
        feedbackId: z.string().min(1),
        body: z.string().min(1),
        isInternal: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, feedbackId, body, isInternal }: any) => toToolResult(await platformClient.apps.feedbacks.addComment(appId, feedbackId, {
      body,
      is_internal: isInternal,
    })),
  );

  registerTool(
    'opg_platform_app_feedback_review',
    {
      title: 'Review OPG App Feedback',
      description: 'Apply a feedback review action such as useful, thanks, or invalid.',
      inputSchema: {
        appId: z.string().min(1),
        feedbackId: z.string().min(1),
        action: z.string().min(1),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, feedbackId, action, note }: any) => toToolResult(await platformClient.apps.feedbacks.review(appId, feedbackId, { action, note })),
  );

  registerTool(
    'opg_platform_app_analytics_overview',
    {
      title: 'Get OPG App Analytics Overview',
      description: 'Read tenant app user analytics overview.',
      inputSchema: {
        appId: z.string().min(1),
        days: z.number().int().min(1).max(365).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        timezone: z.string().optional(),
        granularity: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ appId, days, from, to, timezone, granularity }: any) => toToolResult(await platformClient.apps.analytics.overview(appId, {
      days,
      from,
      to,
      timezone,
      granularity,
    })),
  );

  registerTool(
    'opg_platform_app_analytics_users',
    {
      title: 'List OPG App Analytics Users',
      description: 'Read tenant app user analytics detail rows.',
      inputSchema: {
        appId: z.string().min(1),
        days: z.number().int().min(1).max(365).optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        segment: z.string().optional(),
        source: z.string().optional(),
        paidStatus: z.string().optional(),
        accountStatus: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ appId, days, page, pageSize, segment, source, paidStatus, accountStatus }: any) => toToolResult(await platformClient.apps.analytics.users(appId, {
      days,
      page,
      page_size: pageSize,
      segment,
      source,
      paid_status: paidStatus,
      account_status: accountStatus,
    })),
  );

  registerTool(
    'opg_platform_app_ai_usage_logs',
    {
      title: 'List OPG App AI Usage Logs',
      description: 'Read tenant app AI usage logs with cost and points data.',
      inputSchema: {
        appId: z.string().min(1),
        days: z.number().int().min(1).max(365).optional(),
        capability: z.string().optional(),
        modelKey: z.string().optional(),
        success: z.boolean().optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ appId, days, capability, modelKey, success, page, pageSize }: any) => toToolResult(await platformClient.apps.aiUsage.logs(appId, {
      days,
      capability,
      model_key: modelKey,
      success,
      page,
      page_size: pageSize,
    })),
  );

  registerTool(
    'opg_platform_app_payment_orders',
    {
      title: 'List OPG App Payment Orders',
      description: 'Read tenant app payment orders.',
      inputSchema: {
        appId: z.string().min(1),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        status: z.string().optional(),
        q: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ appId, page, pageSize, status, q }: any) => toToolResult(await platformClient.apps.payments.orders(appId, {
      page,
      page_size: pageSize,
      status,
      q,
    })),
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
    'opg_data_schema_get',
    {
      title: 'Get OPG Data API Schema',
      description: 'Read the Data API schema for the configured OPG app.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toToolResult(await client.data.schema()),
  );

  registerTool(
    'opg_data_rows_list',
    {
      title: 'List OPG Data Rows',
      description: 'List rows from a registered app data table through the structured Data API.',
      inputSchema: {
        table: z.string().min(1),
        query: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ table, query }: any) => toToolResult(await client.data.table(table).list(query)),
  );

  registerTool(
    'opg_data_row_create',
    {
      title: 'Create OPG Data Row',
      description: 'Create a row in a registered app data table through the structured Data API.',
      inputSchema: {
        table: z.string().min(1),
        payload: z.record(z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ table, payload }: any) => toToolResult(await client.data.table(table).create(payload)),
  );

  registerTool(
    'opg_data_row_update',
    {
      title: 'Update OPG Data Row',
      description: 'Update a row in a registered app data table through the structured Data API.',
      inputSchema: {
        table: z.string().min(1),
        id: z.string().min(1),
        payload: z.record(z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ table, id, payload }: any) => toToolResult(await client.data.table(table).update(id, payload)),
  );

  registerTool(
    'opg_data_row_delete',
    {
      title: 'Delete OPG Data Row',
      description: 'Delete or soft-delete a row in a registered app data table through the structured Data API.',
      inputSchema: {
        table: z.string().min(1),
        id: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ table, id }: any) => toToolResult(await client.data.table(table).delete(id)),
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
  const refreshed = await refreshPlatformTokenIfNeeded({
    baseUrl: flags.baseUrl || flags['base-url'] || local.baseUrl,
    app: flags.app || local.app,
    apiKey: flags.apiKey || flags['api-key'] || local.apiKey,
    platformToken: flags.platformToken || flags['platform-token'] || local.platformToken,
    platformRefreshToken: local.platformRefreshToken,
    profile: local.profile,
  });
  return createOpgPlatformClient({
    baseUrl: refreshed.baseUrl,
    apiKey: flags.apiKey || flags['api-key'] || local.apiKey,
    platformToken: flags.platformToken || flags['platform-token'] || refreshed.platformToken,
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
  const credentials = await readCredentials();
  const profile = String(local.profile || credentials.currentProfile || 'default').trim() || 'default';
  const credentialProfile = credentials.profiles?.[profile] || {};
  const envFile = await readDotEnvLocal();
  return {
    baseUrl: process.env.OPG_BASE_URL || envFile.OPG_BASE_URL || local.baseUrl || credentialProfile.baseUrl || '',
    app: process.env.OPG_APP_SLUG || envFile.OPG_APP_SLUG || local.app || credentialProfile.app || '',
    apiKey: process.env.OPG_API_KEY || envFile.OPG_API_KEY || credentialProfile.apiKey || local.apiKey || '',
    platformToken: process.env.OPG_PLATFORM_TOKEN || envFile.OPG_PLATFORM_TOKEN || credentialProfile.platformToken || local.platformToken || '',
    platformRefreshToken: credentialProfile.platformRefreshToken || local.platformRefreshToken || '',
    profile,
  };
}

async function readCredentials(): Promise<CliCredentials> {
  try {
    return JSON.parse(await readFile(path.resolve('.opg/credentials.json'), 'utf8')) as CliCredentials;
  } catch {
    return {};
  }
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

function readBaseConfig(flags: Record<string, string>): CliConfig {
  const baseUrl = flags.baseUrl || flags['base-url'] || process.env.OPG_BASE_URL || '';
  const app = flags.app || process.env.OPG_APP_SLUG || '';
  const apiKey = flags.apiKey || flags['api-key'] || process.env.OPG_API_KEY || '';
  const platformToken = flags.platformToken || flags['platform-token'] || process.env.OPG_PLATFORM_TOKEN || '';
  if (!baseUrl) {
    throw new Error('Missing OPG base URL. Pass --base-url or set OPG_BASE_URL.');
  }
  return { baseUrl, app, apiKey, platformToken, profile: flags.profile || 'default' };
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

function parseColumnSpecs(value: string) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [name, type = 'text'] = item.split(':').map((part) => part.trim());
      return { name, data_type: type };
    });
}

function positionalArgs(commandArgs: string[]) {
  const result: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const current = commandArgs[index];
    if (current.startsWith('--')) {
      if (!current.includes('=') && commandArgs[index + 1] && !commandArgs[index + 1].startsWith('--')) {
        index += 1;
      }
      continue;
    }
    result.push(current);
  }
  return result;
}

function parseQueryPayload(flags: Record<string, string>): Record<string, string | number | boolean | null> {
  if (flags.query) {
    return JSON.parse(flags.query);
  }
  const ignored = new Set([
    'app-id',
    'appId',
    'app',
    'table',
    'id',
    'base-url',
    'baseUrl',
    'api-key',
    'apiKey',
    'platform-token',
    'platformToken',
    'feedback-id',
    'feedbackId',
    'order-id',
    'orderId',
    'json',
    'body',
    'method',
    'path',
  ]);
  const query: Record<string, string | number | boolean | null> = {};
  for (const [key, rawValue] of Object.entries(flags)) {
    if (ignored.has(key)) continue;
    query[key.replace(/-/g, '_')] = parseScalar(rawValue);
  }
  return query;
}

function parseScalar(value: string): string | number | boolean | null {
  const normalized = String(value ?? '').trim();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (normalized === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(normalized)) return Number(normalized);
  return normalized;
}

function pickAppPayload(value: unknown): { id?: string; slug?: string; name?: string } | null {
  const root = value as any;
  const candidates = [
    root?.app,
    root?.data?.app,
    root?.item,
    root?.data,
    root,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && candidate.slug) {
      return {
        id: candidate.id ? String(candidate.id) : undefined,
        slug: String(candidate.slug),
        name: candidate.name ? String(candidate.name) : undefined,
      };
    }
  }
  return null;
}

function requirePlatformAppId(flags: Record<string, string>) {
  const appId = flags.appId || flags['app-id'] || '';
  if (!appId) {
    throw new Error('Missing app id. Use --app-id <id>.');
  }
  return appId;
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

function buildTenantUrl(baseUrl: string, app: string, route: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(app)}/v1${route}`;
}

function buildApiUrl(baseUrl: string, route: string) {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1${route}`;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.message || data?.detail || `Request failed (${response.status})`);
  }
  return data?.data || data;
}

async function refreshPlatformTokenIfNeeded(config: CliConfig): Promise<CliConfig> {
  if (!config.baseUrl || !config.platformToken || !config.platformRefreshToken) {
    return config;
  }
  if (!isJwtExpiring(config.platformToken, 60)) {
    return config;
  }
  const refreshed = await postJson<{
    access_token?: string;
    refresh_token?: string;
  }>(buildApiUrl(config.baseUrl, '/auth/refresh'), {
    refresh_token: config.platformRefreshToken,
  });
  if (!refreshed.access_token) {
    return config;
  }
  await writeLocalPlatformCredentials({
    baseUrl: config.baseUrl,
    app: config.app || '',
    profile: config.profile || 'default',
    platformToken: refreshed.access_token,
    platformRefreshToken: refreshed.refresh_token || config.platformRefreshToken,
  });
  return {
    ...config,
    platformToken: refreshed.access_token,
    platformRefreshToken: refreshed.refresh_token || config.platformRefreshToken,
  };
}

function isJwtExpiring(token: string, skewSeconds: number) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { exp?: number };
    if (!payload.exp) {
      return false;
    }
    return payload.exp * 1000 <= Date.now() + skewSeconds * 1000;
  } catch {
    return false;
  }
}

async function writeLocalLoginCredentials(input: {
  baseUrl: string;
  app: string;
  profile: string;
  apiKey: string;
  apiKeyId?: string;
  grantId?: string;
  keyPrefix?: string;
  keyLast4?: string;
}) {
  await mkdir('.opg', { recursive: true });
  const existing = await readCredentials();
  const profile = input.profile || 'default';
  const next: CliCredentials = {
    currentProfile: profile,
    profiles: {
      ...(existing.profiles || {}),
      [profile]: {
        baseUrl: input.baseUrl,
        app: input.app,
        apiKey: input.apiKey,
        platformToken: existing.profiles?.[profile]?.platformToken,
        platformRefreshToken: existing.profiles?.[profile]?.platformRefreshToken,
        apiKeyId: input.apiKeyId,
        grantId: input.grantId,
        keyPrefix: input.keyPrefix,
        keyLast4: input.keyLast4,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  await writeFile('.opg/credentials.json', `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod('.opg/credentials.json', 0o600).catch(() => undefined);
  await writeFile(
    '.opg/opg.config.json',
    `${JSON.stringify({ baseUrl: input.baseUrl, app: input.app, profile }, null, 2)}\n`,
  );
}

async function writeLocalPlatformCredentials(input: {
  baseUrl: string;
  app?: string;
  profile: string;
  platformToken: string;
  platformRefreshToken?: string;
}) {
  await mkdir('.opg', { recursive: true });
  const existing = await readCredentials();
  const profile = input.profile || 'default';
  const previous = existing.profiles?.[profile] || {};
  const next: CliCredentials = {
    currentProfile: profile,
    profiles: {
      ...(existing.profiles || {}),
      [profile]: {
        ...previous,
        baseUrl: input.baseUrl,
        app: input.app || previous.app || '',
        platformToken: input.platformToken,
        platformRefreshToken: input.platformRefreshToken || previous.platformRefreshToken,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  await writeFile('.opg/credentials.json', `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod('.opg/credentials.json', 0o600).catch(() => undefined);
  await writeFile(
    '.opg/opg.config.json',
    `${JSON.stringify({ baseUrl: input.baseUrl, ...(input.app || previous.app ? { app: input.app || previous.app } : {}), profile }, null, 2)}\n`,
  );
}

async function writeProjectAppConfig(input: {
  baseUrl: string;
  app: string;
  profile: string;
}) {
  if (!input.baseUrl) {
    throw new Error('Missing OPG base URL. Run "opg init --base-url <url>" first, or pass --base-url.');
  }
  await mkdir('.opg', { recursive: true });
  const existing = await readCredentials();
  const profile = input.profile || existing.currentProfile || 'default';
  const previous = existing.profiles?.[profile] || {};
  const next: CliCredentials = {
    currentProfile: profile,
    profiles: {
      ...(existing.profiles || {}),
      [profile]: {
        ...previous,
        baseUrl: input.baseUrl,
        app: input.app,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  await writeFile('.opg/credentials.json', `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod('.opg/credentials.json', 0o600).catch(() => undefined);
  await writeFile(
    '.opg/opg.config.json',
    `${JSON.stringify({ baseUrl: input.baseUrl, app: input.app, profile }, null, 2)}\n`,
  );
}

async function createLocalCallbackServer(timeoutMs: number): Promise<{
  url: string;
  wait: Promise<{ state: string; code: string }>;
  close: () => void;
}> {
  let server: Server | null = null;
  let timeout: NodeJS.Timeout | null = null;
  let settle: (value: { state: string; code: string }) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const sockets = new Set<Socket>();

  const wait = new Promise<{ state: string; code: string }>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });

  server = createServer((req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const state = requestUrl.searchParams.get('state') || '';
      const code = requestUrl.searchParams.get('code') || '';
      if (!state || !code) {
        res.shouldKeepAlive = false;
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('Missing SDK login code.');
        reject(new Error('Missing SDK login code.'));
        return;
      }
      res.shouldKeepAlive = false;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
      res.end('<!doctype html><title>OPG SDK Login</title><p>OPG SDK login complete. You can close this window.</p>');
      settle({ state, code });
    } catch (error) {
      res.shouldKeepAlive = false;
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end('SDK login callback failed.');
      reject(error);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, rejectListen) => {
    server!.once('error', rejectListen);
    server!.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  timeout = setTimeout(() => reject(new Error('SDK login timed out. Run opg login again.')), timeoutMs);

  return {
    url: `http://127.0.0.1:${address.port}/callback`,
    wait: wait.finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    }),
    close: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      server?.close();
      server?.closeIdleConnections?.();
      server?.closeAllConnections?.();
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    },
  };
}

function openBrowser(url: string) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(opener, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => undefined);
  child.unref();
}

function parseScopesFlag(flags: Record<string, string>) {
  const raw = flags.scopes || flags.scope || '';
  if (!raw) {
    return undefined;
  }
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

type HelpTopic = 'root' | 'init' | 'login' | 'app' | 'db' | 'schema' | 'data' | 'function' | 'workflow' | 'block' | 'platform' | 'codex' | 'mcp';

function isHelpRequest(commandArgs: string[]) {
  return commandArgs.length === 0 || commandArgs.some(isHelpToken);
}

function isHelpToken(value: string) {
  return ['help', '--help', '-h', '-help'].includes(String(value || '').trim().toLowerCase());
}

function resolveHelpTopic(commandArgs: string[]): HelpTopic {
  const firstTopic = commandArgs.find((item) => !isHelpToken(item) && !item.startsWith('-')) || '';
  if (firstTopic === 'database') return 'db';
  if (firstTopic === 'apps') return 'app';
  if (firstTopic === 'functions') return 'function';
  if (firstTopic === 'workflows') return 'workflow';
  if (firstTopic === 'blocks') return 'block';
  if (['init', 'login', 'app', 'db', 'schema', 'data', 'function', 'workflow', 'block', 'platform', 'codex', 'mcp'].includes(firstTopic)) {
    return firstTopic as HelpTopic;
  }
  return 'root';
}

function printHelp(topic: HelpTopic = 'root') {
  if (topic === 'init') {
    console.log(`OPG CLI - init

Usage:
  opg init --base-url <url> [--profile <name>]
  opg init --base-url <url> --app <slug> [--api-key <key>]

Options:
  --base-url <url>       OPG gateway base URL, for example https://opg.example.com
  --app <slug>           Optional app slug. Omit for platform-first setup.
  --profile <name>       Local credential profile name. Default: default
  --api-key <key>        Optional app-scoped developer grant for non-browser setup.
  --skip-manifest true   Skip fetching .opg/manifest.json during app setup.

Examples:
  opg init --base-url https://opg.example.com
  opg init --base-url https://opg.example.com --app demo
`);
    return;
  }

  if (topic === 'login') {
    console.log(`OPG CLI - login

Usage:
  opg login [--base-url <url>] [--profile <name>]
  opg login --app <slug> [--scopes <csv>]

Behavior:
  Without --app, login creates a platform profile for app creation and control-plane work.
  With --app, login creates an app-scoped SDK developer grant.

Options:
  --base-url <url>       OPG gateway base URL. Falls back to .opg config or OPG_BASE_URL.
  --app <slug>           App slug for app-scoped SDK authorization.
  --profile <name>       Local credential profile name. Default: default
  --scopes <csv>         App SDK scopes for app-scoped login.
  --web-url <url>        Browser UI base URL. Defaults to --base-url.
  --open false           Print login URL without opening the browser.
  --timeout <seconds>    Browser callback wait time. Default: 120

Examples:
  opg login
  opg login --base-url https://opg.example.com
  opg login --app demo --scopes database:read,database:write
`);
    return;
  }

  if (topic === 'app') {
    console.log(`OPG CLI - app

Usage:
  opg app list
  opg app create --name "Demo App" --slug demo
  opg app create --json '{"name":"Demo App","slug":"demo"}'
  opg app use <slug>

Options:
  --base-url <url>       OPG gateway base URL.
  --platform-token <jwt> Platform admin token. Usually loaded from opg login.
  --profile <name>       Local credential profile name.
  --include-inactive     Include inactive apps. Default: true

Examples:
  opg app list
  opg app create --name "Demo App" --slug demo
  opg app use demo
`);
    return;
  }

  if (topic === 'db') {
    console.log(`OPG CLI - db

Usage:
  opg db smoke
  opg db manifest
  opg db tables
  opg db describe <table>
  opg db query --sql "SELECT * FROM app_demo__customers"
  opg db execute --sql "CREATE TABLE ..." --dry-run true

Options:
  --base-url <url>       OPG gateway base URL.
  --app <slug>           App slug.
  --api-key <key>        App-scoped developer grant. Usually loaded from opg login --app.
  --sql <sql>            SQL for query or execute.
  --params <json>        Positional SQL params as JSON array.
  --limit <number>       Query row limit.
  --dry-run <bool>       Validate execute in a rolled-back transaction. Default is gateway-controlled.
  --confirm <token>      Required by gateway when applying destructive changes.

Examples:
  opg db smoke
  opg db describe app_demo__customers
  opg db query --sql "SELECT * FROM app_demo__customers"
`);
    return;
  }

  if (topic === 'schema') {
    console.log(`OPG CLI - schema

Usage:
  opg schema manifest
  opg schema table create --name customers --columns email:text,name:text
  opg schema table create --name customers --columns email:text,name:text --apply
  opg schema table drop customers --confirm drop:customers --apply
  opg schema column add customers --name phone --type text
  opg schema column add customers --name phone --type text --apply

Options:
  --app-id <id-or-slug>  Target tenant app id or slug. Falls back to selected app.
  --platform-token <jwt> Platform admin token. Usually loaded from opg login.
  --json <json>          Structured schema payload.
  --columns <spec>       Comma list like email:text,name:text.
  --apply                Apply the schema change. Without this, commands dry-run.
  --dry-run <bool>       Explicit dry-run flag.

Examples:
  opg schema manifest
  opg schema table create --name customers --columns email:text,name:text --apply
`);
    return;
  }

  if (topic === 'data') {
    console.log(`OPG CLI - data

Usage:
  opg data schema
  opg data list customers --limit 20
  opg data get customers <id>
  opg data create customers --json '{"email":"a@example.com"}'
  opg data update customers <id> --json '{"name":"Alice"}'
  opg data delete customers <id>

Options:
  --base-url <url>       OPG gateway base URL.
  --app <slug>           App slug.
  --api-key <key>        App-scoped API key or developer grant.
  --json <json>          Row payload for create/update.
  --select <csv>         Fields to return.
  --order <field.asc>    Sort field and direction.
  --limit <number>       Row limit.

Examples:
  opg data list customers --select id,email --limit 20
  opg data create customers --json '{"email":"a@example.com"}'
`);
    return;
  }

  if (topic === 'function') {
    console.log(`OPG CLI - function

Usage:
  opg function list --app-id <app>
  opg function create --app-id <app> --slug sync_customer --source '{"kind":"echo"}'
  opg function deploy --app-id <app> sync_customer
  opg function invoke sync_customer --json '{"input":{"id":"123"}}'
  opg function runs --app-id <app> sync_customer

Notes:
  Function source uses OPG structured handlers, not arbitrary shell execution.
`);
    return;
  }

  if (topic === 'workflow') {
    console.log(`OPG CLI - workflow

Usage:
  opg workflow list --app-id <app>
  opg workflow create --app-id <app> --slug onboard --steps '[{"id":"noop","type":"noop"}]'
  opg workflow run onboard --json '{"input":{"id":"123"}}'
  opg workflow runs --app-id <app> onboard

Notes:
  First-class step types: data.query, data.create, function.invoke, noop.
`);
    return;
  }

  if (topic === 'block') {
    console.log(`OPG CLI - block

Usage:
  opg block ai upsert --app-id <app> --json '{"slug":"copy","prompt_template":"Write {{topic}}"}'
  opg block ai run copy --app-id <app> --json '{"input":{"topic":"launch"}}'
  opg block video upsert --app-id <app> --json '{"slug":"product_video"}'
  opg block storage save --app-id <app> --json '{"bucket":"default","filename":"note.txt","content":"hello"}'
`);
    return;
  }

  if (topic === 'platform') {
    console.log(`OPG CLI - platform

Usage:
  opg platform apps list
  opg platform apps get --app-id <id>
  opg platform apps create --json '{"name":"Demo","slug":"demo"}'
  opg platform apps update --app-id <id> --json '{...}'
  opg platform feedbacks list --app-id <id>
  opg platform feedbacks get --app-id <id> --feedback-id <id>
  opg platform feedbacks update --app-id <id> --feedback-id <id> --json '{...}'
  opg platform feedbacks comment --app-id <id> --feedback-id <id> --json '{...}'
  opg platform feedbacks review --app-id <id> --feedback-id <id> --json '{...}'
  opg platform analytics business --app-id <id> --days 30
  opg platform analytics overview --app-id <id> --days 30
  opg platform analytics growth --app-id <id> --days 30
  opg platform analytics retention --app-id <id> --days 30
  opg platform analytics profiles --app-id <id> --days 30
  opg platform analytics conversion --app-id <id> --days 30
  opg platform analytics users --app-id <id> --days 30
  opg platform ai-usage summary --app-id <id> --days 7
  opg platform ai-usage breakdown --app-id <id> --days 7
  opg platform ai-usage logs --app-id <id> --days 7
  opg platform payments products --app-id <id>
  opg platform payments orders --app-id <id>
  opg platform runtime get
  opg platform runtime update --json '{...}'
  opg platform request --path /storage/providers --method GET

Options:
  --base-url <url>       OPG gateway base URL.
  --platform-token <jwt> Platform admin token. Usually loaded from opg login.
  --app-id <id>          Target tenant app id for app data operations.
  --json <json>          Request body for create/update actions.
  --query <json>         Query parameters as JSON object.
  --method <method>      HTTP method for platform request. Default: GET
  --path <path>          Path under /api/v1/platform-admin for platform request.

Examples:
  opg platform apps list
  opg platform feedbacks list --app-id <id>
  opg platform runtime get
  opg platform request --path /storage/providers --method GET
`);
    return;
  }

  if (topic === 'codex') {
    console.log(`OPG CLI - codex

Usage:
  opg codex install [--base-url <url> --app <slug>]

Options:
  --base-url <url>       OPG gateway base URL.
  --app <slug>           App slug for the MCP server.
  --profile <name>       Local credential profile name.

Example:
  opg codex install
`);
    return;
  }

  if (topic === 'mcp') {
    console.log(`OPG CLI - mcp

Usage:
  opg mcp

Description:
  Starts the OPG MCP server over stdio for Codex or other MCP clients.
  It reads .opg/credentials.json, .env.local, and .opg/opg.config.json.
`);
    return;
  }

  console.log(`OPG CLI

Usage:
  opg <command> [options]
  opg help [command]
  opg <command> --help

Core commands:
  init          Write .opg/opg.config.json and optional app SDK scaffold.
  login         Browser login. Defaults to platform authorization; --app creates app SDK grant.
  app           List, create, or select tenant apps.
  manifest      Print current app SDK manifest.
  smoke         Run app SDK smoke test.
  db            Inspect or query app-owned database tables.
  schema        Create structured app data tables and columns.
  data          Read and write registered app data rows.
  function      Create, deploy, invoke, and inspect app functions.
  workflow      Create, run, and inspect app workflows.
  block         Create and run AI/video/storage blocks.
  platform      Call platform control-plane APIs.
  codex         Write Codex MCP config.
  mcp           Start MCP server over stdio.

Common flow:
  opg init --base-url https://opg.example.com
  opg login
  opg app create --name "Demo App" --slug demo
  opg login --app demo
  opg db smoke
  opg schema table create --name customers --columns email:text --apply
  opg data list customers
  opg function invoke sync_customer --json '{"input":{"id":"123"}}'
  opg workflow run onboard --json '{"input":{"id":"123"}}'
  opg codex install

Help:
  opg --help
  opg login --help
  opg app --help
  opg db --help
  opg schema --help
  opg data --help
  opg function --help
  opg block --help
  opg workflow --help
  opg platform --help
`);
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}
