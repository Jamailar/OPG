import { BadGatewayException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { AsyncLocalStorage } from 'async_hooks';
import FormDataNode = require('form-data');
import nodeFetch, { RequestInit as NodeFetchRequestInit, Response as NodeFetchResponse } from 'node-fetch';
import { Readable } from 'stream';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyAgent as UndiciProxyAgent } from 'undici';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { PrismaClient } from '@prisma/client';
import { buildOutboundProxySecretKey, decryptOutboundProxyPassword } from './outbound-proxy.crypto';
import { OutboundProxyProtocol, OutboundProxyRow } from './outbound-proxy.types';

type ProxyContext = {
  proxyId: string | null;
  allowDisabled?: boolean;
};

type FetchOptions = {
  proxyId?: string | null;
  allowDisabled?: boolean;
  timeoutMs?: number;
};

type ResolvedProxy = {
  id: string;
  name: string;
  protocol: OutboundProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
  status: string;
  updated_at: Date;
};

@Injectable()
export class OutboundHttpClientService implements OnModuleInit {
  private static fetchPatched = false;
  private static originalFetch: typeof fetch | null = null;
  private static activeInstance: OutboundHttpClientService | null = null;

  private readonly logger = new Logger(OutboundHttpClientService.name);
  private readonly context = new AsyncLocalStorage<ProxyContext>();
  private readonly secretKey: Buffer;
  private readonly proxyCache = new Map<string, { expiresAt: number; value: ResolvedProxy }>();
  private readonly agentCache = new Map<string, { cacheKey: string; agent: any }>();
  private readonly proxyCacheTtlMs = 30 * 1000;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
  ) {
    this.secretKey = buildOutboundProxySecretKey(
      process.env.PLATFORM_SECRETS_KEY || process.env.OUTBOUND_PROXY_ENCRYPTION_KEY || this.config.jwt.secret,
    );
  }

  onModuleInit() {
    OutboundHttpClientService.activeInstance = this;
    if (OutboundHttpClientService.fetchPatched) {
      return;
    }
    OutboundHttpClientService.originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const active = OutboundHttpClientService.activeInstance;
      const store = active?.context.getStore();
      if (!active || !store?.proxyId) {
        return OutboundHttpClientService.originalFetch!(input, init);
      }
      return active.fetch(input, init, {
        proxyId: store.proxyId,
        allowDisabled: store.allowDisabled,
      });
    }) as typeof fetch;
    OutboundHttpClientService.fetchPatched = true;
  }

  clearProxyCache(proxyId?: string | null) {
    if (proxyId) {
      this.proxyCache.delete(proxyId);
      this.agentCache.delete(proxyId);
      return;
    }
    this.proxyCache.clear();
    this.agentCache.clear();
  }

  async runWithProxy<T>(
    proxyId: string | null | undefined,
    task: () => Promise<T>,
    options: { allowDisabled?: boolean } = {},
  ): Promise<T> {
    const normalizedProxyId = String(proxyId || '').trim() || null;
    if (!normalizedProxyId) {
      return task();
    }
    return this.context.run({ proxyId: normalizedProxyId, allowDisabled: options.allowDisabled }, task);
  }

  async fetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
    options: FetchOptions = {},
  ): Promise<Response> {
    const proxyId = String(options.proxyId || '').trim();
    if (!proxyId) {
      return this.directFetch(input, init, options.timeoutMs);
    }
    const proxy = await this.resolveProxy(proxyId, !!options.allowDisabled);
    return this.fetchViaProxy(input, init, proxy, options.timeoutMs);
  }

  private async directFetch(input: RequestInfo | URL, init: RequestInit, timeoutMs?: number): Promise<Response> {
    if (!timeoutMs) {
      return OutboundHttpClientService.originalFetch
        ? OutboundHttpClientService.originalFetch(input, init)
        : fetch(input, init);
    }
    const { init: timedInit, cleanup } = this.withTimeout(init, timeoutMs);
    try {
      return await (OutboundHttpClientService.originalFetch
        ? OutboundHttpClientService.originalFetch(input, timedInit)
        : fetch(input, timedInit));
    } finally {
      cleanup();
    }
  }

  private async fetchViaProxy(
    input: RequestInfo | URL,
    init: RequestInit,
    proxy: ResolvedProxy,
    timeoutMs?: number,
  ): Promise<Response> {
    if (proxy.protocol !== 'socks5') {
      return this.fetchViaUndiciProxy(input, init, proxy, timeoutMs);
    }
    const prepared = await this.prepareNodeFetchInput(input, init, timeoutMs);
    try {
      const proxyUrl = this.buildProxyUrl(proxy);
      const agent = this.resolveAgent(proxy.id, proxyUrl, proxy.updated_at);
      const response = await nodeFetch(prepared.url, {
        ...prepared.init,
        agent,
      } as NodeFetchRequestInit);
      return this.toWebResponse(response);
    } finally {
      prepared.cleanup();
    }
  }

  private async fetchViaUndiciProxy(
    input: RequestInfo | URL,
    init: RequestInit,
    proxy: ResolvedProxy,
    timeoutMs?: number,
  ): Promise<Response> {
    const proxyUrl = this.buildProxyUrl(proxy);
    const dispatcher = this.resolveUndiciAgent(proxy.id, proxyUrl, proxy.updated_at);
    const { init: timedInit, cleanup } = this.withTimeout(init, timeoutMs);
    try {
      const fetchImpl = OutboundHttpClientService.originalFetch || fetch;
      return await fetchImpl(input, {
        ...timedInit,
        dispatcher,
      } as RequestInit & { dispatcher: any });
    } finally {
      cleanup();
    }
  }

  private async resolveProxy(proxyId: string, allowDisabled: boolean): Promise<ResolvedProxy> {
    const cached = this.proxyCache.get(proxyId);
    if (cached && cached.expiresAt > Date.now()) {
      this.assertProxyUsable(cached.value, allowDisabled);
      return cached.value;
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM outbound_proxies
       WHERE id = $1::uuid
       LIMIT 1`,
      proxyId,
    ) as Promise<OutboundProxyRow[]>);
    const row = rows[0];
    if (!row) {
      throw new BadGatewayException('代理不存在或已删除');
    }
    const resolved: ResolvedProxy = {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      host: row.host,
      port: Number(row.port),
      username: String(row.username || ''),
      password: decryptOutboundProxyPassword(row.encrypted_password, this.secretKey),
      status: row.status,
      updated_at: row.updated_at,
    };
    this.assertProxyUsable(resolved, allowDisabled);
    this.proxyCache.set(proxyId, {
      expiresAt: Date.now() + this.proxyCacheTtlMs,
      value: resolved,
    });
    return resolved;
  }

  private assertProxyUsable(proxy: ResolvedProxy, allowDisabled: boolean) {
    if (allowDisabled) {
      return;
    }
    if (proxy.status === 'disabled') {
      throw new BadGatewayException(`代理已禁用：${proxy.name}`);
    }
    if (proxy.status === 'unhealthy') {
      throw new BadGatewayException(`代理不可用：${proxy.name}`);
    }
  }

  private buildProxyUrl(proxy: ResolvedProxy): string {
    const scheme = proxy.protocol === 'socks5' ? 'socks5h' : proxy.protocol;
    const auth = proxy.username
      ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ''}@`
      : '';
    return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
  }

  private resolveAgent(proxyId: string, proxyUrl: string, updatedAt: Date) {
    const cacheKey = `node-fetch|${proxyUrl}|${updatedAt.getTime()}`;
    const cached = this.agentCache.get(proxyId);
    if (cached?.cacheKey === cacheKey) {
      return cached.agent;
    }
    const agent = new SocksProxyAgent(proxyUrl);
    this.agentCache.set(proxyId, { cacheKey, agent });
    return agent;
  }

  private resolveUndiciAgent(proxyId: string, proxyUrl: string, updatedAt: Date) {
    const cacheKey = `undici|${proxyUrl}|${updatedAt.getTime()}`;
    const cached = this.agentCache.get(proxyId);
    if (cached?.cacheKey === cacheKey) {
      return cached.agent;
    }
    const agent = new UndiciProxyAgent(proxyUrl);
    this.agentCache.set(proxyId, { cacheKey, agent });
    return agent;
  }

  private async prepareNodeFetchInput(input: RequestInfo | URL, init: RequestInit, timeoutMs?: number) {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : input.toString();
    const headers = new Headers(request?.headers || undefined);
    new Headers(init.headers || undefined).forEach((value, key) => headers.set(key, value));
    let body = init.body as any;
    if (body === undefined && request && request.method !== 'GET' && request.method !== 'HEAD') {
      body = Buffer.from(await request.clone().arrayBuffer());
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const converted = await this.convertFormDataBody(body);
      body = converted.body;
      headers.delete('content-type');
      Object.entries(converted.headers).forEach(([key, value]) => headers.set(key, value));
    }
    const { init: timedInit, cleanup } = this.withTimeout({
      ...init,
      method: init.method || request?.method || 'GET',
      headers,
      body,
    }, timeoutMs);
    return {
      url,
      init: timedInit as any,
      cleanup,
    };
  }

  private async convertFormDataBody(body: FormData) {
    const form = new FormDataNode();
    for (const [key, value] of body.entries()) {
      if (typeof value === 'string') {
        form.append(key, value);
        continue;
      }
      const buffer = Buffer.from(await value.arrayBuffer());
      const options: { filename?: string; contentType?: string; knownLength?: number } = {
        filename: String((value as any).name || '').trim() || 'blob',
        knownLength: buffer.byteLength,
      };
      const contentType = String(value.type || '').trim();
      if (contentType) {
        options.contentType = contentType;
      }
      form.append(key, buffer, options);
    }
    return {
      body: form,
      headers: form.getHeaders(),
    };
  }

  private withTimeout(init: RequestInit, timeoutMs?: number): { init: RequestInit; cleanup: () => void } {
    if (!timeoutMs || timeoutMs <= 0) {
      return { init, cleanup: () => undefined };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const inputSignal = init.signal;
    const abortFromInput = () => controller.abort();
    inputSignal?.addEventListener('abort', abortFromInput);
    return {
      init: {
        ...init,
        signal: controller.signal,
      },
      cleanup: () => {
        clearTimeout(timeout);
        inputSignal?.removeEventListener('abort', abortFromInput);
      },
    };
  }

  private toWebResponse(response: NodeFetchResponse): Response {
    const headers = new Headers();
    response.headers.forEach((value, key) => headers.set(key, value));
    const status = response.status;
    const mustNotHaveBody = status === 204 || status === 205 || status === 304;
    const body = !mustNotHaveBody && response.body
      ? Readable.toWeb(response.body as unknown as Readable) as BodyInit
      : null;
    return new Response(body, {
      status,
      statusText: response.statusText,
      headers,
    });
  }
}
