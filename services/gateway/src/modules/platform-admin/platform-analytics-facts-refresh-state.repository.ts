import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import type { AnalyticsFactRefreshStateRow, ResolvedAnalyticsQuery } from './platform-analytics.types';

@Injectable()
export class PlatformAnalyticsFactsRefreshStateRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async listRecentRefreshStates(limit = 200): Promise<AnalyticsFactRefreshStateRow[]> {
    return (this.prisma.$queryRawUnsafe(
      `
      SELECT job_name, scope_key, app_id, timezone, from_day, to_day, last_refresh_started_at, last_refresh_completed_at, last_error
      FROM analytics_fact_refresh_state
      WHERE job_name = 'analytics_facts'
      ORDER BY COALESCE(last_refresh_completed_at, last_refresh_started_at) DESC NULLS LAST
      LIMIT $1::int
      `,
      limit,
    ) as Promise<AnalyticsFactRefreshStateRow[]>);
  }

  async listHotRefreshWindows(limit = 200): Promise<Array<{ app_id: string; timezone: string }>> {
    return (this.prisma.$queryRawUnsafe(
      `
      SELECT DISTINCT ON (app_id, timezone)
        app_id,
        timezone
      FROM analytics_fact_refresh_state
      WHERE job_name = 'analytics_facts'
      ORDER BY app_id, timezone, COALESCE(last_refresh_completed_at, last_refresh_started_at) DESC NULLS LAST
      LIMIT $1::int
      `,
      limit,
    ) as Promise<Array<{ app_id: string; timezone: string }>>);
  }

  async persistQueued(refreshKey: string, appId: string, query: ResolvedAnalyticsQuery) {
    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO analytics_fact_refresh_state (
        job_name, scope_key, app_id, timezone, from_day, to_day, last_error
      )
      VALUES (
        'analytics_facts',
        $1::text,
        $2::uuid,
        $3::text,
        $4::date,
        $5::date,
        NULL
      )
      ON CONFLICT (scope_key) DO UPDATE SET
        app_id = EXCLUDED.app_id,
        timezone = EXCLUDED.timezone,
        from_day = EXCLUDED.from_day,
        to_day = EXCLUDED.to_day,
        last_error = NULL
      `,
      refreshKey,
      appId,
      query.timezone,
      this.toDateOnly(query.from),
      this.toDateOnly(query.to),
    );
  }

  async markStarted(refreshKey: string) {
    await this.prisma.$executeRawUnsafe(
      `
      UPDATE analytics_fact_refresh_state
      SET last_refresh_started_at = now(), last_error = NULL
      WHERE scope_key = $1::text
      `,
      refreshKey,
    );
  }

  async markCompleted(refreshKey: string) {
    await this.prisma.$executeRawUnsafe(
      `
      UPDATE analytics_fact_refresh_state
      SET last_refresh_completed_at = now(), last_error = NULL
      WHERE scope_key = $1::text
      `,
      refreshKey,
    );
  }

  async markFailed(refreshKey: string, error: unknown) {
    await this.prisma.$executeRawUnsafe(
      `
      UPDATE analytics_fact_refresh_state
      SET last_error = $2::text
      WHERE scope_key = $1::text
      `,
      refreshKey,
      String((error as any)?.message || error || 'unknown analytics refresh error').slice(0, 2000),
    );
  }

  private toDateOnly(value: Date): string {
    return value.toISOString().slice(0, 10);
  }
}
