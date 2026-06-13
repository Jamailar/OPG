import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import { PlatformAnalyticsSchemaHealthService } from './platform-analytics-schema-health.service';
import { PlatformAnalyticsResponseCacheService } from './platform-analytics-response-cache.service';
import { PlatformAnalyticsSourceTablesService } from './platform-analytics-source-tables.service';
import { PlatformAnalyticsFactsReadStateService } from './platform-analytics-facts-read-state.service';
import { PlatformAnalyticsFactsRefreshStateRepository } from './platform-analytics-facts-refresh-state.repository';
import type {
  AnalyticsFactRefreshStateRow,
  AnalyticsFactsReadState,
  AnalyticsTables,
  ResolvedAnalyticsQuery,
} from './platform-analytics.types';

export type PlatformAppAnalyticsQuery = {
  days?: string;
  from?: string;
  to?: string;
  timezone?: string;
  granularity?: string;
  segment?: string;
  created_scope?: string;
  last_login_scope?: string;
  page?: string;
  page_size?: string;
  membership_type?: string;
  login_method?: string;
  source?: string;
  paid_status?: string;
  account_status?: string;
  sort_by?: string;
  sort_order?: string;
};

type AnalyticsFactsRefreshJob = {
  appId: string;
  query: ResolvedAnalyticsQuery;
  tables: AnalyticsTables;
  priority: 'cold' | 'stale';
  queuedAt: number;
};

type AppSummary = {
  id: string;
  slug: string;
  name: string;
};

const ANALYTICS_FACTS_REFRESH_TTL_MS = 5 * 60_000;
const ANALYTICS_BACKGROUND_REFRESH_INTERVAL_MS = 30_000;
const ANALYTICS_BACKGROUND_REFRESH_BATCH_SIZE = 2;
const ANALYTICS_HOT_WINDOW_ENQUEUE_INTERVAL_MS = 5 * 60_000;
const ANALYTICS_HOT_WINDOW_DAYS = [7, 30, 90] as const;

