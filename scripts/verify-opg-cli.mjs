#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const cliEntry = process.env.OPG_CLI_ENTRY || path.join(repoRoot, 'packages/cli/dist/index.js');
const baseUrl = process.env.OPG_TEST_BASE_URL || process.env.OPG_BASE_URL || await readConfiguredBaseUrl();
const originalConfig = await readOptional('.opg/opg.config.json');
const originalCredentials = await readOptional('.opg/credentials.json');
const createdApps = [];
const summary = [];

if (!baseUrl) {
  fail('Missing OPG_TEST_BASE_URL or local .opg baseUrl.');
}
if (!existsSync(cliEntry)) {
  fail('Missing packages/cli/dist/index.js. Run npm --prefix packages/cli run build first.');
}

try {
  await verifyHelp();
  await verifyInit();

  const smoke = await createSmokeApp();
  createdApps.push(smoke);
  await verifyPlatformCommands(smoke);
  const user = await createUserAndFeedback(smoke);
  const feedback = await verifyFeedbackCommands(smoke, user);
  await createAppScopedGrant(smoke);
  await verifyAppScopedCommands(smoke);
  await verifyDatabaseCommands(smoke);
  await verifyCodexInstall(smoke);
  await verifyMcpCommand();

  await cleanupApp(smoke);
  ok('cleanup app inactive', smoke.slug);
  printSummary();
} catch (error) {
  console.error(`\n[FAIL] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  for (const app of createdApps) {
    await cleanupApp(app).catch((cleanupError) => {
      console.error(`[WARN] cleanup failed for ${app.slug}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    });
  }
  process.exitCode = 1;
} finally {
  await restoreLocalState();
}

async function verifyHelp() {
  for (const args of [
    ['--help'],
    ['help', 'init'],
    ['login', '--help'],
    ['app', '--help'],
    ['db', '--help'],
    ['platform', '--help'],
    ['codex', '--help'],
    ['mcp', '--help'],
  ]) {
    const result = await runCli(args);
    assert(result.stdout.includes('Usage:'), `help output missing Usage for ${args.join(' ')}`);
  }
  ok('help topics', 'root/init/login/app/db/platform/codex/mcp');
}

async function verifyInit() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'opg-cli-init-'));
  try {
    await runCli(['init', '--base-url', baseUrl], { cwd: tempDir });
    const platformConfig = JSON.parse(await readFile(path.join(tempDir, '.opg/opg.config.json'), 'utf8'));
    assert(platformConfig.baseUrl === baseUrl, 'platform init did not persist baseUrl');
    assert(!platformConfig.app, 'platform init should not require app slug');

    const appDir = await mkdtemp(path.join(tmpdir(), 'opg-cli-init-app-'));
    try {
      await runCli(['init', '--base-url', baseUrl, '--app', 'demo', '--skip-manifest', 'true'], { cwd: appDir });
      const appConfig = JSON.parse(await readFile(path.join(appDir, '.opg/opg.config.json'), 'utf8'));
      assert(appConfig.app === 'demo', 'app init did not persist app slug');
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  ok('init', 'platform-first and app-scoped setup');
}

async function createSmokeApp() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const slug = `codex-cli-verify-${suffix}`.toLowerCase();
  const name = `Codex CLI Verify ${suffix}`;
  const created = parseJson((await runCli(['app', 'create', '--name', name, '--slug', slug])).stdout);
  const app = pickApp(created);
  assert(app?.id && app?.slug === slug, 'app create did not return expected app');
  ok('app create', `${app.slug} (${app.id})`);

  const listed = parseJson((await runCli(['app', 'list'])).stdout);
  assert(findApp(listed, app.id), 'app list did not include created app');
  ok('app list', app.slug);

  await runCli(['app', 'use', slug]);
  const local = JSON.parse(await readFile(path.join(repoRoot, '.opg/opg.config.json'), 'utf8'));
  assert(local.app === slug, 'app use did not update local app');
  ok('app use', slug);
  return { id: app.id, slug, name };
}

