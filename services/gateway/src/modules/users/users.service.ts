import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { normalizeLanguageCode } from '../../common/utils/language-code';
import { AiPointsService } from '../ai-chat/ai-points.service';
import { EmailVerificationService } from '../auth/email-verification.service';
import { AuthService } from '../auth/auth.service';
import { BehaviorAnalyticsService } from '../behavior-analytics/behavior-analytics.service';
import { FeedbackService } from '../feedback/feedback.service';
import { RedeemService } from '../redeem/redeem.service';
const ADMIN_PERMISSION_CATALOG = [
  { key: 'admin_accounts', name: '管理员分配', description: '子管理员分配、页面权限设置、账号删除' },
  { key: 'admin_redeem_codes', name: '兑换码管理', description: '兑换码创建、作废与列表' },
  { key: 'admin_product_payments', name: '产品与支付', description: '支付商品、订单、签约和扣款' },
];

type AdminPermissionGroupRow = {
  id: string;
  name: string;
  description: string | null;
  page_permissions: unknown;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

type AdminPagePermissionRow = {
  id: string;
  allowed_pages: unknown;
};

@Injectable()
export class UsersService {
  private readonly appIdCache = new Map<string, string>();
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly aiPointsService: AiPointsService,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly authService: AuthService,
    private readonly redeemService: RedeemService,
    private readonly behaviorAnalyticsService: BehaviorAnalyticsService,
    private readonly feedbackService: FeedbackService,
  ) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { app: { select: { slug: true, name: true } } },
    });
    if (!user || user.deletedAt) {
      throw new NotFoundException('User not found');
    }
    return this.toUserProfile(user);
  }

  async updateMe(userId: string, data: Record<string, unknown>) {
    await this.ensureActiveUser(userId);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        fullName: this.stringOrUndefined(data.full_name ?? data.fullName),
        displayName: this.stringOrUndefined(data.display_name ?? data.displayName),
        avatarUrl: this.stringOrUndefined(data.avatar_url ?? data.avatarUrl),
        phone: this.stringOrUndefined(data.phone),
      },
    });
    return this.toUserProfile(updated);
  }

  async getMyPoints(appSlug: string | undefined, userId: string) {
    const appId = await this.resolveAppId(appSlug);
    const [userExists, settings] = await Promise.all([
      this.tenantUserExists(appId, userId),
      this.aiPointsService.getSettingsByAppId(appId),
    ]);
    if (!userExists) {
      throw new NotFoundException('User not found');
    }
    const wallet =
      (await this.aiPointsService.getWalletByAppId(appId, userId))
      || (await this.aiPointsService.getOrCreateWalletByAppId(appId, userId, settings));
    return {
      ...wallet,
      pricing: {
        unit: 'points',
        points_per_yuan: settings.points_per_yuan,
      },
    };
  }

  async getMyAiUsageLogs(
    appSlug: string | undefined,
    userId: string,
    options?: { limit?: string | number; page?: string | number },
  ) {
    const appId = await this.resolveAppId(appSlug);
    const userExists = await this.tenantUserExists(appId, userId);
    if (!userExists) {
      throw new NotFoundException('User not found');
    }

    const safePage = this.normalizePositiveInt(options?.page, 1);
    const safePageSize = Math.min(this.normalizePositiveInt(options?.limit, 20), 100);
    const offset = (safePage - 1) * safePageSize;
    const pointsPerYuan = (await this.aiPointsService.getSettingsByAppId(appId)).points_per_yuan || 100;
    const [rows, totalRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT
           l.id,
           l.created_at,
           COALESCE(m.display_name, l.model_key) AS model,
           COALESCE(l.total_tokens, 0)::bigint AS total_tokens,
           CASE
             WHEN l.points_pricing_source IS NOT NULL
               AND l.points_pricing_source <> ''
               AND l.points_cost IS NOT NULL
               THEN l.points_cost
             WHEN l.points_cost IS NOT NULL
               AND l.points_cost > 0
               THEN l.points_cost
             WHEN l.estimated_cost_rmb > 0
               THEN GREATEST(0.01::numeric, ROUND(l.estimated_cost_rmb * $3::numeric, 2))
             ELSE 0::numeric
           END AS points_cost
         FROM ai_usage_logs l
         LEFT JOIN ai_global_models m ON m.id = l.global_model_id
         WHERE l.app_id = $1::uuid
           AND l.user_id = $2::uuid
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT $4::int
         OFFSET $5::int`,
        appId,
        userId,
        pointsPerYuan,
        safePageSize,
        offset,
      ) as Promise<Array<Record<string, unknown>>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS total
           FROM ai_usage_logs
          WHERE app_id = $1::uuid
            AND user_id = $2::uuid`,
        appId,
        userId,
      ) as Promise<Array<{ total: unknown }>>),
    ]);

    return {
      page: safePage,
      page_size: safePageSize,
      total: this.toSafeInteger(totalRows[0]?.total),
      items: rows.map((row) => ({
        id: String(row.id || ''),
        time: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
        model: String(row.model || ''),
        token: this.toSafeInteger(row.total_tokens),
        points_cost: this.toSafeDecimal2(row.points_cost),
      })),
    };
  }

  async uploadAvatar(userId: string, avatarUrl: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
    });
    return this.toUserProfile(updated);
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const user = await this.ensureActiveUser(userId);
    const valid = await bcrypt.compare(oldPassword, user.hashedPassword);
    if (!valid) {
      throw new UnauthorizedException('旧密码错误');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        hashedPassword: await bcrypt.hash(newPassword, 10),
        sessionToken: `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
        currentRefreshTokenHash: null,
        refreshTokenIssuedAt: null,
        refreshTokenLastUsedAt: null,
      },
    });
    return { message: '密码修改成功' };
  }

  async sendPasswordChangeCode(userId: string, method?: string) {
    const user = await this.ensureActiveUser(userId);
    if ((method || 'email') !== 'email') {
      return {
        message: 'Verification code sent',
        method: method || 'email',
      };
    }
    return this.emailVerificationService.sendCode({
      appId: user.appId,
      userId: user.id,
      email: user.email,
      purpose: 'password_change',
      subjectLabel: '修改密码验证码',
    });
  }

  async changePasswordWithCode(userId: string, code: string, newPassword: string) {
    const user = await this.ensureActiveUser(userId);
    await this.emailVerificationService.verifyCode({
      appId: user.appId,
      userId: user.id,
      email: user.email,
      purpose: 'password_change',
      code,
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        hashedPassword: await bcrypt.hash(newPassword, 10),
        sessionToken: `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
        currentRefreshTokenHash: null,
        refreshTokenIssuedAt: null,
        refreshTokenLastUsedAt: null,
      },
    });
    return { message: '密码修改成功' };
  }

  async sendEmailChangeCode(userId: string, newEmail: string) {
    const user = await this.ensureActiveUser(userId);
    const normalizedEmail = String(newEmail || '').trim().toLowerCase();
    if (!normalizedEmail) {
      throw new ConflictException('Email is required');
    }
    return this.emailVerificationService.sendCode({
      appId: user.appId,
      userId: user.id,
      email: normalizedEmail,
      purpose: 'email_change',
      subjectLabel: '修改邮箱验证码',
      payload: { new_email: normalizedEmail },
    });
  }

  async changeEmail(userId: string, newEmail: string, code: string) {
    const currentUser = await this.ensureActiveUser(userId);
    const normalizedEmail = String(newEmail || '').trim().toLowerCase();
    await this.emailVerificationService.verifyCode({
      appId: currentUser.appId,
      userId: currentUser.id,
      email: normalizedEmail,
      purpose: 'email_change',
      code,
    });
    const existing = await this.prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        deletedAt: null,
      },
    });
    if (existing && existing.id !== userId) {
      throw new ConflictException('Email already exists');
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { email: normalizedEmail },
    });
    return this.toUserProfile(user);
  }

  async sendPhoneBindCode(userId: string, phone: string) {
    const user = await this.ensureActiveUser(userId);
    const normalizedPhone = this.authService.normalizeSmsPhone(phone);
    await this.assertPhoneAvailable(user.appId, user.id, normalizedPhone);
    return this.authService.sendSmsCodeForAppId(user.appId, normalizedPhone);
  }

  async bindPhone(userId: string, phone: string, code: string) {
    const currentUser = await this.ensureActiveUser(userId);
    const verified = await this.authService.verifySmsCodeForAppId(currentUser.appId, phone, code);
    await this.assertPhoneAvailable(currentUser.appId, currentUser.id, verified.phone);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        phone: verified.phone,
        phoneVerified: true,
      },
    });
    return this.toUserProfile(user);
  }

  async listUsers(appSlug?: string, q?: string) {
    const appId = await this.resolveAppId(appSlug);

    const where: any = {
      appId,
      deletedAt: null,
    };
    if (q && q.trim()) {
      const keyword = q.trim();
      where.OR = [
        { email: { contains: keyword, mode: 'insensitive' } },
        { fullName: { contains: keyword, mode: 'insensitive' } },
        { displayName: { contains: keyword, mode: 'insensitive' } },
        { phone: { contains: keyword, mode: 'insensitive' } },
      ];
    }

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        phone: user.phone,
        display_name: user.displayName || user.fullName || user.email,
        full_name: user.fullName,
        role: user.role,
        is_active: user.isActive,
      })),
      total: users.length,
    };
  }

  async adminDeleteUser(appSlug: string | undefined, userId: string) {
    const appId = await this.resolveAppId(appSlug);
    const target = await this.prisma.user.findFirst({
      where: { id: userId, appId, deletedAt: null },
    });
    if (!target) {
      throw new NotFoundException('User not found');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        isActive: false,
        deletedAt: new Date(),
        sessionToken: null,
        currentRefreshTokenHash: null,
        refreshTokenIssuedAt: null,
        refreshTokenLastUsedAt: null,
      },
    });
    return { message: 'User deleted' };
  }

  async redeem(appSlug: string | undefined, userId: string, code: string) {
    return this.redeemService.redeemCodeByAppSlug(appSlug, userId, code);
  }

  async previewRedeem(appSlug: string | undefined, code: string) {
    return this.redeemService.redeemPreviewByAppSlug(appSlug, code);
  }

  async listMyEntitlements(appSlug: string | undefined, userId: string) {
    return this.redeemService.listUserEntitlementsByAppSlug(appSlug, userId);
  }

  async listMyNotifications(
    appSlug: string | undefined,
    userId: string,
    options?: { unread_only?: boolean; limit?: number },
  ) {
    return this.redeemService.listNotificationsByAppSlug(appSlug, userId, options);
  }

  async syncMyNotifications(
    appSlug: string | undefined,
    userId: string,
    options?: { cursor?: string; unread_only?: boolean; limit?: number },
  ) {
    return this.redeemService.syncNotificationsByAppSlug(appSlug, userId, options);
  }

  async markNotificationRead(appSlug: string | undefined, userId: string, notificationId: string) {
    return this.redeemService.markNotificationReadByAppSlug(appSlug, userId, notificationId);
  }

  async markAllNotificationsRead(appSlug: string | undefined, userId: string) {
    return this.redeemService.markAllNotificationsReadByAppSlug(appSlug, userId);
  }

  async submitMyFeedback(
    appSlug: string | undefined,
    userId: string,
    payload: {
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
    },
  ) {
    return this.feedbackService.submitFeedbackByAppSlug(appSlug, userId, payload);
  }

  async listMyFeedbacks(
    appSlug: string | undefined,
    userId: string,
    options?: { page?: number | string; page_size?: number | string; status?: string },
  ) {
    return this.feedbackService.listMyFeedbacksByAppSlug(appSlug, userId, options);
  }

  async getMyFeedback(appSlug: string | undefined, userId: string, feedbackId: string) {
    return this.feedbackService.getMyFeedbackByAppSlug(appSlug, userId, feedbackId);
  }

  async addMyFeedbackComment(appSlug: string | undefined, userId: string, feedbackId: string, payload: { body?: string }) {
    return this.feedbackService.addMyFeedbackCommentByAppSlug(appSlug, userId, feedbackId, payload);
  }

  async trackBehaviorEvents(
    appSlug: string | undefined,
    userId: string,
    payload: Record<string, unknown>,
    request?: any,
  ) {
    const appId = await this.resolveAppId(appSlug);
    await this.ensureActiveUser(userId);

    const rawEvents = Array.isArray(payload?.events)
      ? (payload.events as Array<Record<string, unknown>>)
      : [payload];

    return this.behaviorAnalyticsService.trackEvents({
      appId,
      userId,
      sessionId: this.asString(payload?.session_id || payload?.sessionId),
      source: this.asString(payload?.source),
      userAgent: this.readUserAgent(request),
      ipAddress: this.readClientIp(request),
      events: rawEvents.map((item) => ({
        event_name: this.asString(item.event_name || item.name || payload.event_name),
        event_category: this.asString(item.event_category || item.category || payload.event_category),
        route_path: this.asString(item.route_path || item.path),
        referrer_path: this.asString(item.referrer_path || item.referrer),
        language_code: this.asString(item.language_code || item.language),
        event_value: item.event_value ?? item.value,
        metadata: (item.metadata as unknown) ?? {},
        occurred_at: (item.occurred_at as string | undefined) || (item.timestamp as string | undefined),
        session_id: this.asString(item.session_id || item.sessionId),
        source: this.asString(item.source),
      })),
    });
  }

  async createRedeemCodes(
    appSlug: string | undefined,
    adminUserId: string,
    payload: { days: number; count?: number; expires_at?: string },
  ) {
    return this.redeemService.createSimpleMembershipCodes(appSlug, adminUserId, payload);
  }

  async listRedeemCodes(appSlug: string | undefined, page = 1, pageSize = 20) {
    return this.redeemService.listCodesByAppSlug(appSlug, page, pageSize);
  }

  async listRedeemCodeRedemptions(
    appSlug: string | undefined,
    page = 1,
    pageSize = 20,
    batchId?: string,
  ) {
    const appId = await this.resolveAppId(appSlug);
    return this.redeemService.listCodeRedemptionsByAppId(appId, page, pageSize, batchId);
  }

  async voidRedeemCode(appSlug: string | undefined, code: string, reason?: string) {
    return this.redeemService.voidCodeByAppSlug(appSlug, code, reason);
  }

  async revokeRedeemCodeRedemption(
    appSlug: string | undefined,
    redemptionId: string,
    actorUserId: string,
    reason?: string,
  ) {
    const appId = await this.resolveAppId(appSlug);
    return this.redeemService.revokeCodeRedemptionByAppId(appId, redemptionId, actorUserId, reason);
  }

  getAdminPermissionCatalog() {
    return ADMIN_PERMISSION_CATALOG;
  }

  async getMyAdminPagePermissions(userId: string, appSlug?: string) {
    const appId = await this.resolveAppId(appSlug);
    const user = await this.prisma.user.findFirst({
      where: { id: userId, appId, deletedAt: null },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const permissions = await this.fetchAdminAllowedPages(appId, userId);
    return {
      role: user.role,
      admin_type: user.adminType,
      is_super_admin: user.adminType === 'SUPER_ADMIN',
      page_permissions: permissions,
      catalog: ADMIN_PERMISSION_CATALOG,
    };
  }

  async listAdminPermissionGroups(userId: string, appSlug?: string) {
    const appId = await this.resolveAppId(appSlug);
    await this.ensureActiveUser(userId);

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, name, description, page_permissions, created_by_user_id, updated_by_user_id, created_at, updated_at
       FROM admin_permission_groups
       WHERE app_id = $1::uuid
       ORDER BY created_at DESC`,
      appId,
    ) as Promise<AdminPermissionGroupRow[]>);

    return {
      total: rows.length,
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        page_permissions: this.parseJsonArray(row.page_permissions),
        created_by_user_id: row.created_by_user_id,
        updated_by_user_id: row.updated_by_user_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    };
  }

  async createAdminPermissionGroup(
    userId: string,
    payload: { name: string; description?: string; page_permissions: string[] },
    appSlug?: string,
  ) {
    const appId = await this.resolveAppId(appSlug);
    await this.ensureActiveUser(userId);

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO admin_permission_groups (id, app_id, name, description, page_permissions, created_by_user_id, updated_by_user_id)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb, $5::uuid, $5::uuid)
       RETURNING id, name, description, page_permissions, created_by_user_id, updated_by_user_id, created_at, updated_at`,
      appId,
      payload.name,
      payload.description || null,
      JSON.stringify(payload.page_permissions || []),
      userId,
    ) as Promise<AdminPermissionGroupRow[]>);

    const group = rows[0];
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      page_permissions: this.parseJsonArray(group.page_permissions),
      created_by_user_id: group.created_by_user_id,
      updated_by_user_id: group.updated_by_user_id,
      created_at: group.created_at,
      updated_at: group.updated_at,
    };
  }

  async updateAdminPermissionGroup(
    userId: string,
    groupId: string,
    payload: { name?: string; description?: string; page_permissions?: string[] },
    appSlug?: string,
  ) {
    const appId = await this.resolveAppId(appSlug);
    await this.ensureActiveUser(userId);

    const existing = await (this.prisma.$queryRawUnsafe(
      `SELECT id, name, description, page_permissions, created_by_user_id, updated_by_user_id, created_at, updated_at
       FROM admin_permission_groups
       WHERE id = $1::uuid AND app_id = $2::uuid`,
      groupId,
      appId,
    ) as Promise<AdminPermissionGroupRow[]>);
    if (!existing[0]) {
      throw new NotFoundException('Permission group not found');
    }

    const mergedPermissions = payload.page_permissions ?? this.parseJsonArray(existing[0].page_permissions);
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE admin_permission_groups
       SET name = $1, description = $2, page_permissions = $3::jsonb, updated_by_user_id = $4::uuid, updated_at = now()
       WHERE id = $5::uuid AND app_id = $6::uuid
       RETURNING id, name, description, page_permissions, created_by_user_id, updated_by_user_id, created_at, updated_at`,
      payload.name ?? existing[0].name,
      payload.description ?? existing[0].description,
      JSON.stringify(mergedPermissions),
      userId,
      groupId,
      appId,
    ) as Promise<AdminPermissionGroupRow[]>);

    const group = rows[0];
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      page_permissions: this.parseJsonArray(group.page_permissions),
      created_by_user_id: group.created_by_user_id,
      updated_by_user_id: group.updated_by_user_id,
      created_at: group.created_at,
      updated_at: group.updated_at,
    };
  }

  async deleteAdminPermissionGroup(groupId: string, appSlug?: string) {
    const appId = await this.resolveAppId(appSlug);
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM admin_permission_groups WHERE id = $1::uuid AND app_id = $2::uuid`,
      groupId,
      appId,
    );
    return { message: 'Deleted' };
  }

  async listSubAdmins(appSlug?: string) {
    const appId = await this.resolveAppId(appSlug);
    const users = await this.prisma.user.findMany({
      where: {
        appId,
        role: 'ADMIN',
        adminType: 'ADMIN',
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    const items = await Promise.all(
      users.map(async (user) => {
        const pagePermissions = await this.fetchAdminAllowedPages(appId, user.id);
        return {
          id: user.id,
          email: user.email,
          display_name: user.displayName || user.fullName || user.email,
          is_active: user.isActive,
          created_at: user.createdAt,
          last_login_at: user.lastLoginAt,
          page_permissions: pagePermissions,
        };
      }),
    );

    return {
      total: items.length,
      items,
    };
  }

  async assignSubAdmin(
    currentUserId: string,
    payload: { email: string; password?: string; display_name?: string; page_permissions: string[] },
    appSlug?: string,
  ) {
    const appId = await this.resolveAppId(appSlug);
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    let target = await this.prisma.user.findFirst({
      where: {
        appId,
        email,
        deletedAt: null,
      },
    });
    if (!target) {
      const password = String(payload.password || '');
      if (!password) {
        throw new NotFoundException('User not found');
      }
      if (password.length < 8) {
        throw new BadRequestException('Password must be at least 8 characters');
      }
      const displayName = String(payload.display_name || '').trim() || email.split('@')[0];
      target = await this.prisma.user.create({
        data: {
          appId,
          email,
          hashedPassword: await bcrypt.hash(password, 10),
          fullName: displayName,
          displayName,
          role: 'ADMIN',
          adminType: 'ADMIN',
          isActive: true,
          sessionToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        },
      });
    }
    const updated = await this.prisma.user.update({
      where: { id: target.id },
      data: {
        role: 'ADMIN',
        adminType: 'ADMIN',
        isActive: true,
        displayName: payload.display_name ? String(payload.display_name).trim() || target.displayName : undefined,
        fullName: payload.display_name ? String(payload.display_name).trim() || target.fullName : undefined,
      },
    });

    await this.upsertAdminPagePermissions(appId, updated.id, payload.page_permissions, currentUserId);
    const pagePermissions = await this.fetchAdminAllowedPages(appId, updated.id);
    return {
      id: updated.id,
      email: updated.email,
      display_name: updated.displayName || updated.fullName || updated.email,
      is_active: true,
      created_at: updated.createdAt,
      last_login_at: updated.lastLoginAt,
      page_permissions: pagePermissions,
    };
  }

  async updateSubAdminPermissions(
    currentUserId: string,
    subAdminId: string,
    payload: { page_permissions: string[] },
    appSlug?: string,
  ) {
    const appId = await this.resolveAppId(appSlug);
    const target = await this.prisma.user.findFirst({
      where: {
        id: subAdminId,
        appId,
        role: 'ADMIN',
        deletedAt: null,
      },
    });
    if (!target) {
      throw new NotFoundException('Sub admin not found');
    }

    await this.upsertAdminPagePermissions(appId, target.id, payload.page_permissions, currentUserId);
    const pagePermissions = await this.fetchAdminAllowedPages(appId, target.id);
    return {
      id: target.id,
      email: target.email,
      display_name: target.displayName || target.fullName || target.email,
      is_active: target.isActive,
      created_at: target.createdAt,
      last_login_at: target.lastLoginAt,
      page_permissions: pagePermissions,
    };
  }

  async deleteSubAdmin(subAdminId: string, appSlug?: string) {
    const appId = await this.resolveAppId(appSlug);
    const target = await this.prisma.user.findFirst({
      where: {
        id: subAdminId,
        appId,
        role: 'ADMIN',
        deletedAt: null,
      },
    });
    if (!target) {
      throw new NotFoundException('Sub admin not found');
    }

    await this.prisma.user.update({
      where: { id: target.id },
      data: {
        role: 'USER',
        adminType: null,
      },
    });
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM admin_page_permissions WHERE app_id = $1::uuid AND admin_user_id = $2::uuid`,
      appId,
      target.id,
    );
    return { message: 'Deleted' };
  }

  private async resolveAppId(appSlug?: string): Promise<string> {
    const slug = appSlug || this.config.app.defaultSlug;
    const cached = this.appIdCache.get(slug);
    if (cached) {
      return cached;
    }
    const app = await this.prisma.app.findUnique({ where: { slug } });
    if (!app) {
      throw new NotFoundException(`App not found: ${slug}`);
    }
    this.appIdCache.set(slug, app.id);
    return app.id;
  }

  private async tenantUserExists(appId: string, userId: string): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        appId,
        deletedAt: null,
      },
      select: { id: true },
    });
    return !!user;
  }

  private async ensureActiveUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) {
      throw new NotFoundException('User not found');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('User is inactive');
    }
    return user;
  }

  private async assertPhoneAvailable(appId: string, currentUserId: string, phone: string) {
    const phoneVariants = this.authService.normalizeSmsPhoneVariants(phone);
    const existing = await this.prisma.user.findFirst({
      where: {
        appId,
        phone: { in: phoneVariants },
        phoneVerified: true,
        deletedAt: null,
        NOT: {
          id: currentUserId,
        },
      },
      select: {
        id: true,
      },
    });
    if (existing) {
      throw new ConflictException('手机号已绑定其他账号');
    }
  }

  private toUserProfile(user: any) {
    return {
      id: user.id,
      app_id: user.appId,
      app_slug: user.app?.slug,
      email: user.email,
      full_name: user.fullName,
      display_name: user.displayName || user.fullName || user.email,
      avatar_url: user.avatarUrl,
      role: user.role,
      admin_type: user.adminType,
      is_active: user.isActive,
      phone: user.phone,
      phone_verified: user.phoneVerified,
      wechat_openid: user.wechatOpenid,
      wechat_unionid: user.wechatUnionid,
      membership_type: user.membershipType,
      membership_expires_at: user.membershipExpiresAt,
      is_premium: user.isPremium,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
      last_login_at: user.lastLoginAt,
    };
  }

  private stringOrUndefined(value: unknown): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string') {
      return undefined;
    }
    return value;
  }

  private normalizePositiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.max(1, Math.floor(parsed));
  }

  private toSafeInteger(value: unknown): number {
    const parsed = Number(value || 0);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }
    return Math.floor(parsed);
  }

  private toSafeDecimal2(value: unknown): number {
    const parsed = Number(value || 0);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }
    return Number((Math.round((parsed + Number.EPSILON) * 100) / 100).toFixed(2));
  }

  private generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private asString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  private readUserAgent(request: any): string | null {
    const value = request?.headers?.['user-agent'];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    return null;
  }

  private readClientIp(request: any): string | null {
    const forwardedFor = request?.headers?.['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
      const first = forwardedFor.split(',')[0]?.trim();
      if (first) {
        return first;
      }
    }

    const candidates = [request?.ip, request?.socket?.remoteAddress, request?.connection?.remoteAddress];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return null;
  }

  private parseJsonArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((item) => typeof item === 'string');
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.filter((item) => typeof item === 'string');
        }
      } catch {
        return [];
      }
    }
    return [];
  }

  private async fetchAdminAllowedPages(appId: string, adminUserId: string): Promise<string[]> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, allowed_pages FROM admin_page_permissions WHERE app_id = $1::uuid AND admin_user_id = $2::uuid LIMIT 1`,
      appId,
      adminUserId,
    ) as Promise<AdminPagePermissionRow[]>);
    return this.parseJsonArray(rows[0]?.allowed_pages);
  }

  private async upsertAdminPagePermissions(
    appId: string,
    adminUserId: string,
    pagePermissions: string[],
    actorUserId: string,
  ) {
    const existing = await (this.prisma.$queryRawUnsafe(
      `SELECT id, allowed_pages FROM admin_page_permissions WHERE app_id = $1::uuid AND admin_user_id = $2::uuid LIMIT 1`,
      appId,
      adminUserId,
    ) as Promise<AdminPagePermissionRow[]>);
    if (existing[0]) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE admin_page_permissions
         SET allowed_pages = $1::jsonb, updated_by_user_id = $2::uuid, updated_at = now()
         WHERE id = $3::uuid`,
        JSON.stringify(pagePermissions || []),
        actorUserId,
        existing[0].id,
      );
    } else {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO admin_page_permissions (id, app_id, admin_user_id, allowed_pages, created_by_user_id, updated_by_user_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::jsonb, $4::uuid, $4::uuid)`,
        appId,
        adminUserId,
        JSON.stringify(pagePermissions || []),
        actorUserId,
      );
    }
  }
}
