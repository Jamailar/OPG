import { Injectable } from '@nestjs/common';

export type AiGatewayErrorCategory =
  | 'auth_error'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'model_not_found'
  | 'upstream_timeout'
  | 'client_cancelled'
  | 'upstream_error'
  | 'request_error'
  | 'unknown';

@Injectable()
export class AiGatewayErrorClassifierService {
  classify(input: { status?: number | null; message?: string | null }): AiGatewayErrorCategory {
    const status = Number(input.status || 0);
    const message = String(input.message || '').toLowerCase();

    if (status === 499 || message.includes('client closed') || message.includes('client_cancelled')) {
      return 'client_cancelled';
    }
    if (status === 401 || status === 403 || message.includes('invalid api key') || message.includes('unauthorized')) {
      return 'auth_error';
    }
    if (status === 408 || status === 504 || message.includes('timeout') || message.includes('aborted') || message.includes('econnreset')) {
      return 'upstream_timeout';
    }
    if (status === 429) {
      if (message.includes('quota') || message.includes('insufficient') || message.includes('billing')) {
        return 'quota_exceeded';
      }
      return 'rate_limited';
    }
    if (status === 404 && (message.includes('model') || message.includes('not found'))) {
      return 'model_not_found';
    }
    if (status >= 500 && status <= 599) {
      return 'upstream_error';
    }
    if (status >= 400 && status <= 499) {
      return 'request_error';
    }
    if (message.includes('bad gateway') || message.includes('upstream')) {
      return 'upstream_error';
    }
    return 'unknown';
  }

  shouldCooldown(input: { status?: number | null; message?: string | null }): boolean {
    const category = this.classify(input);
    return category === 'rate_limited'
      || category === 'quota_exceeded'
      || category === 'upstream_timeout'
      || category === 'upstream_error';
  }

  shouldTryNextRoute(input: { status?: number | null; message?: string | null }): boolean {
    const category = this.classify(input);
    return category === 'rate_limited'
      || category === 'quota_exceeded'
      || category === 'upstream_timeout'
      || category === 'upstream_error';
  }
}
