import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';

const REQUIRED_ANALYTICS_READ_MODEL_RELATIONS = [
  'analytics_fact_refresh_state',
  'app_user_daily_facts',
  'app_user_cohort_facts',
  'app_user_conversion_facts',
  'app_user_segment_snapshots',
  'app_user_activity_summary',
  'app_user_payment_summary',
  'app_user_ai_usage_summary',
  'app_user_profile_summary',
  'idx_analytics_fact_refresh_state_job_completed',
  'idx_analytics_fact_refresh_state_app_window',
  'idx_app_user_daily_facts_lookup',
  'idx_app_user_cohort_facts_lookup',
  'idx_app_user_conversion_facts_lookup',
  'idx_app_user_segment_snapshots_lookup',
  'idx_app_user_activity_summary_last_activity',
  'idx_app_user_payment_summary_last_paid',
  'idx_app_user_profile_summary_source',
  'idx_users_app_deleted_created_at',
  'idx_users_app_deleted_last_login_at',
  'idx_users_app_membership_deleted_created_at',
  'idx_alipay_orders_app_status_paid_at',
  'idx_alipay_orders_app_user_status_paid_at',
  'idx_ai_usage_logs_app_user_created',
  'idx_user_behavior_events_app_user_occurred_at',
] as const;

@Injectable()
export class PlatformAnalyticsSchemaHealthService {
  private readonly logger = new Logger(PlatformAnalyticsSchemaHealthService.name);
  private readModelReady = false;

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  isReadModelReady() {
    return this.readModelReady;
  }

  async verifyReadModelSchema(): Promise<boolean> {
    const availability = await Promise.all(
      REQUIRED_ANALYTICS_READ_MODEL_RELATIONS.map(async (relationName) => ({
        relationName,
        exists: await this.isRelationAvailable(relationName),
      })),
    );
    const missing = availability.filter((item) => !item.exists).map((item) => item.relationName);
    if (missing.length > 0) {
      this.logger.warn(`analytics read model migration is incomplete; missing relations: ${missing.join(', ')}`);
      this.readModelReady = false;
      return false;
    }
    this.readModelReady = true;
    return true;
  }

  private async isRelationAvailable(relationName: string): Promise<boolean> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT to_regclass($1)::text AS table_ref`,
      `public.${relationName}`,
    ) as Promise<Array<{ table_ref: string | null }>>);
    return !!rows[0]?.table_ref;
  }
}
