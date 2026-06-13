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
      }),
      catchError((error) => {
        const duration = Date.now() - now;
        const statusCode = this.resolveStatusCode(error);
        this.logRequest(method, url, statusCode, duration, ip, userAgent);
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
