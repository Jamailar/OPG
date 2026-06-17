export type OpgApiKeyProvider = string | (() => string | Promise<string>);

export type OpgClientOptions = {
  baseUrl: string;
  app?: string;
  apiKey?: OpgApiKeyProvider;
  platformToken?: OpgApiKeyProvider;
  fetch?: typeof fetch;
};

export type OpgRequestOptions = {
  method?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type OpgAgentRunInput = {
  input?: unknown;
  input_text?: string;
  inputText?: string;
  [key: string]: unknown;
};

export type OpgVideoTaskInput = {
  model?: string;
  prompt?: string;
  image?: { url?: string; base64?: string };
  video?: { url?: string; base64?: string };
  [key: string]: unknown;
};

export type OpgDatabaseQueryInput = {
  sql: string;
  params?: unknown[];
  limit?: number;
};

export type OpgDatabaseExecuteInput = {
  sql: string;
  params?: unknown[];
  dryRun?: boolean;
  dry_run?: boolean;
  confirm?: string | boolean;
};

type OpgClientInternals = {
  request<T = unknown>(path: string, options?: OpgRequestOptions): Promise<T>;
  stream(path: string, options?: OpgRequestOptions): AsyncIterable<string>;
};

type OpgCrudClient = {
  list(query?: Record<string, string | number | boolean | undefined | null>): Promise<Record<string, unknown>>;
  create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(id: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  delete(id: string): Promise<Record<string, unknown>>;
  test?(idOrInput: string | Record<string, unknown>, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export type OpgPlatformClient = {
  request<T = unknown>(path: string, options?: OpgRequestOptions): Promise<T>;
  apps: {
    list(query?: { includeInactive?: boolean; include_inactive?: boolean }): Promise<Record<string, unknown>>;
    get(appId: string): Promise<Record<string, unknown>>;
    create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    update(appId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
    stats(appId: string): Promise<Record<string, unknown>>;
    ai: {
      modelRoutes(appId: string): Promise<Record<string, unknown>>;
      upsertModelRoute(appId: string, modelId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      deleteModelRoute(appId: string, modelId: string): Promise<Record<string, unknown>>;
      setModelVisibility(appId: string, modelId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      defaultModels(appId: string): Promise<Record<string, unknown>>;
      setDefaultModel(appId: string, capability: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      deleteDefaultModel(appId: string, capability: string): Promise<Record<string, unknown>>;
    };
  };
  runtimeSettings: {
    get(): Promise<Record<string, unknown>>;
    update(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  storageProviders: OpgCrudClient;
  smtpProviders: OpgCrudClient;
  integrationApiKeys: {
    list(): Promise<Record<string, unknown>>;
    create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    revoke(id: string): Promise<Record<string, unknown>>;
  };
  payments: {
    methods: OpgCrudClient;
  };
  sms: {
    providerCatalog(): Promise<Record<string, unknown>>;
    providers: OpgCrudClient;
    signatures: OpgCrudClient;
    templates: OpgCrudClient;
  };
  oauth: {
    wechatOpenApps: OpgCrudClient;
    googleClients: OpgCrudClient;
    githubApps: OpgCrudClient;
    appleCredentials: OpgCrudClient;
  };
  email: {
    cloudflareAccounts: OpgCrudClient & {
      verifyToken(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      sendingDomains(accountId: string): Promise<Record<string, unknown>>;
    };
    senders: OpgCrudClient;
  };
  proxies: OpgCrudClient & {
    batchTest(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    import(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    export(): Promise<Record<string, unknown>>;
    checkLogs(proxyId: string, query?: { limit?: number }): Promise<Record<string, unknown>>;
  };
  ai: {
    sources: OpgCrudClient;
    providerTemplates(): Promise<Record<string, unknown>>;
    gatewayRuntime(): Promise<Record<string, unknown>>;
    providerHealth(query?: Record<string, string | number | boolean | undefined | null>): Promise<Record<string, unknown>>;
    requestEvents(query?: Record<string, string | number | boolean | undefined | null>): Promise<Record<string, unknown>>;
    auditEvents(query?: Record<string, string | number | boolean | undefined | null>): Promise<Record<string, unknown>>;
    models: OpgCrudClient & {
      sourceRoutes(modelId: string): Promise<Record<string, unknown>>;
      replaceSourceRoutes(modelId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      testBatch(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      playground(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      queryPlaygroundTask(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    usageSummary(query?: Record<string, string | number | boolean | undefined | null>): Promise<Record<string, unknown>>;
    usageBreakdown(query?: Record<string, string | number | boolean | undefined | null>): Promise<Record<string, unknown>>;
    usageLogs(query?: Record<string, string | number | boolean | undefined | null>): Promise<Record<string, unknown>>;
  };
};

export type OpgClient = OpgClientInternals & {
  platform: OpgPlatformClient;
  sdk: {
    manifest(): Promise<Record<string, unknown>>;
    openapi(): Promise<Record<string, unknown>>;
    examples(target?: 'node' | 'react' | 'codex' | string): Promise<Record<string, unknown>>;
    smokeTest(): Promise<Record<string, unknown>>;
  };
  ai: {
    models(): Promise<Record<string, unknown>>;
    pricing(refresh?: boolean): Promise<Record<string, unknown>>;
    chat(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    responses(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    streamResponses(input: Record<string, unknown>): AsyncIterable<string>;
    embeddings(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    image(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    speech(input: Record<string, unknown>): Promise<ArrayBuffer>;
  };
  agents: {
    list(): Promise<Record<string, unknown>>;
    meta(slug: string): Promise<Record<string, unknown>>;
    run(slug: string, input: OpgAgentRunInput): Promise<Record<string, unknown>>;
    stream(slug: string, input: OpgAgentRunInput): AsyncIterable<string>;
  };
  upload: {
    presignedUrl(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    imageBuffer(file: Blob, fields?: Record<string, string>): Promise<Record<string, unknown>>;
    fileBuffer(file: Blob, fields?: Record<string, string>): Promise<Record<string, unknown>>;
  };
  video: {
    generate(input: OpgVideoTaskInput): Promise<Record<string, unknown>>;
    generateAsync(input: OpgVideoTaskInput): Promise<Record<string, unknown>>;
    queryTask(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    wait(taskId: string, options?: { intervalMs?: number; timeoutMs?: number }): Promise<Record<string, unknown>>;
  };
  usage: {
    aiLogs(query?: { page?: number; limit?: number }): Promise<Record<string, unknown>>;
  };
  database: {
    manifest(): Promise<Record<string, unknown>>;
    tables(): Promise<Record<string, unknown>>;
    describe(table: string): Promise<Record<string, unknown>>;
    query(input: OpgDatabaseQueryInput): Promise<Record<string, unknown>>;
    execute(input: OpgDatabaseExecuteInput): Promise<Record<string, unknown>>;
  };
};

export function createOpgClient(options: OpgClientOptions): OpgClient {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('OPG SDK requires fetch. Use Node.js 22+ or pass a fetch implementation.');
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const app = options.app ? normalizePathSegment(options.app, 'app') : '';
  const apiBaseUrl = app ? `${baseUrl}/${app}/v1` : '';
  const platform = createOpgPlatformClient({ ...options, baseUrl, fetch: fetchImpl });

  const request = async <T = unknown>(path: string, requestOptions: OpgRequestOptions = {}): Promise<T> => {
    if (!apiBaseUrl) {
      throw new Error('OPG app is required for app-scoped SDK calls. Use createOpgPlatformClient for global platform operations.');
    }
    const response = await rawRequest(fetchImpl, apiBaseUrl, path, options.apiKey, requestOptions);
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new OpgApiError(response.status, resolveErrorMessage(text, response.statusText), text);
    }
    if (contentType.includes('application/json')) {
      return (await response.json()) as T;
    }
    return (await response.arrayBuffer()) as T;
  };

  const stream = async function* (path: string, requestOptions: OpgRequestOptions = {}): AsyncIterable<string> {
    if (!apiBaseUrl) {
      throw new Error('OPG app is required for app-scoped SDK calls. Use createOpgPlatformClient for global platform operations.');
    }
    const response = await rawRequest(fetchImpl, apiBaseUrl, path, options.apiKey, requestOptions);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new OpgApiError(response.status, resolveErrorMessage(text, response.statusText), text);
    }
    if (!response.body) {
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        yield decoder.decode(chunk.value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) {
        yield tail;
      }
    } finally {
      reader.releaseLock();
    }
  };

  return {
    platform,
    request,
    stream,
    sdk: {
      manifest: () => request('/sdk/manifest'),
      openapi: () => request('/sdk/openapi.json'),
      examples: (target) => request('/sdk/examples', { query: { target } }),
      smokeTest: () => request('/sdk/smoke-test', { method: 'POST', body: {} }),
    },
    ai: {
      models: () => request('/models'),
      pricing: (refresh) => request('/models/pricing', { query: { refresh: refresh ? '1' : undefined } }),
      chat: (input) => request('/chat/completions', { method: 'POST', body: input }),
      responses: (input) => request('/responses', { method: 'POST', body: input }),
      streamResponses: (input) => stream('/responses', { method: 'POST', body: { ...input, stream: true } }),
      embeddings: (input) => request('/embeddings', { method: 'POST', body: input }),
      image: (input) => request('/images/generations', { method: 'POST', body: input }),
      speech: (input) => request('/audio/speech', { method: 'POST', body: input }),
    },
    agents: {
      list: () => request('/agent'),
      meta: (slug) => request(`/agent/${encodeURIComponent(slug)}/meta`),
      run: (slug, input) => request(`/agent/${encodeURIComponent(slug)}/run`, { method: 'POST', body: input }),
      stream: (slug, input) => stream(`/agent/${encodeURIComponent(slug)}/stream`, { method: 'POST', body: input }),
    },
    upload: {
      presignedUrl: (input) => request('/upload/presigned-url', { method: 'POST', body: input }),
      imageBuffer: (file, fields) => uploadBlob(request, '/upload/image-buffer', file, fields),
      fileBuffer: (file, fields) => uploadBlob(request, '/upload/file-buffer', file, fields),
    },
    video: {
      generate: (input) => request('/videos/generations', { method: 'POST', body: input }),
      generateAsync: (input) => request('/videos/generations/async', { method: 'POST', body: input }),
      queryTask: (input) => request('/videos/generations/tasks/query', { method: 'POST', body: input }),
      wait: (taskId, waitOptions) => waitForVideoTask(request, taskId, waitOptions),
    },
    usage: {
      aiLogs: (query) => request('/users/me/ai-usage-logs', { query }),
    },
    database: {
      manifest: () => request('/sdk/database/manifest'),
      tables: () => request('/sdk/database/tables'),
      describe: (table) => request(`/sdk/database/tables/${encodeURIComponent(table)}`),
      query: (input) => request('/sdk/database/query', { method: 'POST', body: input }),
      execute: (input) => request('/sdk/database/execute', { method: 'POST', body: input }),
    },
  };
}

export function createOpgPlatformClient(options: OpgClientOptions): OpgPlatformClient {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('OPG SDK requires fetch. Use Node.js 22+ or pass a fetch implementation.');
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const platformBaseUrl = `${baseUrl}/api/v1/platform-admin`;
  const token = options.platformToken || options.apiKey;

  const request = async <T = unknown>(path: string, requestOptions: OpgRequestOptions = {}): Promise<T> => {
    const response = await rawRequest(fetchImpl, platformBaseUrl, path, token, requestOptions);
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new OpgApiError(response.status, resolveErrorMessage(text, response.statusText), text);
    }
    if (contentType.includes('application/json')) {
      return (await response.json()) as T;
    }
    return (await response.arrayBuffer()) as T;
  };

  const crud = (path: string, options: { updateMethod?: 'PATCH' | 'PUT'; testPath?: string } = {}): OpgCrudClient => ({
    list: (query) => request(path, { query }),
    create: (input) => request(path, { method: 'POST', body: input }),
    update: (id, input) => request(`${path}/${encodeURIComponent(id)}`, { method: options.updateMethod || 'PUT', body: input }),
    delete: (id) => request(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    test: (idOrInput, input) => {
      if (typeof idOrInput === 'string') {
        return request(`${path}/${encodeURIComponent(idOrInput)}${options.testPath || '/test'}`, { method: 'POST', body: input || {} });
      }
      return request(`${path}${options.testPath || '/test'}`, { method: 'POST', body: idOrInput || {} });
    },
  });

  const appsBase = '/apps';
  const aiModels = crud('/ai/models');
  const aiSources = crud('/ai/sources');

  return {
    request,
    apps: {
      list: (query) => request(appsBase, {
        query: {
          include_inactive: query?.include_inactive ?? query?.includeInactive,
        },
      }),
      get: (appId) => request(`${appsBase}/${encodeURIComponent(appId)}`),
      create: (input) => request(appsBase, { method: 'POST', body: input }),
      update: (appId, input) => request(`${appsBase}/${encodeURIComponent(appId)}`, { method: 'PUT', body: input }),
      stats: (appId) => request(`${appsBase}/${encodeURIComponent(appId)}/stats`),
      ai: {
        modelRoutes: (appId) => request(`${appsBase}/${encodeURIComponent(appId)}/ai/model-routes`),
        upsertModelRoute: (appId, modelId, input) =>
          request(`${appsBase}/${encodeURIComponent(appId)}/ai/model-routes/${encodeURIComponent(modelId)}`, { method: 'PUT', body: input }),
        deleteModelRoute: (appId, modelId) =>
          request(`${appsBase}/${encodeURIComponent(appId)}/ai/model-routes/${encodeURIComponent(modelId)}`, { method: 'DELETE' }),
        setModelVisibility: (appId, modelId, input) =>
          request(`${appsBase}/${encodeURIComponent(appId)}/ai/model-visibility/${encodeURIComponent(modelId)}`, { method: 'PUT', body: input }),
        defaultModels: (appId) => request(`${appsBase}/${encodeURIComponent(appId)}/ai/default-models`),
        setDefaultModel: (appId, capability, input) =>
          request(`${appsBase}/${encodeURIComponent(appId)}/ai/default-models/${encodeURIComponent(capability)}`, { method: 'PUT', body: input }),
        deleteDefaultModel: (appId, capability) =>
          request(`${appsBase}/${encodeURIComponent(appId)}/ai/default-models/${encodeURIComponent(capability)}`, { method: 'DELETE' }),
      },
    },
    runtimeSettings: {
      get: () => request('/runtime-settings'),
      update: (input) => request('/runtime-settings', { method: 'PATCH', body: input }),
    },
    storageProviders: crud('/storage/providers', { updateMethod: 'PATCH' }),
    smtpProviders: crud('/smtp/providers', { updateMethod: 'PATCH' }),
    integrationApiKeys: {
      list: () => request('/integration-api-keys'),
      create: (input) => request('/integration-api-keys', { method: 'POST', body: input }),
      revoke: (id) => request(`/integration-api-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} }),
    },
    payments: {
      methods: crud('/payments/methods'),
    },
    sms: {
      providerCatalog: () => request('/sms/provider-catalog'),
      providers: crud('/sms/providers'),
      signatures: crud('/sms/signatures'),
      templates: crud('/sms/templates'),
    },
    oauth: {
      wechatOpenApps: crud('/wechat/open-apps'),
      googleClients: crud('/google/oauth-clients'),
      githubApps: crud('/github/oauth-apps'),
      appleCredentials: crud('/apple/login-credentials'),
    },
    email: {
      cloudflareAccounts: {
        ...crud('/email/cloudflare/accounts', { updateMethod: 'PATCH' }),
        verifyToken: (input) => request('/email/cloudflare/accounts/verify-token', { method: 'POST', body: input }),
        sendingDomains: (accountId) => request(`/email/cloudflare/accounts/${encodeURIComponent(accountId)}/sending-domains`),
      },
      senders: crud('/email/senders', { updateMethod: 'PATCH' }),
    },
    proxies: {
      ...crud('/proxies'),
      batchTest: (input) => request('/proxies/batch-test', { method: 'POST', body: input }),
      import: (input) => request('/proxies/import', { method: 'POST', body: input }),
      export: () => request('/proxies/export'),
      checkLogs: (proxyId, query) => request(`/proxies/${encodeURIComponent(proxyId)}/check-logs`, { query }),
    },
    ai: {
      sources: {
        ...aiSources,
        test: (input) => request('/ai/sources/test', { method: 'POST', body: typeof input === 'string' ? {} : input }),
      },
      providerTemplates: () => request('/ai/provider-templates'),
      gatewayRuntime: () => request('/ai/gateway/runtime'),
      providerHealth: (query) => request('/ai/gateway/provider-health', { query }),
      requestEvents: (query) => request('/ai/gateway/request-events', { query }),
      auditEvents: (query) => request('/ai/audit-events', { query }),
      models: {
        ...aiModels,
        test: (input) => request('/ai/models/test', { method: 'POST', body: typeof input === 'string' ? {} : input }),
        testBatch: (input) => request('/ai/models/test-batch', { method: 'POST', body: input }),
        sourceRoutes: (modelId) => request(`/ai/models/${encodeURIComponent(modelId)}/sources`),
        replaceSourceRoutes: (modelId, input) => request(`/ai/models/${encodeURIComponent(modelId)}/sources`, { method: 'PUT', body: input }),
        playground: (input) => request('/ai/models/playground', { method: 'POST', body: input }),
        queryPlaygroundTask: (input) => request('/ai/models/playground/query', { method: 'POST', body: input }),
      },
      usageSummary: (query) => request('/ai/usage/summary', { query }),
      usageBreakdown: (query) => request('/ai/usage/breakdown', { query }),
      usageLogs: (query) => request('/ai/usage/logs', { query }),
    },
  };
}

export class OpgApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly responseText: string,
  ) {
    super(message);
    this.name = 'OpgApiError';
  }
}

async function rawRequest(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  path: string,
  apiKey: OpgApiKeyProvider | undefined,
  options: OpgRequestOptions,
) {
  const url = new URL(`${apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const headers: Record<string, string> = { ...(options.headers || {}) };
  const token = await resolveApiKey(apiKey);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (typeof FormData !== 'undefined' && options.body instanceof FormData) {
      body = options.body;
    } else {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      body = JSON.stringify(options.body);
    }
  }

  return fetchImpl(url, {
    method: options.method || (body ? 'POST' : 'GET'),
    headers,
    body,
    signal: options.signal,
  });
}

async function uploadBlob(
  request: OpgClientInternals['request'],
  path: string,
  file: Blob,
  fields: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.set(key, value));
  form.set('file', file);
  return request<Record<string, unknown>>(path, { method: 'POST', body: form });
}

async function waitForVideoTask(
  request: OpgClientInternals['request'],
  taskId: string,
  options: { intervalMs?: number; timeoutMs?: number } = {},
) {
  const intervalMs = options.intervalMs || 3000;
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await request<Record<string, unknown>>('/videos/generations/tasks/query', {
      method: 'POST',
      body: { task_id: taskId, taskId },
    });
    const status = String(result.status || result.task_status || result.output_status || '').toLowerCase();
    if (['succeeded', 'success', 'completed', 'finished', 'failed', 'error', 'canceled', 'cancelled'].includes(status)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for OPG video task ${taskId}`);
}

async function resolveApiKey(apiKey: OpgApiKeyProvider | undefined) {
  if (!apiKey) {
    return '';
  }
  if (typeof apiKey === 'function') {
    return String(await apiKey()).trim();
  }
  return String(apiKey).trim();
}

function normalizeBaseUrl(value: string) {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  if (!normalized) {
    throw new Error('OPG baseUrl is required');
  }
  return normalized;
}

function normalizePathSegment(value: string, label: string) {
  const normalized = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    throw new Error(`OPG ${label} is required`);
  }
  return encodeURIComponent(normalized);
}

function resolveErrorMessage(text: string, fallback: string) {
  if (!text) {
    return fallback || 'OPG API request failed';
  }
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: { message?: unknown } };
    return String(parsed.error?.message || parsed.message || fallback || text);
  } catch {
    return text || fallback || 'OPG API request failed';
  }
}
