import { Injectable } from '@nestjs/common';

type AnalyticsResponseCacheQuery = {
  from: Date;
  to: Date;
  timezone: string;
  granularity: string;
  page: number;
  pageSize: number;
  segment?: string;
  createdScope?: string;
  lastLoginScope?: string;
  membershipType?: string;
  loginMethod?: string;
  source?: string;
  paidStatus?: string;
  accountStatus?: string;
  sortBy?: string;
  sortOrder?: string;
};

const ANALYTICS_RESPONSE_CACHE_TTL_MS = 60_000;

@Injectable()
export class PlatformAnalyticsResponseCacheService {
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();

  clear() {
    this.cache.clear();
  }

  async withCache<T>(
    scope: string,
    appId: string,
    query: AnalyticsResponseCacheQuery,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cacheKey = this.buildCacheKey(scope, appId, query);
    const cached = this.get<T>(cacheKey);
    if (cached) {
      return cached;
    }
    const result = await loader();
    this.set(cacheKey, result);
    return result;
  }

  private buildCacheKey(scope: string, appId: string, query: AnalyticsResponseCacheQuery) {
    return JSON.stringify({
      scope,
      appId,
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      timezone: query.timezone,
      granularity: query.granularity,
      page: query.page,
      pageSize: query.pageSize,
      segment: query.segment || '',
      createdScope: query.createdScope || '',
      lastLoginScope: query.lastLoginScope || '',
      membershipType: query.membershipType || '',
      loginMethod: query.loginMethod || '',
      source: query.source || '',
      paidStatus: query.paidStatus || '',
      accountStatus: query.accountStatus || '',
      sortBy: query.sortBy || '',
      sortOrder: query.sortOrder || '',
    });
  }

  private get<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return cached.value as T;
  }

  private set<T>(key: string, value: T) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ANALYTICS_RESPONSE_CACHE_TTL_MS,
    });
  }
}
