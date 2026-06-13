import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import type {
  AnalyticsFactStatus,
  AnalyticsFactsMaterializedState,
  AnalyticsFactsReadState,
  AnalyticsTables,
  ResolvedAnalyticsQuery,
} from './platform-analytics.types';

const ANALYTICS_FACTS_REFRESH_TTL_MS = 5 * 60_000;

@Injectable()
export class PlatformAnalyticsFactsReadStateService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  hasMaterializedFacts(counts: AnalyticsFactsMaterializedState['counts']) {
    return counts.daily > 0 || counts.cohort > 0 || counts.conversion > 0 || counts.segments > 0;
  }

  shouldRefreshFacts(state: Pick<AnalyticsFactsMaterializedState, 'counts' | 'refreshedAt'>) {
    if (!this.hasMaterializedFacts(state.counts)) {
      return true;
    }
    if (!state.refreshedAt) {
      return true;
    }
    return Date.now() - state.refreshedAt.getTime() >= ANALYTICS_FACTS_REFRESH_TTL_MS;
  }

  buildReadState(state: AnalyticsFactsMaterializedState, refreshInProgress: boolean): AnalyticsFactsReadState {
    const status = refreshInProgress ? this.withRefreshingStatus(state.status, state.counts) : state.status;
    return {
      status,
      meta: {
        refreshed_at: state.refreshedAt ? state.refreshedAt.toISOString() : null,
        is_stale: this.shouldRefreshFacts(state),
        refresh_in_progress: refreshInProgress,
      },
    };
  }

  async getState(
    appId: string,
    query: ResolvedAnalyticsQuery,
    tables: AnalyticsTables,
  ): Promise<AnalyticsFactsMaterializedState> {
    const fromDate = this.toDateOnly(query.from);
    const toDate = this.toDateOnly(query.to);
    const snapshotDate = this.toDateOnly(query.to);
    const [dailyCountRows, cohortCountRows, conversionCountRows, segmentCountRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count, MAX(updated_at) AS refreshed_at
         FROM app_user_daily_facts
         WHERE app_id = $1::uuid AND timezone = $2::text AND fact_day >= $3::date AND fact_day <= $4::date`,
        appId,
        query.timezone,
        fromDate,
        toDate,
      ) as Promise<Array<{ count: unknown; refreshed_at: unknown }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count, MAX(updated_at) AS refreshed_at
         FROM app_user_cohort_facts
         WHERE app_id = $1::uuid AND timezone = $2::text AND cohort_day >= $3::date AND cohort_day <= $4::date`,
        appId,
        query.timezone,
        fromDate,
        toDate,
      ) as Promise<Array<{ count: unknown; refreshed_at: unknown }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count, MAX(updated_at) AS refreshed_at
         FROM app_user_conversion_facts
         WHERE app_id = $1::uuid AND timezone = $2::text AND fact_day >= $3::date AND fact_day <= $4::date`,
        appId,
        query.timezone,
        fromDate,
        toDate,
      ) as Promise<Array<{ count: unknown; refreshed_at: unknown }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count, MAX(updated_at) AS refreshed_at
         FROM app_user_segment_snapshots
         WHERE app_id = $1::uuid AND timezone = $2::text AND snapshot_day = $3::date`,
        appId,
        query.timezone,
        snapshotDate,
      ) as Promise<Array<{ count: unknown; refreshed_at: unknown }>>),
    ]);

    const counts = {
      daily: this.toInt(dailyCountRows[0]?.count),
      cohort: this.toInt(cohortCountRows[0]?.count),
      conversion: this.toInt(conversionCountRows[0]?.count),
      segments: this.toInt(segmentCountRows[0]?.count),
    };
    const refreshedAt = this.minDate([
      this.toNullableDate(dailyCountRows[0]?.refreshed_at),
      this.toNullableDate(cohortCountRows[0]?.refreshed_at),
      this.toNullableDate(conversionCountRows[0]?.refreshed_at),
      this.toNullableDate(segmentCountRows[0]?.refreshed_at),
    ]);
    return {
      counts,
      refreshedAt,
      status: {
        daily: this.resolveFactStatus(counts.daily, tables.behavior_events || tables.orders || tables.ai_usage_logs),
        cohort: this.resolveFactStatus(counts.cohort, true),
        conversion: this.resolveFactStatus(counts.conversion, true),
        segments: this.resolveFactStatus(counts.segments, true),
      },
    };
  }

  private withRefreshingStatus(
    status: AnalyticsFactStatus,
    counts: AnalyticsFactsMaterializedState['counts'],
  ): AnalyticsFactStatus {
    return {
      daily: counts.daily > 0 || status.daily === 'missing_source' ? status.daily : 'initializing',
      cohort: counts.cohort > 0 || status.cohort === 'missing_source' ? status.cohort : 'initializing',
      conversion: counts.conversion > 0 || status.conversion === 'missing_source' ? status.conversion : 'initializing',
      segments: counts.segments > 0 || status.segments === 'missing_source' ? status.segments : 'initializing',
    };
  }

  private resolveFactStatus(count: number, sourceReady: boolean): AnalyticsFactStatus[keyof AnalyticsFactStatus] {
    if (!sourceReady) return 'missing_source';
    if (count > 0) return 'ready';
    return 'empty';
  }

  private toDateOnly(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private toInt(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.floor(num));
  }

  private toNullableDate(value: unknown): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private minDate(values: Array<Date | null>): Date | null {
    let current: Date | null = null;
    for (const value of values) {
      if (!value) {
        continue;
      }
      if (!current || value.getTime() < current.getTime()) {
        current = value;
      }
    }
    return current;
  }
}