async function verifyPlatformCommands(app) {
  assert(findApp(parseJson((await runCli(['platform', 'apps', 'list'])).stdout), app.id), 'platform apps list missing smoke app');
  ok('platform apps list', app.slug);

  const got = parseJson((await runCli(['platform', 'apps', 'get', '--app-id', app.id])).stdout);
  assert(pickApp(got)?.id === app.id, 'platform apps get returned wrong app');
  ok('platform apps get', app.id);

  const updated = parseJson((await runCli(['platform', 'apps', 'update', '--app-id', app.id, '--json', JSON.stringify({ status: 'ACTIVE' })])).stdout);
  assert(JSON.stringify(updated).includes('ACTIVE'), 'platform apps update did not keep app active');
  ok('platform apps update', 'ACTIVE');

  const viaRequest = parseJson((await runCli(['platform', 'request', '--path', '/apps', '--method', 'GET'])).stdout);
  assert(findApp(viaRequest, app.id), 'platform request /apps missing smoke app');
  ok('platform request', '/apps');

  const runtime = parseJson((await runCli(['platform', 'runtime', 'get'])).stdout);
  assert(runtime && typeof runtime === 'object', 'platform runtime get did not return JSON object');
  ok('platform runtime get', Object.keys(runtime).slice(0, 5).join(','));

  for (const action of ['business', 'overview', 'growth', 'retention', 'profiles', 'conversion', 'users']) {
    const payload = parseJson((await runCli(['platform', 'analytics', action, '--app-id', app.id, '--days', '7'])).stdout);
    assert(payload && typeof payload === 'object', `platform analytics ${action} did not return object`);
  }
  ok('platform analytics', 'business/overview/growth/retention/profiles/conversion/users');

  for (const action of ['summary', 'breakdown', 'logs']) {
    const payload = parseJson((await runCli(['platform', 'ai-usage', action, '--app-id', app.id, '--days', '7'])).stdout);
    assert(payload && typeof payload === 'object', `platform ai-usage ${action} did not return object`);
  }
  ok('platform ai-usage', 'summary/breakdown/logs');

  for (const action of ['products', 'orders']) {
    const payload = parseJson((await runCli(['platform', 'payments', action, '--app-id', app.id])).stdout);
    assert(payload && typeof payload === 'object', `platform payments ${action} did not return object`);
  }
  ok('platform payments', 'products/orders');

  const requestSlug = `${app.slug}-request`;
  const requestCreated = parseJson((await runCli([
    'platform',
    'request',
    '--path',
    '/apps',
    '--method',
    'POST',
    '--json',
    JSON.stringify({
      name: `${app.name} Request`,
      slug: requestSlug,
      status: 'ACTIVE',
    }),
  ])).stdout);
  const requestApp = pickApp(requestCreated);
  assert(requestApp?.id && requestApp?.slug === requestSlug, 'platform request POST /apps did not create app');
  createdApps.push({ id: requestApp.id, slug: requestApp.slug, name: requestApp.name || requestSlug });
  ok('platform request POST', `/apps (${requestSlug})`);

  const requestGot = parseJson((await runCli(['platform', 'request', '--path', `/apps/${requestApp.id}`, '--method', 'GET'])).stdout);
  assert(pickApp(requestGot)?.id === requestApp.id, 'platform request GET /apps/:id returned wrong app');
  ok('platform request GET', `/apps/${requestApp.id}`);

  await cleanupApp({ id: requestApp.id, slug: requestApp.slug });
  ok('platform request cleanup', requestApp.slug);
}

async function createUserAndFeedback(app) {
  const email = `opg-cli-user-${Date.now()}@example.invalid`;
  const password = `UserPass${Date.now()}!`;
  const registered = await postJson(`${baseUrl}/${app.slug}/v1/auth/register`, {
    email,
    password,
    fullName: 'OPG CLI Smoke User',
  });
  const accessToken = registered.access_token || registered.data?.access_token;
  assert(accessToken, 'test user registration did not return access_token');
  ok('test user register', email);

  const feedback = await postJson(`${baseUrl}/${app.slug}/v1/users/me/feedback`, {
    title: 'OPG CLI smoke feedback',
    content: 'This feedback is created by scripts/verify-opg-cli.mjs.',
    category: 'cli-smoke',
    priority: 'normal',
    context: { source: 'verify-opg-cli' },
  }, { Authorization: `Bearer ${accessToken}` });
  const item = feedback.item || feedback.data?.item;
  assert(item?.id, 'test feedback submission did not return item id');
  ok('test feedback submit', item.id);
  return { email, accessToken, feedbackId: item.id };
}

