import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AiPointsService } from '../ai-chat/ai-points.service';
import { RedeemService } from '../redeem/redeem.service';

type FeedbackStatus = 'pending' | 'triaged' | 'in_progress' | 'resolved' | 'closed' | 'useless' | 'thanks' | 'useful';
type FeedbackAction = 'useless' | 'thanks' | 'useful';
type FeedbackPriority = 'low' | 'normal' | 'high' | 'urgent';

type FeedbackRow = {
  id: string;
  app_id: string;
  user_id: string;
  title: string;
  content: string;
  context_json: unknown;
  category: string | null;
  priority: FeedbackPriority;
  status: FeedbackStatus;
  reward_points: number | string;
  admin_note: string | null;
  assignee_user_id: string | null;
  handled_by_user_id: string | null;
  handled_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  user_email?: string | null;
  user_display_name?: string | null;
  user_full_name?: string | null;
  assignee_email?: string | null;
  assignee_display_name?: string | null;
  assignee_full_name?: string | null;
  comment_count?: number | string | bigint | null;
};

type FeedbackCommentRow = {
  id: string;
  feedback_id: string;
  app_id: string;
  author_user_id: string;
  body: string;
  is_internal: boolean;
  created_at: Date;
  updated_at: Date;
  author_email?: string | null;
  author_display_name?: string | null;
  author_full_name?: string | null;
};

type FeedbackActionConfig = {
  status: FeedbackStatus;
  rewardPoints: number;
  notificationTitle: string;
  notificationMessage: string;
};

const FEEDBACK_ACTION_MAP: Record<FeedbackAction, FeedbackActionConfig> = {
  useless: {
    status: 'useless',
    rewardPoints: 0,
    notificationTitle: '反馈已处理',
    notificationMessage: '你的反馈已处理，感谢你的提交与支持。',
  },
  thanks: {
    status: 'thanks',
    rewardPoints: 20,
    notificationTitle: '感谢你的反馈',
    notificationMessage: '管理员已处理你的反馈，并奖励你 20 积分。',
  },
  useful: {
    status: 'useful',
    rewardPoints: 100,
    notificationTitle: '反馈非常有用',
    notificationMessage: '你的反馈被评为“有用”，已奖励你 100 积分，感谢贡献。',
  },
};

const ISSUE_STATUSES: FeedbackStatus[] = ['pending', 'triaged', 'in_progress', 'resolved', 'closed', 'useless', 'thanks', 'useful'];
const PRIORITIES: FeedbackPriority[] = ['low', 'normal', 'high', 'urgent'];
const DESKTOP_BUG_LOG_MAX_CHARS = 200_000;
const DESKTOP_BUG_LOG_MAX_LINES = 2_000;
const DESKTOP_BUG_ATTACHMENTS_MAX = 20;

type FeedbackSubmitPayload = {
  title?: string;
  content?: string;
  category?: string;
  priority?: string;
  context?: Record<string, unknown>;
  source?: string;
  client?: Record<string, unknown>;
  log_text?: string;
  logs?: string | string[];
  attachments?: Array<Record<string, unknown>>;
};

