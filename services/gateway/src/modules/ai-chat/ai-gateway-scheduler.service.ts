import { Injectable } from '@nestjs/common';
import { ResolvedAiRoute } from './ai-routing.service';
import { RuntimeSettingsService } from '../runtime-settings/runtime-settings.service';

type StickyEntry = {
  sourceId: string;
  expiresAt: number;
};

type SchedulerInvokeOptions<T> = {
  payload?: Record<string, unknown>;
  context?: Record<string, unknown>;
  fixedFirstRouteKey?: string;
  shouldTryNext: (error: unknown) => boolean;
  invoke: (route: ResolvedAiRoute) => Promise<T>;
  onRetry?: (route: ResolvedAiRoute, nextIndex: number, error: unknown) => void;
};
const DEFAULT_STICKY_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class AiGatewaySchedulerService {
  private readonly stickySelections = new Map<string, StickyEntry>();
  private stickyTtlMs = DEFAULT_STICKY_TTL_MS;
  private tuningLoadedAt = 0;
  private tuningLoading: Promise<number> | null = null;

  constructor(private readonly runtimeSettingsService: RuntimeSettingsService) {}

  async invokeCandidates<T>(routes: ResolvedAiRoute[], options: SchedulerInvokeOptions<T>): Promise<T> {
    const stickyTtlMs = await this.getStickyTtlMs();
    const orderedRoutes = this.orderRoutes(routes, options.payload || {}, options.context || {}, stickyTtlMs, options.fixedFirstRouteKey);
    let firstError: unknown = null;
    let lastError: unknown = null;
    const stickyKey = this.resolveStickyKey(orderedRoutes[0], options.payload || {}, options.context || {}, stickyTtlMs);

    for (let index = 0; index < orderedRoutes.length; index += 1) {
      const route = orderedRoutes[index];
      try {
        const result = await options.invoke(route);
        if (stickyKey) {
          this.rememberStickyRoute(stickyKey, route, stickyTtlMs);
        }
        return result;
      } catch (error) {
        firstError ||= error;
        lastError = error;
        if (!options.shouldTryNext(error) || index >= orderedRoutes.length - 1) {
          throw error;
        }
        options.onRetry?.(route, index + 1, error);
      }
    }

    throw lastError || firstError || new Error('AI route candidates exhausted');
  }

  getStats() {
    const now = Date.now();
    let activeStickySessions = 0;
    for (const [key, value] of this.stickySelections.entries()) {
      if (value.expiresAt <= now) {
        this.stickySelections.delete(key);
      } else {
        activeStickySessions += 1;
      }
    }
    return {
      sticky_ttl_ms: this.stickyTtlMs,
      active_sticky_sessions: activeStickySessions,
    };
  }

  private orderRoutes(
    routes: ResolvedAiRoute[],
    payload: Record<string, unknown>,
    context: Record<string, unknown>,
    stickyTtlMs: number,
    fixedFirstRouteKey?: string,
  ): ResolvedAiRoute[] {
    if (routes.length <= 1 || stickyTtlMs <= 0) {
      return routes;
    }
    if (fixedFirstRouteKey && routes[0]?.route_key === fixedFirstRouteKey) {
      return routes;
    }
    const stickyKey = this.resolveStickyKey(routes[0], payload, context, stickyTtlMs);
    if (!stickyKey) {
      return routes;
    }
    const sticky = this.stickySelections.get(stickyKey);
    if (!sticky || sticky.expiresAt <= Date.now()) {
      this.stickySelections.delete(stickyKey);
      return routes;
    }
    const stickyIndex = routes.findIndex((route) => route.source.id === sticky.sourceId);
    if (stickyIndex <= 0) {
      return routes;
    }
    return [routes[stickyIndex], ...routes.slice(0, stickyIndex), ...routes.slice(stickyIndex + 1)];
  }

  private rememberStickyRoute(stickyKey: string, route: ResolvedAiRoute, stickyTtlMs: number) {
    if (stickyTtlMs <= 0) {
      return;
    }
    this.stickySelections.set(stickyKey, {
      sourceId: route.source.id,
      expiresAt: Date.now() + stickyTtlMs,
    });
  }

  private resolveStickyKey(
    route: ResolvedAiRoute | undefined,
    payload: Record<string, unknown>,
    context: Record<string, unknown>,
    stickyTtlMs: number,
  ): string {
    if (!route || stickyTtlMs <= 0) {
      return '';
    }
    const explicit = this.stringOrUndefined(
      payload.sticky_key,
      payload.conversation_id,
      payload.thread_id,
      payload.session_id,
      payload.previous_response_id,
      context.sticky_key,
    );
    if (!explicit) {
      return '';
    }
    return [
      route.app_id,
      route.capability,
      route.model_id,
      explicit,
    ].join(':');
  }

  private stringOrUndefined(...values: unknown[]): string {
    for (const value of values) {
      const normalized = String(value || '').trim();
      if (normalized) {
        return normalized;
      }
    }
    return '';
  }

  private async getStickyTtlMs() {
    const now = Date.now();
    if (this.tuningLoadedAt > 0 && now - this.tuningLoadedAt < 15000) {
      return this.stickyTtlMs;
    }
    if (!this.tuningLoading) {
      this.tuningLoading = this.loadStickyTtlMs().finally(() => {
        this.tuningLoading = null;
      });
    }
    return this.tuningLoading;
  }

  private async loadStickyTtlMs() {
    try {
      const tuning = await this.runtimeSettingsService.getAiGatewayTuning();
      this.stickyTtlMs = this.numberValue(tuning.sticky_ttl_ms, DEFAULT_STICKY_TTL_MS, 0, 24 * 60 * 60 * 1000);
    } catch {
      this.stickyTtlMs = DEFAULT_STICKY_TTL_MS;
    }
    this.tuningLoadedAt = Date.now();
    return this.stickyTtlMs;
  }

  private numberValue(value: unknown, fallback: number, min: number, max: number) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }
}
