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
const createdResources = {
  table: false,
  function: false,
  workflow: false,
};

try {
  evidence.schema = await platform.apps.schema.createTable(app, {
    name: table,
    columns: [{ name: 'email', data_type: 'text' }, { name: 'name', data_type: 'text' }],
    soft_delete: true,
    dry_run: false,
  });
  createdResources.table = true;
  const created = await client.data.table(table).create({ email: `verify-${suffix}@example.com`, name: 'Verifier' });
  evidence.data_create = created;
  evidence.data_list = await client.data.table(table).list({ limit: 5 });

  evidence.function_create = await platform.apps.functions.create(app, {
    slug: fn,
    source: { kind: 'transform', pick: ['email'], set: { verified: true } },
  });
  createdResources.function = true;
  evidence.function_deploy = await platform.apps.functions.deploy(app, fn);
  evidence.function_invoke = await client.functions.invoke(fn, { input: { email: `verify-${suffix}@example.com` } });
  evidence.function_run = await waitForLatestSucceededRun(() => platform.apps.functions.runs(app, fn), 'function');

  evidence.workflow_create = await platform.apps.workflows.create(app, {
    slug: workflow,
    steps: [
      { id: 'load_rows', type: 'data.query', table, query: { limit: 1 } },
      { id: 'call_function', type: 'function.invoke', function: fn, input: { email: `verify-${suffix}@example.com` } },
    ],
  });
  createdResources.workflow = true;
  evidence.workflow_run = await client.workflows.run(workflow, { input: { email: `verify-${suffix}@example.com` } });
  evidence.workflow_run_result = await waitForLatestSucceededRun(() => platform.apps.workflows.runs(app, workflow), 'workflow');
  evidence.build_summary = await platform.apps.build.summary(app);
  evidence.build_events = await platform.apps.build.events(app, { limit: 10 });
  evidence.cleanup_workflow = await platform.apps.workflows.delete(app, workflow, { confirm: `delete:${workflow}` });
  createdResources.workflow = false;
  evidence.cleanup_function = await platform.apps.functions.delete(app, fn, { confirm: `delete:${fn}` });
  createdResources.function = false;
  evidence.cleanup_table = await platform.apps.schema.dropTable(app, table, {
    dry_run: false,
    confirm: `drop:${table}`,
  });
  createdResources.table = false;

  console.log(JSON.stringify({
    ok: true,
    app,
    resources: { table, function: fn, workflow },
    checks: Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, Boolean(value)])),
    cleanup: {
      structured_drop_table_supported: true,
      table_dropped: evidence.cleanup_table?.applied === true,
      function_deleted: evidence.cleanup_function?.deleted === true,
      workflow_deleted: evidence.cleanup_workflow?.deleted === true,
    },
    execution_ms: Date.now() - startedAt,
  }, null, 2));
} catch (error) {
  evidence.cleanup_after_failure = await cleanupBestEffort(platform, app, { table, fn, workflow }, createdResources);
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

async function waitForLatestSucceededRun(fetchRuns, label) {
  const deadline = Date.now() + Number(process.env.OPG_VERIFIER_RUN_TIMEOUT_MS || 30000);
  let latest = null;
  while (Date.now() < deadline) {
    const result = await fetchRuns();
    latest = pickLatestRun(result);
    if (latest?.status === 'SUCCEEDED') {
      return latest;
    }
    if (latest?.status === 'FAILED') {
      throw new Error(`${label} run failed: ${latest.error_message || latest.error || latest.id || 'unknown error'}`);
    }
    await sleep(500);
  }
  throw new Error(`${label} run did not reach SUCCEEDED before timeout${latest?.status ? ` (last status: ${latest.status})` : ''}`);
}

function pickLatestRun(result) {
  const items = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
  if (!items.length) return null;
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || left.createdAt || left.updated_at || left.updatedAt || 0);
    const rightTime = Date.parse(right.created_at || right.createdAt || right.updated_at || right.updatedAt || 0);
    return rightTime - leftTime;
  })[0];
}

async function cleanupBestEffort(platformClient, appSlug, resources, created) {
  const cleanup = {};
  if (created.workflow) {
    cleanup.workflow = await swallow(() => platformClient.apps.workflows.delete(appSlug, resources.workflow, { confirm: `delete:${resources.workflow}` }));
  }
  if (created.function) {
    cleanup.function = await swallow(() => platformClient.apps.functions.delete(appSlug, resources.fn, { confirm: `delete:${resources.fn}` }));
  }
  if (created.table) {
    cleanup.table = await swallow(() => platformClient.apps.schema.dropTable(appSlug, resources.table, {
      dry_run: false,
      confirm: `drop:${resources.table}`,
    }));
  }
  return cleanup;
}

async function swallow(callback) {
  try {
    return await callback();
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
