export type OpgApiKeyProvider = string | (() => string | Promise<string>);

export type OpgClientOptions = {
  baseUrl: string;
  app: string;
  apiKey?: OpgApiKeyProvider;
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

type OpgClientInternals = {
  request<T = unknown>(path: string, options?: OpgRequestOptions): Promise<T>;
  stream(path: string, options?: OpgRequestOptions): AsyncIterable<string>;
};

export type OpgClient = OpgClientInternals & {
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
};

export function createOpgClient(options: OpgClientOptions): OpgClient {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('OPG SDK requires fetch. Use Node.js 22+ or pass a fetch implementation.');
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const app = normalizePathSegment(options.app, 'app');
  const apiBaseUrl = `${baseUrl}/${app}/v1`;

  const request = async <T = unknown>(path: string, requestOptions: OpgRequestOptions = {}): Promise<T> => {
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
