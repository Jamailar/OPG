import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';

export type BehaviorEventTrackInput = {
  event_name?: string;
  event_category?: string;
  route_path?: string;
  referrer_path?: string;
  language_code?: string;
  event_value?: unknown;
  metadata?: unknown;
  occurred_at?: string | Date;
  session_id?: string;
  source?: string;
};

type BehaviorTrackRequest = {
  appId: string;
  userId?: string | null;
  sessionId?: string | null;
  source?: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  events: BehaviorEventTrackInput[];
};

type NormalizedBehaviorEvent = {
  sessionId: string | null;
  source: string;
  eventName: string;
  eventCategory: string;
  routePath: string | null;
  referrerPath: string | null;
  languageCode: string | null;
  eventValue: number | null;
  metadataJson: string;
  occurredAt: Date;
};

@Injectable()
export class BehaviorAnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(BehaviorAnalyticsService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`behavior analytics startup warmup failed: ${error?.message || error}`);
    }
  }

  async trackEvents(input: BehaviorTrackRequest) {
    await this.ensureSchema();
    const normalized = this.normalizeEvents(input.events, input.sessionId, input.source);
    const dropped = Math.max(0, (input.events || []).length - normalized.length);
    if (!normalized.length) {
      return {
        accepted: 0,
        dropped,
      };
    }

    const userAgent = this.normalizeString(input.userAgent, 512);
    const ipAddress = this.normalizeString(input.ipAddress, 64);
    const tuples = normalized.map(
      (item) => Prisma.sql`(
        gen_random_uuid(),
        ${input.appId}::uuid,
        ${input.userId || null}::uuid,
        ${item.sessionId},
        ${item.eventName},
        ${item.eventCategory},
        ${item.routePath},
        ${item.referrerPath},
        ${item.languageCode},
        ${item.source},
        ${item.eventValue}::numeric,
        ${item.metadataJson}::jsonb,
        ${item.occurredAt}::timestamptz,
        ${userAgent},
        ${ipAddress}
      )`,
    );

    try {
      await this.prisma.$executeRaw(
        Prisma.sql`INSERT INTO user_behavior_events (
           id, app_id, user_id, session_id, event_name, event_category, route_path, referrer_path,
           language_code, source, event_value, metadata_json, occurred_at, user_agent, ip_address
         )
         VALUES ${Prisma.join(tuples)}`,
      );
    } catch (error: any) {
      this.logger.warn(`behavior event insert failed: ${error?.message || error}`);
      return {
        accepted: 0,
        dropped: (input.events || []).length,
      };
    }

    return {
      accepted: normalized.length,
      dropped,
    };
  }

  async getAppBehaviorAnalytics(appId: string, from: Date, to: Date) {
    await this.ensureSchema();

    const [overviewRows, dailyRows, topRouteRows, topEventRows, frequencyRows, transitionRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT
           COUNT(*)::bigint AS events_total,
           SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END)::bigint AS page_views,
           COUNT(DISTINCT user_id)::bigint AS active_users,
           COUNT(DISTINCT NULLIF(session_id, ''))::bigint AS active_sessions,
           COUNT(DISTINCT NULLIF(route_path, ''))::bigint AS unique_routes
         FROM user_behavior_events
         WHERE app_id = $1::uuid
           AND occurred_at >= $2::timestamptz
           AND occurred_at <= $3::timestamptz`,
        appId,
        from,
        to,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `WITH days AS (
           SELECT generate_series(
             date_trunc('day', $2::timestamptz),
             date_trunc('day', $3::timestamptz),
             interval '1 day'
           ) AS day
         ),
         events_daily AS (
           SELECT
             date_trunc('day', occurred_at) AS day,
             COUNT(*)::bigint AS events_total,
             SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END)::bigint AS page_views,
             COUNT(DISTINCT user_id)::bigint AS active_users,
             COUNT(DISTINCT NULLIF(session_id, ''))::bigint AS active_sessions
           FROM user_behavior_events
           WHERE app_id = $1::uuid
             AND occurred_at >= $2::timestamptz
             AND occurred_at <= $3::timestamptz
           GROUP BY 1
         )
         SELECT
           to_char(days.day, 'YYYY-MM-DD') AS day,
           COALESCE(events_daily.events_total, 0)::bigint AS events_total,
           COALESCE(events_daily.page_views, 0)::bigint AS page_views,
           COALESCE(events_daily.active_users, 0)::bigint AS active_users,
           COALESCE(events_daily.active_sessions, 0)::bigint AS active_sessions
         FROM days
         LEFT JOIN events_daily ON events_daily.day = days.day
         ORDER BY days.day ASC`,
        appId,
        from,
        to,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           route_path,
           COUNT(*)::bigint AS views,
           COUNT(DISTINCT user_id)::bigint AS active_users
         FROM user_behavior_events
         WHERE app_id = $1::uuid
           AND occurred_at >= $2::timestamptz
           AND occurred_at <= $3::timestamptz
           AND event_name = 'page_view'
           AND route_path IS NOT NULL
           AND route_path <> ''
         GROUP BY route_path
         ORDER BY views DESC, active_users DESC
         LIMIT 20`,
        appId,
        from,
        to,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           event_name,
           COUNT(*)::bigint AS events_count,
           COUNT(DISTINCT user_id)::bigint AS active_users
         FROM user_behavior_events
         WHERE app_id = $1::uuid
           AND occurred_at >= $2::timestamptz
           AND occurred_at <= $3::timestamptz
         GROUP BY event_name
         ORDER BY events_count DESC
         LIMIT 20`,
        appId,
        from,
        to,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `WITH user_counts AS (
           SELECT user_id, COUNT(*)::bigint AS events_count
           FROM user_behavior_events
           WHERE app_id = $1::uuid
             AND occurred_at >= $2::timestamptz
             AND occurred_at <= $3::timestamptz
             AND user_id IS NOT NULL
           GROUP BY user_id
         ),
         buckets AS (
           SELECT
             CASE
               WHEN events_count <= 3 THEN '1-3'
               WHEN events_count <= 9 THEN '4-9'
               WHEN events_count <= 29 THEN '10-29'
               ELSE '30+'
             END AS bucket
           FROM user_counts
         )
         SELECT bucket, COUNT(*)::bigint AS users_count
         FROM buckets
         GROUP BY bucket
         ORDER BY CASE bucket
           WHEN '1-3' THEN 1
           WHEN '4-9' THEN 2
           WHEN '10-29' THEN 3
           ELSE 4
         END`,
        appId,
        from,
        to,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `WITH ordered AS (
           SELECT
             id,
             COALESCE(NULLIF(session_id, ''), user_id::text) AS session_key,
             route_path,
             LEAD(route_path) OVER (
               PARTITION BY COALESCE(NULLIF(session_id, ''), user_id::text)
               ORDER BY occurred_at ASC, id ASC
             ) AS next_path
           FROM user_behavior_events
           WHERE app_id = $1::uuid
             AND occurred_at >= $2::timestamptz
             AND occurred_at <= $3::timestamptz
             AND event_name = 'page_view'
             AND route_path IS NOT NULL
             AND route_path <> ''
         )
         SELECT
           route_path AS from_path,
           next_path AS to_path,
           COUNT(*)::bigint AS transitions
         FROM ordered
         WHERE next_path IS NOT NULL
           AND next_path <> ''
           AND next_path <> route_path
         GROUP BY route_path, next_path
         ORDER BY transitions DESC
         LIMIT 20`,
        appId,
        from,
        to,
      ) as Promise<Array<Record<string, unknown>>>),
    ]);

    const overviewRow = overviewRows[0] || {};
    const eventsTotal = this.toFiniteInteger(overviewRow.events_total, 0);
    const pageViews = this.toFiniteInteger(overviewRow.page_views, 0);
    const activeUsers = this.toFiniteInteger(overviewRow.active_users, 0);
    const activeSessions = this.toFiniteInteger(overviewRow.active_sessions, 0);

    return {
      table_ready: true,
      overview: {
        events_total: eventsTotal,
        page_views: pageViews,
        interaction_events: Math.max(0, eventsTotal - pageViews),
        active_users: activeUsers,
        active_sessions: activeSessions,
        unique_routes: this.toFiniteInteger(overviewRow.unique_routes, 0),
        avg_events_per_user: activeUsers > 0 ? eventsTotal / activeUsers : 0,
        avg_events_per_session: activeSessions > 0 ? eventsTotal / activeSessions : 0,
      },
      daily: dailyRows.map((row) => ({
        day: String(row.day || ''),
        events_total: this.toFiniteInteger(row.events_total, 0),
        page_views: this.toFiniteInteger(row.page_views, 0),
        active_users: this.toFiniteInteger(row.active_users, 0),
        active_sessions: this.toFiniteInteger(row.active_sessions, 0),
      })),
      top_routes: topRouteRows.map((row) => ({
        route_path: String(row.route_path || ''),
        views: this.toFiniteInteger(row.views, 0),
        active_users: this.toFiniteInteger(row.active_users, 0),
      })),
      top_events: topEventRows.map((row) => ({
        event_name: String(row.event_name || ''),
        events_count: this.toFiniteInteger(row.events_count, 0),
        active_users: this.toFiniteInteger(row.active_users, 0),
      })),
      frequency_distribution: frequencyRows.map((row) => ({
        bucket: String(row.bucket || ''),
        users_count: this.toFiniteInteger(row.users_count, 0),
      })),
      path_transitions: transitionRows.map((row) => ({
        from_path: String(row.from_path || ''),
        to_path: String(row.to_path || ''),
        transitions: this.toFiniteInteger(row.transitions, 0),
      })),
    };
  }

  private normalizeEvents(
    events: BehaviorEventTrackInput[],
    defaultSessionId?: string | null,
    defaultSource?: string,
  ): NormalizedBehaviorEvent[] {
    if (!Array.isArray(events)) {
      return [];
    }
    if (events.length > 100) {
      throw new BadRequestException('events too large (max 100)');
    }

    const now = Date.now();
    const normalized: NormalizedBehaviorEvent[] = [];

    for (const raw of events) {
      const eventName = this.normalizeEventName(raw?.event_name);
      if (!eventName) {
        continue;
      }
      const occurredAt = this.normalizeDate(raw?.occurred_at);
      if (!occurredAt) {
        continue;
      }
      if (Math.abs(occurredAt.getTime() - now) > 45 * 24 * 60 * 60 * 1000) {
        continue;
      }
      normalized.push({
        sessionId: this.normalizeString(raw?.session_id || defaultSessionId, 80),
        source: this.normalizeSource(raw?.source || defaultSource),
        eventName,
        eventCategory: this.normalizeEventCategory(raw?.event_category),
        routePath: this.normalizePath(raw?.route_path),
        referrerPath: this.normalizePath(raw?.referrer_path),
        languageCode: this.normalizeLanguageCode(raw?.language_code),
        eventValue: this.normalizeNumber(raw?.event_value),
        metadataJson: this.normalizeMetadata(raw?.metadata),
        occurredAt,
      });
    }

    return normalized;
  }

  private normalizeEventName(value: unknown): string | null {
    const raw = this.normalizeString(value, 64);
    if (!raw) {
      return null;
    }
    return raw.toLowerCase();
  }

  private normalizeEventCategory(value: unknown): string {
    const raw = this.normalizeString(value, 64);
    if (!raw) {
      return 'engagement';
    }
    return raw.toLowerCase();
  }

  private normalizeSource(value: unknown): string {
    const raw = this.normalizeString(value, 32);
    if (!raw) {
      return 'web';
    }
    return raw.toLowerCase();
  }

  private normalizePath(value: unknown): string | null {
    const raw = this.normalizeString(value, 512);
    if (!raw) {
      return null;
    }
    if (!raw.startsWith('/')) {
      return `/${raw}`;
    }
    return raw;
  }

  private normalizeLanguageCode(value: unknown): string | null {
    const raw = this.normalizeString(value, 16);
    if (!raw) {
      return null;
    }
    return raw.toLowerCase();
  }

  private normalizeMetadata(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return '{}';
    }
    try {
      const serialized = JSON.stringify(value);
      if (serialized.length > 12000) {
        return JSON.stringify({ truncated: true });
      }
      return serialized;
    } catch {
      return '{}';
    }
  }

  private normalizeNumber(value: unknown): number | null {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return null;
    }
    return num;
  }

  private normalizeDate(value: unknown): Date | null {
    if (!value) {
      return new Date();
    }
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return null;
      return value;
    }
    const parsed = new Date(String(value).trim());
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  private normalizeString(value: unknown, maxLength: number): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const text = String(value).trim();
    if (!text) {
      return null;
    }
    return text.slice(0, maxLength);
  }

  private toFiniteInteger(value: unknown, fallback: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return fallback;
    }
    return Math.max(0, Math.floor(num));
  }

  private async ensureSchema() {
    if (this.schemaReady) {
      return;
    }
    if (this.schemaPromise) {
      await this.schemaPromise;
      return;
    }
    this.schemaPromise = this.initializeSchema()
      .then(() => {
        this.schemaReady = true;
      })
      .catch((error) => {
        this.logger.error(`Failed to init behavior schema: ${error?.message || error}`);
        throw error;
      })
      .finally(() => {
        this.schemaPromise = null;
      });
    await this.schemaPromise;
  }

  private async initializeSchema() {
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS user_behavior_events (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
         user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
         session_id varchar(80) NULL,
         event_name varchar(64) NOT NULL,
         event_category varchar(64) NOT NULL DEFAULT 'engagement',
         route_path varchar(512) NULL,
         referrer_path varchar(512) NULL,
         language_code varchar(16) NULL,
         source varchar(32) NOT NULL DEFAULT 'web',
         event_value numeric(14, 4) NULL,
         metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
         occurred_at timestamptz NOT NULL DEFAULT now(),
         user_agent varchar(512) NULL,
         ip_address varchar(64) NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_user_behavior_events_app_time
       ON user_behavior_events(app_id, occurred_at DESC)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_user_behavior_events_app_user_time
       ON user_behavior_events(app_id, user_id, occurred_at DESC)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_user_behavior_events_app_session_time
       ON user_behavior_events(app_id, session_id, occurred_at DESC)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_user_behavior_events_app_event_time
       ON user_behavior_events(app_id, event_name, occurred_at DESC)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_user_behavior_events_app_route_time
       ON user_behavior_events(app_id, route_path, occurred_at DESC)`,
    );
  }
}