async function verifyFeedbackCommands(app, user) {
  const list = parseJson((await runCli(['platform', 'feedbacks', 'list', '--app-id', app.id, '--q', 'OPG CLI smoke'])).stdout);
  const listed = findFeedback(list, user.feedbackId);
  assert(listed, 'platform feedbacks list missing test feedback');
  ok('platform feedbacks list', user.feedbackId);

  const detail = parseJson((await runCli(['platform', 'feedbacks', 'get', '--app-id', app.id, '--feedback-id', user.feedbackId])).stdout);
  assert(JSON.stringify(detail).includes(user.feedbackId), 'platform feedbacks get returned wrong item');
  ok('platform feedbacks get', user.feedbackId);

  const updated = parseJson((await runCli([
    'platform',
    'feedbacks',
    'update',
    '--app-id',
    app.id,
    '--feedback-id',
    user.feedbackId,
    '--json',
    JSON.stringify({ status: 'triaged', priority: 'high', admin_note: 'CLI smoke update' }),
  ])).stdout);
  assert(JSON.stringify(updated).includes('triaged'), 'platform feedbacks update did not apply status');
  ok('platform feedbacks update', 'triaged');

  const comment = parseJson((await runCli([
    'platform',
    'feedbacks',
    'comment',
    '--app-id',
    app.id,
    '--feedback-id',
    user.feedbackId,
    '--json',
    JSON.stringify({ body: 'CLI smoke internal comment', is_internal: true }),
  ])).stdout);
  assert(JSON.stringify(comment).includes('CLI smoke internal comment'), 'platform feedbacks comment did not return comment body');
  ok('platform feedbacks comment', user.feedbackId);

  const reviewed = parseJson((await runCli([
    'platform',
    'feedbacks',
    'review',
    '--app-id',
    app.id,
    '--feedback-id',
    user.feedbackId,
    '--json',
    JSON.stringify({ action: 'thanks', note: 'CLI smoke review' }),
  ])).stdout);
  assert(JSON.stringify(reviewed).includes('thanks'), 'platform feedbacks review did not apply thanks action');
  ok('platform feedbacks review', 'thanks');
  return user.feedbackId;
}

async function createAppScopedGrant(app) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await createAppScopedGrantOnce(app);
      ok('login --app', app.slug);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= 3 || !isTransientCliError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

