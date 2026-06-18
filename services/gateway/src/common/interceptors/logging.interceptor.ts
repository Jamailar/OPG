import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  HttpException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { PlatformObservabilityService } from '../../modules/observability/platform-observability.service';
import { PlatformRequestContextService } from '../../modules/observability/platform-request-context.service';

type AccessLogMode = 'off' | 'error' | 'slow' | 'sample' | 'all';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');
  private readonly accessLogMode = this.readAccessLogMode();
  private readonly sampleRate = this.readNumber(
    ['GATEWAY_ACCESS_LOG_SAMPLE_RATE', 'AI_GATEWAY_ACCESS_LOG_SAMPLE_RATE'],
    0,
    0,
    1,
  );
  private readonly slowRequestMs = this.readNumber(
    ['GATEWAY_SLOW_REQUEST_MS', 'AI_GATEWAY_SLOW_REQUEST_MS'],
    3000,
    1,
    60 * 60 * 1000,
  );

  constructor(
    private readonly observability: PlatformObservabilityService,
    private readonly requestContext: PlatformRequestContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, ip } = request;
    const url = this.safeUrl(request.originalUrl || request.url || '');
    const userAgent = request.get('user-agent') || '';
    const now = Date.now();

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse();
        const { statusCode } = response;
        const duration = Date.now() - now;
        this.logRequest(method, url, statusCode, duration, ip, userAgent);
        this.recordRequestEvent(request, method, url, statusCode, duration, ip, userAgent);
      }),
      catchError((error) => {
        const duration = Date.now() - now;
        const statusCode = this.resolveStatusCode(error);
        this.logRequest(method, url, statusCode, duration, ip, userAgent);
        this.recordRequestEvent(request, method, url, statusCode, duration, ip, userAgent, error);
        return throwError(() => error);
      }),
    );
  }

  private logRequest(
    method: string,
    url: string,
    statusCode: number,
    duration: number,
    ip: string,
    userAgent: string,
  ): void {
    if (!this.shouldLog(url, statusCode, duration)) {
      return;
    }

    const message = `${method} ${url} ${statusCode} - ${duration}ms - ${ip} ${this.truncate(userAgent, 160)}`;
    if (statusCode >= 500) {
      this.logger.error(message);
      return;
    }
    if (statusCode >= 400 || duration >= this.slowRequestMs) {
      this.logger.warn(message);
      return;
    }
    this.logger.log(message);
  }

  private recordRequestEvent(
    request: any,
    method: string,
    url: string,
    statusCode: number,
    duration: number,
    ip: string,
    userAgent: string,
    error?: unknown,
  ): void {
    const shouldRecordRequest = this.shouldRecordEvent(url, statusCode, duration) || this.isMutationMethod(method);
    if (!shouldRecordRequest) {
      return;
    }

    const context = this.requestContext.get();
    const errorMessage = error instanceof Error ? error.message : String((error as any)?.message || '');
    const appContext = this.resolveAppContext(request, url);
    this.observability.recordRequestEventSafe({
      request_id: request?.requestId || context?.request_id || null,
      trace_id: request?.traceId || context?.trace_id || null,
      app_id: appContext.app_id,
      app_slug: appContext.app_slug,
      actor_user_id: request?.user?.id || request?.user?.userId || null,
      module: this.resolveModule(url),
      operation: `${String(method || 'GET').toUpperCase()} ${this.normalizeRoutePath(url)}`,
      stage: 'http_completed',
      method,
      request_path: this.normalizeRoutePath(url),
      success: statusCode < 400,
      status_code: statusCode,
      error_category: statusCode >= 500 ? 'server_error' : statusCode >= 400 ? 'client_error' : null,
      error_message: statusCode >= 400 ? errorMessage || null : null,
      latency_ms: duration,
      ip_address: ip,
      user_agent: userAgent,
    });
    this.recordMutationAudit(request, method, url, statusCode, duration);
  }

  private recordMutationAudit(request: any, method: string, url: string, statusCode: number, duration: number): void {
    const normalizedMethod = String(method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) {
      return;
    }
    const path = this.normalizeRoutePath(url);
    if (this.isLowSignalPath(path)) {
      return;
    }

    this.observability.recordAuditEventSafe({
      request_id: request?.requestId || this.requestContext.getRequestId(),
      actor_user_id: request?.user?.id || request?.user?.userId || null,
      ...this.resolveAppContext(request, path),
      module: this.resolveModule(path),
      action: `${normalizedMethod} ${path}`.slice(0, 96),
      resource_type: this.resolveResourceType(path),
      resource_id: this.resolveResourceId(path),
      after: this.buildAuditSnapshot(request?.body),
      metadata: {
        success: statusCode < 400,
        status_code: statusCode,
        latency_ms: duration,
        body_shape: this.resolveBodyShape(request?.body),
      },
    });
  }

  private isMutationMethod(method: string): boolean {
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
  }

  private resolveAppContext(request: any, url: string): { app_id: string | null; app_slug: string | null } {
    const userAppId = request?.user?.app_id || request?.user?.appId || null;
    const userAppSlug = request?.user?.app_slug || request?.user?.appSlug || null;
    const routeAppId = request?.params?.app_id || request?.params?.appId || null;
    const pathAppId = this.extractPlatformAppIdFromPath(url);

    return {
      app_id: routeAppId || pathAppId || userAppId || null,
      app_slug: userAppSlug || null,
    };
  }

  private extractPlatformAppIdFromPath(url: string): string | null {
    const path = this.normalizeRoutePath(url);
    const match = path.match(/^\/(?:api\/v1\/)?platform-admin\/apps\/([^/]+)/);
    if (!match?.[1]) {
      return null;
    }
    const value = decodeURIComponent(match[1]);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
  }

  private buildAuditSnapshot(value: unknown, depth = 0): unknown {
    if (value === undefined || value === null) {
      return null;
    }
    if (depth > 4) {
      return '[max-depth]';
    }
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => this.buildAuditSnapshot(item, depth + 1));
    }
    if (Buffer.isBuffer(value)) {
      return `[buffer:${value.length}]`;
    }
    if (typeof value === 'string') {
      return value.length > 512 ? `${value.slice(0, 512)}...[truncated:${value.length}]` : value;
    }
    if (typeof value !== 'object') {
      return value;
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.includes('key') ||
        normalizedKey.includes('secret') ||
        normalizedKey.includes('token') ||
        normalizedKey.includes('credential') ||
        normalizedKey.includes('password')
      ) {
        output[key] = item ? '[redacted]' : item;
      } else {
        output[key] = this.buildAuditSnapshot(item, depth + 1);
      }
    }
    return output;
  }

  private resolveBodyShape(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') {
      return {
        type: value === null || value === undefined ? 'empty' : typeof value,
      };
    }
    if (Array.isArray(value)) {
      return {
        type: 'array',
        length: value.length,
      };
    }
    return {
      type: 'object',
      keys: Object.keys(value as Record<string, unknown>).slice(0, 40),
    };
  }

  private resolveResourceType(path: string): string {
    const segments = path.split('/').filter(Boolean);
    const platformAdminIndex = segments.indexOf('platform-admin');
    if (platformAdminIndex >= 0 && segments[platformAdminIndex + 1]) {
      return segments[platformAdminIndex + 1].slice(0, 64);
    }
    const versionIndex = segments.indexOf('v1');
    if (versionIndex >= 0 && segments[versionIndex + 1]) {
      return segments[versionIndex + 1].slice(0, 64);
    }
    return (segments[0] || 'http').slice(0, 64);
  }

  private resolveResourceId(path: string): string | null {
    const match = path.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i);
    return match?.[1] || null;
  }

  private shouldRecordEvent(url: string, statusCode: number, duration: number): boolean {
    if (this.isLowSignalPath(url)) {
      return statusCode >= 500 || duration >= this.slowRequestMs;
    }
    if (statusCode >= 400 || duration >= this.slowRequestMs) {
      return true;
    }
    if (this.accessLogMode === 'all') {
      return true;
    }
    if (this.accessLogMode === 'sample') {
      return this.sampleRate > 0 && Math.random() < this.sampleRate;
    }
    return false;
  }

  private resolveModule(url: string): string {
    const path = this.normalizeRoutePath(url);
    const platformMatch = path.match(/^\/(?:api\/v1\/)?platform-admin\/([^/?]+)/);
    if (platformMatch?.[1]) {
      return `platform.${platformMatch[1]}`.slice(0, 64);
    }
    const tenantMatch = path.match(/^\/(?:api\/v1\/)?([^/]+)\/v1\/([^/?]+)/);
    if (tenantMatch?.[2]) {
      return tenantMatch[2].slice(0, 64);
    }
    const firstSegment = path.split('/').filter(Boolean)[0] || 'http';
    return firstSegment.slice(0, 64);
  }

  private normalizeRoutePath(url: string): string {
    return (url.split('?')[0] || '/').slice(0, 255);
  }

  private shouldLog(url: string, statusCode: number, duration: number): boolean {
    if (this.accessLogMode === 'off') {
      return false;
    }
    if (statusCode >= 500) {
      return true;
    }
    if (duration >= this.slowRequestMs) {
      return true;
    }
    if (this.accessLogMode === 'error') {
      return false;
    }
    if (this.accessLogMode === 'slow') {
      return false;
    }
    if (this.isLowSignalPath(url) && this.accessLogMode !== 'all') {
      return false;
    }
    if (this.accessLogMode === 'sample') {
      return this.sampleRate > 0 && Math.random() < this.sampleRate;
    }
    return this.accessLogMode === 'all';
  }

  private isLowSignalPath(url: string): boolean {
    const path = url.split('?')[0] || '/';
    return path === '/'
      || path === '/health'
      || path === '/healthz'
      || path === '/api/v1/health'
      || path === '/readyz'
      || path === '/api/v1/readyz'
      || path === '/api/docs'
      || path.startsWith('/socket.io')
      || path.endsWith('/socket.io');
  }

  private resolveStatusCode(error: unknown): number {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    const maybeStatus = Number((error as any)?.status || (error as any)?.statusCode || 500);
    return Number.isFinite(maybeStatus) ? maybeStatus : 500;
  }

  private safeUrl(rawUrl: string): string {
    try {
      const url = new URL(rawUrl || '/', 'http://gateway.local');
      for (const key of Array.from(url.searchParams.keys())) {
        if (this.isSensitiveQueryKey(key)) {
          url.searchParams.set(key, '[redacted]');
        }
      }
      return `${url.pathname}${url.search}`;
    } catch {
      return String(rawUrl || '').split('?')[0] || '/';
    }
  }

  private isSensitiveQueryKey(key: string): boolean {
    return ['token', 'access_token', 'refresh_token', 'api_key', 'key', 'secret', 'password', 'code'].includes(
      key.toLowerCase(),
    );
  }

  private readAccessLogMode(): AccessLogMode {
    const raw = String(process.env.GATEWAY_ACCESS_LOG || process.env.AI_GATEWAY_ACCESS_LOG || '').trim().toLowerCase();
    if (['off', 'error', 'slow', 'sample', 'all'].includes(raw)) {
      return raw as AccessLogMode;
    }
    return process.env.NODE_ENV === 'production' ? 'error' : 'all';
  }

  private readNumber(names: string[], fallback: number, min: number, max: number): number {
    for (const name of names) {
      const raw = String(process.env[name] || '').trim();
      if (!raw) {
        continue;
      }
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return Math.min(max, Math.max(min, parsed));
      }
    }
    return fallback;
  }

  private truncate(value: string, maxLength: number): string {
    const text = String(value || '');
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}...`;
  }
}
