import { createHash } from 'crypto';
import { BadGatewayException, HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ResolvedAiRoute } from './ai-routing.service';
import { AiGatewayErrorClassifierService } from './ai-gateway-error-classifier.service';
import { RuntimeSettingsService } from '../runtime-settings/runtime-settings.service';
import { AiGatewayObservabilityService } from './ai-gateway-observability.service';

type ActiveCounter = {
  active: number;
};

type FixedWindowCounter = {
  windowStartedAt: number;
  count: number;
};

type SourceHealth = {
  consecutiveFailures: number;
  cooldownUntil: number;
  lastFailureMessage: string;
  lastFailureCategory: string;
  lastStatus: number | null;
};

export type AiGatewayRelease = () => void;

type AiGatewayThrottleTuning = {
  redisLimitsEnabled: boolean;
  redisPrefix: string;
  maxSourceConcurrency: number;
  maxUserConcurrency: number;
  maxApiKeyConcurrency: number;
  maxAccountConcurrency: number;
  sourceRpm: number;
  userRpm: number;
  apiKeyRpm: number;
  accountRpm: number;
  cooldownFailureThreshold: number;
  cooldownMs: number;
  failOpen: boolean;
};
const DEFAULT_AI_GATEWAY_THROTTLE_TUNING: AiGatewayThrottleTuning = {
  redisLimitsEnabled: false,
  redisPrefix: 'ai-gateway',
  maxSourceConcurrency: 128,
  maxUserConcurrency: 16,
  maxApiKeyConcurrency: 0,
  maxAccountConcurrency: 0,
  sourceRpm: 0,
  userRpm: 0,
  apiKeyRpm: 0,
  accountRpm: 0,
  cooldownFailureThreshold: 3,
  cooldownMs: 10000,
  failOpen: false,
};

@Injectable()
export class AiGatewayThrottleService implements OnModuleDestroy {
  private readonly logger = new Logger(AiGatewayThrottleService.name);
  private readonly activeCounters = new Map<string, ActiveCounter>();
  private readonly rpmCounters = new Map<string, FixedWindowCounter>();
  private readonly sourceHealth = new Map<string, SourceHealth>();
  private redis: Redis | null = null;
  private redisUnavailableLogged = false;
  private tuning = DEFAULT_AI_GATEWAY_THROTTLE_TUNING;
  private tuningLoadedAt = 0;
  private tuningLoading: Promise<AiGatewayThrottleTuning> | null = null;