@Injectable()
export class FeedbackService implements OnModuleInit {
  private readonly logger = new Logger(FeedbackService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly aiPointsService: AiPointsService,
    private readonly redeemService: RedeemService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchemaReady();
    } catch (error: any) {
      this.logger.warn(`feedback schema check failed: ${error?.message || error}`);
    }
  }

  async submitFeedbackByAppSlug(
    appSlug: string | undefined,
    userId: string,
    payload: FeedbackSubmitPayload,
  ) {
    await this.ensureSchemaReady();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    const normalizedContext = this.buildSubmitContext(payload);
    const hasBugLog = Boolean(normalizedContext.bug_report);
    const content = this.cleanText(payload?.content, 4000) || (hasBugLog ? this.deriveBugReportContent(payload) : '');
    if (!content) {
      throw new BadRequestException('反馈内容不能为空');
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO user_feedbacks (
         id, app_id, user_id, title, content, context_json, category, priority, status,
         reward_points, admin_note, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(),
         $1::uuid,
         $2::uuid,
         $3::text,
         $4::text,
         $5::jsonb,
         NULLIF($6::text, ''),
         $7::text,
         'pending',
         0,
         NULL,
         now(),
         now()
       )
       RETURNING ${this.feedbackSelectColumns('user_feedbacks')}`,
      app.id,
      userId,
      this.cleanText(payload?.title, 180) || this.deriveTitle(content),
      content,
      JSON.stringify(normalizedContext),
      this.cleanText(payload?.category, 64),
      this.normalizePriority(payload?.priority),
    ) as Promise<FeedbackRow[]>);

    return {
      message: '反馈已提交，感谢你的建议',
      item: this.serializeFeedbackRow(rows[0]),
    };
  }

  async listMyFeedbacksByAppSlug(
    appSlug: string | undefined,
    userId: string,
    options?: { page?: number | string; page_size?: number | string; status?: string },
  ) {
    await this.ensureSchemaReady();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    const page = Math.max(1, Math.floor(Number(options?.page || 1)));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(options?.page_size || 20))));
    const offset = (page - 1) * pageSize;
    const status = this.normalizeStatus(options?.status, true);

    const [countRows, rows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count
         FROM user_feedbacks
         WHERE app_id = $1::uuid
           AND user_id = $2::uuid
           AND ($3::text = '' OR status = $3::text)`,
        app.id,
        userId,
        status,
      ) as Promise<Array<{ count: bigint }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           ${this.feedbackSelectColumns('f')},
           COALESCE(comment_counts.comment_count, 0) AS comment_count
         FROM user_feedbacks f
         LEFT JOIN (
           SELECT feedback_id, COUNT(*)::bigint AS comment_count
           FROM user_feedback_comments
           WHERE app_id = $1::uuid
           GROUP BY feedback_id
         ) comment_counts ON comment_counts.feedback_id = f.id
         WHERE f.app_id = $1::uuid
           AND f.user_id = $2::uuid
           AND ($3::text = '' OR f.status = $3::text)
         ORDER BY f.updated_at DESC
         LIMIT $4 OFFSET $5`,
        app.id,
        userId,
        status,
        pageSize,
        offset,
      ) as Promise<FeedbackRow[]>),
    ]);

    return {
      total: Number(countRows[0]?.count || 0),
      page,
      page_size: pageSize,
      items: rows.map((row) => this.serializeFeedbackRow(row)),
    };
  }

  async getMyFeedbackByAppSlug(appSlug: string | undefined, userId: string, feedbackId: string) {
    await this.ensureSchemaReady();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT ${this.feedbackSelectColumns('f')}
       FROM user_feedbacks f
       WHERE f.app_id = $1::uuid
         AND f.user_id = $2::uuid
         AND f.id = $3::uuid`,
      app.id,
      userId,
      feedbackId,
    ) as Promise<FeedbackRow[]>);
    const item = rows[0];
    if (!item) {
      throw new NotFoundException('反馈不存在');
    }
    return {
      item: this.serializeFeedbackRow(item),
      comments: await this.listComments(app.id, feedbackId, false),
    };
  }

  async addMyFeedbackCommentByAppSlug(
    appSlug: string | undefined,
    userId: string,
    feedbackId: string,
    payload: { body?: string },
  ) {
    await this.ensureSchemaReady();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
       FROM user_feedbacks
       WHERE app_id = $1::uuid
         AND user_id = $2::uuid
         AND id = $3::uuid`,
      app.id,
      userId,
      feedbackId,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) {
      throw new NotFoundException('反馈不存在');
    }
    return this.addFeedbackCommentByAppId(app.id, feedbackId, userId, {
      body: payload?.body,
      is_internal: false,
    });
  }

  async listFeedbacksByAppId(
    appId: string,
    options?: { page?: number | string; page_size?: number | string; status?: string; priority?: string; assignee_user_id?: string; q?: string },
  ) {
    await this.ensureSchemaReady();
    await this.resolveAppById(appId);
    const page = Math.max(1, Math.floor(Number(options?.page || 1)));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(options?.page_size || 20))));
    const offset = (page - 1) * pageSize;
    const status = this.normalizeStatus(options?.status, true);
    const priority = this.normalizePriorityFilter(options?.priority);
    const assigneeUserId = String(options?.assignee_user_id || '').trim();
    const q = String(options?.q || '').trim();

    const whereSql = `
      f.app_id = $1::uuid
      AND ($2::text = '' OR f.status = $2::text)
      AND ($3::text = '' OR f.priority = $3::text)
      AND ($4::text = '' OR f.assignee_user_id = NULLIF($4::text, '')::uuid)
      AND (
        $5::text = ''
        OR f.title ILIKE ('%' || $5::text || '%')
        OR f.content ILIKE ('%' || $5::text || '%')
        OR u.email ILIKE ('%' || $5::text || '%')
        OR COALESCE(u.display_name, u.full_name, '') ILIKE ('%' || $5::text || '%')
      )
    `;

    const [countRows, rows, summaryRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count
         FROM user_feedbacks f
         JOIN users u ON u.id = f.user_id
         WHERE ${whereSql}`,
        appId,
        status,
        priority,
        assigneeUserId,
        q,
      ) as Promise<Array<{ count: bigint }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           ${this.feedbackSelectColumns('f')},
           u.email AS user_email, u.display_name AS user_display_name, u.full_name AS user_full_name,
           assignee.email AS assignee_email,
           assignee.display_name AS assignee_display_name,
           assignee.full_name AS assignee_full_name,
           COALESCE(comment_counts.comment_count, 0) AS comment_count
         FROM user_feedbacks f
         JOIN users u ON u.id = f.user_id
         LEFT JOIN users assignee ON assignee.id = f.assignee_user_id
         LEFT JOIN (
           SELECT feedback_id, COUNT(*)::bigint AS comment_count
           FROM user_feedback_comments
           WHERE app_id = $1::uuid
           GROUP BY feedback_id
         ) comment_counts ON comment_counts.feedback_id = f.id
         WHERE ${whereSql}
         ORDER BY
           CASE f.status
             WHEN 'pending' THEN 0
             WHEN 'triaged' THEN 1
             WHEN 'in_progress' THEN 2
             ELSE 3
           END ASC,
           CASE f.priority
             WHEN 'urgent' THEN 0
             WHEN 'high' THEN 1
             WHEN 'normal' THEN 2
             ELSE 3
           END ASC,
           f.updated_at DESC
         LIMIT $6 OFFSET $7`,
        appId,
        status,
        priority,
        assigneeUserId,
        q,
        pageSize,
        offset,
      ) as Promise<FeedbackRow[]>),
      (this.prisma.$queryRawUnsafe(
        `SELECT status, COUNT(*)::bigint AS count
         FROM user_feedbacks
         WHERE app_id = $1::uuid
         GROUP BY status`,
        appId,
      ) as Promise<Array<{ status: FeedbackStatus; count: bigint }>>),
    ]);

    return {
      total: Number(countRows[0]?.count || 0),
      page,
      page_size: pageSize,
      summary: summaryRows.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = Number(row.count || 0);
        return acc;
      }, {}),
      items: rows.map((row) => this.serializeFeedbackRow(row)),
    };
  }

  async getFeedbackByAppId(appId: string, feedbackId: string) {
    await this.ensureSchemaReady();
    await this.resolveAppById(appId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         ${this.feedbackSelectColumns('f')},
         u.email AS user_email, u.display_name AS user_display_name, u.full_name AS user_full_name,
         assignee.email AS assignee_email,
         assignee.display_name AS assignee_display_name,
         assignee.full_name AS assignee_full_name,
         COALESCE(comment_counts.comment_count, 0) AS comment_count
       FROM user_feedbacks f
       JOIN users u ON u.id = f.user_id
       LEFT JOIN users assignee ON assignee.id = f.assignee_user_id
       LEFT JOIN (
         SELECT feedback_id, COUNT(*)::bigint AS comment_count
         FROM user_feedback_comments
         WHERE app_id = $1::uuid
         GROUP BY feedback_id
       ) comment_counts ON comment_counts.feedback_id = f.id
       WHERE f.app_id = $1::uuid
         AND f.id = $2::uuid`,
      appId,
      feedbackId,
    ) as Promise<FeedbackRow[]>);
    const item = rows[0];
    if (!item) {
      throw new NotFoundException('反馈不存在');
    }
    return {
      item: this.serializeFeedbackRow(item),
      comments: await this.listComments(appId, feedbackId),
    };
  }

  async updateFeedbackByAppId(
    appId: string,
    feedbackId: string,
    actorUserId: string,
    payload: { status?: string; priority?: string; assignee_user_id?: string | null; title?: string; category?: string | null; note?: string | null },
  ) {
    await this.ensureSchemaReady();
    await this.resolveAppById(appId);
    await this.ensureActorUserExists(actorUserId);
    const status = this.normalizeStatus(payload?.status, true);
    const priority = this.normalizePriorityFilter(payload?.priority);
    const assigneeUserId = String(payload?.assignee_user_id || '').trim();
    if (assigneeUserId) {
      await this.ensureUserInApp(appId, assigneeUserId);
    }
    const title = this.cleanOptional(payload?.title, 180);
    const category = this.cleanOptional(payload?.category, 64);
    const adminNote = this.cleanOptional(payload?.note, 2000);

    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE user_feedbacks
       SET title = COALESCE(NULLIF($3::text, ''), title),
           category = CASE WHEN $4::text = '__KEEP__' THEN category ELSE NULLIF($4::text, '') END,
           priority = COALESCE(NULLIF($5::text, ''), priority),
           status = COALESCE(NULLIF($6::text, ''), status),
           assignee_user_id = CASE
             WHEN $7::text = '__KEEP__' THEN assignee_user_id
             WHEN $7::text = '' THEN NULL
             ELSE $7::uuid
           END,
           admin_note = CASE WHEN $8::text = '__KEEP__' THEN admin_note ELSE NULLIF($8::text, '') END,
           handled_by_user_id = CASE WHEN NULLIF($6::text, '') IS NULL THEN handled_by_user_id ELSE $9::uuid END,
           handled_at = CASE WHEN NULLIF($6::text, '') IS NULL THEN handled_at ELSE now() END,
           closed_at = CASE
             WHEN $6::text IN ('closed', 'resolved', 'useless', 'thanks', 'useful') THEN COALESCE(closed_at, now())
             WHEN $6::text IN ('pending', 'triaged', 'in_progress') THEN NULL
             ELSE closed_at
           END,
           updated_at = now()
       WHERE app_id = $1::uuid
         AND id = $2::uuid
       RETURNING ${this.feedbackSelectColumns('user_feedbacks')}`,
      appId,
      feedbackId,
      title ?? '',
      category === undefined ? '__KEEP__' : category || '',
      priority,
      status,
      payload && Object.prototype.hasOwnProperty.call(payload, 'assignee_user_id') ? assigneeUserId : '__KEEP__',
      adminNote === undefined ? '__KEEP__' : adminNote || '',
      actorUserId,
    ) as Promise<FeedbackRow[]>);
    const item = rows[0];
    if (!item) {
      throw new NotFoundException('反馈不存在');
    }

    return {
      item: this.serializeFeedbackRow(item),
      comments: await this.listComments(appId, feedbackId),
    };
  }

  async addFeedbackCommentByAppId(
    appId: string,
    feedbackId: string,
    actorUserId: string,
    payload: { body?: string; is_internal?: boolean },
  ) {
    await this.ensureSchemaReady();
    await this.resolveAppById(appId);
    await this.ensureActorUserExists(actorUserId);
    const body = this.cleanText(payload?.body, 4000);
    if (!body) {
      throw new BadRequestException('评论内容不能为空');
    }
    const feedbackRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, user_id
       FROM user_feedbacks
       WHERE app_id = $1::uuid
         AND id = $2::uuid`,
      appId,
      feedbackId,
    ) as Promise<Array<{ id: string; user_id: string }>>);
    const target = feedbackRows[0];
    if (!target) {
      throw new NotFoundException('反馈不存在');
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO user_feedback_comments (
         id, feedback_id, app_id, author_user_id, body, is_internal, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::text, $5::boolean, now(), now()
       )
       RETURNING id, feedback_id, app_id, author_user_id, body, is_internal, created_at, updated_at`,
      feedbackId,
      appId,
      actorUserId,
      body,
      Boolean(payload?.is_internal),
    ) as Promise<FeedbackCommentRow[]>);
    await this.prisma.$executeRawUnsafe(
      `UPDATE user_feedbacks
       SET updated_at = now()
       WHERE app_id = $1::uuid
         AND id = $2::uuid`,
      appId,
      feedbackId,
    );

    if (!payload?.is_internal) {
      await this.notifyUser(appId, target.user_id, {
        type: 'feedback.comment',
        title: '反馈有新回复',
        message: body.length > 120 ? `${body.slice(0, 120)}...` : body,
        payload: { feedback_id: feedbackId, comment_id: rows[0]?.id },
      });
    }

    return {
      comment: this.serializeCommentRow(rows[0]),
      comments: await this.listComments(appId, feedbackId),
    };
  }

  async reviewFeedbackByAppId(
    appId: string,
    feedbackId: string,
    actorUserId: string,
    payload: { action?: string; note?: string },
  ) {
    await this.ensureSchemaReady();
    await this.resolveAppById(appId);
    await this.ensureActorUserExists(actorUserId);

    const action = String(payload?.action || '').trim().toLowerCase() as FeedbackAction;
    if (!FEEDBACK_ACTION_MAP[action]) {
      throw new BadRequestException('无效处理动作，可选：useless / thanks / useful');
    }
    const actionConfig = FEEDBACK_ACTION_MAP[action];
    const adminNote = this.cleanOptional(payload?.note, 2000) || '';

    const result = await this.prisma.$transaction(async (tx) => {
      const feedbackRows = await (tx.$queryRawUnsafe(
        `SELECT ${this.feedbackSelectColumns('f')}
         FROM user_feedbacks f
         WHERE f.app_id = $1::uuid
           AND f.id = $2::uuid
         FOR UPDATE`,
        appId,
        feedbackId,
      ) as Promise<FeedbackRow[]>);
      const target = feedbackRows[0];
      if (!target) {
        throw new NotFoundException('反馈不存在');
      }
      if (['closed', 'resolved', 'useless', 'thanks', 'useful'].includes(target.status)) {
        throw new BadRequestException('该反馈已处理');
      }

      if (actionConfig.rewardPoints > 0) {
        await this.aiPointsService.getOrCreateWalletByAppId(appId, target.user_id);
        const walletRows = await (tx.$queryRawUnsafe(
          `UPDATE user_ai_points_wallets
           SET balance = balance + $3::numeric,
               total_earned = total_earned + $3::numeric,
               updated_at = now()
           WHERE app_id = $1::uuid
             AND user_id = $2::uuid
           RETURNING balance, total_earned`,
          appId,
          target.user_id,
          actionConfig.rewardPoints,
        ) as Promise<Array<{ balance: number | string; total_earned: number | string }>>);
        const wallet = walletRows[0];
        if (!wallet) {
          throw new BadRequestException('奖励积分失败：钱包不存在');
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO user_ai_points_ledger (
             id, app_id, user_id, delta, balance_after, event_type, reference_type, reference_id, metadata_json, created_at
           )
          VALUES (
             gen_random_uuid(),
             $1::uuid,
             $2::uuid,
             $3::numeric,
             $4::numeric,
             'feedback_reward',
             'user_feedback',
             $5::text,
             $6::jsonb,
             now()
           )`,
          appId,
          target.user_id,
          actionConfig.rewardPoints,
          Number(Number(wallet.balance || 0).toFixed(2)),
          target.id,
          JSON.stringify({
            action,
            reward_points: actionConfig.rewardPoints,
          }),
        );
      }

      const updatedRows = await (tx.$queryRawUnsafe(
        `UPDATE user_feedbacks
         SET status = $3::text,
             reward_points = $4::integer,
             admin_note = NULLIF($5::text, ''),
             handled_by_user_id = $6::uuid,
             handled_at = now(),
             closed_at = now(),
             updated_at = now()
         WHERE app_id = $1::uuid
           AND id = $2::uuid
         RETURNING ${this.feedbackSelectColumns('user_feedbacks')}`,
        appId,
        feedbackId,
        actionConfig.status,
        actionConfig.rewardPoints,
        adminNote,
        actorUserId,
      ) as Promise<FeedbackRow[]>);

      const updated = updatedRows[0];
      if (!updated) {
        throw new BadRequestException('反馈处理失败');
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO user_notifications (
           id, app_id, user_id, notification_type, title, message, payload_json, is_read, created_at
         )
         VALUES (
           gen_random_uuid(),
           $1::uuid,
           $2::uuid,
           'feedback.reviewed',
           $3::text,
           $4::text,
           $5::jsonb,
           false,
           now()
         )`,
        appId,
        updated.user_id,
        actionConfig.notificationTitle,
        actionConfig.notificationMessage,
        JSON.stringify({
          feedback_id: updated.id,
          action,
          reward_points: actionConfig.rewardPoints,
        }),
      );

      return updated;
    });

    return {
      item: this.serializeFeedbackRow(result),
      reward_points: actionConfig.rewardPoints,
    };
  }

  private async listComments(appId: string, feedbackId: string, includeInternal = true) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         c.id, c.feedback_id, c.app_id, c.author_user_id, c.body, c.is_internal, c.created_at, c.updated_at,
         u.email AS author_email, u.display_name AS author_display_name, u.full_name AS author_full_name
       FROM user_feedback_comments c
       JOIN users u ON u.id = c.author_user_id
       WHERE c.app_id = $1::uuid
         AND c.feedback_id = $2::uuid
         AND ($3::boolean OR c.is_internal = false)
       ORDER BY c.created_at ASC`,
      appId,
      feedbackId,
      includeInternal,
    ) as Promise<FeedbackCommentRow[]>);
    return rows.map((row) => this.serializeCommentRow(row));
  }

  private serializeFeedbackRow(row?: FeedbackRow | null) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      app_id: row.app_id,
      user_id: row.user_id,
      user_email: row.user_email || null,
      user_display_name: row.user_display_name || row.user_full_name || null,
      title: row.title || this.deriveTitle(row.content),
      content: row.content,
      context: this.parseObject(row.context_json),
      category: row.category || null,
      priority: row.priority || 'normal',
      status: row.status,
      reward_points: Number(row.reward_points || 0),
      admin_note: row.admin_note,
      assignee_user_id: row.assignee_user_id,
      assignee_email: row.assignee_email || null,
      assignee_display_name: row.assignee_display_name || row.assignee_full_name || null,
      handled_by_user_id: row.handled_by_user_id,
      handled_at: row.handled_at ? row.handled_at.toISOString() : null,
      closed_at: row.closed_at ? row.closed_at.toISOString() : null,
      comment_count: Number(row.comment_count || 0),
      created_at: row.created_at ? row.created_at.toISOString() : null,
      updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    };
  }

  private serializeCommentRow(row?: FeedbackCommentRow | null) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      feedback_id: row.feedback_id,
      app_id: row.app_id,
      author_user_id: row.author_user_id,
      author_email: row.author_email || null,
      author_display_name: row.author_display_name || row.author_full_name || null,
      body: row.body,
      is_internal: Boolean(row.is_internal),
      created_at: row.created_at ? row.created_at.toISOString() : null,
      updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    };
  }

  private parseObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return {};
      }
    }
    return {};
  }

  private feedbackSelectColumns(alias: string) {
    return `${alias}.id, ${alias}.app_id, ${alias}.user_id, ${alias}.title, ${alias}.content, ${alias}.context_json,
      ${alias}.category, ${alias}.priority, ${alias}.status, ${alias}.reward_points, ${alias}.admin_note,
      ${alias}.assignee_user_id, ${alias}.handled_by_user_id, ${alias}.handled_at, ${alias}.closed_at,
      ${alias}.created_at, ${alias}.updated_at`;
  }

  private cleanText(value: unknown, maxLength: number) {
    const text = String(value || '').trim();
    if (text.length > maxLength) {
      throw new BadRequestException(`内容过长，请控制在 ${maxLength} 字以内`);
    }
    return text;
  }

  private cleanOptional(value: unknown, maxLength: number) {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return '';
    }
    return this.cleanText(value, maxLength);
  }

  private deriveTitle(content: string) {
    return content.replace(/\s+/g, ' ').slice(0, 180) || '用户反馈';
  }

  private deriveBugReportContent(payload: FeedbackSubmitPayload) {
    const title = this.cleanText(payload?.title, 180);
    return title || '桌面端错误日志';
  }

  private buildSubmitContext(payload: FeedbackSubmitPayload): Record<string, unknown> {
    const context = this.parseObject(payload?.context || {});
    const source = this.cleanText(payload?.source, 64);
    const client = this.normalizeSmallObject(payload?.client, 80);
    const attachments = this.normalizeAttachments(payload?.attachments);
    const normalizedLog = this.normalizeBugLog(payload?.log_text, payload?.logs);

    if (!source && !client && !attachments.length && !normalizedLog.text) {
      return context;
    }

    return {
      ...context,
      bug_report: {
        source: source || 'desktop',
        client,
        log_text: normalizedLog.text,
        log_truncated: normalizedLog.truncated,
        log_original_chars: normalizedLog.originalChars,
        log_original_lines: normalizedLog.originalLines,
        attachments,
        submitted_at: new Date().toISOString(),
      },
    };
  }

  private normalizeBugLog(logText: unknown, logs: unknown) {
    const lines: string[] = [];
    if (typeof logText === 'string' && logText.trim()) {
      lines.push(logText);
    }
    if (typeof logs === 'string' && logs.trim()) {
      lines.push(logs);
    } else if (Array.isArray(logs)) {
      logs.forEach((line) => {
        const normalized = String(line || '').trimEnd();
        if (normalized) {
          lines.push(normalized);
        }
      });
    }

    const joined = lines.join('\n');
    const originalChars = joined.length;
    const splitLines = joined ? joined.split(/\r?\n/) : [];
    const originalLines = splitLines.length;
    const lineLimited = splitLines.slice(Math.max(0, splitLines.length - DESKTOP_BUG_LOG_MAX_LINES)).join('\n');
    const charLimited =
      lineLimited.length > DESKTOP_BUG_LOG_MAX_CHARS
        ? lineLimited.slice(lineLimited.length - DESKTOP_BUG_LOG_MAX_CHARS)
        : lineLimited;
    return {
      text: charLimited,
      originalChars,
      originalLines,
      truncated: originalChars > charLimited.length || originalLines > DESKTOP_BUG_LOG_MAX_LINES,
    };
  }

  private normalizeSmallObject(value: unknown, maxKeys: number): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    const output: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>)
      .slice(0, maxKeys)
      .forEach(([key, raw]) => {
        const normalizedKey = String(key || '').trim().slice(0, 80);
        if (!normalizedKey) {
          return;
        }
        if (raw === null || typeof raw === 'boolean' || typeof raw === 'number') {
          output[normalizedKey] = raw;
          return;
        }
        if (typeof raw === 'string') {
          output[normalizedKey] = raw.slice(0, 2000);
        }
      });
    return output;
  }

  private normalizeAttachments(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.slice(0, DESKTOP_BUG_ATTACHMENTS_MAX).map((item) => {
      const source = this.parseObject(item);
      return {
        url: String(source.url || '').trim().slice(0, 2000),
        name: String(source.name || '').trim().slice(0, 255),
        mime_type: String(source.mime_type || source.mimeType || '').trim().slice(0, 120),
        size: Number.isFinite(Number(source.size)) ? Number(source.size) : null,
      };
    });
  }

  private normalizePriority(value: unknown): FeedbackPriority {
    const input = String(value || '').trim().toLowerCase();
    if (PRIORITIES.includes(input as FeedbackPriority)) {
      return input as FeedbackPriority;
    }
    return 'normal';
  }

  private normalizePriorityFilter(value: unknown): FeedbackPriority | '' {
    const input = String(value || '').trim().toLowerCase();
    if (!input) {
      return '';
    }
    if (!PRIORITIES.includes(input as FeedbackPriority)) {
      throw new BadRequestException('无效优先级');
    }
    return input as FeedbackPriority;
  }

  private normalizeStatus(value: unknown, allowEmpty = false): FeedbackStatus | '' {
    const input = String(value || '').trim().toLowerCase();
    if (!input && allowEmpty) {
      return '';
    }
    if (!ISSUE_STATUSES.includes(input as FeedbackStatus)) {
      throw new BadRequestException('无效反馈状态');
    }
    return input as FeedbackStatus;
  }

  private async resolveAppBySlug(appSlug?: string) {
    const slug = String(appSlug || '').trim().toLowerCase();
    if (!slug) {
      throw new BadRequestException('app slug is required');
    }
    const app = await this.prisma.app.findUnique({ where: { slug } });
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  private async resolveAppById(appId: string) {
    const app = await this.prisma.app.findUnique({ where: { id: appId } });
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app;
  }

  private async ensureUserInApp(appId: string, userId: string) {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, appId, deletedAt: null },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException('User not found');
    }
  }

  private async ensureActorUserExists(userId: string) {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException('Actor user not found');
    }
  }

  private async notifyUser(
    appId: string,
    userId: string,
    notification: { type: string; title: string; message: string; payload: Record<string, unknown> },
  ) {
    try {
      await this.redeemService.pushNotificationByAppId(appId, userId, notification);
    } catch (error: any) {
      this.logger.warn(`push feedback notification failed app=${appId}: ${error?.message || 'unknown error'}`);
    }
  }

  private async ensureSchemaReady() {
    if (this.schemaReady) {
      return;
    }
    if (this.schemaPromise) {
      await this.schemaPromise;
      return;
    }
    this.schemaPromise = this.verifySchemaReady();
    try {
      await this.schemaPromise;
      this.schemaReady = true;
    } finally {
      this.schemaPromise = null;
    }
  }

  private async verifySchemaReady() {
    const rows = await (this.prisma.$queryRawUnsafe(
      `WITH required_columns(table_name, column_name) AS (
         VALUES
           ('user_feedbacks', 'title'),
           ('user_feedbacks', 'priority'),
           ('user_feedbacks', 'assignee_user_id'),
           ('user_feedbacks', 'closed_at'),
           ('user_feedback_comments', 'feedback_id'),
           ('user_feedback_comments', 'body')
       )
       SELECT COALESCE(array_agg(table_name || '.' || column_name), ARRAY[]::text[]) AS missing
       FROM required_columns rc
       WHERE NOT EXISTS (
         SELECT 1
         FROM information_schema.columns c
         WHERE c.table_schema = current_schema()
           AND c.table_name = rc.table_name
           AND c.column_name = rc.column_name
       )`,
    ) as Promise<Array<{ missing: string[] }>>);
    const missing = rows[0]?.missing || [];
    if (missing.length) {
      throw new ServiceUnavailableException(
        `feedback schema is not ready; run migration 20260504_102500_feedback_issue_management first: ${missing.join(', ')}`,
      );
    }
  }
}
