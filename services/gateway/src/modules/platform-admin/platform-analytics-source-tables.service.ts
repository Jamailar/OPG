import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import type { AnalyticsTables } from './platform-analytics.types';

const ANALYTICS_TABLES_CACHE_TTL_MS = 60_000;

@Injectable()
export class PlatformAnalyticsSourceTablesService {
  private availabilityCache: { value: AnalyticsTables; expiresAt: number } | null = null;

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async resolveAvailability(): Promise<AnalyticsTables> {
    const now = Date.now();
    if (this.availabilityCache && this.availabilityCache.expiresAt > now) {
      return this.availabilityCache.value;
    }
    const [orders, agreements, deductions, behaviorEvents, aiUsageLogs, pointsWallets, pointsLedger] = await Promise.all([
      this.isTableAvailable('alipay_orders'),
      this.isTableAvailable('alipay_agreements'),
      this.isTableAvailable('alipay_deductions'),
      this.isTableAvailable('user_behavior_events'),
      this.isTableAvailable('ai_usage_logs'),
      this.isTableAvailable('user_ai_points_wallets'),
      this.isTableAvailable('user_ai_points_ledger'),
    ]);
    const value = {
      orders,
      agreements,
      deductions,
      behavior_events: behaviorEvents,
      ai_usage_logs: aiUsageLogs,
      points_wallets: pointsWallets,
      points_ledger: pointsLedger,
    };
    this.availabilityCache = {
      value,
      expiresAt: now + ANALYTICS_TABLES_CACHE_TTL_MS,
    };
    return value;
  }

  private async isTableAvailable(tableName: string): Promise<boolean> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT to_regclass($1)::text AS table_ref`,
      `public.${tableName}`,
    ) as Promise<Array<{ table_ref: string | null }>>);
    return !!rows[0]?.table_ref;
  }
}
