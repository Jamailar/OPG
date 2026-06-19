import { io, type Socket } from 'socket.io-client';

export type OpgApiKeyProvider = string | (() => string | Promise<string>);

export type OpgClientOptions = {
  baseUrl: string;
  app?: string;
  apiKey?: OpgApiKeyProvider;
  platformToken?: OpgApiKeyProvider;
  fetch?: typeof fetch;
};

export type OpgLocalConfigOptions = {
  cwd?: string;
  profile?: string;
};

export type OpgResolvedLocalConfig = OpgClientOptions & {
  profile: string;
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

export type OpgSchemaTableInput = {
  slug?: string;
  name?: string;
  display_name?: string;
  displayName?: string;
  description?: string;
  owner_column?: string;
  ownerColumn?: string;
  soft_delete?: boolean;
  softDelete?: boolean;
  columns?: Array<Record<string, unknown>>;
  dry_run?: boolean;
  dryRun?: boolean;
};

export type OpgSchemaColumnInput = Record<string, unknown> & {
  slug?: string;
  name?: string;
  data_type?: string;
  dataType?: string;
  dry_run?: boolean;
  dryRun?: boolean;
};

export type OpgRealtimeEnvelope = {
  id: string;
  channel: string;
  event: string;
  app_id?: string | null;
  app_slug?: string | null;
  resource_id?: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type OpgRealtimeSubscription = {
  channel: string;
  socket: Socket;
  close(): void;
};

export type OpgRealtimeSubscribeOptions = {
  event?: string;
  timeoutMs?: number;
  transports?: Array<'websocket' | 'polling'>;
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

type OpgQuery = Record<string, string | number | boolean | undefined | null>;

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
    feedbacks: {
      list(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      get(appId: string, feedbackId: string): Promise<Record<string, unknown>>;
      update(appId: string, feedbackId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      addComment(appId: string, feedbackId: string, input: { body?: string; is_internal?: boolean }): Promise<Record<string, unknown>>;
      review(appId: string, feedbackId: string, input: { action?: string; note?: string }): Promise<Record<string, unknown>>;
    };
    analytics: {
      business(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      overview(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      growth(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      retention(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      profiles(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      conversion(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      users(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
    };
    aiUsage: {
      summary(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      breakdown(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      logs(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
    };
    payments: {
      products(appId: string): Promise<Record<string, unknown>>;
      orders(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      refundOrder(appId: string, orderId: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    email: {
      settings(appId: string): Promise<Record<string, unknown>>;
      updateSettings(appId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      contacts(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      importContacts(appId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      updateContact(appId: string, contactId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      templates(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      createTemplate(appId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      updateTemplate(appId: string, templateId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      campaigns(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      createCampaign(appId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      sendCampaignTest(appId: string, campaignId: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
      scheduleCampaign(appId: string, campaignId: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
      cancelCampaign(appId: string, campaignId: string): Promise<Record<string, unknown>>;
      campaignRecipients(appId: string, campaignId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
    };
    site: {
      messages(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      updateMessage(appId: string, messageId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      cookieConsents(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
    };
    redeem: {
      packages(appId: string): Promise<Record<string, unknown>>;
      createPackage(appId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      updatePackage(appId: string, packageId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      deletePackage(appId: string, packageId: string): Promise<Record<string, unknown>>;
      distributePackage(appId: string, packageId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      createCodeBatch(appId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      codes(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      redemptions(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      revokeRedemption(appId: string, redemptionId: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
      batches(appId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      batchText(appId: string, batchId: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      voidCode(appId: string, code: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    admins: {
      list(appId: string): Promise<Record<string, unknown>>;
      myPermissions(appId: string): Promise<Record<string, unknown>>;
      create(appId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      setPassword(appId: string, adminUserId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      updatePermissions(appId: string, adminUserId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      updateStatus(appId: string, adminUserId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      remove(appId: string, adminUserId: string): Promise<Record<string, unknown>>;
    };
    schema: {
      manifest(appId: string): Promise<Record<string, unknown>>;
      createTable(appId: string, input: OpgSchemaTableInput): Promise<Record<string, unknown>>;
      addColumn(appId: string, table: string, input: OpgSchemaColumnInput): Promise<Record<string, unknown>>;
    };
    functions: {
      list(appId: string): Promise<Record<string, unknown>>;
      create(appId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      deploy(appId: string, functionId: string): Promise<Record<string, unknown>>;
      runs(appId: string, functionId: string): Promise<Record<string, unknown>>;
      invoke(appId: string, functionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    workflows: {
      list(appId: string): Promise<Record<string, unknown>>;
      create(appId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      run(appId: string, workflowId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      runs(appId: string, workflowId: string): Promise<Record<string, unknown>>;
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
    providerHealth(query?: OpgQuery): Promise<Record<string, unknown>>;
    requestEvents(query?: OpgQuery): Promise<Record<string, unknown>>;
    auditEvents(query?: OpgQuery): Promise<Record<string, unknown>>;
    models: OpgCrudClient & {
      sourceRoutes(modelId: string): Promise<Record<string, unknown>>;
      replaceSourceRoutes(modelId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      testBatch(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      playground(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      queryPlaygroundTask(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    usageSummary(query?: OpgQuery): Promise<Record<string, unknown>>;
    usageBreakdown(query?: OpgQuery): Promise<Record<string, unknown>>;
    usageLogs(query?: OpgQuery): Promise<Record<string, unknown>>;
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
  data: {
    schema(): Promise<Record<string, unknown>>;
    table(table: string): {
      list(query?: OpgQuery): Promise<Record<string, unknown>>;
      get(id: string, query?: OpgQuery): Promise<Record<string, unknown>>;
      create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      update(id: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      delete(id: string): Promise<Record<string, unknown>>;
    };
  };
  functions: {
    invoke(slug: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  workflows: {
    run(slug: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  realtime: {
    subscribe(
      channel: string,
      handler: (event: OpgRealtimeEnvelope) => void,
      options?: OpgRealtimeSubscribeOptions,
    ): Promise<OpgRealtimeSubscription>;
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
  const dataTable = (table: string) => {
    const encodedTable = encodeURIComponent(table);
    return {
      list: (query?: OpgQuery) => request<Record<string, unknown>>(`/data/${encodedTable}`, { query }),
      get: (id: string, query?: OpgQuery) => request<Record<string, unknown>>(`/data/${encodedTable}/${encodeURIComponent(id)}`, { query }),
      create: (input: Record<string, unknown>) => request<Record<string, unknown>>(`/data/${encodedTable}`, { method: 'POST', body: input }),
      update: (id: string, input: Record<string, unknown>) => request<Record<string, unknown>>(`/data/${encodedTable}/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
      delete: (id: string) => request<Record<string, unknown>>(`/data/${encodedTable}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    };
  };

  const subscribeRealtime = async (
    channel: string,
    handler: (event: OpgRealtimeEnvelope) => void,
    subscribeOptions: OpgRealtimeSubscribeOptions = {},
  ): Promise<OpgRealtimeSubscription> => {
    if (!app) {
      throw new Error('OPG app is required for realtime subscriptions.');
    }
    const token = await resolveApiKey(options.apiKey);
    if (!token) {
      throw new Error('OPG apiKey is required for realtime subscriptions.');
    }
    const socket = io(`${baseUrl}/realtime`, {
      path: '/socket.io',
      auth: { token, app: options.app },
      transports: subscribeOptions.transports || ['websocket', 'polling'],
    });
    const eventName = subscribeOptions.event || 'opg.event';
    socket.on(eventName, handler);
    await waitForSocketConnect(socket, subscribeOptions.timeoutMs || 10000);
    const ack = await socket.timeout(subscribeOptions.timeoutMs || 10000).emitWithAck('subscribe', { channel });
    if (!ack?.ok) {
      socket.close();
      throw new Error(ack?.message || ack?.code || `Failed to subscribe to ${channel}`);
    }
    return {
      channel,
      socket,
      close: () => {
        socket.emit('unsubscribe', { channel });
        socket.close();
      },
    };
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
    data: {
      schema: () => request<Record<string, unknown>>('/data/schema'),
      table: dataTable,
    },
    functions: {
      invoke: (slug, input) => request<Record<string, unknown>>(`/functions/${encodeURIComponent(slug)}/invoke`, { method: 'POST', body: input }),
    },
    workflows: {
      run: (slug, input) => request<Record<string, unknown>>(`/workflows/${encodeURIComponent(slug)}/run`, { method: 'POST', body: input }),
    },
    realtime: {
      subscribe: subscribeRealtime,
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
  const appPath = (appId: string, path = '') => `${appsBase}/${encodeURIComponent(appId)}${path}`;
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
        modelRoutes: (appId) => request(appPath(appId, '/ai/model-routes')),
        upsertModelRoute: (appId, modelId, input) =>
          request(appPath(appId, `/ai/model-routes/${encodeURIComponent(modelId)}`), { method: 'PUT', body: input }),
        deleteModelRoute: (appId, modelId) =>
          request(appPath(appId, `/ai/model-routes/${encodeURIComponent(modelId)}`), { method: 'DELETE' }),
        setModelVisibility: (appId, modelId, input) =>
          request(appPath(appId, `/ai/model-visibility/${encodeURIComponent(modelId)}`), { method: 'PUT', body: input }),
        defaultModels: (appId) => request(appPath(appId, '/ai/default-models')),
        setDefaultModel: (appId, capability, input) =>
          request(appPath(appId, `/ai/default-models/${encodeURIComponent(capability)}`), { method: 'PUT', body: input }),
        deleteDefaultModel: (appId, capability) =>
          request(appPath(appId, `/ai/default-models/${encodeURIComponent(capability)}`), { method: 'DELETE' }),
      },
      feedbacks: {
        list: (appId, query) => request(appPath(appId, '/feedbacks'), { query }),
        get: (appId, feedbackId) => request(appPath(appId, `/feedbacks/${encodeURIComponent(feedbackId)}`)),
        update: (appId, feedbackId, input) => request(appPath(appId, `/feedbacks/${encodeURIComponent(feedbackId)}`), { method: 'PATCH', body: input }),
        addComment: (appId, feedbackId, input) =>
          request(appPath(appId, `/feedbacks/${encodeURIComponent(feedbackId)}/comments`), { method: 'POST', body: input }),
        review: (appId, feedbackId, input) =>
          request(appPath(appId, `/feedbacks/${encodeURIComponent(feedbackId)}/review`), { method: 'POST', body: input }),
      },
      analytics: {
        business: (appId, query) => request(appPath(appId, '/business-analytics'), { query }),
        overview: (appId, query) => request(appPath(appId, '/analytics/overview'), { query }),
        growth: (appId, query) => request(appPath(appId, '/analytics/growth'), { query }),
        retention: (appId, query) => request(appPath(appId, '/analytics/retention'), { query }),
        profiles: (appId, query) => request(appPath(appId, '/analytics/profiles'), { query }),
        conversion: (appId, query) => request(appPath(appId, '/analytics/conversion'), { query }),
        users: (appId, query) => request(appPath(appId, '/analytics/users'), { query }),
      },
      aiUsage: {
        summary: (appId, query) => request(appPath(appId, '/ai/usage/summary'), { query }),
        breakdown: (appId, query) => request(appPath(appId, '/ai/usage/breakdown'), { query }),
        logs: (appId, query) => request(appPath(appId, '/ai/usage/logs'), { query }),
      },
      payments: {
        products: (appId) => request(`/payments/apps/${encodeURIComponent(appId)}/products`),
        orders: (appId, query) => request(appPath(appId, '/payments/orders'), { query }),
        refundOrder: (appId, orderId, input = {}) =>
          request(appPath(appId, `/payments/orders/${encodeURIComponent(orderId)}/refund`), { method: 'POST', body: input }),
      },
      email: {
        settings: (appId) => request(appPath(appId, '/email/settings')),
        updateSettings: (appId, input) => request(appPath(appId, '/email/settings'), { method: 'PUT', body: input }),
        contacts: (appId, query) => request(appPath(appId, '/email/contacts'), { query }),
        importContacts: (appId, input) => request(appPath(appId, '/email/contacts/import'), { method: 'POST', body: input }),
        updateContact: (appId, contactId, input) =>
          request(appPath(appId, `/email/contacts/${encodeURIComponent(contactId)}`), { method: 'PATCH', body: input }),
        templates: (appId, query) => request(appPath(appId, '/email/templates'), { query }),
        createTemplate: (appId, input) => request(appPath(appId, '/email/templates'), { method: 'POST', body: input }),
        updateTemplate: (appId, templateId, input) =>
          request(appPath(appId, `/email/templates/${encodeURIComponent(templateId)}`), { method: 'PATCH', body: input }),
        campaigns: (appId, query) => request(appPath(appId, '/email/campaigns'), { query }),
        createCampaign: (appId, input) => request(appPath(appId, '/email/campaigns'), { method: 'POST', body: input }),
        sendCampaignTest: (appId, campaignId, input = {}) =>
          request(appPath(appId, `/email/campaigns/${encodeURIComponent(campaignId)}/send-test`), { method: 'POST', body: input }),
        scheduleCampaign: (appId, campaignId, input = {}) =>
          request(appPath(appId, `/email/campaigns/${encodeURIComponent(campaignId)}/schedule`), { method: 'POST', body: input }),
        cancelCampaign: (appId, campaignId) =>
          request(appPath(appId, `/email/campaigns/${encodeURIComponent(campaignId)}/cancel`), { method: 'POST', body: {} }),
        campaignRecipients: (appId, campaignId, query) =>
          request(appPath(appId, `/email/campaigns/${encodeURIComponent(campaignId)}/recipients`), { query }),
      },
      site: {
        messages: (appId, query) => request(appPath(appId, '/site/messages'), { query }),
        updateMessage: (appId, messageId, input) =>
          request(appPath(appId, `/site/messages/${encodeURIComponent(messageId)}`), { method: 'PATCH', body: input }),
        cookieConsents: (appId, query) => request(appPath(appId, '/site/cookie-consents'), { query }),
      },
      redeem: {
        packages: (appId) => request(appPath(appId, '/redeem/packages')),
        createPackage: (appId, input) => request(appPath(appId, '/redeem/packages'), { method: 'POST', body: input }),
        updatePackage: (appId, packageId, input) =>
          request(appPath(appId, `/redeem/packages/${encodeURIComponent(packageId)}`), { method: 'PUT', body: input }),
        deletePackage: (appId, packageId) =>
          request(appPath(appId, `/redeem/packages/${encodeURIComponent(packageId)}`), { method: 'DELETE' }),
        distributePackage: (appId, packageId, input) =>
          request(appPath(appId, `/redeem/packages/${encodeURIComponent(packageId)}/distribute`), { method: 'POST', body: input }),
        createCodeBatch: (appId, input) => request(appPath(appId, '/redeem/codes/batches'), { method: 'POST', body: input }),
        codes: (appId, query) => request(appPath(appId, '/redeem/codes'), { query }),
        redemptions: (appId, query) => request(appPath(appId, '/redeem/redemptions'), { query }),
        revokeRedemption: (appId, redemptionId, input = {}) =>
          request(appPath(appId, `/redeem/redemptions/${encodeURIComponent(redemptionId)}/revoke`), { method: 'POST', body: input }),
        batches: (appId, query) => request(appPath(appId, '/redeem/codes/batches'), { query }),
        batchText: (appId, batchId, query) => request(appPath(appId, `/redeem/codes/batches/${encodeURIComponent(batchId)}/txt`), { query }),
        voidCode: (appId, code, input = {}) =>
          request(appPath(appId, `/redeem/codes/${encodeURIComponent(code)}/void`), { method: 'POST', body: input }),
      },
      admins: {
        list: (appId) => request(appPath(appId, '/admins')),
        myPermissions: (appId) => request(appPath(appId, '/admin-permissions/me')),
        create: (appId, input) => request(appPath(appId, '/admins'), { method: 'POST', body: input }),
        setPassword: (appId, adminUserId, input) =>
          request(appPath(appId, `/admins/${encodeURIComponent(adminUserId)}/password`), { method: 'PUT', body: input }),
        updatePermissions: (appId, adminUserId, input) =>
          request(appPath(appId, `/admins/${encodeURIComponent(adminUserId)}/permissions`), { method: 'PATCH', body: input }),
        updateStatus: (appId, adminUserId, input) =>
          request(appPath(appId, `/admins/${encodeURIComponent(adminUserId)}/status`), { method: 'PATCH', body: input }),
        remove: (appId, adminUserId) => request(appPath(appId, `/admins/${encodeURIComponent(adminUserId)}`), { method: 'DELETE' }),
      },
      schema: {
        manifest: (appId) => request(appPath(appId, '/schema/manifest')),
        createTable: (appId, input) => request(appPath(appId, '/schema/tables'), { method: 'POST', body: input }),
        addColumn: (appId, table, input) =>
          request(appPath(appId, `/schema/tables/${encodeURIComponent(table)}/columns`), { method: 'POST', body: input }),
      },
      functions: {
        list: (appId) => request(appPath(appId, '/functions')),
        create: (appId, input) => request(appPath(appId, '/functions'), { method: 'POST', body: input }),
        deploy: (appId, functionId) => request(appPath(appId, `/functions/${encodeURIComponent(functionId)}/deploy`), { method: 'POST', body: {} }),
        runs: (appId, functionId) => request(appPath(appId, `/functions/${encodeURIComponent(functionId)}/runs`)),
        invoke: (appId, functionId, input) => request(appPath(appId, `/functions/${encodeURIComponent(functionId)}/invoke`), { method: 'POST', body: input }),
      },
      workflows: {
        list: (appId) => request(appPath(appId, '/workflows')),
        create: (appId, input) => request(appPath(appId, '/workflows'), { method: 'POST', body: input }),
        run: (appId, workflowId, input) => request(appPath(appId, `/workflows/${encodeURIComponent(workflowId)}/run`), { method: 'POST', body: input }),
        runs: (appId, workflowId) => request(appPath(appId, `/workflows/${encodeURIComponent(workflowId)}/runs`)),
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

export async function readOpgLocalConfig(options: OpgLocalConfigOptions = {}): Promise<OpgResolvedLocalConfig> {
  const [{ readFile }, path] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
  ]);
  const cwd = options.cwd || process.cwd();
  const readJson = async <T>(relativePath: string, fallback: T): Promise<T> => {
    try {
      return JSON.parse(await readFile(path.resolve(cwd, relativePath), 'utf8')) as T;
    } catch {
      return fallback;
    }
  };
  const local = await readJson<{
    baseUrl?: string;
    app?: string;
    apiKey?: string;
    platformToken?: string;
    profile?: string;
  }>('.opg/opg.config.json', {});
  const credentials = await readJson<{
    currentProfile?: string;
    profiles?: Record<string, {
      baseUrl?: string;
      app?: string;
      apiKey?: string;
      platformToken?: string;
    }>;
  }>('.opg/credentials.json', {});
  const envFile = await readOpgDotEnvLocal(cwd);
  const profile = String(options.profile || local.profile || credentials.currentProfile || 'default').trim() || 'default';
  const credentialProfile = credentials.profiles?.[profile] || {};
  const baseUrl = process.env.OPG_BASE_URL || envFile.OPG_BASE_URL || local.baseUrl || credentialProfile.baseUrl || '';
  const app = process.env.OPG_APP_SLUG || envFile.OPG_APP_SLUG || local.app || credentialProfile.app || '';
  const apiKey = process.env.OPG_API_KEY || envFile.OPG_API_KEY || credentialProfile.apiKey || local.apiKey || '';
  const platformToken = process.env.OPG_PLATFORM_TOKEN || envFile.OPG_PLATFORM_TOKEN || credentialProfile.platformToken || local.platformToken || '';

  if (!baseUrl) {
    throw new Error('Missing OPG base URL. Run "opg init --base-url <url> --app <slug>" first.');
  }
  return {
    baseUrl,
    app,
    apiKey,
    platformToken,
    profile,
  };
}

export async function createOpgClientFromLocalConfig(options: OpgLocalConfigOptions = {}) {
  return createOpgClient(await readOpgLocalConfig(options));
}

async function readOpgDotEnvLocal(cwd: string): Promise<Record<string, string>> {
  const [{ readFile }, path] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
  ]);
  try {
    const content = await readFile(path.resolve(cwd, '.env.local'), 'utf8');
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

function waitForSocketConnect(socket: Socket, timeoutMs: number) {
  if (socket.connected) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out connecting to OPG realtime gateway'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      socket.off('error', onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String((error as any)?.message || error || 'Realtime connection failed')));
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
    socket.once('error', onError);
  });
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