async function createAppScopedGrantOnce(app) {
  const child = spawn(process.execPath, [cliEntry, 'login', '--base-url', baseUrl, '--app', app.slug, '--open', 'false', '--timeout', '20'], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const loginUrl = await waitFor(() => {
    const match = stdout.match(/https?:\/\/\S*\/sdk-login\?\S+/);
    return match?.[0];
  }, 10_000, 'CLI login URL was not printed');
  const state = new URL(loginUrl).searchParams.get('state');
  assert(state, 'CLI login URL missing state');

  const platformToken = await readPlatformToken();
  const authorization = await postJson(`${baseUrl}/${app.slug}/v1/sdk/auth/sessions/${encodeURIComponent(state)}/authorize`, {
    target: 'app',
    scopes: ['database:read', 'database:write'],
  }, { Authorization: `Bearer ${platformToken}` });
  const redirectUrl = authorization.redirect_url || authorization.data?.redirect_url;
  assert(redirectUrl, 'SDK authorization did not return redirect_url');
  await fetch(redirectUrl);

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  if (exitCode !== 0) {
    throw new Error(`opg login --app exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  assert(stdout.includes('OPG SDK login saved'), 'opg login --app did not save SDK grant');
}

async function verifyAppScopedCommands(app) {
  const manifest = parseJson((await runCli(['manifest'])).stdout);
  assert(JSON.stringify(manifest).includes(app.slug), 'manifest did not reference current app');
  ok('manifest', app.slug);

  const smoke = parseJson((await runCli(['smoke'])).stdout);
  assert(JSON.stringify(smoke).includes(app.slug) || smoke.ok === true, 'smoke did not return expected app result');
  ok('smoke', app.slug);
}

async function verifyDatabaseCommands(app) {
  const manifest = parseJson((await runCli(['db', 'manifest'])).stdout);
  const namespace = String(manifest.namespace || '');
  const confirm = String(manifest.safety?.apply_confirmation || `apply:${app.slug}`);
  assert(namespace.startsWith('app_') && namespace.endsWith('__'), 'db manifest missing namespace');
  ok('db manifest', namespace);

  await runCli(['db', 'smoke']);
  ok('db smoke', 'dry-run DDL');

  await runCli(['db', 'tables']);
  ok('db tables', 'listed');

  const table = `${namespace}cli_verify_${Date.now()}`;
  await runCli(['db', 'execute', '--sql', `CREATE TABLE ${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`, '--dry-run', 'false', '--confirm', confirm]);
  ok('db execute create', table);

  await runCli(['db', 'execute', '--sql', `INSERT INTO ${table} (note) VALUES ($1)`, '--params', '["hello"]', '--dry-run', 'false', '--confirm', confirm]);
  ok('db execute insert', table);

  const query = parseJson((await runCli(['db', 'query', '--sql', `SELECT note FROM ${table} ORDER BY created_at DESC`, '--limit', '10'])).stdout);
  assert(JSON.stringify(query).includes('hello'), 'db query did not return inserted row');
  ok('db query', table);

  const describe = parseJson((await runCli(['db', 'describe', table])).stdout);
  assert(JSON.stringify(describe).includes('note'), 'db describe did not include note column');
  ok('db describe', table);

  await runCli(['db', 'execute', '--sql', `DROP TABLE ${table}`, '--dry-run', 'false', '--confirm', confirm]);
  ok('db execute drop', table);
}

async function verifyCodexInstall(app) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'opg-cli-codex-'));
  try {
    await runCli(['codex', 'install', '--base-url', baseUrl, '--app', app.slug], { cwd: tempDir });
    const config = JSON.parse(await readFile(path.join(tempDir, '.opg/codex-mcp.json'), 'utf8'));
    assert(config.mcpServers?.opg?.command === 'npx', 'codex install did not write npx MCP command');
    assert(config.mcpServers?.opg?.args?.includes('@jamba/opg-cli'), 'codex install did not reference @jamba/opg-cli');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  ok('codex install', '.opg/codex-mcp.json');
}

async function verifyMcpCommand() {
  const child = spawn(process.execPath, [cliEntry, 'mcp'], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'opg-cli-smoke', version: '0.0.0' },
    },
  })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);

  await waitFor(() => stdout.includes('"id":2'), 10_000, 'MCP tools/list response was not received');
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('close', resolve));
  assert(stdout.includes('opg_platform_apps_list'), `MCP tools list missing platform tool. stderr: ${stderr}`);
  assert(stdout.includes('opg_database_query'), 'MCP tools list missing database tool');
  ok('mcp tools/list', 'platform and database tools');
}

async function cleanupApp(app) {
  if (!app?.id) return;
  await runCli(['platform', 'apps', 'update', '--app-id', app.id, '--json', JSON.stringify({ status: 'INACTIVE' })]);
}

async function restoreLocalState() {
  if (originalConfig !== null) {
    await writeFile(path.join(repoRoot, '.opg/opg.config.json'), originalConfig);
  }
  if (originalCredentials !== null) {
    await writeFile(path.join(repoRoot, '.opg/credentials.json'), originalCredentials, { mode: 0o600 });
  }
}

async function runCli(args, options = {}) {
  const maxAttempts = options.retry === false ? 1 : 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run(process.execPath, [cliEntry, ...args], {
        cwd: options.cwd || repoRoot,
        env: process.env,
        timeoutMs: options.timeoutMs || 60_000,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientCliError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

async function run(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const timeout = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timeout);
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${command} ${args.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { stdout, stderr };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${url} failed ${response.status}: ${data?.message || data?.detail || text}`);
  }
  return data?.data || data;
}

async function readConfiguredBaseUrl() {
  try {
    const config = JSON.parse(await readFile(path.join(repoRoot, '.opg/opg.config.json'), 'utf8'));
    return String(config.baseUrl || '');
  } catch {
    return '';
  }
}

async function readOptional(relativePath) {
  try {
    return await readFile(path.join(repoRoot, relativePath), 'utf8');
  } catch {
    return null;
  }
}

async function readPlatformToken() {
  const credentials = JSON.parse(await readFile(path.join(repoRoot, '.opg/credentials.json'), 'utf8'));
  const profile = credentials.currentProfile || 'default';
  const token = credentials.profiles?.[profile]?.platformToken;
  assert(token, 'local credentials do not include platformToken. Run opg login first.');
  return token;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Expected JSON output, got:\n${text}`);
  }
}

function pickApp(value) {
  const root = value || {};
  for (const candidate of [root.app, root.data?.app, root.item, root.data, root]) {
    if (candidate && typeof candidate === 'object' && candidate.id && candidate.slug) {
      return candidate;
    }
  }
  return null;
}

function findApp(value, appId) {
  const root = value || {};
  const candidates = [root.items, root.apps, root.data?.items, root.data, root];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.some((item) => item?.id === appId)) {
      return true;
    }
  }
  return JSON.stringify(value).includes(appId);
}

function findFeedback(value, feedbackId) {
  const root = value || {};
  const candidates = [root.items, root.feedbacks, root.data?.items, root.data, root];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.some((item) => item?.id === feedbackId)) {
      return true;
    }
  }
  return JSON.stringify(value).includes(feedbackId);
}

async function waitFor(check, timeoutMs, message) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isTransientCliError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'fetch failed',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'socket hang up',
  ].some((fragment) => message.includes(fragment));
}

function ok(name, detail) {
  summary.push({ name, detail });
  console.log(`[OK] ${name}${detail ? `: ${detail}` : ''}`);
}

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function printSummary() {
  console.log(`\nOPG CLI verification passed (${summary.length} checks).`);
}
