#!/usr/bin/env node
import { createOpgClient, createOpgPlatformClient } from 'opg-sdk';

const flags = parseFlags(process.argv.slice(2));
const baseUrl = flags.baseUrl || flags['base-url'] || process.env.OPG_BASE_URL || '';
const app = flags.app || flags.appId || flags['app-id'] || process.env.OPG_APP_SLUG || '';
const apiKey = flags.apiKey || flags['api-key'] || process.env.OPG_API_KEY || '';
const platformToken = flags.platformToken || flags['platform-token'] || process.env.OPG_PLATFORM_TOKEN || '';

if (!baseUrl || !app || !apiKey || !platformToken) {
  console.error([
    'Missing app construction verifier config.',
    'Set OPG_BASE_URL, OPG_APP_SLUG, OPG_API_KEY, and OPG_PLATFORM_TOKEN, or pass --base-url --app --api-key --platform-token.',
  ].join('\n'));
  process.exit(2);
}

const suffix = Date.now().toString(36);
const table = `verify_${suffix}`;
const fn = `verify_fn_${suffix}`;
const workflow = `verify_wf_${suffix}`;
const client = createOpgClient({ baseUrl, app, apiKey });
const platform = createOpgPlatformClient({ baseUrl, platformToken });
const startedAt = Date.now();
const evidence = {};

try {
  evidence.schema = await platform.apps.schema.createTable(app, {
    name: table,
    columns: [{ name: 'email', data_type: 'text' }, { name: 'name', data_type: 'text' }],
    soft_delete: true,
    dry_run: false,
  });
  const created = await client.data.table(table).create({ email: `verify-${suffix}@example.com`, name: 'Verifier' });
  evidence.data_create = created;
  evidence.data_list = await client.data.table(table).list({ limit: 5 });

  evidence.function_create = await platform.apps.functions.create(app, {
    slug: fn,
    source: { kind: 'transform', pick: ['email'], set: { verified: true } },
  });
  evidence.function_deploy = await platform.apps.functions.deploy(app, fn);
  evidence.function_invoke = await client.functions.invoke(fn, { input: { email: `verify-${suffix}@example.com` } });

  evidence.workflow_create = await platform.apps.workflows.create(app, {
    slug: workflow,
    steps: [
      { id: 'load_rows', type: 'data.query', table, query: { limit: 1 } },
      { id: 'call_function', type: 'function.invoke', function: fn, input: { email: `verify-${suffix}@example.com` } },
    ],
  });
  evidence.workflow_run = await client.workflows.run(workflow, { input: { email: `verify-${suffix}@example.com` } });
  evidence.build_summary = await platform.apps.build.summary(app);
  evidence.build_events = await platform.apps.build.events(app, { limit: 10 });
  evidence.cleanup_table = await platform.apps.schema.dropTable(app, table, {
    dry_run: false,
    confirm: `drop:${table}`,
  });

  console.log(JSON.stringify({
    ok: true,
    app,
    resources: { table, function: fn, workflow },
    checks: Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, Boolean(value)])),
    cleanup: { structured_drop_table_supported: true, table_dropped: evidence.cleanup_table?.applied === true },
    execution_ms: Date.now() - startedAt,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    app,
    resources: { table, function: fn, workflow },
    error: formatError(error),
    evidence,
    execution_ms: Date.now() - startedAt,
  }, null, 2));
  process.exit(1);
}

function parseFlags(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith('--')) continue;
    const [key, inlineValue] = current.slice(2).split('=', 2);
    result[key] = inlineValue ?? args[index + 1] ?? '';
    if (inlineValue === undefined) index += 1;
  }
  return result;
}

function formatError(error) {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