@Injectable()
export class PlatformAppAnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(PlatformAppAnalyticsService.name);
  private readonly factsRefreshInFlight = new Map<string, Promise<void>>();
  private readonly factsRefreshTouchedAt = new Map<string, number>();
  private readonly factsRefreshQueue = new Map<string, AnalyticsFactsRefreshJob>();
  private factsRefreshWorkerRunning = false;
  private factsRefreshStateRecovered = false;
  private lastHotWindowEnqueueAt = 0;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly schemaHealth: PlatformAnalyticsSchemaHealthService,
    private readonly responseCache: PlatformAnalyticsResponseCacheService,
    private readonly sourceTables: PlatformAnalyticsSourceTablesService,
    private readonly factsReadState: PlatformAnalyticsFactsReadStateService,
    private readonly refreshStateRepository: PlatformAnalyticsFactsRefreshStateRepository,
  ) {}

  async onModuleInit() {
    try {
      const schemaReady = await this.schemaHealth.verifyReadModelSchema();
      if (schemaReady) {
        await this.restorePersistedFactsRefreshQueue();
        await this.enqueueHotWindowRefreshes(true);
      }
    } catch (error: any) {
      this.logger.warn(`analytics startup warmup failed: ${error?.message || error}`);
    }
  }

  async getOverview(appId: string, rawQuery: PlatformAppAnalyticsQuery = {}) {
    const app = await this.ensureAppExists(appId);
    const query = this.resolveQuery(rawQuery);
    const tables = await this.sourceTables.resolveAvailability();
    return this.responseCache.withCache('overview', app.id, query, async () => {
      const facts = await this.prepareFactsForRead(app.id, query, tables);
      const [summaryRows, trendRows] = await Promise.all([
        (this.prisma.$queryRawUnsafe(
          this.buildSummaryQuery(tables),
          app.id,
          query.from,
          query.to,
          query.timezone,
          this.daysAgo(query.to, 7),
          this.daysAgo(query.to, 30),
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(
          this.finalizeSeriesSql(this.buildOverviewTrendFactsQuery(), query),
          app.id,
          query.timezone,
          query.from,
          query.to,
          query.granularity,
        ) as Promise<Array<Record<string, unknown>>>),
      ]);

      const summary = summaryRows[0] || {};
      const totalUsers = this.toInt(summary.users_total);
      const paidUsers = this.toInt(summary.paid_users_total);
      const rechargeUsers = this.toInt(summary.recharge_users_total);
      const activeUsers = this.toInt(summary.active_users_in_range);
      const newUsers = this.toInt(summary.users_new_in_range);
      const activatedUsers = this.toInt(summary.activated_users_in_range);
      const paidAmount = this.toNumber(summary.paid_amount_in_range);
      const latestWeekRevenue = this.toNumber(summary.paid_amount_7d);
      const arrEstimate = latestWeekRevenue * 52;

      return {
        app_id: app.id,
        app_slug: app.slug,
        app_name: app.name,
        range: this.serializeRange(query),
        tables,
        facts_status: facts.status,
        facts_meta: facts.meta,
        summary: {
          users_total: totalUsers,
          valid_users_total: totalUsers,
          deleted_users_total: this.toInt(summary.deleted_users_total),
          paid_users_total: paidUsers,
          recharge_users_total: rechargeUsers,
          active_users_in_range: activeUsers,
          users_new_in_range: newUsers,
          activated_users_in_range: activatedUsers,
          activation_rate: newUsers > 0 ? activatedUsers / newUsers : 0,
          paid_users_in_range: this.toInt(summary.paid_users_in_range),
          pay_rate: totalUsers > 0 ? paidUsers / totalUsers : 0,
          paid_amount_in_range: paidAmount,
          paid_amount_7d: latestWeekRevenue,
          arr_estimate: arrEstimate,
          arpu: totalUsers > 0 ? paidAmount / totalUsers : 0,
          arppu: paidUsers > 0 ? paidAmount / paidUsers : 0,
          dau_latest: this.toInt(summary.dau_latest),
          wau_latest: this.toInt(summary.wau_latest),
          mau_latest: this.toInt(summary.mau_latest),
        },
        highlights: [
          {
            key: 'activation',
            label: '激活率',
            value: newUsers > 0 ? activatedUsers / newUsers : 0,
            note: `窗口内新增 ${newUsers}，其中 ${activatedUsers} 已激活`,
          },
          {
            key: 'active',
            label: '活跃用户',
            value: activeUsers,
            note: `近 7 天 ${this.toInt(summary.active_users_7d)}，近 30 天 ${this.toInt(summary.active_users_30d)}`,
          },
          {
            key: 'paid',
            label: '充值用户',
            value: rechargeUsers,
            note: `累计付费用户 ${paidUsers}，窗口内支付 ${this.toInt(summary.paid_users_in_range)}`,
          },
          {
            key: 'revenue',
            label: '窗口收入',
            value: paidAmount,
            note: `ARPU ${this.round2(totalUsers > 0 ? paidAmount / totalUsers : 0)}，ARPPU ${this.round2(
              paidUsers > 0 ? paidAmount / paidUsers : 0,
            )}`,
          },
          {
            key: 'arr',
            label: 'ARR',
            value: arrEstimate,
            note: `按近 7 天收入 ${this.round2(latestWeekRevenue)} 年化估算`,
          },
        ],
        trends: trendRows.map((row) => ({
          period: String(row.period || ''),
          registrations: this.toInt(row.registrations),
          users_total: this.toInt(row.users_total),
          active_users: this.toInt(row.active_users),
          paid_users: this.toInt(row.paid_users),
          revenue: this.toNumber(row.revenue),
        })),
        generated_at: new Date().toISOString(),
      };
    });
  }

  async getGrowth(appId: string, rawQuery: PlatformAppAnalyticsQuery = {}) {
    const app = await this.ensureAppExists(appId);
    const query = this.resolveQuery(rawQuery);
    const tables = await this.sourceTables.resolveAvailability();
    return this.responseCache.withCache('growth', app.id, query, async () => {
      const facts = await this.prepareFactsForRead(app.id, query, tables);
      const [summaryRows, registrationRows, sourceRows, methodRows] = await Promise.all([
        (this.prisma.$queryRawUnsafe(
          this.buildGrowthSummaryQuery(tables),
          app.id,
          query.from,
          query.to,
          query.timezone,
          this.startOfDay(query.to),
          this.daysAgo(query.to, 7),
          this.daysAgo(query.to, 30),
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(
          this.finalizeSeriesSql(this.buildGrowthTrendFactsQuery(), query),
          app.id,
          query.timezone,
          query.from,
          query.to,
          query.granularity,
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(this.buildSourceDistributionQuery(tables), app.id) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(this.buildLoginMethodDistributionQuery(), app.id) as Promise<Array<Record<string, unknown>>>),
      ]);

      const summary = summaryRows[0] || {};
      const newToday = this.toInt(summary.registered_today);
      const newWeek = this.toInt(summary.registered_7d);
      const newMonth = this.toInt(summary.registered_30d);
      const activated = this.toInt(summary.activated_in_range);
      const registered = this.toInt(summary.registered_in_range);

      return {
        app_id: app.id,
        app_slug: app.slug,
        app_name: app.name,
        range: this.serializeRange(query),
        facts_status: facts.status,
        facts_meta: facts.meta,
        summary: {
          registered_today: newToday,
          registered_7d: newWeek,
          registered_30d: newMonth,
          registered_in_range: registered,
          activated_in_range: activated,
          first_login_in_range: this.toInt(summary.first_login_in_range),
          activation_rate: registered > 0 ? activated / registered : 0,
          dau_latest: this.toInt(summary.dau_latest),
          wau_latest: this.toInt(summary.wau_latest),
          mau_latest: this.toInt(summary.mau_latest),
        },
        registrations_trend: registrationRows.map((row) => ({
          period: String(row.period || ''),
          registrations: this.toInt(row.registrations),
          users_total: this.toInt(row.users_total),
          activated_users: this.toInt(row.activated_users),
          login_users: this.toInt(row.login_users),
          active_users: this.toInt(row.active_users),
        })),
        login_method_distribution: methodRows.map((row) => ({
          login_method: String(row.login_method || 'email'),
          users_count: this.toInt(row.users_count),
        })),
        source_distribution: sourceRows.map((row) => ({
          source: String(row.source || 'unknown'),
          users_count: this.toInt(row.users_count),
        })),
        generated_at: new Date().toISOString(),
      };
    });
  }

  async getRetention(appId: string, rawQuery: PlatformAppAnalyticsQuery = {}) {
    const app = await this.ensureAppExists(appId);
    const query = this.resolveQuery(rawQuery);
    const tables = await this.sourceTables.resolveAvailability();
    return this.responseCache.withCache('retention', app.id, query, async () => {
      const facts = await this.prepareFactsForRead(app.id, query, tables);
      const [summaryRows, cohortRows, lifecycleRows, reactivationRows] = await Promise.all([
        (this.prisma.$queryRawUnsafe(
          this.buildRetentionSummaryQuery(tables),
          app.id,
          query.from,
          query.to,
          query.timezone,
          this.daysAgo(query.to, 7),
          this.daysAgo(query.to, 30),
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(
          this.finalizeSeriesSql(this.buildRetentionCohortFactsQuery(), query),
          app.id,
          query.timezone,
          query.from,
          query.to,
          query.granularity,
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(
          this.buildSegmentSnapshotQuery('activity'),
          app.id,
          query.timezone,
          query.to,
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(
          this.finalizeSeriesSql(this.buildReactivationTrendFactsQuery(), query),
          app.id,
          query.timezone,
          query.from,
          query.to,
          query.granularity,
        ) as Promise<Array<Record<string, unknown>>>),
      ]);

      const summary = summaryRows[0] || {};

      return {
        app_id: app.id,
        app_slug: app.slug,
        app_name: app.name,
        range: this.serializeRange(query),
        facts_status: facts.status,
        facts_meta: facts.meta,
        summary: {
          d1_retention: this.toRatio(summary.d1_retention),
          d3_retention: this.toRatio(summary.d3_retention),
          d7_retention: this.toRatio(summary.d7_retention),
          d14_retention: this.toRatio(summary.d14_retention),
          d30_retention: this.toRatio(summary.d30_retention),
          reactivated_users: this.toInt(summary.reactivated_users),
          dormant_users: this.toInt(summary.dormant_users),
          churned_users: this.toInt(summary.churned_users),
        },
        cohorts: cohortRows.map((row) => ({
          cohort_period: String(row.cohort_period || ''),
          cohort_size: this.toInt(row.cohort_size),
          d1: this.toRatio(row.d1_rate),
          d3: this.toRatio(row.d3_rate),
          d7: this.toRatio(row.d7_rate),
          d14: this.toRatio(row.d14_rate),
          d30: this.toRatio(row.d30_rate),
        })),
        lifecycle_distribution: lifecycleRows.map((row) => ({
          segment: String(row.segment || ''),
          users_count: this.toInt(row.users_count),
        })),
        reactivation_trend: reactivationRows.map((row) => ({
          period: String(row.period || ''),
          users_total: this.toInt(row.users_total),
          reactivated_users: this.toInt(row.reactivated_users),
        })),
        generated_at: new Date().toISOString(),
      };
    });
  }

  async getProfiles(appId: string, rawQuery: PlatformAppAnalyticsQuery = {}) {
    const app = await this.ensureAppExists(appId);
    const query = this.resolveQuery(rawQuery);
    const tables = await this.sourceTables.resolveAvailability();
    return this.responseCache.withCache('profiles', app.id, query, async () => {
      const facts = await this.prepareFactsForRead(app.id, query, tables);
      const [membershipRows, loginMethodRows, sourceRows, activityRows, paymentRows] = await Promise.all([
        (this.prisma.$queryRawUnsafe(this.buildSegmentSnapshotQuery('membership'), app.id, query.timezone, query.to) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(this.buildSegmentSnapshotQuery('login_method'), app.id, query.timezone, query.to) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(this.buildSegmentSnapshotQuery('source'), app.id, query.timezone, query.to) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(this.buildSegmentSnapshotQuery('activity'), app.id, query.timezone, query.to) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(this.buildSegmentSnapshotQuery('payment'), app.id, query.timezone, query.to) as Promise<Array<Record<string, unknown>>>),
      ]);

      return {
        app_id: app.id,
        app_slug: app.slug,
        app_name: app.name,
        range: this.serializeRange(query),
        facts_status: facts.status,
        facts_meta: facts.meta,
        membership_distribution: membershipRows.map((row) => ({
          membership_type: String(row.segment || 'FREE'),
          users_count: this.toInt(row.users_count),
        })),
        login_method_distribution: loginMethodRows.map((row) => ({
          login_method: String(row.segment || 'email'),
          users_count: this.toInt(row.users_count),
        })),
        source_distribution: sourceRows.map((row) => ({
          source: String(row.segment || 'unknown'),
          users_count: this.toInt(row.users_count),
        })),
        activity_segments: activityRows.map((row) => ({
          segment: String(row.segment || ''),
          users_count: this.toInt(row.users_count),
        })),
        payment_segments: paymentRows.map((row) => ({
          segment: String(row.segment || ''),
          users_count: this.toInt(row.users_count),
        })),
        data_gaps: [
          { key: 'geo', label: '国家地区', ready: false, note: '当前未统一采集地域信息' },
          { key: 'device', label: '设备平台', ready: false, note: '当前未统一沉淀设备维度' },
        ],
        generated_at: new Date().toISOString(),
      };
    });
  }

  async getConversion(appId: string, rawQuery: PlatformAppAnalyticsQuery = {}) {
    const app = await this.ensureAppExists(appId);
    const query = this.resolveQuery(rawQuery);
    const tables = await this.sourceTables.resolveAvailability();
    return this.responseCache.withCache('conversion', app.id, query, async () => {
      const facts = await this.prepareFactsForRead(app.id, query, tables);
      const [funnelRows, paymentTrendRows] = await Promise.all([
        (this.prisma.$queryRawUnsafe(
          this.buildConversionSummaryFactsQuery(),
          app.id,
          query.timezone,
          query.from,
          query.to,
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(
          this.finalizeSeriesSql(this.buildPaymentTrendFactsQuery(), query),
          app.id,
          query.timezone,
          query.from,
          query.to,
          query.granularity,
        ) as Promise<Array<Record<string, unknown>>>),
      ]);

      const funnel = funnelRows[0] || {};
      const steps = [
        { key: 'registered', label: '注册', users: this.toInt(funnel.registered_users) },
        { key: 'activated', label: '激活', users: this.toInt(funnel.activated_users) },
        { key: 'active', label: '活跃', users: this.toInt(funnel.first_login_users) },
        { key: 'first_paid', label: '首次付费', users: this.toInt(funnel.first_paid_users) },
        { key: 'repeat_paid', label: '复购', users: this.toInt(funnel.repeat_paid_users) },
      ].map((step, index, all) => ({
        ...step,
        conversion_from_start: all[0].users > 0 ? step.users / all[0].users : 0,
        conversion_from_previous: index === 0 ? 1 : all[index - 1].users > 0 ? step.users / all[index - 1].users : 0,
      }));

      return {
        app_id: app.id,
        app_slug: app.slug,
        app_name: app.name,
        range: this.serializeRange(query),
        facts_status: facts.status,
        facts_meta: facts.meta,
        funnel: steps,
        payment_trend: paymentTrendRows.map((row) => ({
          period: String(row.period || ''),
          users_total: this.toInt(row.users_total),
          paid_users: this.toInt(row.paid_users),
          revenue: this.toNumber(row.revenue),
          repeat_buyers: this.toInt(row.repeat_buyers),
        })),
        generated_at: new Date().toISOString(),
      };
    });
  }

  async getUsers(appId: string, rawQuery: PlatformAppAnalyticsQuery = {}) {
    const app = await this.ensureAppExists(appId);
    const query = this.resolveQuery(rawQuery);
    const tables = await this.sourceTables.resolveAvailability();
    return this.responseCache.withCache('users', app.id, query, async () => {
      const facts = await this.prepareFactsForRead(app.id, query, tables);
      const itemParams = this.buildUsersQueryParams(app.id, query, false);
      const totalParams = this.buildUsersQueryParams(app.id, query, true);
      const [itemsRows, totalRows] = await Promise.all([
        (this.prisma.$queryRawUnsafe(
          this.buildUsersQuery(tables, false, itemParams.filterSql, itemParams.paginationSql, itemParams.sortColumn, itemParams.sortOrder),
          ...itemParams.params,
        ) as Promise<Array<Record<string, unknown>>>),
        (this.prisma.$queryRawUnsafe(this.buildUsersQuery(tables, true, totalParams.filterSql), ...totalParams.params) as Promise<Array<Record<string, unknown>>>),
      ]);

      return {
        app_id: app.id,
        app_slug: app.slug,
        app_name: app.name,
        range: this.serializeRange(query),
        facts_status: facts.status,
        facts_meta: facts.meta,
        filters: {
          segment: query.segment || '',
          created_scope: query.createdScope || '',
          last_login_scope: query.lastLoginScope || '',
          membership_type: query.membershipType || '',
          login_method: query.loginMethod || '',
          source: query.source || '',
          paid_status: query.paidStatus || '',
          account_status: query.accountStatus || 'active',
          sort_by: query.sortBy,
          sort_order: query.sortOrder,
          page: query.page,
          page_size: query.pageSize,
        },
        pagination: {
          page: query.page,
          page_size: query.pageSize,
          total: this.toInt(totalRows[0]?.total),
        },
        items: itemsRows.map((row) => ({
          id: String(row.id || ''),
          email: String(row.email || ''),
          phone: this.nullableString(row.phone),
          display_name: this.nullableString(row.display_name),
          is_active: row.is_active !== false,
          deleted_at: this.toNullableIsoString(row.deleted_at),
          deactivated_at: this.toNullableIsoString(row.deactivated_at),
          deactivated_email: this.nullableString(row.deactivated_email),
          deactivated_phone: this.nullableString(row.deactivated_phone),
          membership_type: String(row.membership_type || 'FREE'),
          login_method: String(row.login_method || 'email'),
          source: String(row.source || row.login_method || 'unknown'),
          created_at: this.toIsoString(row.created_at),
          last_login_at: this.toNullableIsoString(row.last_login_at),
          last_activity_at: this.toNullableIsoString(row.last_activity_at),
          paid_orders_total: this.toInt(row.paid_orders_total),
          paid_amount_total: this.toNumber(row.paid_amount_total),
          points_balance: this.toNumber(row.points_balance),
          ai_requests_total: this.toInt(row.ai_requests_total),
          ai_total_tokens: this.toInt(row.ai_total_tokens),
          ai_points_spent_total: this.toNumber(row.ai_points_spent_total),
          recent_event: this.nullableString(row.recent_event),
          recent_order: this.nullableString(row.recent_order),
          recent_recharge: this.toNullableIsoString(row.recent_recharge),
        })),
        generated_at: new Date().toISOString(),
      };
    });
  }

  private buildSummaryQuery(tables: AnalyticsTables) {
    return `
      WITH activity_events AS (${this.buildActivityUnionSql(tables)}),
      active_in_range AS (
        SELECT DISTINCT user_id
        FROM activity_events
        WHERE activity_at >= $2::timestamptz AND activity_at <= $3::timestamptz
      ),
      active_7d AS (
        SELECT DISTINCT user_id FROM activity_events WHERE activity_at >= $5::timestamptz
      ),
      active_30d AS (
        SELECT DISTINCT user_id FROM activity_events WHERE activity_at >= $6::timestamptz
      ),
      paid_orders AS (${this.buildPaidOrdersSql(tables)}),
      paid_users_total AS (
        SELECT COUNT(DISTINCT user_id)::bigint AS total FROM paid_orders
      ),
      paid_users_in_range AS (
        SELECT COUNT(DISTINCT user_id)::bigint AS total
        FROM paid_orders
        WHERE paid_at >= $2::timestamptz AND paid_at <= $3::timestamptz
      ),
      dau AS (
        SELECT COUNT(DISTINCT user_id)::bigint AS total
        FROM activity_events
        WHERE activity_at >= date_trunc('day', $3::timestamptz)
      ),
      wau AS (
        SELECT COUNT(DISTINCT user_id)::bigint AS total FROM active_7d
      ),
      mau AS (
        SELECT COUNT(DISTINCT user_id)::bigint AS total FROM active_30d
      )
      SELECT
        COUNT(*) FILTER (WHERE u.deleted_at IS NULL)::bigint AS users_total,
        COUNT(*) FILTER (WHERE u.deleted_at IS NOT NULL)::bigint AS deleted_users_total,
        COUNT(*) FILTER (WHERE u.deleted_at IS NULL AND u.created_at >= $2::timestamptz AND u.created_at <= $3::timestamptz)::bigint AS users_new_in_range,
        COUNT(*) FILTER (WHERE u.deleted_at IS NULL AND EXISTS (SELECT 1 FROM active_in_range a WHERE a.user_id = u.id))::bigint AS active_users_in_range,
        COUNT(*) FILTER (WHERE u.deleted_at IS NULL AND EXISTS (SELECT 1 FROM active_7d a WHERE a.user_id = u.id))::bigint AS active_users_7d,
        COUNT(*) FILTER (WHERE u.deleted_at IS NULL AND EXISTS (SELECT 1 FROM active_30d a WHERE a.user_id = u.id))::bigint AS active_users_30d,
        COUNT(*) FILTER (
          WHERE u.deleted_at IS NULL
            AND u.created_at >= $2::timestamptz AND u.created_at <= $3::timestamptz
            AND EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = u.id)
        )::bigint AS activated_users_in_range,
        COALESCE((SELECT total FROM paid_users_total), 0)::bigint AS paid_users_total,
        COALESCE((SELECT total FROM paid_users_in_range), 0)::bigint AS paid_users_in_range,
        COALESCE((SELECT COUNT(DISTINCT user_id)::bigint FROM paid_orders), 0)::bigint AS recharge_users_total,
        COALESCE((SELECT SUM(amount_total) FROM paid_orders WHERE paid_at >= $2::timestamptz AND paid_at <= $3::timestamptz), 0)::numeric AS paid_amount_in_range,
        COALESCE((SELECT SUM(amount_total) FROM paid_orders WHERE paid_at >= $5::timestamptz AND paid_at <= $3::timestamptz), 0)::numeric AS paid_amount_7d,
        COALESCE((SELECT total FROM dau), 0)::bigint AS dau_latest,
        COALESCE((SELECT total FROM wau), 0)::bigint AS wau_latest,
        COALESCE((SELECT total FROM mau), 0)::bigint AS mau_latest
      FROM users u
      WHERE u.app_id = $1::uuid
    `;
  }

  private buildOverviewTrendQuery(tables: AnalyticsTables) {
    return `
      WITH periods AS (
        SELECT generate_series(
          date_trunc($5::text, timezone($4::text, $2::timestamptz)),
          date_trunc($5::text, timezone($4::text, $3::timestamptz)),
          interval '${'__STEP__'}'
        ) AS period_start
      ),
      registrations AS (
        SELECT date_trunc($5::text, timezone($4::text, created_at)) AS period_start, COUNT(*)::bigint AS registrations
        FROM users
        WHERE app_id = $1::uuid AND deleted_at IS NULL AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
        GROUP BY 1
      ),
      activity_events AS (${this.buildActivityUnionSql(tables)}),
      active_users AS (
        SELECT date_trunc($5::text, timezone($4::text, activity_at)) AS period_start, COUNT(DISTINCT user_id)::bigint AS active_users
        FROM activity_events
        WHERE activity_at >= $2::timestamptz AND activity_at <= $3::timestamptz
        GROUP BY 1
      ),
      paid_orders AS (${this.buildPaidOrdersSql(tables)}),
      payments AS (
        SELECT
          date_trunc($5::text, timezone($4::text, paid_at)) AS period_start,
          COUNT(DISTINCT user_id)::bigint AS paid_users,
          COALESCE(SUM(amount_total), 0)::numeric AS revenue
        FROM paid_orders
        WHERE paid_at >= $2::timestamptz AND paid_at <= $3::timestamptz
        GROUP BY 1
      )
      SELECT
        to_char(periods.period_start, '${'__FORMAT__'}') AS period,
        COALESCE(registrations.registrations, 0)::bigint AS registrations,
        COALESCE(active_users.active_users, 0)::bigint AS active_users,
        COALESCE(payments.paid_users, 0)::bigint AS paid_users,
        COALESCE(payments.revenue, 0)::numeric AS revenue
      FROM periods
      LEFT JOIN registrations ON registrations.period_start = periods.period_start
      LEFT JOIN active_users ON active_users.period_start = periods.period_start
      LEFT JOIN payments ON payments.period_start = periods.period_start
      ORDER BY periods.period_start ASC
    `;
  }

  private buildGrowthSummaryQuery(tables: AnalyticsTables) {
    return `
      WITH activity_events AS (${this.buildActivityUnionSql(tables)}),
      dau AS (
        SELECT COUNT(DISTINCT user_id)::bigint AS total
        FROM activity_events
        WHERE activity_at >= $5::timestamptz
      ),
      wau AS (
        SELECT COUNT(DISTINCT user_id)::bigint AS total
        FROM activity_events
        WHERE activity_at >= $6::timestamptz
      ),
      mau AS (
        SELECT COUNT(DISTINCT user_id)::bigint AS total
        FROM activity_events
        WHERE activity_at >= $7::timestamptz
      )
      SELECT
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND created_at >= $5::timestamptz)::bigint AS registered_today,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND created_at >= $6::timestamptz)::bigint AS registered_7d,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND created_at >= $7::timestamptz)::bigint AS registered_30d,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz)::bigint AS registered_in_range,
        COUNT(*) FILTER (
          WHERE deleted_at IS NULL
            AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
            AND EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = users.id)
        )::bigint AS activated_in_range,
        COUNT(*) FILTER (
          WHERE deleted_at IS NULL
            AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
            AND last_login_at IS NOT NULL
        )::bigint AS first_login_in_range,
        COALESCE((SELECT total FROM dau), 0)::bigint AS dau_latest,
        COALESCE((SELECT total FROM wau), 0)::bigint AS wau_latest,
        COALESCE((SELECT total FROM mau), 0)::bigint AS mau_latest
      FROM users
      WHERE app_id = $1::uuid
    `;
  }

  private buildGrowthTrendQuery(tables: AnalyticsTables) {
    return `
      WITH periods AS (
        SELECT generate_series(
          date_trunc($5::text, timezone($4::text, $2::timestamptz)),
          date_trunc($5::text, timezone($4::text, $3::timestamptz)),
          interval '${'__STEP__'}'
        ) AS period_start
      ),
      registrations AS (
        SELECT date_trunc($5::text, timezone($4::text, created_at)) AS period_start, COUNT(*)::bigint AS registrations
        FROM users
        WHERE app_id = $1::uuid AND deleted_at IS NULL AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
        GROUP BY 1
      ),
      activity_events AS (${this.buildActivityUnionSql(tables)}),
      activity AS (
        SELECT
          date_trunc($5::text, timezone($4::text, activity_at)) AS period_start,
          COUNT(DISTINCT user_id)::bigint AS active_users
        FROM activity_events
        WHERE activity_at >= $2::timestamptz AND activity_at <= $3::timestamptz
        GROUP BY 1
      ),
      activations AS (
        SELECT
          date_trunc($5::text, timezone($4::text, u.created_at)) AS period_start,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = u.id))::bigint AS activated_users,
          COUNT(*) FILTER (WHERE u.last_login_at IS NOT NULL)::bigint AS login_users
        FROM users u
        WHERE u.app_id = $1::uuid AND u.deleted_at IS NULL AND u.created_at >= $2::timestamptz AND u.created_at <= $3::timestamptz
        GROUP BY 1
      )
      SELECT
        to_char(periods.period_start, '${'__FORMAT__'}') AS period,
        COALESCE(registrations.registrations, 0)::bigint AS registrations,
        COALESCE(activations.activated_users, 0)::bigint AS activated_users,
        COALESCE(activations.login_users, 0)::bigint AS login_users,
        COALESCE(activity.active_users, 0)::bigint AS active_users
      FROM periods
      LEFT JOIN registrations ON registrations.period_start = periods.period_start
      LEFT JOIN activations ON activations.period_start = periods.period_start
      LEFT JOIN activity ON activity.period_start = periods.period_start
      ORDER BY periods.period_start ASC
    `;
  }

  private buildRetentionSummaryQuery(tables: AnalyticsTables) {
    return `
      WITH activity_events AS (${this.buildActivityUnionSql(tables)}),
      cohort_users AS (
        SELECT id, created_at
        FROM users
        WHERE app_id = $1::uuid AND deleted_at IS NULL AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
      ),
      cohort_retention AS (
        SELECT
          c.id,
          BOOL_OR(a.activity_at >= c.created_at + interval '1 day' AND a.activity_at < c.created_at + interval '2 day') AS d1,
          BOOL_OR(a.activity_at >= c.created_at + interval '3 day' AND a.activity_at < c.created_at + interval '4 day') AS d3,
          BOOL_OR(a.activity_at >= c.created_at + interval '7 day' AND a.activity_at < c.created_at + interval '8 day') AS d7,
          BOOL_OR(a.activity_at >= c.created_at + interval '14 day' AND a.activity_at < c.created_at + interval '15 day') AS d14,
          BOOL_OR(a.activity_at >= c.created_at + interval '30 day' AND a.activity_at < c.created_at + interval '31 day') AS d30
        FROM cohort_users c
        LEFT JOIN activity_events a ON a.user_id = c.id
        GROUP BY c.id
      ),
      latest_activity AS (
        SELECT user_id, MAX(activity_at) AS last_activity_at
        FROM activity_events
        GROUP BY user_id
      ),
      reactivated AS (
        SELECT COUNT(*)::bigint AS total
        FROM (
          SELECT user_id, MIN(activity_at) AS reactivated_at
          FROM activity_events
          WHERE activity_at >= $2::timestamptz AND activity_at <= $3::timestamptz
          GROUP BY user_id
        ) t
        JOIN latest_activity la ON la.user_id = t.user_id
        WHERE EXISTS (
          SELECT 1 FROM activity_events older
          WHERE older.user_id = t.user_id
            AND older.activity_at < t.reactivated_at - interval '30 day'
        )
      )
      SELECT
        COALESCE(AVG(CASE WHEN cohort_retention.d1 THEN 1 ELSE 0 END), 0)::numeric AS d1_retention,
        COALESCE(AVG(CASE WHEN cohort_retention.d3 THEN 1 ELSE 0 END), 0)::numeric AS d3_retention,
        COALESCE(AVG(CASE WHEN cohort_retention.d7 THEN 1 ELSE 0 END), 0)::numeric AS d7_retention,
        COALESCE(AVG(CASE WHEN cohort_retention.d14 THEN 1 ELSE 0 END), 0)::numeric AS d14_retention,
        COALESCE(AVG(CASE WHEN cohort_retention.d30 THEN 1 ELSE 0 END), 0)::numeric AS d30_retention,
        COALESCE((SELECT total FROM reactivated), 0)::bigint AS reactivated_users,
        COUNT(*) FILTER (WHERE la.last_activity_at >= $5::timestamptz AND la.last_activity_at < $3::timestamptz)::bigint AS dormant_users,
        COUNT(*) FILTER (WHERE la.last_activity_at < $6::timestamptz OR la.last_activity_at IS NULL)::bigint AS churned_users
      FROM users u
      LEFT JOIN latest_activity la ON la.user_id = u.id
      LEFT JOIN cohort_retention ON cohort_retention.id = u.id
      WHERE u.app_id = $1::uuid AND u.deleted_at IS NULL
    `;
  }

  private buildRetentionCohortQuery(tables: AnalyticsTables) {
    return `
      WITH activity_events AS (${this.buildActivityUnionSql(tables)}),
      cohort_users AS (
        SELECT id, created_at, date_trunc($5::text, timezone($4::text, created_at)) AS cohort_period
        FROM users
        WHERE app_id = $1::uuid AND deleted_at IS NULL AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
      ),
      cohort_retention AS (
        SELECT
          c.cohort_period,
          c.id,
          BOOL_OR(a.activity_at >= c.created_at + interval '1 day' AND a.activity_at < c.created_at + interval '2 day') AS d1,
          BOOL_OR(a.activity_at >= c.created_at + interval '3 day' AND a.activity_at < c.created_at + interval '4 day') AS d3,
          BOOL_OR(a.activity_at >= c.created_at + interval '7 day' AND a.activity_at < c.created_at + interval '8 day') AS d7,
          BOOL_OR(a.activity_at >= c.created_at + interval '14 day' AND a.activity_at < c.created_at + interval '15 day') AS d14,
          BOOL_OR(a.activity_at >= c.created_at + interval '30 day' AND a.activity_at < c.created_at + interval '31 day') AS d30
        FROM cohort_users c
        LEFT JOIN activity_events a ON a.user_id = c.id
        GROUP BY c.cohort_period, c.id
      )
      SELECT
        to_char(cohort_period, '${'__FORMAT__'}') AS cohort_period,
        COUNT(*)::bigint AS cohort_size,
        COALESCE(AVG(CASE WHEN d1 THEN 1 ELSE 0 END), 0)::numeric AS d1_rate,
        COALESCE(AVG(CASE WHEN d3 THEN 1 ELSE 0 END), 0)::numeric AS d3_rate,
        COALESCE(AVG(CASE WHEN d7 THEN 1 ELSE 0 END), 0)::numeric AS d7_rate,
        COALESCE(AVG(CASE WHEN d14 THEN 1 ELSE 0 END), 0)::numeric AS d14_rate,
        COALESCE(AVG(CASE WHEN d30 THEN 1 ELSE 0 END), 0)::numeric AS d30_rate
      FROM cohort_retention
      GROUP BY cohort_period
      ORDER BY cohort_period ASC
    `;
  }

  private buildLifecycleDistributionQuery(tables: AnalyticsTables) {
    return `
      WITH activity_events AS (${this.buildActivityUnionSql(tables)}),
      latest_activity AS (
        SELECT user_id, MAX(activity_at) AS last_activity_at, MIN(activity_at) AS first_activity_at
        FROM activity_events
        GROUP BY user_id
      )
      SELECT segment, COUNT(*)::bigint AS users_count
      FROM (
        SELECT
          CASE
            WHEN la.first_activity_at IS NULL THEN '未激活'
            WHEN la.last_activity_at >= $3::timestamptz THEN '稳定活跃'
            WHEN la.last_activity_at >= $4::timestamptz THEN '沉睡用户'
            ELSE '流失用户'
          END AS segment
        FROM users u
        LEFT JOIN latest_activity la ON la.user_id = u.id
        WHERE u.app_id = $1::uuid AND u.deleted_at IS NULL
      ) t
      GROUP BY segment
      ORDER BY users_count DESC
    `;
  }

  private buildReactivationTrendQuery(tables: AnalyticsTables) {
    return `
      WITH periods AS (
        SELECT generate_series(
          date_trunc($5::text, timezone($4::text, $2::timestamptz)),
          date_trunc($5::text, timezone($4::text, $3::timestamptz)),
          interval '${'__STEP__'}'
        ) AS period_start
      ),
      activity_events AS (${this.buildActivityUnionSql(tables)}),
      first_in_period AS (
        SELECT
          user_id,
          MIN(activity_at) AS first_activity_at
        FROM activity_events
        WHERE activity_at >= $2::timestamptz AND activity_at <= $3::timestamptz
        GROUP BY user_id
      ),
      reactivated AS (
        SELECT
          date_trunc($5::text, timezone($4::text, f.first_activity_at)) AS period_start,
          COUNT(*)::bigint AS reactivated_users
        FROM first_in_period f
        WHERE EXISTS (
          SELECT 1 FROM activity_events older
          WHERE older.user_id = f.user_id AND older.activity_at < f.first_activity_at - interval '30 day'
        )
        GROUP BY 1
      )
      SELECT
        to_char(periods.period_start, '${'__FORMAT__'}') AS period,
        COALESCE(reactivated.reactivated_users, 0)::bigint AS reactivated_users
      FROM periods
      LEFT JOIN reactivated ON reactivated.period_start = periods.period_start
      ORDER BY periods.period_start ASC
    `;
  }

  private buildMembershipDistributionQuery() {
    return `
      SELECT COALESCE(membership_type::text, 'FREE') AS membership_type, COUNT(*)::bigint AS users_count
      FROM users
      WHERE app_id = $1::uuid AND deleted_at IS NULL
      GROUP BY 1
      ORDER BY users_count DESC
    `;
  }

  private buildLoginMethodDistributionQuery() {
    return `
      SELECT ${this.loginMethodExpr('users')} AS login_method, COUNT(*)::bigint AS users_count
      FROM users
      WHERE app_id = $1::uuid AND deleted_at IS NULL
      GROUP BY 1
      ORDER BY users_count DESC
    `;
  }

  private buildSourceDistributionQuery(tables: AnalyticsTables) {
    return `
      WITH first_source AS (${this.buildFirstSourceSql(tables)})
      SELECT COALESCE(first_source.source, ${this.loginMethodExpr('u')}) AS source, COUNT(*)::bigint AS users_count
      FROM users u
      LEFT JOIN first_source ON first_source.user_id = u.id
      WHERE u.app_id = $1::uuid AND u.deleted_at IS NULL
      GROUP BY 1
      ORDER BY users_count DESC
    `;
  }

  private buildActivitySegmentQuery(tables: AnalyticsTables) {
    return `
      WITH activity_events AS (${this.buildActivityUnionSql(tables)}),
      latest_activity AS (
        SELECT user_id, MAX(activity_at) AS last_activity_at, COUNT(*)::bigint AS activity_events_total
        FROM activity_events
        GROUP BY user_id
      )
      SELECT segment, COUNT(*)::bigint AS users_count
      FROM (
        SELECT CASE
          WHEN la.last_activity_at IS NULL THEN '未激活'
          WHEN la.last_activity_at >= $3::timestamptz THEN '近7天活跃'
          WHEN la.last_activity_at >= $4::timestamptz THEN '近30天回访'
          ELSE '30天未活跃'
        END AS segment
        FROM users u
        LEFT JOIN latest_activity la ON la.user_id = u.id
        WHERE u.app_id = $1::uuid AND u.deleted_at IS NULL
      ) t
      GROUP BY segment
      ORDER BY users_count DESC
    `;
  }

  private buildPaymentSegmentQuery(tables: AnalyticsTables) {
    return `
      WITH paid_orders AS (${this.buildPaidOrdersSql(tables)})
      SELECT segment, COUNT(*)::bigint AS users_count
      FROM (
        SELECT
          u.id,
          CASE
            WHEN COALESCE(po.paid_orders_total, 0) = 0 THEN '未付费'
            WHEN COALESCE(po.paid_orders_total, 0) = 1 THEN '单次付费'
            WHEN COALESCE(po.paid_orders_total, 0) <= 3 THEN '复购用户'
            ELSE '高频付费'
          END AS segment
        FROM users u
        LEFT JOIN (
          SELECT user_id, COUNT(*)::bigint AS paid_orders_total
          FROM paid_orders
          GROUP BY user_id
        ) po ON po.user_id = u.id
        WHERE u.app_id = $1::uuid AND u.deleted_at IS NULL
      ) t
      GROUP BY segment
      ORDER BY users_count DESC
    `;
  }

  private buildConversionSummaryQuery(tables: AnalyticsTables) {
    return `
      WITH activity_events AS (${this.buildActivityUnionSql(tables)}),
      paid_orders AS (${this.buildPaidOrdersSql(tables)}),
      cohort_users AS (
        SELECT id, last_login_at
        FROM users
        WHERE app_id = $1::uuid AND deleted_at IS NULL AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
      )
      SELECT
        COUNT(*)::bigint AS registered_users,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = cohort_users.id))::bigint AS activated_users,
        COUNT(*) FILTER (WHERE last_login_at IS NOT NULL OR EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = cohort_users.id))::bigint AS first_login_users,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM paid_orders p WHERE p.user_id = cohort_users.id))::bigint AS first_paid_users,
        COUNT(*) FILTER (
          WHERE (
            SELECT COUNT(*) FROM paid_orders p WHERE p.user_id = cohort_users.id
          ) >= 2
        )::bigint AS repeat_paid_users
      FROM cohort_users
    `;
  }

  private buildPaymentTrendQuery(tables: AnalyticsTables) {
    return `
      WITH periods AS (
        SELECT generate_series(
          date_trunc($5::text, timezone($4::text, $2::timestamptz)),
          date_trunc($5::text, timezone($4::text, $3::timestamptz)),
          interval '${'__STEP__'}'
        ) AS period_start
      ),
      paid_orders AS (${this.buildPaidOrdersSql(tables)}),
      payment_stats AS (
        SELECT
          date_trunc($5::text, timezone($4::text, paid_at)) AS period_start,
          COUNT(DISTINCT user_id)::bigint AS paid_users,
          COALESCE(SUM(amount_total), 0)::numeric AS revenue,
          COUNT(DISTINCT user_id) FILTER (
            WHERE user_id IN (
              SELECT user_id FROM paid_orders GROUP BY user_id HAVING COUNT(*) >= 2
            )
          )::bigint AS repeat_buyers
        FROM paid_orders
        WHERE paid_at >= $2::timestamptz AND paid_at <= $3::timestamptz
        GROUP BY 1
      )
      SELECT
        to_char(periods.period_start, '${'__FORMAT__'}') AS period,
        COALESCE(payment_stats.paid_users, 0)::bigint AS paid_users,
        COALESCE(payment_stats.revenue, 0)::numeric AS revenue,
        COALESCE(payment_stats.repeat_buyers, 0)::bigint AS repeat_buyers
      FROM periods
      LEFT JOIN payment_stats ON payment_stats.period_start = periods.period_start
      ORDER BY periods.period_start ASC
    `;
  }

  private buildOverviewTrendFactsQuery() {
    return `
      WITH periods AS (
        SELECT generate_series(
          date_trunc($5::text, $3::date::timestamp),
          date_trunc($5::text, $4::date::timestamp),
          interval '__STEP__'
        ) AS period_start
      ),
      period_ranges AS (
        SELECT
          period_start,
          COALESCE(
            LEAD(period_start) OVER (ORDER BY period_start ASC),
            period_start + interval '__STEP__'
          ) AS period_end_exclusive
        FROM periods
      ),
      user_totals AS (
        SELECT
          pr.period_start,
          COUNT(u.id)::bigint AS users_total
        FROM period_ranges pr
        LEFT JOIN users u
          ON u.app_id = $1::uuid
         AND u.deleted_at IS NULL
         AND timezone($2::text, u.created_at) < pr.period_end_exclusive
        GROUP BY pr.period_start
      ),
      daily AS (
        SELECT
          date_trunc($5::text, fact_day::timestamp) AS period_start,
          SUM(registrations_count)::bigint AS registrations,
          SUM(active_users_count)::bigint AS active_users,
          SUM(paid_users_count)::bigint AS paid_users,
          SUM(revenue_amount)::numeric AS revenue
        FROM app_user_daily_facts
        WHERE app_id = $1::uuid
          AND timezone = $2::text
          AND fact_day >= $3::date
          AND fact_day <= $4::date
        GROUP BY 1
      )
      SELECT
        to_char(periods.period_start, '__FORMAT__') AS period,
        COALESCE(daily.registrations, 0)::bigint AS registrations,
        COALESCE(ut.users_total, 0)::bigint AS users_total,
        COALESCE(daily.active_users, 0)::bigint AS active_users,
        COALESCE(daily.paid_users, 0)::bigint AS paid_users,
        COALESCE(daily.revenue, 0)::numeric AS revenue
      FROM periods
      LEFT JOIN daily ON daily.period_start = periods.period_start
      LEFT JOIN user_totals ut ON ut.period_start = periods.period_start
      ORDER BY periods.period_start ASC
    `;
  }

  private buildGrowthTrendFactsQuery() {
    return `
      WITH periods AS (
        SELECT generate_series(
          date_trunc($5::text, $3::date::timestamp),
          date_trunc($5::text, $4::date::timestamp),
          interval '__STEP__'
        ) AS period_start
      ),
      period_ranges AS (
        SELECT
          period_start,
          COALESCE(
            LEAD(period_start) OVER (ORDER BY period_start ASC),
            period_start + interval '__STEP__'
          ) AS period_end_exclusive
        FROM periods
      ),
      user_totals AS (
        SELECT
          pr.period_start,
          COUNT(u.id)::bigint AS users_total
        FROM period_ranges pr
        LEFT JOIN users u
          ON u.app_id = $1::uuid
         AND u.deleted_at IS NULL
         AND timezone($2::text, u.created_at) < pr.period_end_exclusive
        GROUP BY pr.period_start
      ),
      daily AS (
        SELECT
          date_trunc($5::text, fact_day::timestamp) AS period_start,
          SUM(registrations_count)::bigint AS registrations,
          SUM(activated_registrations_count)::bigint AS activated_users,
          SUM(first_login_registrations_count)::bigint AS login_users,
          SUM(active_users_count)::bigint AS active_users
        FROM app_user_daily_facts
        WHERE app_id = $1::uuid
          AND timezone = $2::text
          AND fact_day >= $3::date
          AND fact_day <= $4::date
        GROUP BY 1
      )
      SELECT
        to_char(periods.period_start, '__FORMAT__') AS period,
        COALESCE(daily.registrations, 0)::bigint AS registrations,
        COALESCE(ut.users_total, 0)::bigint AS users_total,
        COALESCE(daily.activated_users, 0)::bigint AS activated_users,
        COALESCE(daily.login_users, 0)::bigint AS login_users,
        COALESCE(daily.active_users, 0)::bigint AS active_users
      FROM periods
      LEFT JOIN daily ON daily.period_start = periods.period_start
      LEFT JOIN user_totals ut ON ut.period_start = periods.period_start
      ORDER BY periods.period_start ASC
    `;
  }

  private buildRetentionCohortFactsQuery() {
    return `
      SELECT
        to_char(date_trunc($5::text, cohort_day::timestamp), '__FORMAT__') AS cohort_period,
        SUM(cohort_size)::bigint AS cohort_size,
        COALESCE(SUM(d1_users_count)::numeric / NULLIF(SUM(cohort_size), 0), 0)::numeric AS d1_rate,
        COALESCE(SUM(d3_users_count)::numeric / NULLIF(SUM(cohort_size), 0), 0)::numeric AS d3_rate,
        COALESCE(SUM(d7_users_count)::numeric / NULLIF(SUM(cohort_size), 0), 0)::numeric AS d7_rate,
        COALESCE(SUM(d14_users_count)::numeric / NULLIF(SUM(cohort_size), 0), 0)::numeric AS d14_rate,
        COALESCE(SUM(d30_users_count)::numeric / NULLIF(SUM(cohort_size), 0), 0)::numeric AS d30_rate
      FROM app_user_cohort_facts
      WHERE app_id = $1::uuid
        AND timezone = $2::text
        AND cohort_day >= $3::date
        AND cohort_day <= $4::date
      GROUP BY 1
      ORDER BY MIN(cohort_day) ASC
    `;
  }

  private buildReactivationTrendFactsQuery() {
    return `
      WITH periods AS (
        SELECT generate_series(
          date_trunc($5::text, $3::date::timestamp),
          date_trunc($5::text, $4::date::timestamp),
          interval '__STEP__'
        ) AS period_start
      ),
      period_ranges AS (
        SELECT
          period_start,
          COALESCE(
            LEAD(period_start) OVER (ORDER BY period_start ASC),
            period_start + interval '__STEP__'
          ) AS period_end_exclusive
        FROM periods
      ),
      user_totals AS (
        SELECT
          pr.period_start,
          COUNT(u.id)::bigint AS users_total
        FROM period_ranges pr
        LEFT JOIN users u
          ON u.app_id = $1::uuid
         AND u.deleted_at IS NULL
         AND timezone($2::text, u.created_at) < pr.period_end_exclusive
        GROUP BY pr.period_start
      ),
      daily AS (
        SELECT
          date_trunc($5::text, fact_day::timestamp) AS period_start,
          SUM(reactivated_users_count)::bigint AS reactivated_users
        FROM app_user_daily_facts
        WHERE app_id = $1::uuid
          AND timezone = $2::text
          AND fact_day >= $3::date
          AND fact_day <= $4::date
        GROUP BY 1
      )
      SELECT
        to_char(periods.period_start, '__FORMAT__') AS period,
        COALESCE(ut.users_total, 0)::bigint AS users_total,
        COALESCE(daily.reactivated_users, 0)::bigint AS reactivated_users
      FROM periods
      LEFT JOIN daily ON daily.period_start = periods.period_start
      LEFT JOIN user_totals ut ON ut.period_start = periods.period_start
      ORDER BY periods.period_start ASC
    `;
  }

  private buildPaymentTrendFactsQuery() {
    return `
      WITH periods AS (
        SELECT generate_series(
          date_trunc($5::text, $3::date::timestamp),
          date_trunc($5::text, $4::date::timestamp),
          interval '__STEP__'
        ) AS period_start
      ),
      period_ranges AS (
        SELECT
          period_start,
          COALESCE(
            LEAD(period_start) OVER (ORDER BY period_start ASC),
            period_start + interval '__STEP__'
          ) AS period_end_exclusive
        FROM periods
      ),
      user_totals AS (
        SELECT
          pr.period_start,
          COUNT(u.id)::bigint AS users_total
        FROM period_ranges pr
        LEFT JOIN users u
          ON u.app_id = $1::uuid
         AND u.deleted_at IS NULL
         AND timezone($2::text, u.created_at) < pr.period_end_exclusive
        GROUP BY pr.period_start
      ),
      daily AS (
        SELECT
          date_trunc($5::text, fact_day::timestamp) AS period_start,
          SUM(paid_users_count)::bigint AS paid_users,
          SUM(revenue_amount)::numeric AS revenue,
          SUM(repeat_buyers_count)::bigint AS repeat_buyers
        FROM app_user_daily_facts
        WHERE app_id = $1::uuid
          AND timezone = $2::text
          AND fact_day >= $3::date
          AND fact_day <= $4::date
        GROUP BY 1
      )
      SELECT
        to_char(periods.period_start, '__FORMAT__') AS period,
        COALESCE(ut.users_total, 0)::bigint AS users_total,
        COALESCE(daily.paid_users, 0)::bigint AS paid_users,
        COALESCE(daily.revenue, 0)::numeric AS revenue,
        COALESCE(daily.repeat_buyers, 0)::bigint AS repeat_buyers
      FROM periods
      LEFT JOIN daily ON daily.period_start = periods.period_start
      LEFT JOIN user_totals ut ON ut.period_start = periods.period_start
      ORDER BY periods.period_start ASC
    `;
  }

  private buildConversionSummaryFactsQuery() {
    return `
      SELECT
        COALESCE(SUM(registered_users_count), 0)::bigint AS registered_users,
        COALESCE(SUM(activated_users_count), 0)::bigint AS activated_users,
        COALESCE(SUM(first_login_users_count), 0)::bigint AS first_login_users,
        COALESCE(SUM(first_paid_users_count), 0)::bigint AS first_paid_users,
        COALESCE(SUM(repeat_paid_users_count), 0)::bigint AS repeat_paid_users
      FROM app_user_conversion_facts
      WHERE app_id = $1::uuid
        AND timezone = $2::text
        AND fact_day >= $3::date
        AND fact_day <= $4::date
    `;
  }

  private buildSegmentSnapshotQuery(segmentType: 'membership' | 'login_method' | 'source' | 'activity' | 'payment') {
    return `
      SELECT
        segment_key AS segment,
        users_count::bigint AS users_count
      FROM app_user_segment_snapshots
      WHERE app_id = $1::uuid
        AND timezone = $2::text
        AND snapshot_day = ($3::timestamptz AT TIME ZONE $2)::date
        AND segment_type = '${segmentType}'
      ORDER BY users_count DESC, segment_key ASC
    `;
  }

  private buildUsersQuery(
    tables: AnalyticsTables,
    countOnly: boolean,
    filterSql: string,
    paginationSql = '',
    sortColumn = 'created_at',
    sortOrder = 'DESC',
  ) {
    const filterBaseSql = `
      FROM users u
      LEFT JOIN app_user_activity_summary la ON la.app_id = u.app_id AND la.user_id = u.id
      LEFT JOIN app_user_profile_summary fs ON fs.app_id = u.app_id AND fs.user_id = u.id
      LEFT JOIN app_user_payment_summary po ON po.app_id = u.app_id AND po.user_id = u.id
      WHERE u.app_id = $1::uuid ${filterSql}
    `;

    if (countOnly) {
      return `
        SELECT COUNT(*)::bigint AS total
        ${filterBaseSql}
      `;
    }

    return `
      WITH filtered_users AS (
        SELECT
          u.id,
          u.email,
          u.phone,
          COALESCE(NULLIF(u.display_name, ''), NULLIF(u.full_name, ''), u.email) AS display_name,
          u.is_active,
          u.deleted_at,
          u.deactivated_at,
          u.deactivated_email,
          u.deactivated_phone,
          u.membership_type::text AS membership_type,
          COALESCE(fs.resolved_login_method, ${this.loginMethodExpr('u')}) AS login_method,
          COALESCE(fs.first_source, COALESCE(fs.resolved_login_method, ${this.loginMethodExpr('u')})) AS source,
          u.created_at,
          u.last_login_at,
          la.last_activity_at,
          la.recent_event,
          COALESCE(po.paid_orders_total, 0)::bigint AS paid_orders_total,
          COALESCE(po.paid_amount_total, 0)::numeric AS paid_amount_total,
          po.recent_order,
          po.recent_recharge
        ${filterBaseSql}
      ),
      points_wallets AS (${this.buildPointsWalletSql(tables, 'SELECT id FROM filtered_users')}),
      enriched_users AS (
        SELECT
          fu.*,
          COALESCE(pw.balance, 0)::numeric AS points_balance,
          COALESCE(ai.ai_requests_total, 0)::bigint AS ai_requests_total,
          COALESCE(ai.ai_total_tokens, 0)::bigint AS ai_total_tokens,
          COALESCE(ai.ai_points_spent_total, 0)::numeric AS ai_points_spent_total
        FROM filtered_users fu
        LEFT JOIN app_user_ai_usage_summary ai ON ai.app_id = $1::uuid AND ai.user_id = fu.id
        LEFT JOIN points_wallets pw ON pw.user_id = fu.id
      ),
      paged_users AS (
        SELECT *
        FROM enriched_users
        ORDER BY ${this.buildUsersOrderBySql(undefined, sortColumn, sortOrder)}
        ${paginationSql}
      )
      SELECT
        pu.id,
        pu.email,
        pu.phone,
        pu.display_name,
        pu.is_active,
        pu.deleted_at,
        pu.deactivated_at,
        pu.deactivated_email,
        pu.deactivated_phone,
        pu.membership_type,
        pu.login_method,
        pu.source,
        pu.created_at,
        pu.last_login_at,
        pu.last_activity_at,
        pu.paid_orders_total,
        pu.paid_amount_total,
        pu.points_balance,
        pu.ai_requests_total,
        pu.ai_total_tokens,
        pu.ai_points_spent_total,
        pu.recent_event,
        pu.recent_order,
        pu.recent_recharge
      FROM paged_users pu
      ORDER BY ${this.buildUsersOrderBySql('pu', sortColumn, sortOrder)}
    `;
  }

  private buildUsersOrderBySql(alias: string | undefined, sortColumn: string, sortOrder: string) {
    const prefix = alias ? `${alias}.` : '';
    return `${prefix}${sortColumn} ${sortOrder} NULLS LAST, ${prefix}created_at DESC, ${prefix}id DESC`;
  }

  private buildUsersQueryParams(appId: string, query: ResolvedAnalyticsQuery, countOnly: boolean) {
    const params: Array<string | number | Date> = [appId];
    let index = 2;
    let filterSql = '';
    let paginationSql = '';
    if (query.accountStatus === 'deactivated') {
      filterSql += ` AND u.deleted_at IS NOT NULL`;
    } else if (query.accountStatus !== 'all') {
      filterSql += ` AND u.deleted_at IS NULL`;
    }
    if (query.createdScope === 'in_range') {
      filterSql += ` AND u.created_at >= $${index}::timestamptz AND u.created_at <= $${index + 1}::timestamptz`;
      params.push(query.from, query.to);
      index += 2;
    } else if (query.createdScope === 'out_of_range') {
      filterSql += ` AND (u.created_at < $${index}::timestamptz OR u.created_at > $${index + 1}::timestamptz)`;
      params.push(query.from, query.to);
      index += 2;
    }
    if (query.lastLoginScope === 'in_range') {
      filterSql += ` AND u.last_login_at IS NOT NULL AND u.last_login_at >= $${index}::timestamptz AND u.last_login_at <= $${index + 1}::timestamptz`;
      params.push(query.from, query.to);
      index += 2;
    } else if (query.lastLoginScope === 'out_of_range') {
      filterSql += ` AND u.last_login_at IS NOT NULL AND (u.last_login_at < $${index}::timestamptz OR u.last_login_at > $${index + 1}::timestamptz)`;
      params.push(query.from, query.to);
      index += 2;
    } else if (query.lastLoginScope === 'never') {
      filterSql += ` AND u.last_login_at IS NULL`;
    }
    if (query.membershipType) {
      filterSql += ` AND u.membership_type::text = $${index}::text`;
      params.push(query.membershipType);
      index += 1;
    }
    if (query.loginMethod) {
      filterSql += ` AND COALESCE(fs.resolved_login_method, ${this.loginMethodExpr('u')}) = $${index}::text`;
      params.push(query.loginMethod);
      index += 1;
    }
    if (query.source) {
      filterSql += ` AND COALESCE(fs.first_source, COALESCE(fs.resolved_login_method, ${this.loginMethodExpr('u')})) = $${index}::text`;
      params.push(query.source);
      index += 1;
    }
    if (query.segment === 'unactivated') {
      filterSql += ` AND la.last_activity_at IS NULL`;
    } else if (query.segment === 'active_7d') {
      filterSql += ` AND la.last_activity_at >= $${index}::timestamptz`;
      params.push(this.daysAgo(query.to, 7));
      index += 1;
    } else if (query.segment === 'active_30d') {
      filterSql += ` AND la.last_activity_at >= $${index}::timestamptz`;
      params.push(this.daysAgo(query.to, 30));
      index += 1;
    } else if (query.segment === 'inactive_30d') {
      filterSql += ` AND la.last_activity_at IS NOT NULL AND la.last_activity_at < $${index}::timestamptz`;
      params.push(this.daysAgo(query.to, 30));
      index += 1;
    }
    if (query.paidStatus === 'paid') {
      filterSql += ` AND COALESCE(po.paid_orders_total, 0) > 0`;
    } else if (query.paidStatus === 'unpaid') {
      filterSql += ` AND COALESCE(po.paid_orders_total, 0) = 0`;
    }
    if (!countOnly) {
      const sortColumn = this.resolveUsersSortColumn(query.sortBy);
      const sortOrder = query.sortOrder.toUpperCase();
      paginationSql = `LIMIT $${index}::int OFFSET $${index + 1}::int`;
      params.push(query.pageSize, (query.page - 1) * query.pageSize);
      return {
        params,
        filterSql,
        paginationSql,
        sortColumn,
        sortOrder,
      };
    }
    return { params, filterSql, paginationSql, sortColumn: 'created_at', sortOrder: 'DESC' };
  }

  private resolveUsersSortColumn(value: ResolvedAnalyticsQuery['sortBy']) {
    if (value === 'paid_amount_total') return 'paid_amount_total';
    if (value === 'points_balance') return 'points_balance';
    if (value === 'ai_requests_total') return 'ai_requests_total';
    if (value === 'last_login_at') return 'last_login_at';
    return 'created_at';
  }

  private buildActivityUnionSql(tables: AnalyticsTables) {
    const branches = [
      `SELECT id AS user_id, last_login_at AS activity_at, 'login'::text AS event_name, 'auth'::text AS source
       FROM users
       WHERE app_id = $1::uuid AND deleted_at IS NULL AND last_login_at IS NOT NULL`,
    ];
    if (tables.behavior_events) {
      branches.push(`
        SELECT user_id, occurred_at AS activity_at, event_name::text AS event_name, COALESCE(NULLIF(source, ''), 'web')::text AS source
        FROM user_behavior_events
        WHERE app_id = $1::uuid AND user_id IS NOT NULL
      `);
    }
    if (tables.ai_usage_logs) {
      branches.push(`
        SELECT user_id, created_at AS activity_at, 'ai_usage'::text AS event_name, 'ai'::text AS source
        FROM ai_usage_logs
        WHERE app_id = $1::uuid AND user_id IS NOT NULL
      `);
    }
    if (tables.orders) {
      branches.push(`
        SELECT user_id, COALESCE(paid_at, created_at) AS activity_at, 'paid_order'::text AS event_name, 'payment'::text AS source
        FROM alipay_orders
        WHERE app_id = $1::uuid AND user_id IS NOT NULL AND status = 'PAID'
      `);
    }
    return branches.join(' UNION ALL ');
  }

  private buildPaidOrdersSql(tables: AnalyticsTables) {
    if (!tables.orders) {
      return `SELECT NULL::uuid AS user_id, NULL::timestamptz AS paid_at, 0::numeric AS amount_total, NULL::text AS out_trade_no WHERE false`;
    }
    return `
      SELECT user_id, COALESCE(paid_at, created_at) AS paid_at, total_amount::numeric AS amount_total, out_trade_no::text AS out_trade_no
      FROM alipay_orders
      WHERE app_id = $1::uuid AND user_id IS NOT NULL AND status = 'PAID'
    `;
  }

  private buildFirstSourceSql(tables: AnalyticsTables) {
    if (!tables.behavior_events) {
      return `SELECT NULL::uuid AS user_id, NULL::text AS source WHERE false`;
    }
    return `
      SELECT DISTINCT ON (user_id)
        user_id,
        COALESCE(NULLIF(source, ''), 'web')::text AS source
      FROM user_behavior_events
      WHERE app_id = $1::uuid AND user_id IS NOT NULL
      ORDER BY user_id, occurred_at ASC
    `;
  }

  private buildAiUsageSql(tables: AnalyticsTables, userScopeSql?: string) {
    if (!tables.ai_usage_logs) {
      return `SELECT NULL::uuid AS user_id, 0::bigint AS total_tokens, 0::numeric AS points_cost, NULL::timestamptz AS last_request_at WHERE false`;
    }
    const userScopeClause = userScopeSql ? `AND user_id IN (${userScopeSql})` : '';
    const pointsCostExpr = tables.points_ledger
      ? `COALESCE((
          SELECT COALESCE(NULLIF(ledger.metadata_json->>'points_cost', '')::numeric(20, 2), ABS(ledger.delta))
          FROM user_ai_points_ledger ledger
          WHERE ledger.app_id = ai_usage_logs.app_id
            AND ledger.user_id = ai_usage_logs.user_id
            AND ledger.reference_type = 'ai_usage'
            AND (
              (ai_usage_logs.request_id IS NOT NULL AND ai_usage_logs.request_id <> '' AND ledger.metadata_json->>'request_id' = ai_usage_logs.request_id)
              OR (ai_usage_logs.request_id IS NOT NULL AND ai_usage_logs.request_id <> '' AND ledger.reference_id = CONCAT(ai_usage_logs.global_model_id::text, ':', ai_usage_logs.request_id))
            )
          ORDER BY ledger.created_at DESC
          LIMIT 1
        ), 0::numeric)`
      : '0::numeric';
    return `
      SELECT
        user_id,
        COALESCE(total_tokens, 0)::bigint AS total_tokens,
        ${pointsCostExpr} AS points_cost,
        created_at AS last_request_at
      FROM ai_usage_logs
      WHERE app_id = $1::uuid AND user_id IS NOT NULL ${userScopeClause}
    `;
  }

  private buildPointsWalletSql(tables: AnalyticsTables, userScopeSql?: string) {
    if (!tables.points_wallets) {
      return `SELECT NULL::uuid AS user_id, 0::numeric AS balance WHERE false`;
    }
    const userScopeClause = userScopeSql ? `AND user_id IN (${userScopeSql})` : '';
    return `SELECT user_id, balance::numeric AS balance FROM user_ai_points_wallets WHERE app_id = $1::uuid ${userScopeClause}`;
  }

  private async ensureAppExists(appId: string): Promise<AppSummary> {
    const app = await this.prisma.app.findUnique({
      where: { id: appId },
      select: { id: true, slug: true, name: true },
    });
    if (!app) {
      throw new NotFoundException('app not found');
    }
    return app;
  }

  private resolveQuery(raw: PlatformAppAnalyticsQuery): ResolvedAnalyticsQuery {
    const days = this.normalizePositiveInt(raw.days, 30, 7, 365);
    const to = raw.to ? this.parseDate(raw.to, 'invalid to date') : new Date();
    const from = raw.from ? this.parseDate(raw.from, 'invalid from date') : new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be <= to');
    }
    const timezone = this.normalizeTimezone(raw.timezone);
    const derivedDays = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
    const granularity = this.normalizeGranularity(raw.granularity, derivedDays);
    const page = this.normalizePositiveInt(raw.page, 1, 1, 100000);
    const pageSize = this.normalizePositiveInt(raw.page_size, 20, 1, 100);
    const membershipType = this.normalizeMembershipType(raw.membership_type);
    const loginMethod = this.normalizeLoginMethod(raw.login_method);
    const source = this.normalizeOptionalString(raw.source, 64);
    const segment = this.normalizeSegment(raw.segment);
    const createdScope = this.normalizeCreatedScope(raw.created_scope);
    const lastLoginScope = this.normalizeLastLoginScope(raw.last_login_scope);
    const paidStatus = this.normalizePaidStatus(raw.paid_status);
    const accountStatus = this.normalizeAccountStatus(raw.account_status);
    const sortBy = this.normalizeUsersSortBy(raw.sort_by);
    const sortOrder = String(raw.sort_order || '').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
    const seriesStep = granularity === 'month' ? '1 month' : granularity === 'week' ? '1 week' : '1 day';
    const periodFormat = granularity === 'month' ? 'YYYY-MM' : granularity === 'week' ? 'YYYY-MM-DD' : 'YYYY-MM-DD';
    return {
      from,
      to,
      days: derivedDays,
      timezone,
      granularity,
      seriesStep,
      periodFormat,
      page,
      pageSize,
      segment,
      createdScope,
      lastLoginScope,
      membershipType,
      loginMethod,
      source,
      paidStatus,
      accountStatus,
      sortBy,
      sortOrder,
    };
  }

  private serializeRange(query: ResolvedAnalyticsQuery) {
    return {
      days: query.days,
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      timezone: query.timezone,
      granularity: query.granularity,
    };
  }

  private normalizeGranularity(value: string | undefined, days: number): 'day' | 'week' | 'month' {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'day' || raw === 'week' || raw === 'month') {
      return raw;
    }
    if (days > 180) return 'month';
    if (days > 60) return 'week';
    return 'day';
  }

  private normalizeMembershipType(value: string | undefined): string | undefined {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return undefined;
    return raw === 'FREE' || raw === 'PREMIUM' ? raw : undefined;
  }

  private normalizeLoginMethod(value: string | undefined): 'wechat' | 'phone' | 'email' | undefined {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'wechat' || raw === 'phone' || raw === 'email') return raw;
    return undefined;
  }

  private normalizePaidStatus(value: string | undefined): 'paid' | 'unpaid' | undefined {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'paid' || raw === 'unpaid') return raw;
    return undefined;
  }

  private normalizeAccountStatus(value: string | undefined): 'active' | 'deactivated' | 'all' {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'deactivated' || raw === 'all') return raw;
    return 'active';
  }

  private normalizeUsersSortBy(
    value: string | undefined,
  ): 'created_at' | 'paid_amount_total' | 'points_balance' | 'ai_requests_total' | 'last_login_at' {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'paid_amount_total' || raw === 'points_balance' || raw === 'ai_requests_total' || raw === 'last_login_at') {
      return raw;
    }
    return 'created_at';
  }

  private normalizeCreatedScope(value: string | undefined): 'in_range' | 'out_of_range' | undefined {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'in_range' || raw === 'out_of_range') return raw;
    return undefined;
  }

  private normalizeLastLoginScope(value: string | undefined): 'in_range' | 'out_of_range' | 'never' | undefined {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'in_range' || raw === 'out_of_range' || raw === 'never') return raw;
    return undefined;
  }

  private normalizeSegment(
    value: string | undefined,
  ): 'unactivated' | 'active_7d' | 'active_30d' | 'inactive_30d' | undefined {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'unactivated' || raw === 'active_7d' || raw === 'active_30d' || raw === 'inactive_30d') {
      return raw;
    }
    return undefined;
  }

  private normalizeOptionalString(value: string | undefined, max: number): string | undefined {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return undefined;
    return raw.slice(0, max);
  }

  private normalizeTimezone(value: string | undefined): string {
    const raw = String(value || '').trim();
    if (!raw) return 'Asia/Shanghai';
    return /^[A-Za-z_\/+-]+$/.test(raw) ? raw : 'Asia/Shanghai';
  }

  private finalizeSeriesSql(sql: string, query: ResolvedAnalyticsQuery): string {
    return sql.replaceAll('__STEP__', query.seriesStep).replaceAll('__FORMAT__', query.periodFormat);
  }

  private parseDate(value: string, message: string): Date {
    const parsed = new Date(String(value || '').trim());
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(message);
    }
    return parsed;
  }

  private normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const normalized = Math.floor(num);
    if (normalized < min) return min;
    if (normalized > max) return max;
    return normalized;
  }

  private daysAgo(base: Date, days: number) {
    return new Date(base.getTime() - days * 24 * 60 * 60 * 1000);
  }

  private buildRefreshKey(appId: string, query: ResolvedAnalyticsQuery) {
    return `${appId}:${query.timezone}:${this.toDateOnly(query.from)}:${this.toDateOnly(query.to)}`;
  }

  private async prepareFactsForRead(appId: string, query: ResolvedAnalyticsQuery, tables: AnalyticsTables): Promise<AnalyticsFactsReadState> {
    const refreshKey = this.buildRefreshKey(appId, query);
    const state = await this.factsReadState.getState(appId, query, tables);
    if (!this.factsReadState.hasMaterializedFacts(state.counts) && !this.factsRefreshTouchedAt.has(refreshKey)) {
      this.queueFactsRefresh(query, appId, tables, 'cold');
      return this.factsReadState.buildReadState(state, this.isFactsRefreshInProgress(refreshKey));
    }
    if (this.factsReadState.shouldRefreshFacts(state)) {
      this.queueFactsRefresh(query, appId, tables, this.factsReadState.hasMaterializedFacts(state.counts) ? 'stale' : 'cold');
    }
    return this.factsReadState.buildReadState(state, this.isFactsRefreshInProgress(refreshKey));
  }

  private queueFactsRefresh(
    query: ResolvedAnalyticsQuery,
    appId: string,
    tables: AnalyticsTables,
    priority: AnalyticsFactsRefreshJob['priority'],
  ) {
    const refreshKey = this.buildRefreshKey(appId, query);
    const lastTouchedAt = this.factsRefreshTouchedAt.get(refreshKey) || 0;
    if (Date.now() - lastTouchedAt < ANALYTICS_FACTS_REFRESH_TTL_MS) {
      this.factsRefreshQueue.delete(refreshKey);
      return;
    }
    if (this.factsRefreshInFlight.has(refreshKey)) {
      return;
    }
    const existing = this.factsRefreshQueue.get(refreshKey);
    this.factsRefreshQueue.set(refreshKey, {
      appId,
      query,
      tables,
      priority: existing?.priority === 'cold' || priority === 'cold' ? 'cold' : 'stale',
      queuedAt: existing?.queuedAt || Date.now(),
    });
    void this.refreshStateRepository.persistQueued(refreshKey, appId, query).catch((error: any) => {
      this.logger.warn(`analytics refresh state persist failed for ${refreshKey}: ${error?.message || error}`);
    });
  }

  @Interval(ANALYTICS_BACKGROUND_REFRESH_INTERVAL_MS)
  private async processFactsRefreshQueue() {
    if (this.factsRefreshWorkerRunning) {
      return;
    }
    this.factsRefreshWorkerRunning = true;
    try {
      if (!this.schemaHealth.isReadModelReady() && !(await this.schemaHealth.verifyReadModelSchema())) {
        return;
      }
      if (!this.factsRefreshStateRecovered) {
        await this.restorePersistedFactsRefreshQueue();
      }
      await this.enqueueHotWindowRefreshes();
      if (this.factsRefreshQueue.size === 0) {
        return;
      }
      const jobs = [...this.factsRefreshQueue.entries()]
        .sort((left, right) => {
          if (left[1].priority !== right[1].priority) {
            return left[1].priority === 'cold' ? -1 : 1;
          }
          return left[1].queuedAt - right[1].queuedAt;
        })
        .slice(0, ANALYTICS_BACKGROUND_REFRESH_BATCH_SIZE);

      for (const [refreshKey, job] of jobs) {
        const lastTouchedAt = this.factsRefreshTouchedAt.get(refreshKey) || 0;
        if (Date.now() - lastTouchedAt < ANALYTICS_FACTS_REFRESH_TTL_MS) {
          this.factsRefreshQueue.delete(refreshKey);
          continue;
        }
        try {
          await this.refreshStateRepository.persistQueued(refreshKey, job.appId, job.query);
          await this.refreshStateRepository.markStarted(refreshKey);
          await this.refreshAnalyticsFacts(job.appId, job.query, job.tables);
          await this.refreshStateRepository.markCompleted(refreshKey);
          this.factsRefreshQueue.delete(refreshKey);
        } catch (error: any) {
          await this.refreshStateRepository.markFailed(refreshKey, error);
          this.logger.warn(`analytics queued refresh failed for ${refreshKey}: ${error?.message || error}`);
        }
      }
    } finally {
      this.factsRefreshWorkerRunning = false;
    }
  }

  private isFactsRefreshInProgress(refreshKey: string) {
    return this.factsRefreshInFlight.has(refreshKey) || this.factsRefreshQueue.has(refreshKey);
  }

  private startOfDay(value: Date) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  private async refreshAnalyticsFacts(appId: string, query: ResolvedAnalyticsQuery, tables: AnalyticsTables) {
    const fromDate = this.toDateOnly(query.from);
    const toDate = this.toDateOnly(query.to);
    const refreshKey = this.buildRefreshKey(appId, query);
    const now = Date.now();
    const lastTouchedAt = this.factsRefreshTouchedAt.get(refreshKey) || 0;
    if (now - lastTouchedAt < ANALYTICS_FACTS_REFRESH_TTL_MS) {
      return;
    }

    const existing = this.factsRefreshInFlight.get(refreshKey);
    if (existing) {
      await existing;
      return;
    }

    const refreshPromise = (async () => {
      await this.refreshStateRepository.persistQueued(refreshKey, appId, query);
      await this.refreshStateRepository.markStarted(refreshKey);
      await Promise.all([
        this.refreshDailyFacts(appId, query.timezone, fromDate, toDate, tables),
        this.refreshCohortFacts(appId, query.timezone, fromDate, toDate, tables),
        this.refreshConversionFacts(appId, query.timezone, fromDate, toDate, tables),
        this.refreshSegmentSnapshot(appId, query.timezone, toDate, tables),
        this.refreshUserSummaries(appId, tables),
      ]);
      this.factsRefreshTouchedAt.set(refreshKey, Date.now());
      this.responseCache.clear();
      await this.refreshStateRepository.markCompleted(refreshKey);
    })();

    this.factsRefreshInFlight.set(refreshKey, refreshPromise);
    try {
      await refreshPromise;
    } catch (error) {
      await this.refreshStateRepository.markFailed(refreshKey, error);
      throw error;
    } finally {
      this.factsRefreshInFlight.delete(refreshKey);
    }
  }

  private async restorePersistedFactsRefreshQueue() {
    const rows = await this.refreshStateRepository.listRecentRefreshStates();
    const tables = await this.sourceTables.resolveAvailability();
    for (const row of rows) {
      const query = this.buildRefreshQueryFromStateRow(row);
      const refreshKey = row.scope_key || this.buildRefreshKey(row.app_id, query);
      const completedAt = this.toNullableDate(row.last_refresh_completed_at);
      if (completedAt) {
        this.factsRefreshTouchedAt.set(refreshKey, completedAt.getTime());
      }
      if (this.shouldQueuePersistedRefresh(row, completedAt)) {
        this.factsRefreshQueue.set(refreshKey, {
          appId: row.app_id,
          query,
          tables,
          priority: completedAt ? 'stale' : 'cold',
          queuedAt: completedAt?.getTime() || Date.now(),
        });
      }
    }
    this.factsRefreshStateRecovered = true;
  }

  private async enqueueHotWindowRefreshes(force = false) {
    if (!force && Date.now() - this.lastHotWindowEnqueueAt < ANALYTICS_HOT_WINDOW_ENQUEUE_INTERVAL_MS) {
      return;
    }
    const rows = await this.refreshStateRepository.listHotRefreshWindows();
    if (!rows.length) {
      this.lastHotWindowEnqueueAt = Date.now();
      return;
    }
    const tables = await this.sourceTables.resolveAvailability();
    for (const row of rows) {
      for (const days of ANALYTICS_HOT_WINDOW_DAYS) {
        const query = this.resolveQuery({
          days: String(days),
          timezone: row.timezone,
        });
        this.queueFactsRefresh(query, row.app_id, tables, 'stale');
      }
    }
    this.lastHotWindowEnqueueAt = Date.now();
  }

  private buildRefreshQueryFromStateRow(row: AnalyticsFactRefreshStateRow): ResolvedAnalyticsQuery {
    const fromDay = this.toDateOnlyValue(row.from_day);
    const toDay = this.toDateOnlyValue(row.to_day);
    return this.resolveQuery({
      from: `${fromDay}T00:00:00.000Z`,
      to: `${toDay}T23:59:59.999Z`,
      timezone: row.timezone,
    });
  }

  private shouldQueuePersistedRefresh(row: AnalyticsFactRefreshStateRow, completedAt: Date | null) {
    if (!completedAt) {
      return true;
    }
    if (row.last_error) {
      return true;
    }
    return Date.now() - completedAt.getTime() >= ANALYTICS_FACTS_REFRESH_TTL_MS;
  }

  private async refreshDailyFacts(appId: string, timezone: string, fromDate: string, toDate: string, tables: AnalyticsTables) {
    await this.prisma.$executeRawUnsafe(
      `
      DELETE FROM app_user_daily_facts
      WHERE app_id = $1::uuid AND timezone = $2::text AND fact_day >= $3::date AND fact_day <= $4::date
      `,
      appId,
      timezone,
      fromDate,
      toDate,
    );

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO app_user_daily_facts (
        app_id, timezone, fact_day, registrations_count, activated_registrations_count, first_login_registrations_count,
        active_users_count, paid_users_count, revenue_amount, reactivated_users_count, repeat_buyers_count, created_at, updated_at
      )
      WITH days AS (
        SELECT generate_series($3::date, $4::date, interval '1 day')::date AS fact_day
      ),
      activity_events AS (${this.buildActivityUnionSql(tables)}),
      paid_orders AS (${this.buildPaidOrdersSql(tables)}),
      registration_stats AS (
        SELECT
          timezone($2::text, u.created_at)::date AS fact_day,
          COUNT(*)::bigint AS registrations_count,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = u.id))::bigint AS activated_registrations_count,
          COUNT(*) FILTER (WHERE u.last_login_at IS NOT NULL OR EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = u.id))::bigint AS first_login_registrations_count
        FROM users u
        WHERE u.app_id = $1::uuid
          AND u.deleted_at IS NULL
          AND timezone($2::text, u.created_at)::date >= $3::date
          AND timezone($2::text, u.created_at)::date <= $4::date
        GROUP BY 1
      ),
      activity_daily AS (
        SELECT
          timezone($2::text, activity_at)::date AS fact_day,
          COUNT(DISTINCT user_id)::bigint AS active_users_count
        FROM activity_events
        WHERE timezone($2::text, activity_at)::date >= $3::date
          AND timezone($2::text, activity_at)::date <= $4::date
        GROUP BY 1
      ),
      payment_daily AS (
        SELECT
          timezone($2::text, paid_at)::date AS fact_day,
          COUNT(DISTINCT user_id)::bigint AS paid_users_count,
          COALESCE(SUM(amount_total), 0)::numeric AS revenue_amount,
          COUNT(DISTINCT user_id) FILTER (
            WHERE user_id IN (SELECT user_id FROM paid_orders GROUP BY user_id HAVING COUNT(*) >= 2)
          )::bigint AS repeat_buyers_count
        FROM paid_orders
        WHERE timezone($2::text, paid_at)::date >= $3::date
          AND timezone($2::text, paid_at)::date <= $4::date
        GROUP BY 1
      ),
      reactivation_daily AS (
        SELECT
          timezone($2::text, first_activity_at)::date AS fact_day,
          COUNT(*)::bigint AS reactivated_users_count
        FROM (
          SELECT user_id, MIN(activity_at) AS first_activity_at
          FROM activity_events
          WHERE timezone($2::text, activity_at)::date >= $3::date
            AND timezone($2::text, activity_at)::date <= $4::date
          GROUP BY user_id
        ) firsts
        WHERE EXISTS (
          SELECT 1 FROM activity_events older
          WHERE older.user_id = firsts.user_id
            AND older.activity_at < firsts.first_activity_at - interval '30 day'
        )
        GROUP BY 1
      )
      SELECT
        $1::uuid,
        $2::text,
        days.fact_day,
        COALESCE(r.registrations_count, 0)::bigint,
        COALESCE(r.activated_registrations_count, 0)::bigint,
        COALESCE(r.first_login_registrations_count, 0)::bigint,
        COALESCE(a.active_users_count, 0)::bigint,
        COALESCE(p.paid_users_count, 0)::bigint,
        COALESCE(p.revenue_amount, 0)::numeric,
        COALESCE(rd.reactivated_users_count, 0)::bigint,
        COALESCE(p.repeat_buyers_count, 0)::bigint,
        now(),
        now()
      FROM days
      LEFT JOIN registration_stats r ON r.fact_day = days.fact_day
      LEFT JOIN activity_daily a ON a.fact_day = days.fact_day
      LEFT JOIN payment_daily p ON p.fact_day = days.fact_day
      LEFT JOIN reactivation_daily rd ON rd.fact_day = days.fact_day
      ON CONFLICT (app_id, timezone, fact_day) DO UPDATE
      SET registrations_count = EXCLUDED.registrations_count,
          activated_registrations_count = EXCLUDED.activated_registrations_count,
          first_login_registrations_count = EXCLUDED.first_login_registrations_count,
          active_users_count = EXCLUDED.active_users_count,
          paid_users_count = EXCLUDED.paid_users_count,
          revenue_amount = EXCLUDED.revenue_amount,
          reactivated_users_count = EXCLUDED.reactivated_users_count,
          repeat_buyers_count = EXCLUDED.repeat_buyers_count,
          updated_at = EXCLUDED.updated_at
      `,
      appId,
      timezone,
      fromDate,
      toDate,
    );
  }

  private async refreshCohortFacts(appId: string, timezone: string, fromDate: string, toDate: string, tables: AnalyticsTables) {
    await this.prisma.$executeRawUnsafe(
      `
      DELETE FROM app_user_cohort_facts
      WHERE app_id = $1::uuid AND timezone = $2::text AND cohort_day >= $3::date AND cohort_day <= $4::date
      `,
      appId,
      timezone,
      fromDate,
      toDate,
    );

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO app_user_cohort_facts (
        app_id, timezone, cohort_day, cohort_size, d1_users_count, d3_users_count, d7_users_count, d14_users_count, d30_users_count, created_at, updated_at
      )
      WITH activity_events AS (${this.buildActivityUnionSql(tables)}),
      cohort_users AS (
        SELECT id, created_at, timezone($2::text, created_at)::date AS cohort_day
        FROM users
        WHERE app_id = $1::uuid
          AND deleted_at IS NULL
          AND timezone($2::text, created_at)::date >= $3::date
          AND timezone($2::text, created_at)::date <= $4::date
      )
      SELECT
        $1::uuid,
        $2::text,
        c.cohort_day,
        COUNT(*)::bigint AS cohort_size,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = c.id AND a.activity_at >= c.created_at + interval '1 day' AND a.activity_at < c.created_at + interval '2 day'))::bigint,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = c.id AND a.activity_at >= c.created_at + interval '3 day' AND a.activity_at < c.created_at + interval '4 day'))::bigint,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = c.id AND a.activity_at >= c.created_at + interval '7 day' AND a.activity_at < c.created_at + interval '8 day'))::bigint,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = c.id AND a.activity_at >= c.created_at + interval '14 day' AND a.activity_at < c.created_at + interval '15 day'))::bigint,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = c.id AND a.activity_at >= c.created_at + interval '30 day' AND a.activity_at < c.created_at + interval '31 day'))::bigint,
        now(),
        now()
      FROM cohort_users c
      GROUP BY c.cohort_day
      ON CONFLICT (app_id, timezone, cohort_day) DO UPDATE
      SET cohort_size = EXCLUDED.cohort_size,
          d1_users_count = EXCLUDED.d1_users_count,
          d3_users_count = EXCLUDED.d3_users_count,
          d7_users_count = EXCLUDED.d7_users_count,
          d14_users_count = EXCLUDED.d14_users_count,
          d30_users_count = EXCLUDED.d30_users_count,
          updated_at = EXCLUDED.updated_at
      `,
      appId,
      timezone,
      fromDate,
      toDate,
    );
  }

  private async refreshConversionFacts(appId: string, timezone: string, fromDate: string, toDate: string, tables: AnalyticsTables) {
    await this.prisma.$executeRawUnsafe(
      `
      DELETE FROM app_user_conversion_facts
      WHERE app_id = $1::uuid AND timezone = $2::text AND fact_day >= $3::date AND fact_day <= $4::date
      `,
      appId,
      timezone,
      fromDate,
      toDate,
    );

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO app_user_conversion_facts (
        app_id, timezone, fact_day, registered_users_count, activated_users_count, first_login_users_count, first_paid_users_count, repeat_paid_users_count, created_at, updated_at
      )
      WITH activity_events AS (${this.buildActivityUnionSql(tables)}),
      paid_orders AS (${this.buildPaidOrdersSql(tables)}),
      cohort_users AS (
        SELECT id, last_login_at, timezone($2::text, created_at)::date AS fact_day
        FROM users
        WHERE app_id = $1::uuid
          AND deleted_at IS NULL
          AND timezone($2::text, created_at)::date >= $3::date
          AND timezone($2::text, created_at)::date <= $4::date
      )
      SELECT
        $1::uuid,
        $2::text,
        fact_day,
        COUNT(*)::bigint AS registered_users_count,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = cohort_users.id))::bigint AS activated_users_count,
        COUNT(*) FILTER (WHERE cohort_users.last_login_at IS NOT NULL OR EXISTS (SELECT 1 FROM activity_events a WHERE a.user_id = cohort_users.id))::bigint AS first_login_users_count,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM paid_orders p WHERE p.user_id = cohort_users.id))::bigint AS first_paid_users_count,
        COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM paid_orders p WHERE p.user_id = cohort_users.id) >= 2)::bigint AS repeat_paid_users_count,
        now(),
        now()
      FROM cohort_users
      GROUP BY fact_day
      ON CONFLICT (app_id, timezone, fact_day) DO UPDATE
      SET registered_users_count = EXCLUDED.registered_users_count,
          activated_users_count = EXCLUDED.activated_users_count,
          first_login_users_count = EXCLUDED.first_login_users_count,
          first_paid_users_count = EXCLUDED.first_paid_users_count,
          repeat_paid_users_count = EXCLUDED.repeat_paid_users_count,
          updated_at = EXCLUDED.updated_at
      `,
      appId,
      timezone,
      fromDate,
      toDate,
    );
  }

  private async refreshSegmentSnapshot(appId: string, timezone: string, snapshotDate: string, tables: AnalyticsTables) {
    await this.prisma.$executeRawUnsafe(
      `
      DELETE FROM app_user_segment_snapshots
      WHERE app_id = $1::uuid AND timezone = $2::text AND snapshot_day = $3::date
      `,
      appId,
      timezone,
      snapshotDate,
    );

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO app_user_segment_snapshots (
        app_id, timezone, snapshot_day, segment_type, segment_key, users_count, created_at, updated_at
      )
      WITH activity_events AS (${this.buildActivityUnionSql(tables)}),
      paid_orders AS (${this.buildPaidOrdersSql(tables)}),
      latest_activity AS (
        SELECT user_id, MAX(activity_at) AS last_activity_at
        FROM activity_events
        WHERE activity_at <= ($3::date + interval '1 day' - interval '1 second')
        GROUP BY user_id
      ),
      first_source AS (${this.buildFirstSourceSql(tables)}),
      paid_orders_agg AS (
        SELECT user_id, COUNT(*)::bigint AS paid_orders_total
        FROM paid_orders
        GROUP BY user_id
      ),
      base_users AS (
        SELECT
          u.id,
          COALESCE(u.membership_type::text, 'FREE') AS membership_type,
          ${this.loginMethodExpr('u')} AS login_method,
          COALESCE(fs.source, ${this.loginMethodExpr('u')}) AS source,
          la.last_activity_at,
          COALESCE(po.paid_orders_total, 0)::bigint AS paid_orders_total
        FROM users u
        LEFT JOIN latest_activity la ON la.user_id = u.id
        LEFT JOIN first_source fs ON fs.user_id = u.id
        LEFT JOIN paid_orders_agg po ON po.user_id = u.id
        WHERE u.app_id = $1::uuid
          AND u.deleted_at IS NULL
      ),
      segment_rows AS (
        SELECT 'membership'::text AS segment_type, membership_type AS segment_key, COUNT(*)::bigint AS users_count FROM base_users GROUP BY 1, 2
        UNION ALL
        SELECT 'login_method'::text, login_method, COUNT(*)::bigint FROM base_users GROUP BY 1, 2
        UNION ALL
        SELECT 'source'::text, source, COUNT(*)::bigint FROM base_users GROUP BY 1, 2
        UNION ALL
        SELECT
          'activity'::text,
          CASE
            WHEN last_activity_at IS NULL THEN '未激活'
            WHEN last_activity_at >= ($3::date::timestamp + interval '1 day' - interval '7 day') THEN '近7天活跃'
            WHEN last_activity_at >= ($3::date::timestamp + interval '1 day' - interval '30 day') THEN '近30天回访'
            ELSE '30天未活跃'
          END,
          COUNT(*)::bigint
        FROM base_users
        GROUP BY 1, 2
        UNION ALL
        SELECT
          'payment'::text,
          CASE
            WHEN paid_orders_total = 0 THEN '未付费'
            WHEN paid_orders_total = 1 THEN '单次付费'
            WHEN paid_orders_total <= 3 THEN '复购用户'
            ELSE '高频付费'
          END,
          COUNT(*)::bigint
        FROM base_users
        GROUP BY 1, 2
      )
      SELECT
        $1::uuid,
        $2::text,
        $3::date,
        segment_type,
        segment_key,
        users_count,
        now(),
        now()
      FROM segment_rows
      ON CONFLICT (app_id, timezone, snapshot_day, segment_type, segment_key) DO UPDATE
      SET users_count = EXCLUDED.users_count,
          updated_at = EXCLUDED.updated_at
      `,
      appId,
      timezone,
      snapshotDate,
    );
  }

  private async refreshUserSummaries(appId: string, tables: AnalyticsTables) {
    await Promise.all([
      this.refreshUserActivitySummary(appId, tables),
      this.refreshUserPaymentSummary(appId, tables),
      this.refreshUserAiUsageSummary(appId, tables),
      this.refreshUserProfileSummary(appId, tables),
    ]);
  }

  private async refreshUserActivitySummary(appId: string, tables: AnalyticsTables) {
    await this.prisma.$executeRawUnsafe(`DELETE FROM app_user_activity_summary WHERE app_id = $1::uuid`, appId);
    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO app_user_activity_summary (
        app_id, user_id, last_activity_at, recent_event, updated_at
      )
      WITH activity_events AS (${this.buildActivityUnionSql(tables)}),
      activity_agg AS (
        SELECT
          a.user_id,
          MAX(a.activity_at) AS last_activity_at,
          (ARRAY_REMOVE(ARRAY_AGG(a.event_name ORDER BY a.activity_at DESC), NULL))[1] AS recent_event
        FROM activity_events a
        GROUP BY a.user_id
      )
      SELECT
        $1::uuid,
        activity_agg.user_id,
        activity_agg.last_activity_at,
        activity_agg.recent_event,
        now()
      FROM activity_agg
      ON CONFLICT (app_id, user_id) DO UPDATE
      SET last_activity_at = EXCLUDED.last_activity_at,
          recent_event = EXCLUDED.recent_event,
          updated_at = EXCLUDED.updated_at
      `,
      appId,
    );
  }

  private async refreshUserPaymentSummary(appId: string, tables: AnalyticsTables) {
    await this.prisma.$executeRawUnsafe(`DELETE FROM app_user_payment_summary WHERE app_id = $1::uuid`, appId);
    if (!tables.orders) {
      return;
    }
    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO app_user_payment_summary (
        app_id, user_id, paid_orders_total, paid_amount_total, last_paid_at, recent_order, recent_recharge, updated_at
      )
      WITH paid_orders AS (${this.buildPaidOrdersSql(tables)}),
      payment_agg AS (
        SELECT
          user_id,
          COUNT(*)::bigint AS paid_orders_total,
          COALESCE(SUM(amount_total), 0)::numeric AS paid_amount_total,
          MAX(paid_at) AS last_paid_at,
          (ARRAY_REMOVE(ARRAY_AGG(out_trade_no ORDER BY paid_at DESC), NULL))[1] AS recent_order
        FROM paid_orders
        GROUP BY user_id
      )
      SELECT
        $1::uuid,
        payment_agg.user_id,
        payment_agg.paid_orders_total,
        payment_agg.paid_amount_total,
        payment_agg.last_paid_at,
        payment_agg.recent_order,
        payment_agg.last_paid_at,
        now()
      FROM payment_agg
      ON CONFLICT (app_id, user_id) DO UPDATE
      SET paid_orders_total = EXCLUDED.paid_orders_total,
          paid_amount_total = EXCLUDED.paid_amount_total,
          last_paid_at = EXCLUDED.last_paid_at,
          recent_order = EXCLUDED.recent_order,
          recent_recharge = EXCLUDED.recent_recharge,
          updated_at = EXCLUDED.updated_at
      `,
      appId,
    );
  }

  private async refreshUserAiUsageSummary(appId: string, tables: AnalyticsTables) {
    await this.prisma.$executeRawUnsafe(`DELETE FROM app_user_ai_usage_summary WHERE app_id = $1::uuid`, appId);
    if (!tables.ai_usage_logs) {
      return;
    }
    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO app_user_ai_usage_summary (
        app_id, user_id, ai_requests_total, ai_total_tokens, ai_points_spent_total, last_ai_request_at, updated_at
      )
      WITH ai_usage AS (${this.buildAiUsageSql(tables)}),
      ai_usage_agg AS (
        SELECT
          user_id,
          COUNT(*)::bigint AS ai_requests_total,
          COALESCE(SUM(total_tokens), 0)::bigint AS ai_total_tokens,
          COALESCE(SUM(points_cost), 0)::numeric AS ai_points_spent_total,
          MAX(last_request_at) AS last_ai_request_at
        FROM ai_usage
        GROUP BY user_id
      )
      SELECT
        $1::uuid,
        ai_usage_agg.user_id,
        ai_usage_agg.ai_requests_total,
        ai_usage_agg.ai_total_tokens,
        ai_usage_agg.ai_points_spent_total,
        ai_usage_agg.last_ai_request_at,
        now()
      FROM ai_usage_agg
      ON CONFLICT (app_id, user_id) DO UPDATE
      SET ai_requests_total = EXCLUDED.ai_requests_total,
          ai_total_tokens = EXCLUDED.ai_total_tokens,
          ai_points_spent_total = EXCLUDED.ai_points_spent_total,
          last_ai_request_at = EXCLUDED.last_ai_request_at,
          updated_at = EXCLUDED.updated_at
      `,
      appId,
    );
  }

  private async refreshUserProfileSummary(appId: string, tables: AnalyticsTables) {
    await this.prisma.$executeRawUnsafe(`DELETE FROM app_user_profile_summary WHERE app_id = $1::uuid`, appId);
    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO app_user_profile_summary (
        app_id, user_id, first_source, resolved_login_method, updated_at
      )
      WITH first_source AS (${this.buildFirstSourceSql(tables)})
      SELECT
        u.app_id,
        u.id,
        fs.source,
        ${this.loginMethodExpr('u')} AS resolved_login_method,
        now()
      FROM users u
      LEFT JOIN first_source fs ON fs.user_id = u.id
      WHERE u.app_id = $1::uuid
        AND u.deleted_at IS NULL
      ON CONFLICT (app_id, user_id) DO UPDATE
      SET first_source = EXCLUDED.first_source,
          resolved_login_method = EXCLUDED.resolved_login_method,
          updated_at = EXCLUDED.updated_at
      `,
      appId,
    );
  }

  private toDateOnly(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private toDateOnlyValue(value: Date | string): string {
    if (value instanceof Date) {
      return this.toDateOnly(value);
    }
    return String(value).slice(0, 10);
  }

  private loginMethodExpr(alias: string) {
    return `CASE
      WHEN ${alias}.wechat_openid IS NOT NULL AND ${alias}.wechat_openid <> '' THEN 'wechat'
      WHEN (${alias}.phone_verified = true OR (${alias}.phone IS NOT NULL AND ${alias}.phone <> '')) THEN 'phone'
      ELSE 'email'
    END`;
  }

  private toInt(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.floor(num));
  }

  private toNumber(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return this.round2(num);
  }

  private toRatio(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(1, num));
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private nullableString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized || null;
  }

  private toIsoString(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(String(value || ''));
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  }

  private toNullableIsoString(value: unknown): string | null {
    if (!value) return null;
    const iso = this.toIsoString(value);
    return iso || null;
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