  constructor(
    private readonly errorClassifier: AiGatewayErrorClassifierService,
    private readonly runtimeSettingsService: RuntimeSettingsService,
    private readonly observability: AiGatewayObservabilityService,
  ) {}

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit().catch(() => undefined);
      this.redis = null;
    }
  }

  async acquire(route: ResolvedAiRoute, context: { user_id?: string | null } = {}): Promise<AiGatewayRelease> {
    const tuning = await this.getTuning();
    const keys = this.buildLimitKeys(route, context.user_id || null);
    try {
      this.assertSourceNotCoolingDown(route, tuning);
      if (tuning.redisLimitsEnabled) {
        return await this.acquireRedis(keys, tuning);
      }
      this.acquireMemory(keys, tuning);
    } catch (error) {
      if (!tuning.failOpen) {
        throw error;
      }
      this.logger.warn(`AI gateway throttle fail-open: ${(error as any)?.message || 'unknown error'}`);
      return () => undefined;
    }

    return this.buildMemoryRelease(keys);
  }

  recordSuccess(route: ResolvedAiRoute): void {
    this.sourceHealth.delete(this.sourceKey(route));
    this.observability.recordRouteHealthSafe({
      route,
      success: true,
    });
  }

  recordFailure(route: ResolvedAiRoute, status?: number | null, message?: string | null): void {
    if (!this.errorClassifier.shouldCooldown({ status, message })) {
      return;
    }
    const key = this.sourceKey(route);
    const current = this.sourceHealth.get(key) || {
      consecutiveFailures: 0,
      cooldownUntil: 0,
      lastFailureMessage: '',
      lastFailureCategory: 'unknown',
      lastStatus: null,
    };
    const category = this.errorClassifier.classify({ status, message });
    current.consecutiveFailures += 1;
    current.lastFailureMessage = String(message || '').slice(0, 500);
    current.lastFailureCategory = category;
    current.lastStatus = status ?? null;
    const tuning = this.tuning;
    if (tuning.cooldownMs > 0 && current.consecutiveFailures >= tuning.cooldownFailureThreshold) {
      current.cooldownUntil = Date.now() + tuning.cooldownMs;
      this.logger.warn(
        `AI source cooldown source=${route.source.name} model=${route.model_key} status=${status || '-'} failures=${current.consecutiveFailures} cooldown_ms=${tuning.cooldownMs}`,
      );
    }
    this.sourceHealth.set(key, current);
    this.observability.recordRouteHealthSafe({
      route,
      success: false,
      status_code: status ?? null,
      error_message: message || null,
      cooldown_until: current.cooldownUntil > Date.now() ? new Date(current.cooldownUntil) : null,
    });
  }

  getStats() {
    const now = Date.now();
    const tuning = this.tuning;
    return {
      max_source_concurrency: tuning.maxSourceConcurrency,
      max_user_concurrency: tuning.maxUserConcurrency,
      max_api_key_concurrency: tuning.maxApiKeyConcurrency,
      max_account_concurrency: tuning.maxAccountConcurrency,
      source_rpm: tuning.sourceRpm,
      user_rpm: tuning.userRpm,
      api_key_rpm: tuning.apiKeyRpm,
      account_rpm: tuning.accountRpm,
      fail_open: tuning.failOpen,
      backend: tuning.redisLimitsEnabled ? 'redis' : 'memory',
      redis_available: tuning.redisLimitsEnabled ? !!this.redis : false,
      active: Array.from(this.activeCounters.entries()).map(([key, value]) => ({ key, active: value.active })),
      cooldowns: Array.from(this.sourceHealth.entries())
        .filter(([, value]) => value.cooldownUntil > now)
        .map(([key, value]) => ({
          key,
          cooldown_until: new Date(value.cooldownUntil).toISOString(),
          consecutive_failures: value.consecutiveFailures,
          last_status: value.lastStatus,
          last_failure_category: value.lastFailureCategory,
          last_failure_message: value.lastFailureMessage,
        })),
    };
  }

  private buildLimitKeys(route: ResolvedAiRoute, userId: string | null) {
    const source = this.sourceKey(route);
    const user = userId ? `${source}:user:${userId}` : '';
    const apiKey = route.source.api_key ? `apikey:${this.hashLimitSegment(route.source.api_key)}` : '';
    const account = `account:${route.source.id}`;
    return {
      sourceConcurrencyKey: `${source}:concurrency`,
      userConcurrencyKey: user ? `${user}:concurrency` : '',
      apiKeyConcurrencyKey: apiKey ? `${apiKey}:concurrency` : '',
      accountConcurrencyKey: `${account}:concurrency`,
      sourceRpmKey: `${source}:rpm`,
      userRpmKey: user ? `${user}:rpm` : '',
      apiKeyRpmKey: apiKey ? `${apiKey}:rpm` : '',
      accountRpmKey: `${account}:rpm`,
    };
  }

  private sourceKey(route: ResolvedAiRoute): string {
    return `source:${route.source.id}:model:${route.model_id}:capability:${route.capability}`;
  }

  private assertSourceNotCoolingDown(route: ResolvedAiRoute, tuning: AiGatewayThrottleTuning): void {
    const health = this.sourceHealth.get(this.sourceKey(route));
    if (!health || health.cooldownUntil <= Date.now()) {
      return;
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((health.cooldownUntil - Date.now()) / 1000));
    throw new BadGatewayException(
      `AI source is cooling down after upstream failures; retry after ${retryAfterSeconds}s`,
    );
  }

  private acquireMemory(keys: ReturnType<AiGatewayThrottleService['buildLimitKeys']>, tuning: AiGatewayThrottleTuning) {
    this.assertFixedWindow(keys.sourceRpmKey, tuning.sourceRpm, 'source');
    this.assertFixedWindow(keys.userRpmKey, tuning.userRpm, 'user');
    this.assertFixedWindow(keys.apiKeyRpmKey, tuning.apiKeyRpm, 'api key');
    this.assertFixedWindow(keys.accountRpmKey, tuning.accountRpm, 'account');
    this.incrementActive(keys.sourceConcurrencyKey, tuning.maxSourceConcurrency, 'source');
    this.incrementActive(keys.userConcurrencyKey, tuning.maxUserConcurrency, 'user');
    this.incrementActive(keys.apiKeyConcurrencyKey, tuning.maxApiKeyConcurrency, 'api key');
    this.incrementActive(keys.accountConcurrencyKey, tuning.maxAccountConcurrency, 'account');
  }

  private buildMemoryRelease(keys: ReturnType<AiGatewayThrottleService['buildLimitKeys']>): AiGatewayRelease {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.decrementActive(keys.sourceConcurrencyKey);
      this.decrementActive(keys.userConcurrencyKey);
      this.decrementActive(keys.apiKeyConcurrencyKey);
      this.decrementActive(keys.accountConcurrencyKey);
    };
  }

  private assertFixedWindow(key: string, limit: number, label: string): void {
    if (!key || limit <= 0) {
      return;
    }
    const now = Date.now();
    const windowMs = 60_000;
    const current = this.rpmCounters.get(key);
    const counter = current && current.windowStartedAt + windowMs > now
      ? current
      : { windowStartedAt: now, count: 0 };
    counter.count += 1;
    this.rpmCounters.set(key, counter);
    if (counter.count > limit) {
      throw new HttpException(`AI gateway ${label} rate limit exceeded`, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private incrementActive(key: string, limit: number, label: string): void {
    if (!key || limit <= 0) {
      return;
    }
    const counter = this.activeCounters.get(key) || { active: 0 };
    if (counter.active >= limit) {
      throw new HttpException(`AI gateway ${label} concurrency limit exceeded`, HttpStatus.TOO_MANY_REQUESTS);
    }
    counter.active += 1;
    this.activeCounters.set(key, counter);
  }

  private decrementActive(key: string): void {
    const counter = this.activeCounters.get(key);
    if (!counter) {
      return;
    }
    counter.active -= 1;
    if (counter.active <= 0) {
      this.activeCounters.delete(key);
    } else {
      this.activeCounters.set(key, counter);
    }
  }

  private shouldCooldownForFailure(status?: number | null, message?: string | null): boolean {
    return this.errorClassifier.shouldCooldown({ status, message });
  }

  private async acquireRedis(
    keys: ReturnType<AiGatewayThrottleService['buildLimitKeys']>,
    tuning: AiGatewayThrottleTuning,
  ): Promise<AiGatewayRelease> {
    const redis = this.getRedis(tuning);
    if (!redis) {
      this.acquireMemory(keys, tuning);
      return this.buildMemoryRelease(keys);
    }

    const redisKeys = [
      keys.sourceConcurrencyKey,
      keys.userConcurrencyKey,
      keys.apiKeyConcurrencyKey,
      keys.accountConcurrencyKey,
      keys.sourceRpmKey,
      keys.userRpmKey,
      keys.apiKeyRpmKey,
      keys.accountRpmKey,
    ].map((key) => this.redisKey(key || 'disabled', tuning));
    const result = await redis.eval(
      this.acquireRedisLua(),
      redisKeys.length,
      ...redisKeys,
      tuning.maxSourceConcurrency,
      tuning.maxUserConcurrency,
      tuning.maxApiKeyConcurrency,
      tuning.maxAccountConcurrency,
      tuning.sourceRpm,
      tuning.userRpm,
      tuning.apiKeyRpm,
      tuning.accountRpm,
      60_000,
      10 * 60_000,
    ) as [number, string];

    if (Array.isArray(result) && Number(result[0]) === 1) {
      return this.buildRedisRelease(keys);
    }

    const reason = Array.isArray(result) ? String(result[1] || 'limit exceeded') : 'limit exceeded';
    throw new HttpException(`AI gateway ${reason}`, HttpStatus.TOO_MANY_REQUESTS);
  }

  private buildRedisRelease(keys: ReturnType<AiGatewayThrottleService['buildLimitKeys']>): AiGatewayRelease {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const redis = this.getRedis(this.tuning);
      if (!redis) {
        return;
      }
      void redis.eval(
        this.releaseRedisLua(),
        4,
        this.redisKey(keys.sourceConcurrencyKey, this.tuning),
        this.redisKey(keys.userConcurrencyKey || 'disabled', this.tuning),
        this.redisKey(keys.apiKeyConcurrencyKey || 'disabled', this.tuning),
        this.redisKey(keys.accountConcurrencyKey || 'disabled', this.tuning),
      ).catch((error: any) => {
        this.logger.warn(`AI gateway redis release failed: ${error?.message || error}`);
      });
    };
  }

  private getRedis(tuning: AiGatewayThrottleTuning): Redis | null {
    if (!tuning.redisLimitsEnabled) {
      return null;
    }
    if (this.redis) {
      return this.redis;
    }
    try {
      const url = String(process.env.REDIS_URL || 'redis://localhost:6379/0').trim();
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 1,
      });
      this.redis.on('error', (error) => {
        if (!this.redisUnavailableLogged) {
          this.redisUnavailableLogged = true;
          this.logger.warn(`AI gateway redis unavailable; throttle will fail${tuning.failOpen ? '-open' : ''}: ${error?.message || error}`);
        }
      });
      return this.redis;
    } catch (error: any) {
      this.logger.warn(`AI gateway redis init failed: ${error?.message || error}`);
      return null;
    }
  }

  private redisKey(key: string, tuning: AiGatewayThrottleTuning): string {
    return `${tuning.redisPrefix}:${key}`;
  }

  private hashLimitSegment(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  private acquireRedisLua(): string {
    return `
      local activeKeys = {KEYS[1], KEYS[2], KEYS[3], KEYS[4]}
      local rpmKeys = {KEYS[5], KEYS[6], KEYS[7], KEYS[8]}
      local activeLimits = {tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])}
      local rpmLimits = {tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7]), tonumber(ARGV[8])}
      local windowMs = tonumber(ARGV[9])
      local activeTtlMs = tonumber(ARGV[10])
      local labels = {'source', 'user', 'api key', 'account'}

      for i = 1, 4 do
        if rpmLimits[i] and rpmLimits[i] > 0 and string.find(rpmKeys[i], ':disabled$') == nil then
          local nextCount = redis.call('INCR', rpmKeys[i])
          if nextCount == 1 then
            redis.call('PEXPIRE', rpmKeys[i], windowMs)
          end
          if nextCount > rpmLimits[i] then
            return {0, labels[i] .. ' rate limit exceeded'}
          end
        end
      end

      for i = 1, 4 do
        if activeLimits[i] and activeLimits[i] > 0 and string.find(activeKeys[i], ':disabled$') == nil then
          local current = tonumber(redis.call('GET', activeKeys[i]) or '0')
          if current >= activeLimits[i] then
            return {0, labels[i] .. ' concurrency limit exceeded'}
          end
        end
      end

      for i = 1, 4 do
        if activeLimits[i] and activeLimits[i] > 0 and string.find(activeKeys[i], ':disabled$') == nil then
          redis.call('INCR', activeKeys[i])
          redis.call('PEXPIRE', activeKeys[i], activeTtlMs)
        end
      end

      return {1, 'ok'}
    `;
  }

  private releaseRedisLua(): string {
    return `
      for i = 1, #KEYS do
        if string.find(KEYS[i], ':disabled$') == nil then
          local current = tonumber(redis.call('GET', KEYS[i]) or '0')
          if current > 1 then
            redis.call('DECR', KEYS[i])
          elseif current == 1 then
            redis.call('DEL', KEYS[i])
          end
        end
      end
      return 1
    `;
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

  private async loadTuning(): Promise<AiGatewayThrottleTuning> {
    const defaults = DEFAULT_AI_GATEWAY_THROTTLE_TUNING;
    try {
      const raw = await this.runtimeSettingsService.getAiGatewayTuning();
      this.tuning = {
        redisLimitsEnabled: this.booleanValue(raw.redis_limits_enabled, defaults.redisLimitsEnabled),
        redisPrefix: String(raw.redis_prefix || defaults.redisPrefix).trim() || 'ai-gateway',
        maxSourceConcurrency: this.numberValue(raw.max_source_concurrency, defaults.maxSourceConcurrency, 0, 10000),
        maxUserConcurrency: this.numberValue(raw.max_user_concurrency, defaults.maxUserConcurrency, 0, 10000),
        maxApiKeyConcurrency: this.numberValue(raw.max_api_key_concurrency, defaults.maxApiKeyConcurrency, 0, 10000),
        maxAccountConcurrency: this.numberValue(raw.max_account_concurrency, defaults.maxAccountConcurrency, 0, 10000),
        sourceRpm: this.numberValue(raw.source_rpm, defaults.sourceRpm, 0, 1000000),
        userRpm: this.numberValue(raw.user_rpm, defaults.userRpm, 0, 1000000),
        apiKeyRpm: this.numberValue(raw.api_key_rpm, defaults.apiKeyRpm, 0, 1000000),
        accountRpm: this.numberValue(raw.account_rpm, defaults.accountRpm, 0, 1000000),
        cooldownFailureThreshold: this.numberValue(raw.cooldown_failure_threshold, defaults.cooldownFailureThreshold, 1, 1000),
        cooldownMs: this.numberValue(raw.cooldown_ms, defaults.cooldownMs, 0, 60 * 60 * 1000),
        failOpen: this.booleanValue(raw.throttle_fail_open, defaults.failOpen),
      };
    } catch (error: any) {
      this.logger.warn(`AI gateway tuning load failed; using defaults: ${error?.message || error}`);
      this.tuning = defaults;
    }
    this.tuningLoadedAt = Date.now();
    return this.tuning;
  }

  private booleanValue(value: unknown, fallback: boolean) {
    if (value === undefined || value === null || value === '') return fallback;
    return value === true || String(value).trim() === '1' || String(value).trim().toLowerCase() === 'true';
  }

  private numberValue(value: unknown, fallback: number, min: number, max: number) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }
}
