import { BadGatewayException, Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { OutboundHttpClientService } from '../outbound-proxy/outbound-http-client.service';
import { ResolvedAiRoute } from './ai-routing.service';
import { RuntimeSettingsService } from '../runtime-settings/runtime-settings.service';

type UpstreamFetchOptions = {
  timeoutMs?: number;
  stream?: boolean;
};

type AiUpstreamTuning = {
  defaultHeaderTimeoutMs: number;
  streamHeaderTimeoutMs: number;
  requestBodyMaxBytes: number;
  responseTextMaxBytes: number;
};
const DEFAULT_AI_UPSTREAM_TUNING: AiUpstreamTuning = {
  defaultHeaderTimeoutMs: 60000,
  streamHeaderTimeoutMs: 30000,
  requestBodyMaxBytes: 20 * 1024 * 1024,
  responseTextMaxBytes: 4 * 1024 * 1024,
};

@Injectable()
export class AiUpstreamClientService {
  private readonly logger = new Logger(AiUpstreamClientService.name);
  private tuning = DEFAULT_AI_UPSTREAM_TUNING;
  private tuningLoadedAt = 0;
  private tuningLoading: Promise<AiUpstreamTuning> | null = null;

  constructor(
    private readonly outboundHttp: OutboundHttpClientService,
    private readonly runtimeSettingsService: RuntimeSettingsService,
  ) {}

  async fetch(
    route: ResolvedAiRoute,
    endpointUrl: string,
    init: RequestInit,
    options: UpstreamFetchOptions = {},
  ): Promise<Response> {
    const tuning = await this.getTuning();
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs
      ?? (options.stream ? tuning.streamHeaderTimeoutMs : tuning.defaultHeaderTimeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const requestId = this.buildGatewayRequestId(route);
    this.assertRequestBodyWithinLimit(init.body, tuning.requestBodyMaxBytes);

    try {
      return await this.outboundHttp.fetch(endpointUrl, {
        ...init,
        headers: this.withGatewayHeaders(init.headers, requestId),
        signal: controller.signal,
      }, {
        proxyId: route.source.outbound_proxy_id,
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        this.logger.warn(
          `AI upstream header timeout model=${route.model_key} source=${route.source.name} timeout_ms=${timeoutMs} url=${this.redactUrl(endpointUrl)}`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  filterResponseHeaders(headers: Headers, fallbackContentType: string): Record<string, string> {
    const contentType = headers.get('content-type') || fallbackContentType;
    const cacheControl = headers.get('cache-control') || 'no-cache';
    const requestId = headers.get('x-request-id') || headers.get('request-id') || '';
    const output: Record<string, string> = {
      'content-type': contentType,
      'cache-control': cacheControl,
    };
    if (requestId) {
      output['x-upstream-request-id'] = requestId;
    }
    const accelBuffering = headers.get('x-accel-buffering');
    if (accelBuffering) {
      output['x-accel-buffering'] = accelBuffering;
    }
    return output;
  }

  async readText(response: Response, maxBytes?: number): Promise<string> {
    const tuning = await this.getTuning();
    const limit = maxBytes || tuning.responseTextMaxBytes;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      throw new BadGatewayException(`AI upstream response body exceeds ${limit} bytes`);
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > limit) {
      throw new BadGatewayException(`AI upstream response body exceeds ${limit} bytes`);
    }
    return raw;
  }

  private withGatewayHeaders(headers: HeadersInit | undefined, requestId: string): Headers {
    const next = new Headers(headers || {});
    if (!next.has('x-gateway-request-id')) {
      next.set('x-gateway-request-id', requestId);
    }
    return next;
  }

  private buildGatewayRequestId(route: ResolvedAiRoute): string {
    return `gw_${route.model_key}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  }

  private assertRequestBodyWithinLimit(body: BodyInit | null | undefined, maxBytes: number): void {
    if (!body) {
      return;
    }
    let byteLength = 0;
    if (typeof body === 'string') {
      byteLength = Buffer.byteLength(body, 'utf8');
    } else if (body instanceof URLSearchParams) {
      byteLength = Buffer.byteLength(body.toString(), 'utf8');
    } else if (body instanceof Blob) {
      byteLength = body.size;
    } else if (body instanceof ArrayBuffer) {
      byteLength = body.byteLength;
    } else if (ArrayBuffer.isView(body)) {
      byteLength = body.byteLength;
    }
    if (byteLength > maxBytes) {
      throw new PayloadTooLargeException(`AI upstream request body exceeds ${maxBytes} bytes`);
    }
  }

  private redactUrl(rawUrl: string): string {
    try {
      const url = new URL(rawUrl);
      url.username = '';
      url.password = '';
      return url.toString();
    } catch {
      return rawUrl.split('?')[0] || rawUrl;
    }
  }

  private async getTuning() {
    const now = Date.now();
    if (this.tuningLoadedAt > 0 && now - this.tuningLoadedAt < 15000) {
      return this.tuning;
    }
    if (!this.tuningLoading) {
      this.tuningLoading = this.loadTuning().finally(() => {
        this.tuningLoading = null;
      });
    }
    return this.tuningLoading;
  }

  private async loadTuning(): Promise<AiUpstreamTuning> {
    const defaults = DEFAULT_AI_UPSTREAM_TUNING;
    try {
      const raw = await this.runtimeSettingsService.getAiGatewayTuning();
      this.tuning = {
        defaultHeaderTimeoutMs: this.numberValue(raw.upstream_header_timeout_ms, defaults.defaultHeaderTimeoutMs, 1000, 10 * 60 * 1000),
        streamHeaderTimeoutMs: this.numberValue(raw.upstream_stream_header_timeout_ms, defaults.streamHeaderTimeoutMs, 1000, 10 * 60 * 1000),
        requestBodyMaxBytes: this.numberValue(raw.request_body_max_bytes, defaults.requestBodyMaxBytes, 1024, 200 * 1024 * 1024),
        responseTextMaxBytes: this.numberValue(raw.response_text_max_bytes, defaults.responseTextMaxBytes, 1024, 100 * 1024 * 1024),
      };
    } catch (error: any) {
      this.logger.warn(`AI upstream tuning load failed; using defaults: ${error?.message || error}`);
      this.tuning = defaults;
    }
    this.tuningLoadedAt = Date.now();
    return this.tuning;
  }

  private numberValue(value: unknown, fallback: number, min: number, max: number) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }
}
