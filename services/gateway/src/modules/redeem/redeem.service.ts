import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { normalizeLanguageCode } from '../../common/utils/language-code';
import { PRISMA_CLIENT } from '../../config/database.module';

type TxClient = Prisma.TransactionClient;

export type RedeemGrantScope = 'app_membership' | 'ai_membership';

export interface RedeemGrantInput {
  scope: RedeemGrantScope;
  resource_id?: string;
  language_code?: string;
  days?: number;
  metadata?: Record<string, unknown>;
}

export interface RedeemGrantNormalized {
  scope: RedeemGrantScope;
  resource_id: string | null;
  language_code: string | null;
  days: number | null;
  metadata: Record<string, unknown>;
}

interface EntitlementCodeRow {
  id: string;
  app_id: string;
  batch_id: string | null;
  code: string;
  package_id: string | null;
  grants_json: unknown;
  note: string | null;
  max_uses: number;
  used_count: number;
  expires_at: Date | null;
  status: string;
  void_reason: string | null;
  first_used_by_user_id: string | null;
  first_used_at: Date | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface UserEntitlementRow {
  id: string;
  app_id: string;
  user_id: string;
  entitlement_key: string;
  scope: RedeemGrantScope;
  resource_id: string | null;
  language_code: string | null;
  starts_at: Date;
  expires_at: Date | null;
  is_active: boolean;
  source_code_id: string | null;
  source_redemption_id: string | null;
  metadata_json: unknown;
  created_at: Date;
  updated_at: Date;
}

interface EntitlementCodeRedemptionRow {
  id: string;
  app_id: string;
  code_id: string;
  user_id: string;
  applied_grants_json: unknown;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by_user_id: string | null;
  revoke_reason: string | null;
}

interface PublicMembershipProductItem {
  id: string;
  name: string;
  description: string;
  cover_url: string | null;
  price_cny: number;
  updated_at: Date;
}

interface PublicMembershipProductsResponse {
  total: number;
  items: PublicMembershipProductItem[];
}

interface PublicMembershipProductsCacheEntry {
  value: PublicMembershipProductsResponse;
  expiresAt: number;
}

const PUBLIC_PRODUCTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLIC_PRODUCTS_CACHE_MAX_ENTRIES = 500;

@Injectable()
export class RedeemService implements OnModuleInit {
  private readonly logger = new Logger(RedeemService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;
  private readonly publicMembershipProductsCache = new Map<string, PublicMembershipProductsCacheEntry>();

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`redeem startup warmup failed: ${error?.message || error}`);
    }
  }

  async redeemCodeByAppSlug(appSlug: string | undefined, userId: string, rawCode: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const code = this.normalizeCode(rawCode);
    if (!code) {
      throw new BadRequestException('兑换码不能为空');
    }

    await this.ensureUserInApp(app.id, userId);

    const result = await this.prisma.$transaction(async (tx) => {
      const lockedRows = await (tx.$queryRawUnsafe(
        `SELECT *
         FROM entitlement_codes
         WHERE app_id = $1::uuid
           AND code = $2
         LIMIT 1
         FOR UPDATE`,
        app.id,
        code,
      ) as Promise<EntitlementCodeRow[]>);
      const codeRow = lockedRows[0];
      if (!codeRow) {
        throw new NotFoundException('兑换码不存在');
      }
      if (String(codeRow.status || '').toLowerCase() !== 'active') {
        throw new BadRequestException('兑换码已失效');
      }
      if (codeRow.expires_at && codeRow.expires_at.getTime() <= Date.now()) {
        throw new BadRequestException('兑换码已过期');
      }
      if (Number(codeRow.used_count || 0) >= Number(codeRow.max_uses || 1)) {
        throw new BadRequestException('兑换码已达到使用次数上限');
      }

      const existingRedeem = await (tx.$queryRawUnsafe(
        `SELECT id
         FROM entitlement_code_redemptions
         WHERE app_id = $1::uuid AND code_id = $2::uuid AND user_id = $3::uuid
         LIMIT 1`,
        app.id,
        codeRow.id,
        userId,
      ) as Promise<Array<{ id: string }>>);
      if (existingRedeem[0]) {
        throw new ConflictException('该账号已使用过此兑换码');
      }

      const grants = this.parseGrantArray(codeRow.grants_json);
      if (!grants.length) {
        throw new BadRequestException('兑换码未配置权益内容');
      }
      const packageMetaRows = codeRow.package_id
        ? await (tx.$queryRawUnsafe(
            `SELECT id, name, cover_url
             FROM entitlement_packages
             WHERE app_id = $1::uuid AND id = $2::uuid
             LIMIT 1`,
            app.id,
            codeRow.package_id,
          ) as Promise<Array<{ id: string; name: string; cover_url: string | null }>>)
        : [];
      const packageMeta = packageMetaRows[0] || null;

      const redemptionRows = await (tx.$queryRawUnsafe(
        `INSERT INTO entitlement_code_redemptions (
           id, app_id, code_id, user_id, applied_grants_json, created_at
         )
         VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::jsonb, now()
         )
         RETURNING id, created_at`,
        app.id,
        codeRow.id,
        userId,
        JSON.stringify(grants),
      ) as Promise<Array<{ id: string; created_at: Date }>>);
      const redemption = redemptionRows[0];

      await tx.$executeRawUnsafe(
        `UPDATE entitlement_codes
         SET used_count = used_count + 1,
             first_used_by_user_id = COALESCE(first_used_by_user_id, $1::uuid),
             first_used_at = COALESCE(first_used_at, now()),
             updated_at = now()
         WHERE id = $2::uuid`,
        userId,
        codeRow.id,
      );

      const granted: Array<Record<string, unknown>> = [];
      for (const grant of grants) {
        const applied = await this.applyGrant(tx, {
          appId: app.id,
          userId,
          actorUserId: userId,
          codeId: codeRow.id,
          redemptionId: redemption.id,
          grant,
        });
        granted.push(applied);
      }
      await this.pushNotificationTx(tx, app.id, userId, {
        type: 'product.redeem_granted',
        title: '新产品已到账',
        message: packageMeta?.name
          ? `你已通过兑换码获得产品「${packageMeta.name}」。`
          : '你已通过兑换码获得新的产品权益。',
        payload: {
          source: 'redeem_code',
          code: codeRow.code,
          product_id: packageMeta?.id || codeRow.package_id || null,
          product_name: packageMeta?.name || null,
          product_cover_url: packageMeta?.cover_url || null,
          granted_count: granted.length,
          granted_scopes: granted.map((item) => String(item.scope || '')).filter(Boolean),
          redeemed_at: redemption.created_at,
        },
      });

      return {
        code: codeRow.code,
        package_id: packageMeta?.id || codeRow.package_id || null,
        package_name: packageMeta?.name || null,
        redeemed_at: redemption.created_at,
        granted,
      };
    });

    const entitlementSummary = await this.listUserEntitlementsByAppSlug(app.slug, userId);

    return {
      message: '兑换成功',
      ...result,
      entitlements: entitlementSummary,
    };
  }

  async listUserEntitlementsByAppSlug(appSlug: string | undefined, userId: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);

    const nowIso = new Date().toISOString();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM user_entitlements
       WHERE app_id = $1::uuid
         AND user_id = $2::uuid
         AND is_active = true
         AND (expires_at IS NULL OR expires_at > $3::timestamptz)
       ORDER BY created_at DESC`,
      app.id,
      userId,
      nowIso,
    ) as Promise<UserEntitlementRow[]>);

    const userRows = await (this.prisma.$queryRawUnsafe(
      `SELECT membership_expires_at
       FROM users
       WHERE id = $1::uuid AND app_id = $2::uuid AND deleted_at IS NULL
       LIMIT 1`,
      userId,
      app.id,
    ) as Promise<Array<{ membership_expires_at: Date | null }>>);

    const appMembershipExpiresAt = userRows[0]?.membership_expires_at || null;

    let aiMembershipExpiresAt: Date | null = null;

    rows.forEach((row) => {
      if (row.scope === 'ai_membership') {
        if (!aiMembershipExpiresAt || ((row.expires_at?.getTime() || 0) > aiMembershipExpiresAt.getTime())) {
          aiMembershipExpiresAt = row.expires_at;
        }
      }
    });

    return {
      app_id: app.id,
      app_slug: app.slug,
      app_membership_expires_at: appMembershipExpiresAt,
      ai_membership_expires_at: aiMembershipExpiresAt,
      items: rows.map((row) => this.serializeEntitlementRow(row)),
    };
  }

  async pushNotificationByAppSlug(
    appSlug: string | undefined,
    userId: string,
    payload: { type?: string; title: string; message: string; payload?: Record<string, unknown> },
  ) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    return this.pushNotificationByAppId(app.id, userId, payload);
  }

  async pushNotificationByAppId(
    appId: string,
    userId: string,
    payload: { type?: string; title: string; message: string; payload?: Record<string, unknown> },
  ) {
    await this.ensureSchema();
    await this.ensureUserInApp(appId, userId);
    const type = String(payload.type || 'system').trim() || 'system';
    const title = String(payload.title || '').trim();
    const message = String(payload.message || '').trim();
    if (!title || !message) {
      throw new BadRequestException('通知标题和内容不能为空');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO user_notifications (
         id, app_id, user_id, notification_type, title, message, payload_json, is_read, created_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, false, now()
       )
       RETURNING id, notification_type, title, message, payload_json, is_read, read_at, created_at`,
      appId,
      userId,
      type,
      title,
      message,
      JSON.stringify(payload.payload || {}),
    ) as Promise<Array<{
        id: string;
        notification_type: string;
        title: string;
        message: string;
        payload_json: unknown;
        is_read: boolean;
        read_at: Date | null;
        created_at: Date;
      }>>);
    return this.serializeNotificationRow(rows[0]);
  }

  async listNotificationsByAppSlug(
    appSlug: string | undefined,
    userId: string,
    options?: { unread_only?: boolean; limit?: number },
  ) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    const unreadOnly = !!options?.unread_only;
    const limit = Math.min(Math.max(Number(options?.limit || 20), 1), 100);

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, notification_type, title, message, payload_json, is_read, read_at, created_at
       FROM user_notifications
       WHERE app_id = $1::uuid
         AND user_id = $2::uuid
         AND ($3::boolean = false OR is_read = false)
       ORDER BY created_at DESC
       LIMIT $4`,
      app.id,
      userId,
      unreadOnly,
      limit,
    ) as Promise<Array<{
        id: string;
        notification_type: string;
        title: string;
        message: string;
        payload_json: unknown;
        is_read: boolean;
        read_at: Date | null;
        created_at: Date;
      }>>);

    const unreadRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count
       FROM user_notifications
       WHERE app_id = $1::uuid AND user_id = $2::uuid AND is_read = false`,
      app.id,
      userId,
    ) as Promise<Array<{ count: bigint }>>);

    return {
      unread_count: Number(unreadRows[0]?.count || 0),
      items: rows.map((row) => this.serializeNotificationRow(row)),
    };
  }

  async syncNotificationsByAppSlug(
    appSlug: string | undefined,
    userId: string,
    options?: { cursor?: string; unread_only?: boolean; limit?: number },
  ) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    const cursor = String(options?.cursor || '').trim();
    const unreadOnly = !!options?.unread_only;
    const limit = Math.min(Math.max(Number(options?.limit || 20), 1), 50);

    const [rows, unreadRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT id, notification_type, title, message, payload_json, is_read, read_at, created_at
         FROM user_notifications
         WHERE app_id = $1::uuid
           AND user_id = $2::uuid
           AND ($3::text = '' OR created_at > NULLIF($3::text, '')::timestamptz)
           AND ($4::boolean = false OR is_read = false)
         ORDER BY created_at DESC
         LIMIT $5`,
        app.id,
        userId,
        cursor,
        unreadOnly,
        limit + 1,
      ) as Promise<Array<{
          id: string;
          notification_type: string;
          title: string;
          message: string;
          payload_json: unknown;
          is_read: boolean;
          read_at: Date | null;
          created_at: Date;
        }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count
         FROM user_notifications
         WHERE app_id = $1::uuid AND user_id = $2::uuid AND is_read = false`,
        app.id,
        userId,
      ) as Promise<Array<{ count: bigint }>>),
    ]);

    const items = rows.slice(0, limit);
    const cursorSource = items.reduce<Date | null>((latest, row) => {
      if (!latest || row.created_at > latest) {
        return row.created_at;
      }
      return latest;
    }, null);
    const serverClockRows =
      cursorSource || cursor ? [] : await (this.prisma.$queryRawUnsafe(`SELECT now() AS cursor`) as Promise<Array<{ cursor: Date }>>);
    return {
      unread_count: Number(unreadRows[0]?.count || 0),
      cursor: cursorSource ? cursorSource.toISOString() : cursor || (serverClockRows[0]?.cursor || new Date()).toISOString(),
      items: items.map((row) => this.serializeNotificationRow(row)),
      has_more: rows.length > limit,
      next_poll_after_seconds: 300,
    };
  }

  async markNotificationReadByAppSlug(appSlug: string | undefined, userId: string, notificationId: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE user_notifications
       SET is_read = true,
           read_at = COALESCE(read_at, now())
       WHERE app_id = $1::uuid
         AND user_id = $2::uuid
         AND id = $3::uuid
       RETURNING id, notification_type, title, message, payload_json, is_read, read_at, created_at`,
      app.id,
      userId,
      notificationId,
    ) as Promise<Array<{
        id: string;
        notification_type: string;
        title: string;
        message: string;
        payload_json: unknown;
        is_read: boolean;
        read_at: Date | null;
        created_at: Date;
      }>>);
    if (!rows[0]) {
      throw new NotFoundException('通知不存在');
    }
    return this.serializeNotificationRow(rows[0]);
  }

  async markAllNotificationsReadByAppSlug(appSlug: string | undefined, userId: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    const affected = await this.prisma.$executeRawUnsafe(
      `UPDATE user_notifications
       SET is_read = true,
           read_at = COALESCE(read_at, now())
       WHERE app_id = $1::uuid
         AND user_id = $2::uuid
         AND is_read = false`,
      app.id,
      userId,
    );
    return {
      affected: Number(affected || 0),
    };
  }

  async listPublicMembershipProductsByAppSlug(
    appSlug: string | undefined,
    options?: { limit?: number },
  ) {
    const slug = String(appSlug || '').trim();
    if (!slug) {
      throw new NotFoundException('App slug is required');
    }
    const rawLimit = Number(options?.limit || 200);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.round(rawLimit))) : 200;
    const cacheKey = this.buildPublicMembershipProductsCacheKey(slug, limit);
    const cached = this.readPublicMembershipProductsCache(cacheKey);
    if (cached) {
      return cached;
    }

    await this.ensureSchema();
    const app = await this.resolveAppBySlug(slug);

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, name, description, cover_url, language_code, price_cny, updated_at
       FROM entitlement_packages
       WHERE app_id = $1::uuid
         AND is_active = true
       ORDER BY updated_at DESC
       LIMIT ${limit}`,
      app.id,
    ) as Promise<Array<{
        id: string;
        name: string;
        description: string | null;
        cover_url: string | null;
        language_code: string | null;
        price_cny: unknown;
        updated_at: Date;
      }>>);

    const items = rows.map((row) => ({
      id: row.id,
      name: String(row.name || '').trim() || '未命名产品',
      description: row.description || '',
      cover_url: row.cover_url || null,
      price_cny: this.normalizePriceCnyValue(row.price_cny),
      updated_at: row.updated_at,
    }));

    const response: PublicMembershipProductsResponse = {
      total: items.length,
      items,
    };
    this.writePublicMembershipProductsCache(cacheKey, response);
    return response;
  }

  async listPackagesByAppId(appId: string) {
    await this.ensureSchema();
    await this.resolveAppById(appId);

    const packages = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM entitlement_packages
       WHERE app_id = $1::uuid
       ORDER BY updated_at DESC, created_at DESC`,
      appId,
    ) as Promise<Array<{
        id: string;
        app_id: string;
        name: string;
        description: string | null;
        cover_url: string | null;
        language_code: string | null;
        price_cny: unknown;
        is_active: boolean;
        created_by_user_id: string | null;
        updated_by_user_id: string | null;
        created_at: Date;
        updated_at: Date;
      }>>);

    const packageIds = packages.map((item) => item.id);
    let items: Array<{
      id: string;
      package_id: string;
      sort_order: number;
      scope: RedeemGrantScope;
      resource_id: string | null;
      language_code: string | null;
      days: number | null;
      metadata_json: unknown;
    }> = [];

    if (packageIds.length > 0) {
      items = await this.prisma.$queryRawUnsafe(
        `SELECT id, package_id, sort_order, scope, resource_id, language_code, days, metadata_json
         FROM entitlement_package_items
         WHERE app_id = $1::uuid AND package_id = ANY($2::uuid[])
         ORDER BY sort_order ASC, created_at ASC`,
        appId,
        packageIds,
      );
    }

    const grouped = new Map<string, typeof items>();
    items.forEach((item) => {
      const arr = grouped.get(item.package_id) || [];
      arr.push(item);
      grouped.set(item.package_id, arr);
    });

    return {
      items: packages.map((pkg) => ({
        id: pkg.id,
        app_id: pkg.app_id,
        name: pkg.name,
        description: pkg.description,
        cover_url: pkg.cover_url || null,
        language_code: normalizeLanguageCode(pkg.language_code) || pkg.language_code || null,
        price_cny: this.normalizePriceCnyValue(pkg.price_cny),
        is_active: pkg.is_active,
        created_by_user_id: pkg.created_by_user_id,
        updated_by_user_id: pkg.updated_by_user_id,
        created_at: pkg.created_at,
        updated_at: pkg.updated_at,
        grants: (grouped.get(pkg.id) || []).map((grant) => this.serializeGrantRow(grant)),
      })),
    };
  }

  async createPackageByAppId(
    appId: string,
    actorUserId: string,
    payload: {
      name: string;
      description?: string;
      cover_url?: string;
      language_code?: string;
      price_cny?: unknown;
      is_active?: boolean;
      grants: RedeemGrantInput[];
    },
  ) {
    await this.ensureSchema();
    await this.resolveAppById(appId);
    await this.ensureActiveUser(actorUserId);

    const name = String(payload?.name || '').trim();
    if (!name) {
      throw new BadRequestException('产品名称不能为空');
    }
    const priceCny = this.normalizePriceCnyInput(payload?.price_cny, 'price_cny');

    const grants = this.normalizeGrants(payload?.grants || []);
    await this.validateGrantTargets(appId, grants);

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO entitlement_packages (
         id, app_id, name, description, cover_url, language_code, price_cny, is_active, created_by_user_id, updated_by_user_id, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::numeric, $7, $8::uuid, $8::uuid, now(), now()
       )
       RETURNING id`,
      appId,
      name,
      payload.description || null,
      payload.cover_url || null,
      null,
      priceCny,
      payload.is_active !== false,
      actorUserId,
    ) as Promise<Array<{ id: string }>>);

    const packageId = rows[0]?.id;
    if (!packageId) {
      throw new BadRequestException('创建产品失败');
    }

    await this.replacePackageGrants(appId, packageId, grants);
    this.clearPublicMembershipProductsCache();
    const list = await this.listPackagesByAppId(appId);
    return list.items.find((item: any) => item.id === packageId);
  }

  async updatePackageByAppId(
    appId: string,
    packageId: string,
    actorUserId: string,
    payload: {
      name?: string;
      description?: string;
      cover_url?: string;
      language_code?: string;
      price_cny?: unknown;
      is_active?: boolean;
      grants?: RedeemGrantInput[];
    },
  ) {
    await this.ensureSchema();
    await this.resolveAppById(appId);
    await this.ensureActiveUser(actorUserId);

    const existing = await (this.prisma.$queryRawUnsafe(
      `SELECT id, name, description, cover_url, language_code, price_cny, is_active
       FROM entitlement_packages
       WHERE app_id = $1::uuid AND id = $2::uuid
       LIMIT 1`,
      appId,
      packageId,
    ) as Promise<Array<{
        id: string;
        name: string;
        description: string | null;
        cover_url: string | null;
        language_code: string | null;
        price_cny: unknown;
        is_active: boolean;
      }>>);
    if (!existing[0]) {
      throw new NotFoundException('产品不存在');
    }

    const nextName = payload.name !== undefined ? String(payload.name || '').trim() : existing[0].name;
    if (!nextName) {
      throw new BadRequestException('产品名称不能为空');
    }
    const nextPriceCny = payload.price_cny !== undefined
      ? this.normalizePriceCnyInput(payload.price_cny, 'price_cny')
      : this.normalizePriceCnyValue(existing[0].price_cny);
    await this.prisma.$executeRawUnsafe(
      `UPDATE entitlement_packages
       SET name = $1,
           description = $2,
           cover_url = $3,
           language_code = $4,
           price_cny = $5::numeric,
           is_active = $6,
           updated_by_user_id = $7::uuid,
           updated_at = now()
       WHERE app_id = $8::uuid AND id = $9::uuid`,
      nextName,
      payload.description !== undefined ? payload.description : existing[0].description,
      payload.cover_url !== undefined ? payload.cover_url : existing[0].cover_url,
      null,
      nextPriceCny,
      payload.is_active !== undefined ? payload.is_active : existing[0].is_active,
      actorUserId,
      appId,
      packageId,
    );

    if (payload.grants) {
      const grants = this.normalizeGrants(payload.grants);
      await this.validateGrantTargets(appId, grants);
      await this.replacePackageGrants(appId, packageId, grants);
    }

    this.clearPublicMembershipProductsCache();
    const list = await this.listPackagesByAppId(appId);
    return list.items.find((item: any) => item.id === packageId);
  }

  async deletePackageByAppId(appId: string, packageId: string) {
    await this.ensureSchema();
    await this.resolveAppById(appId);

    const affected = await this.prisma.$executeRawUnsafe(
      `DELETE FROM entitlement_packages WHERE app_id = $1::uuid AND id = $2::uuid`,
      appId,
      packageId,
    );
    if (Number(affected || 0) > 0) {
      this.clearPublicMembershipProductsCache();
    }

    return { deleted: Number(affected || 0) > 0 };
  }

  async distributePackageToUserByAppId(
    appId: string,
    packageId: string,
    actorUserId: string,
    payload: {
      user_id: string;
      source?: 'admin' | 'purchase';
      order_id?: string | null;
      out_trade_no?: string | null;
      payment_channel?: string | null;
    },
  ) {
    await this.ensureSchema();
    await this.resolveAppById(appId);
    await this.ensureActiveUser(actorUserId);
    const targetUserId = String(payload?.user_id || '').trim();
    if (!targetUserId) {
      throw new BadRequestException('user_id 不能为空');
    }
    await this.ensureUserInApp(appId, targetUserId);

    const packageRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, name, cover_url, is_active
       FROM entitlement_packages
       WHERE app_id = $1::uuid AND id = $2::uuid
       LIMIT 1`,
      appId,
      packageId,
    ) as Promise<Array<{ id: string; name: string; cover_url: string | null; is_active: boolean }>>);
    const packageRow = packageRows[0];
    if (!packageRow) {
      throw new NotFoundException('产品不存在');
    }
    if (!packageRow.is_active) {
      throw new BadRequestException('产品已停用，无法分发');
    }

    const grantRows = await (this.prisma.$queryRawUnsafe(
      `SELECT scope, resource_id, language_code, days, metadata_json
       FROM entitlement_package_items
       WHERE app_id = $1::uuid AND package_id = $2::uuid
       ORDER BY sort_order ASC, created_at ASC`,
      appId,
      packageId,
    ) as Promise<Array<{
        scope: RedeemGrantScope;
        resource_id: string | null;
        language_code: string | null;
        days: number | null;
        metadata_json: unknown;
      }>>);
    const grants = grantRows.map((row) => ({
      scope: row.scope,
      resource_id: row.resource_id,
      language_code: row.language_code,
      days: row.days,
      metadata: this.parseObject(row.metadata_json),
    }));
    if (!grants.length) {
      throw new BadRequestException('产品没有可分发权益');
    }

    const source = payload?.source === 'purchase' ? 'purchase' : 'admin';
    const granted = await this.prisma.$transaction(async (tx) => {
      const appliedItems: Array<Record<string, unknown>> = [];
      for (const grant of grants) {
        const applied = await this.applyGrant(tx, {
          appId,
          userId: targetUserId,
          actorUserId,
          codeId: null,
          redemptionId: null,
          grant,
        });
        appliedItems.push(applied);
      }
      const isPurchase = source === 'purchase';
      await this.pushNotificationTx(tx, appId, targetUserId, {
        type: isPurchase ? 'product.purchase_granted' : 'product.distributed',
        title: isPurchase ? '购买成功' : '新产品已到账',
        message: isPurchase
          ? `你已成功购买产品「${packageRow.name}」，权益已到账。`
          : `管理员已为你分发产品「${packageRow.name}」。`,
        payload: {
          source: isPurchase ? 'product_purchase' : 'product_distribution',
          product_id: packageRow.id,
          product_name: packageRow.name,
          product_cover_url: packageRow.cover_url,
          distributed_by_user_id: actorUserId,
          order_id: payload?.order_id || null,
          out_trade_no: payload?.out_trade_no || null,
          payment_channel: payload?.payment_channel || null,
          granted_count: appliedItems.length,
          granted_scopes: appliedItems.map((item) => String(item.scope || '')).filter(Boolean),
          distributed_at: new Date().toISOString(),
        },
      });
      return appliedItems;
    });

    return {
      message: '产品分发成功',
      package: {
        id: packageRow.id,
        name: packageRow.name,
        cover_url: packageRow.cover_url,
      },
      user_id: targetUserId,
      granted,
    };
  }

  async createCodeBatchByAppId(
    appId: string,
    actorUserId: string,
    payload: {
      name?: string;
      note?: string;
      count: number;
      code_prefix?: string;
      max_uses?: number;
      expires_at?: string;
      package_id?: string;
      grants?: RedeemGrantInput[];
    },
  ) {
    await this.ensureSchema();
    await this.resolveAppById(appId);
    await this.ensureActiveUser(actorUserId);

    const count = Math.min(Math.max(Number(payload?.count || 0), 1), 5000);
    const maxUses = Math.min(Math.max(Number(payload?.max_uses || 1), 1), 1000);
    const codePrefix = this.normalizeCodePrefix(payload?.code_prefix);
    const expiresAt = payload?.expires_at ? new Date(payload.expires_at) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('expires_at 不是合法时间');
    }

    let grants: RedeemGrantNormalized[] = [];
    let packageId: string | null = null;

    if (payload?.package_id) {
      const packageRows = await (this.prisma.$queryRawUnsafe(
        `SELECT id, is_active
         FROM entitlement_packages
         WHERE app_id = $1::uuid AND id = $2::uuid
         LIMIT 1`,
        appId,
        payload.package_id,
      ) as Promise<Array<{ id: string; is_active: boolean }>>);
      const pkg = packageRows[0];
      if (!pkg) {
        throw new NotFoundException('产品不存在');
      }
      if (!pkg.is_active) {
        throw new BadRequestException('产品已停用');
      }
      packageId = pkg.id;
      const itemRows = await (this.prisma.$queryRawUnsafe(
        `SELECT scope, resource_id, language_code, days, metadata_json
         FROM entitlement_package_items
         WHERE app_id = $1::uuid AND package_id = $2::uuid
         ORDER BY sort_order ASC, created_at ASC`,
        appId,
        packageId,
      ) as Promise<Array<{
          scope: RedeemGrantScope;
          resource_id: string | null;
          language_code: string | null;
          days: number | null;
          metadata_json: unknown;
        }>>);
      grants = itemRows.map((item) => ({
        scope: item.scope,
        resource_id: item.resource_id,
        language_code: item.language_code,
        days: item.days,
        metadata: this.parseObject(item.metadata_json),
      }));
    } else {
      grants = this.normalizeGrants(payload?.grants || []);
      await this.validateGrantTargets(appId, grants);
    }

    if (!grants.length) {
      throw new BadRequestException('至少配置一项权益');
    }

    const batchName = String(payload?.name || '').trim() || `兑换码批次 ${new Date().toLocaleString('zh-CN')}`;

    const batchRows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO entitlement_code_batches (
         id, app_id, name, note, code_prefix, total_count, max_uses, expires_at,
         package_id, grants_json, created_by_user_id, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7,
         $8::uuid, $9::jsonb, $10::uuid, now(), now()
       )
       RETURNING id`,
      appId,
      batchName,
      payload?.note || null,
      codePrefix,
      count,
      maxUses,
      expiresAt,
      packageId,
      JSON.stringify(grants),
      actorUserId,
    ) as Promise<Array<{ id: string }>>);

    const batchId = batchRows[0]?.id;
    if (!batchId) {
      throw new BadRequestException('创建兑换码批次失败');
    }

    const createdCodes: string[] = [];
    for (let i = 0; i < count; i += 1) {
      let inserted = false;
      let attempts = 0;
      while (!inserted && attempts < 20) {
        attempts += 1;
        const nextCode = this.generateCode(codePrefix || undefined);
        try {
          await this.prisma.$executeRawUnsafe(
            `INSERT INTO entitlement_codes (
               id, app_id, batch_id, code, package_id, grants_json, note,
               max_uses, used_count, expires_at, status, created_by_user_id, created_at, updated_at
             )
             VALUES (
               gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::uuid, $5::jsonb, $6,
               $7, 0, $8, 'active', $9::uuid, now(), now()
             )`,
            appId,
            batchId,
            nextCode,
            packageId,
            JSON.stringify(grants),
            payload?.note || null,
            maxUses,
            expiresAt,
            actorUserId,
          );
          inserted = true;
          createdCodes.push(nextCode);
        } catch (error: any) {
          const message = String(error?.message || '');
          if (!message.includes('duplicate key value') && !message.includes('UNIQUE')) {
            throw error;
          }
        }
      }

      if (!inserted) {
        throw new ConflictException('生成兑换码失败：重复冲突过多，请重试');
      }
    }

    return {
      batch_id: batchId,
      name: batchName,
      created_count: createdCodes.length,
      max_uses: maxUses,
      expires_at: expiresAt,
      codes: createdCodes,
    };
  }

  async listCodesByAppId(appId: string, page = 1, pageSize = 20, batchId?: string) {
    await this.ensureSchema();
    await this.resolveAppById(appId);

    const safePage = Math.max(Number(page || 1), 1);
    const safePageSize = Math.min(Math.max(Number(pageSize || 20), 1), 200);
    const offset = (safePage - 1) * safePageSize;

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT c.*,
              b.name AS batch_name,
              p.name AS package_name,
              u.email AS first_used_by_email
       FROM entitlement_codes c
       LEFT JOIN entitlement_code_batches b ON b.id = c.batch_id
       LEFT JOIN entitlement_packages p ON p.id = c.package_id
       LEFT JOIN users u ON u.id = c.first_used_by_user_id
       WHERE c.app_id = $1::uuid
         AND ($2::uuid IS NULL OR c.batch_id = $2::uuid)
       ORDER BY c.created_at DESC
       OFFSET $3
       LIMIT $4`,
      appId,
      batchId || null,
      offset,
      safePageSize,
    ) as Promise<Array<
        EntitlementCodeRow & {
          batch_name: string | null;
          package_name: string | null;
          first_used_by_email: string | null;
        }
      >>);

    const totalRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count
       FROM entitlement_codes
       WHERE app_id = $1::uuid
         AND ($2::uuid IS NULL OR batch_id = $2::uuid)`,
      appId,
      batchId || null,
    ) as Promise<Array<{ count: bigint }>>);

    return {
      total: Number(totalRows[0]?.count || 0),
      page: safePage,
      page_size: safePageSize,
      items: rows.map((row) => ({
        ...row,
        grants: this.parseGrantArray(row.grants_json),
      })),
    };
  }

  async listCodeRedemptionsByAppId(appId: string, page = 1, pageSize = 20, batchId?: string) {
    await this.ensureSchema();
    await this.resolveAppById(appId);

    const safePage = Math.max(Number(page || 1), 1);
    const safePageSize = Math.min(Math.max(Number(pageSize || 20), 1), 100);
    const offset = (safePage - 1) * safePageSize;

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         r.id,
         r.code_id,
         c.code,
         r.user_id,
         u.email AS user_email,
         u.display_name AS user_display_name,
         c.batch_id,
         b.name AS batch_name,
         c.package_id,
         p.name AS package_name,
         p.cover_url AS package_cover_url,
         r.created_at,
         r.revoked_at,
         r.revoked_by_user_id,
         ru.email AS revoked_by_email,
         r.revoke_reason,
         COALESCE(ent.total_entitlements, 0)::bigint AS total_entitlements,
         COALESCE(ent.active_entitlements, 0)::bigint AS active_entitlements
       FROM entitlement_code_redemptions r
       JOIN entitlement_codes c ON c.id = r.code_id
       LEFT JOIN entitlement_code_batches b ON b.id = c.batch_id
       LEFT JOIN entitlement_packages p ON p.id = c.package_id
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN users ru ON ru.id = r.revoked_by_user_id
       LEFT JOIN (
         SELECT
           ue.source_redemption_id AS redemption_id,
           COUNT(*)::bigint AS total_entitlements,
           COUNT(*) FILTER (
             WHERE ue.is_active = true
               AND (ue.expires_at IS NULL OR ue.expires_at > now())
           )::bigint AS active_entitlements
         FROM user_entitlements ue
         WHERE ue.app_id = $1::uuid
           AND ue.source_redemption_id IS NOT NULL
         GROUP BY ue.source_redemption_id
       ) ent ON ent.redemption_id = r.id
       WHERE r.app_id = $1::uuid
         AND ($2::uuid IS NULL OR c.batch_id = $2::uuid)
       ORDER BY r.created_at DESC
       OFFSET $3
       LIMIT $4`,
      appId,
      batchId || null,
      offset,
      safePageSize,
    ) as Promise<Array<{
        id: string;
        code_id: string;
        code: string;
        user_id: string;
        user_email: string | null;
        user_display_name: string | null;
        batch_id: string | null;
        batch_name: string | null;
        package_id: string | null;
        package_name: string | null;
        package_cover_url: string | null;
        created_at: Date;
        revoked_at: Date | null;
        revoked_by_user_id: string | null;
        revoked_by_email: string | null;
        revoke_reason: string | null;
        total_entitlements: bigint;
        active_entitlements: bigint;
      }>>);

    const totalRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count
       FROM entitlement_code_redemptions r
       JOIN entitlement_codes c ON c.id = r.code_id
       WHERE r.app_id = $1::uuid
         AND ($2::uuid IS NULL OR c.batch_id = $2::uuid)`,
      appId,
      batchId || null,
    ) as Promise<Array<{ count: bigint }>>);

    return {
      total: Number(totalRows[0]?.count || 0),
      page: safePage,
      page_size: safePageSize,
      items: rows.map((row) => ({
        id: row.id,
        code_id: row.code_id,
        code: row.code,
        user_id: row.user_id,
        user_email: row.user_email,
        user_display_name: row.user_display_name,
        batch_id: row.batch_id,
        batch_name: row.batch_name,
        package_id: row.package_id,
        package_name: row.package_name,
        package_cover_url: row.package_cover_url,
        redeemed_at: row.created_at,
        revoked_at: row.revoked_at,
        revoked_by_user_id: row.revoked_by_user_id,
        revoked_by_email: row.revoked_by_email,
        revoke_reason: row.revoke_reason,
        total_entitlements: Number(row.total_entitlements || 0),
        active_entitlements: Number(row.active_entitlements || 0),
      })),
    };
  }

  async revokeCodeRedemptionByAppId(
    appId: string,
    redemptionId: string,
    actorUserId: string,
    reason?: string,
  ) {
    await this.ensureSchema();
    await this.resolveAppById(appId);
    await this.ensureActiveUser(actorUserId);

    const revokeReason = String(reason || '').trim() || null;

    return this.prisma.$transaction(async (tx) => {
      const redemptionRows = await (tx.$queryRawUnsafe(
        `SELECT r.*, c.code
         FROM entitlement_code_redemptions r
         JOIN entitlement_codes c ON c.id = r.code_id
         WHERE r.app_id = $1::uuid
           AND r.id = $2::uuid
         LIMIT 1
         FOR UPDATE`,
        appId,
        redemptionId,
      ) as Promise<Array<
          EntitlementCodeRedemptionRow & {
            code: string;
          }
        >>);
      const redemption = redemptionRows[0];
      if (!redemption) {
        throw new NotFoundException('兑换记录不存在');
      }
      if (redemption.revoked_at) {
        throw new BadRequestException('该兑换记录已撤销');
      }

      const entitlementRows = await (tx.$queryRawUnsafe(
        `SELECT id, scope, resource_id
         FROM user_entitlements
         WHERE app_id = $1::uuid
           AND user_id = $2::uuid
           AND source_redemption_id = $3::uuid
           AND is_active = true
         FOR UPDATE`,
        appId,
        redemption.user_id,
        redemption.id,
      ) as Promise<Array<{
          id: string;
          scope: RedeemGrantScope;
          resource_id: string | null;
        }>>);

      const nowIso = new Date().toISOString();

      const deactivatedCount = await tx.$executeRawUnsafe(
        `UPDATE user_entitlements
         SET is_active = false,
             expires_at = COALESCE(expires_at, $4::timestamptz),
             updated_at = now()
         WHERE app_id = $1::uuid
           AND user_id = $2::uuid
           AND source_redemption_id = $3::uuid
           AND is_active = true`,
        appId,
        redemption.user_id,
        redemption.id,
        nowIso,
      );

      const hasRevokedAppMembership = entitlementRows.some((item) => item.scope === 'app_membership');
      let membershipExpiresAt: Date | null = null;
      if (hasRevokedAppMembership) {
        const userRows = await (tx.$queryRawUnsafe(
          `SELECT membership_expires_at
           FROM users
           WHERE id = $1::uuid
             AND app_id = $2::uuid
             AND deleted_at IS NULL
           LIMIT 1
           FOR UPDATE`,
          redemption.user_id,
          appId,
        ) as Promise<Array<{ membership_expires_at: Date | null }>>);
        const currentMembershipExpiresAt = userRows[0]?.membership_expires_at || null;
        const maxAppMembershipRows = await (tx.$queryRawUnsafe(
          `SELECT MAX(expires_at) AS max_expires_at
           FROM user_entitlements
           WHERE app_id = $1::uuid
             AND user_id = $2::uuid
             AND scope = 'app_membership'
             AND is_active = true
             AND (expires_at IS NULL OR expires_at > now())`,
          appId,
          redemption.user_id,
        ) as Promise<Array<{ max_expires_at: Date | null }>>);
        membershipExpiresAt = maxAppMembershipRows[0]?.max_expires_at || null;

        const revokedMembershipRows = await (tx.$queryRawUnsafe(
          `SELECT MAX(expires_at) AS max_expires_at
           FROM user_entitlements
           WHERE app_id = $1::uuid
             AND user_id = $2::uuid
             AND source_redemption_id = $3::uuid
             AND scope = 'app_membership'`,
          appId,
          redemption.user_id,
          redemption.id,
        ) as Promise<Array<{ max_expires_at: Date | null }>>);
        const revokedMembershipMaxExpiresAt = revokedMembershipRows[0]?.max_expires_at || null;
        const shouldRollbackMembership =
          !!currentMembershipExpiresAt &&
          !!revokedMembershipMaxExpiresAt &&
          Math.abs(currentMembershipExpiresAt.getTime() - revokedMembershipMaxExpiresAt.getTime()) <= 60 * 1000;

        if (shouldRollbackMembership) {
          await tx.$executeRawUnsafe(
            `UPDATE users
             SET membership_type = $1,
                 membership_expires_at = $2::timestamptz,
                 updated_at = now()
             WHERE id = $3::uuid
               AND app_id = $4::uuid`,
            membershipExpiresAt ? 'PREMIUM' : 'FREE',
            membershipExpiresAt,
            redemption.user_id,
            appId,
          );
        }
      }

      await tx.$executeRawUnsafe(
        `UPDATE entitlement_code_redemptions
         SET revoked_at = now(),
             revoked_by_user_id = $1::uuid,
             revoke_reason = $2
         WHERE id = $3::uuid
           AND app_id = $4::uuid`,
        actorUserId,
        revokeReason,
        redemption.id,
        appId,
      );

      await tx.$executeRawUnsafe(
        `UPDATE entitlement_codes
         SET used_count = GREATEST(used_count - 1, 0),
             updated_at = now()
         WHERE id = $1::uuid
           AND app_id = $2::uuid`,
        redemption.code_id,
        appId,
      );

      return {
        message: '兑换记录已撤销，相关权益已回收',
        redemption_id: redemption.id,
        code: redemption.code,
        user_id: redemption.user_id,
        deactivated_entitlements: Number(deactivatedCount || 0),
        app_membership_expires_at: membershipExpiresAt,
      };
    });
  }

  async listCodeBatchesByAppId(appId: string, page = 1, pageSize = 20) {
    await this.ensureSchema();
    await this.resolveAppById(appId);

    const safePage = Math.max(Number(page || 1), 1);
    const safePageSize = Math.min(Math.max(Number(pageSize || 20), 1), 100);
    const offset = (safePage - 1) * safePageSize;

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT b.*, p.name AS package_name
       FROM entitlement_code_batches b
       LEFT JOIN entitlement_packages p ON p.id = b.package_id
       WHERE b.app_id = $1::uuid
       ORDER BY b.created_at DESC
       OFFSET $2
       LIMIT $3`,
      appId,
      offset,
      safePageSize,
    ) as Promise<Array<{
        id: string;
        name: string;
        note: string | null;
        code_prefix: string | null;
        total_count: number;
        max_uses: number;
        expires_at: Date | null;
        package_id: string | null;
        package_name: string | null;
        created_by_user_id: string | null;
        created_at: Date;
        updated_at: Date;
        grants_json: unknown;
      }>>);

    const totals = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count
       FROM entitlement_code_batches
       WHERE app_id = $1::uuid`,
      appId,
    ) as Promise<Array<{ count: bigint }>>);

    return {
      total: Number(totals[0]?.count || 0),
      page: safePage,
      page_size: safePageSize,
      items: rows.map((row) => ({
        ...row,
        grants: this.parseGrantArray(row.grants_json),
      })),
    };
  }

  async voidCodeByAppId(appId: string, rawCode: string, reason?: string) {
    await this.ensureSchema();
    await this.resolveAppById(appId);

    const code = this.normalizeCode(rawCode);
    if (!code) {
      throw new BadRequestException('code 不能为空');
    }

    const affected = await this.prisma.$executeRawUnsafe(
      `UPDATE entitlement_codes
       SET status = 'voided', void_reason = $1, updated_at = now()
       WHERE app_id = $2::uuid AND code = $3`,
      reason || null,
      appId,
      code,
    );

    return {
      message: Number(affected || 0) > 0 ? '兑换码已作废' : '兑换码不存在',
      affected: Number(affected || 0),
    };
  }

  async buildBatchTxtByAppId(
    appId: string,
    batchId: string,
    options?: {
      format?: 'code' | 'url';
      baseUrl?: string;
    },
  ) {
    await this.ensureSchema();
    await this.resolveAppById(appId);

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT code
       FROM entitlement_codes
       WHERE app_id = $1::uuid AND batch_id = $2::uuid
       ORDER BY created_at ASC`,
      appId,
      batchId,
    ) as Promise<Array<{ code: string }>>);

    if (!rows.length) {
      throw new NotFoundException('批次不存在或没有兑换码');
    }

    const format = String(options?.format || 'code').trim().toLowerCase();
    if (format !== 'code' && format !== 'url') {
      throw new BadRequestException('format 仅支持 code 或 url');
    }

    let lines = rows.map((row) => row.code);
    let filename = `redeem-codes-${batchId}.txt`;
    if (format === 'url') {
      const baseUrl = this.normalizeRedeemBaseUrl(options?.baseUrl);
      if (!baseUrl) {
        throw new BadRequestException('base_url 无效');
      }
      lines = rows.map((row) => this.buildRedeemCodeUrl(baseUrl, row.code));
      filename = `redeem-code-urls-${batchId}.txt`;
    }

    const content = `${lines.join('\n')}\n`;
    return {
      filename,
      content,
      line_count: rows.length,
      format,
    };
  }

  async createSimpleMembershipCodes(
    appSlug: string | undefined,
    actorUserId: string,
    payload: { days: number; count?: number; expires_at?: string },
  ) {
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, actorUserId);

    const days = Math.max(Number(payload.days || 0), 0);
    if (!days) {
      throw new BadRequestException('days 必须大于 0');
    }

    return this.createCodeBatchByAppId(app.id, actorUserId, {
      name: `会员天数码 ${days}天`,
      count: Math.min(Math.max(Number(payload.count || 1), 1), 500),
      expires_at: payload.expires_at,
      grants: [{ scope: 'app_membership', days }],
    });
  }

  async listCodesByAppSlug(appSlug: string | undefined, page = 1, pageSize = 20) {
    const app = await this.resolveAppBySlug(appSlug);
    return this.listCodesByAppId(app.id, page, pageSize);
  }

  async voidCodeByAppSlug(appSlug: string | undefined, code: string, reason?: string) {
    const app = await this.resolveAppBySlug(appSlug);
    return this.voidCodeByAppId(app.id, code, reason);
  }

  async redeemPreviewByAppSlug(appSlug: string | undefined, rawCode: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const code = this.normalizeCode(rawCode);

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM entitlement_codes
       WHERE app_id = $1::uuid
         AND code = $2
       LIMIT 1`,
      app.id,
      code,
    ) as Promise<EntitlementCodeRow[]>);

    const found = rows[0];
    if (!found) {
      throw new NotFoundException('兑换码不存在');
    }

    return {
      code: found.code,
      status: found.status,
      max_uses: found.max_uses,
      used_count: found.used_count,
      expires_at: found.expires_at,
      is_expired: !!found.expires_at && found.expires_at.getTime() <= Date.now(),
      grants: this.parseGrantArray(found.grants_json),
      package_id: found.package_id,
      note: found.note,
    };
  }

  private async applyGrant(
    tx: TxClient,
    params: {
      appId: string;
      userId: string;
      actorUserId?: string | null;
      codeId?: string | null;
      redemptionId?: string | null;
      grant: RedeemGrantNormalized;
    },
  ): Promise<Record<string, unknown>> {
    const { appId, userId, codeId, redemptionId, grant } = params;
    const now = new Date();

    if (grant.scope === 'app_membership') {
      if (!grant.days || grant.days <= 0) {
        throw new BadRequestException('app_membership 必须设置正数天数');
      }

      const userRows = await (tx.$queryRawUnsafe(
        `SELECT membership_expires_at
         FROM users
         WHERE id = $1::uuid AND app_id = $2::uuid AND deleted_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        userId,
        appId,
      ) as Promise<Array<{ membership_expires_at: Date | null }>>);
      if (!userRows[0]) {
        throw new NotFoundException('用户不存在');
      }

      const currentExpiry = userRows[0].membership_expires_at && userRows[0].membership_expires_at > now
        ? userRows[0].membership_expires_at
        : now;
      const nextExpiry = new Date(currentExpiry.getTime() + grant.days * 86400000);

      await tx.$executeRawUnsafe(
        `UPDATE users
         SET membership_type = 'PREMIUM',
             membership_expires_at = $1::timestamptz,
             updated_at = now()
         WHERE id = $2::uuid AND app_id = $3::uuid`,
        nextExpiry,
        userId,
        appId,
      );

      const entitlement = await this.upsertEntitlement(tx, {
        appId,
        userId,
        scope: 'app_membership',
        resourceId: null,
        languageCode: null,
        extensionDays: grant.days,
        codeId: codeId || null,
        redemptionId: redemptionId || null,
        metadata: grant.metadata,
      });

      return {
        scope: 'app_membership',
        expires_at: entitlement.expires_at,
      };
    }

    if (!grant.days || grant.days <= 0) {
      throw new BadRequestException('ai_membership 必须设置正数天数');
    }

    const entitlement = await this.upsertEntitlement(tx, {
      appId,
      userId,
      scope: 'ai_membership',
      resourceId: null,
      languageCode: null,
      extensionDays: grant.days,
      codeId: codeId || null,
      redemptionId: redemptionId || null,
      metadata: grant.metadata,
    });

    return {
      scope: 'ai_membership',
      expires_at: entitlement.expires_at,
    };
  }

  private async upsertEntitlement(
    tx: TxClient,
    params: {
      appId: string;
      userId: string;
      scope: RedeemGrantScope;
      resourceId: string | null;
      languageCode: string | null;
      extensionDays: number | null;
      codeId?: string | null;
      redemptionId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    const key = this.buildEntitlementKey(params.scope, params.resourceId, params.languageCode);
    const rows = await (tx.$queryRawUnsafe(
      `SELECT *
       FROM user_entitlements
       WHERE app_id = $1::uuid
         AND user_id = $2::uuid
         AND entitlement_key = $3
       LIMIT 1
       FOR UPDATE`,
      params.appId,
      params.userId,
      key,
    ) as Promise<UserEntitlementRow[]>);

    const now = new Date();
    const existing = rows[0];
    let nextExpiresAt: Date | null = null;

    if (!params.extensionDays || params.extensionDays <= 0) {
      nextExpiresAt = null;
    } else if (!existing?.expires_at) {
      nextExpiresAt = new Date(now.getTime() + params.extensionDays * 86400000);
    } else {
      const start = existing.expires_at > now ? existing.expires_at : now;
      nextExpiresAt = new Date(start.getTime() + params.extensionDays * 86400000);
    }

    if (existing) {
      await tx.$executeRawUnsafe(
        `UPDATE user_entitlements
         SET scope = $1,
             resource_id = $2::uuid,
             language_code = $3,
             expires_at = $4::timestamptz,
             is_active = true,
             source_code_id = $5::uuid,
             source_redemption_id = $6::uuid,
             metadata_json = $7::jsonb,
             updated_at = now()
         WHERE id = $8::uuid`,
        params.scope,
        params.resourceId,
        params.languageCode,
        nextExpiresAt,
        params.codeId || null,
        params.redemptionId || null,
        JSON.stringify(params.metadata || {}),
        existing.id,
      );

      const refreshed = await (tx.$queryRawUnsafe(
        `SELECT * FROM user_entitlements WHERE id = $1::uuid LIMIT 1`,
        existing.id,
      ) as Promise<UserEntitlementRow[]>);
      return refreshed[0];
    }

    const inserted = await (tx.$queryRawUnsafe(
      `INSERT INTO user_entitlements (
         id, app_id, user_id, entitlement_key, scope, resource_id, language_code,
         starts_at, expires_at, is_active, source_code_id, source_redemption_id, metadata_json,
         created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::uuid, $6,
         now(), $7::timestamptz, true, $8::uuid, $9::uuid, $10::jsonb,
         now(), now()
       )
       RETURNING *`,
      params.appId,
      params.userId,
      key,
      params.scope,
      params.resourceId,
      params.languageCode,
      nextExpiresAt,
      params.codeId || null,
      params.redemptionId || null,
      JSON.stringify(params.metadata || {}),
    ) as Promise<UserEntitlementRow[]>);

    return inserted[0];
  }

  private buildEntitlementKey(scope: RedeemGrantScope, _resourceId: string | null, _languageCode: string | null) {
    return scope;
  }

  private serializeEntitlementRow(row: UserEntitlementRow) {
    return {
      id: row.id,
      entitlement_key: row.entitlement_key,
      scope: row.scope,
      resource_id: row.resource_id,
      language_code: row.language_code,
      starts_at: row.starts_at,
      expires_at: row.expires_at,
      metadata: this.parseObject(row.metadata_json),
      source_code_id: row.source_code_id,
      source_redemption_id: row.source_redemption_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private serializeGrantRow(row: {
    scope: RedeemGrantScope;
    resource_id: string | null;
    language_code: string | null;
    days: number | null;
    metadata_json: unknown;
  }) {
    return {
      scope: row.scope,
      resource_id: row.resource_id,
      language_code: row.language_code,
      days: row.days,
      metadata: this.parseObject(row.metadata_json),
    };
  }

  private serializeNotificationRow(row: {
    id: string;
    notification_type: string;
    title: string;
    message: string;
    payload_json: unknown;
    is_read: boolean;
    read_at: Date | null;
    created_at: Date;
  }) {
    return {
      id: row.id,
      type: row.notification_type,
      title: row.title,
      message: row.message,
      payload: this.parseObject(row.payload_json),
      is_read: row.is_read,
      read_at: row.read_at,
      created_at: row.created_at,
    };
  }

  private async pushNotificationTx(
    tx: TxClient,
    appId: string,
    userId: string,
    payload: { type?: string; title: string; message: string; payload?: Record<string, unknown> },
  ) {
    const type = String(payload.type || 'system').trim() || 'system';
    await tx.$executeRawUnsafe(
      `INSERT INTO user_notifications (
         id, app_id, user_id, notification_type, title, message, payload_json, is_read, created_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, false, now()
       )`,
      appId,
      userId,
      type,
      payload.title,
      payload.message,
      JSON.stringify(payload.payload || {}),
    );
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

  private parseGrantArray(value: unknown): RedeemGrantNormalized[] {
    const array = this.parseJsonArray(value);
    if (!array.length) {
      return [];
    }
    try {
      return array.map((grant, index) => this.normalizeGrant(grant as RedeemGrantInput, index));
    } catch {
      return [];
    }
  }

  private parseJsonArray(value: unknown): unknown[] {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return [];
      }
    }
    return [];
  }

  private normalizeGrants(grants: RedeemGrantInput[]): RedeemGrantNormalized[] {
    if (!Array.isArray(grants) || grants.length === 0) {
      throw new BadRequestException('grants 不能为空');
    }

    return grants.map((grant, index) => this.normalizeGrant(grant, index));
  }

  private normalizeGrant(raw: RedeemGrantInput, index = 0): RedeemGrantNormalized {
    const scope = String(raw?.scope || '').trim() as RedeemGrantScope;
    if (!scope || !['app_membership', 'ai_membership'].includes(scope)) {
      throw new BadRequestException(`第 ${index + 1} 条权益 scope 无效`);
    }

    const metadata = raw?.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, unknown>)
      : {};

    const rawDays = raw?.days;
    const days = rawDays === undefined || rawDays === null ? null : Number(rawDays);
    const normalizedDays = days === null ? null : Math.max(Math.round(days), 0);

    if (!normalizedDays || normalizedDays <= 0) {
      throw new BadRequestException(`第 ${index + 1} 条会员权益缺少有效 days`);
    }

    return {
      scope,
      resource_id: null,
      language_code: null,
      days: normalizedDays,
      metadata,
    };
  }

  private async replacePackageGrants(appId: string, packageId: string, grants: RedeemGrantNormalized[]) {
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM entitlement_package_items WHERE app_id = $1::uuid AND package_id = $2::uuid`,
      appId,
      packageId,
    );

    for (let i = 0; i < grants.length; i += 1) {
      const grant = grants[i];
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO entitlement_package_items (
           id, app_id, package_id, sort_order, scope, resource_id, language_code, days, metadata_json, created_at, updated_at
         )
         VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8::jsonb, now(), now()
         )`,
        appId,
        packageId,
        i,
        grant.scope,
        grant.resource_id,
        grant.language_code,
        grant.days,
        JSON.stringify(grant.metadata || {}),
      );
    }
  }

  private async validateGrantTargets(_appId: string, _grants: RedeemGrantNormalized[]) {
    return;
  }

  private normalizeCode(raw: string): string {
    return String(raw || '').trim().toUpperCase();
  }

  private normalizePriceCnyValue(raw: unknown): number {
    const parsed = Number(raw ?? 0);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return Math.round(parsed * 100) / 100;
  }

  private normalizePriceCnyInput(raw: unknown, fieldName: string): number {
    const value = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new BadRequestException(`${fieldName} 必须是大于等于 0 的数字`);
    }
    return Math.round(value * 100) / 100;
  }

  private normalizeCodePrefix(raw: string | undefined): string | null {
    const value = String(raw || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (!value) {
      return null;
    }
    return value.slice(0, 8);
  }

  private normalizeRedeemBaseUrl(raw?: string): string | null {
    const value = String(raw || '').trim();
    if (!value) return null;
    const full = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const parsed = new URL(full);
      if (!parsed.hostname) return null;
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  private buildRedeemCodeUrl(baseUrl: string, code: string): string {
    const safeCode = String(code || '').trim();
    if (!safeCode) return '';
    try {
      const parsed = new URL(baseUrl);
      parsed.searchParams.set('code', safeCode);
      return parsed.toString();
    } catch {
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}code=${encodeURIComponent(safeCode)}`;
    }
  }

  private generateCode(prefix?: string) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let random = '';
    for (let i = 0; i < 10; i += 1) {
      random += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!prefix) {
      return random;
    }
    return `${prefix}${random}`;
  }

  private buildPublicMembershipProductsCacheKey(slug: string, limit: number) {
    return `${slug}|${limit}`;
  }

  private readPublicMembershipProductsCache(cacheKey: string): PublicMembershipProductsResponse | null {
    const cached = this.publicMembershipProductsCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt <= Date.now()) {
      this.publicMembershipProductsCache.delete(cacheKey);
      return null;
    }
    return this.clonePublicMembershipProductsResponse(cached.value);
  }

  private writePublicMembershipProductsCache(cacheKey: string, value: PublicMembershipProductsResponse) {
    const now = Date.now();
    this.publicMembershipProductsCache.set(cacheKey, {
      value: this.clonePublicMembershipProductsResponse(value),
      expiresAt: now + PUBLIC_PRODUCTS_CACHE_TTL_MS,
    });
    if (this.publicMembershipProductsCache.size <= PUBLIC_PRODUCTS_CACHE_MAX_ENTRIES) {
      return;
    }
    for (const [key, entry] of this.publicMembershipProductsCache.entries()) {
      if (entry.expiresAt <= now) {
        this.publicMembershipProductsCache.delete(key);
      }
    }
    while (this.publicMembershipProductsCache.size > PUBLIC_PRODUCTS_CACHE_MAX_ENTRIES) {
      const oldestKey = this.publicMembershipProductsCache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.publicMembershipProductsCache.delete(oldestKey);
    }
  }

  private clearPublicMembershipProductsCache() {
    this.publicMembershipProductsCache.clear();
  }

  private clonePublicMembershipProductsResponse(value: PublicMembershipProductsResponse): PublicMembershipProductsResponse {
    return {
      total: value.total,
      items: value.items.map((item) => ({
        ...item,
        updated_at: new Date(item.updated_at),
      })),
    };
  }

  private async resolveAppBySlug(appSlug: string | undefined) {
    const slug = String(appSlug || '').trim();
    if (!slug) {
      throw new NotFoundException('App slug is required');
    }
    const app = await this.prisma.app.findUnique({ where: { slug } });
    if (!app) {
      throw new NotFoundException(`App not found: ${slug}`);
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
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
       FROM users
       WHERE id = $1::uuid AND app_id = $2::uuid AND deleted_at IS NULL
       LIMIT 1`,
      userId,
      appId,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) {
      throw new NotFoundException('User not found');
    }
  }

  private async ensureActiveUser(userId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
       FROM users
       WHERE id = $1::uuid AND deleted_at IS NULL
       LIMIT 1`,
      userId,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) {
      throw new NotFoundException('User not found');
    }
  }

  private async ensureSchema() {
    if (this.schemaReady) {
      return;
    }
    if (this.schemaPromise) {
      await this.schemaPromise;
      return;
    }

    this.schemaPromise = this.initializeSchema();
    try {
      await this.schemaPromise;
      this.schemaReady = true;
    } finally {
      this.schemaPromise = null;
    }
  }

  private async initializeSchema() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS redeem_runtime_migrations (
        name varchar(128) PRIMARY KEY,
        executed_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS entitlement_packages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        name varchar(128) NOT NULL,
        description text NULL,
        cover_url text NULL,
        price_cny numeric(10, 2) NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        created_by_user_id uuid NULL,
        updated_by_user_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE entitlement_packages
      ADD COLUMN IF NOT EXISTS price_cny numeric(10, 2) NOT NULL DEFAULT 0
    `);
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE entitlement_packages
      ADD COLUMN IF NOT EXISTS cover_url text NULL
    `);
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE entitlement_packages
      ADD COLUMN IF NOT EXISTS language_code varchar(16) NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS entitlement_package_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        package_id uuid NOT NULL REFERENCES entitlement_packages(id) ON DELETE CASCADE,
        sort_order integer NOT NULL DEFAULT 0,
        scope varchar(48) NOT NULL,
        resource_id uuid NULL,
        language_code varchar(16) NULL,
        days integer NULL,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS entitlement_code_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        name varchar(128) NOT NULL,
        note text NULL,
        code_prefix varchar(16) NULL,
        total_count integer NOT NULL DEFAULT 0,
        max_uses integer NOT NULL DEFAULT 1,
        expires_at timestamptz NULL,
        package_id uuid NULL REFERENCES entitlement_packages(id) ON DELETE SET NULL,
        grants_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_by_user_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS entitlement_codes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        batch_id uuid NULL REFERENCES entitlement_code_batches(id) ON DELETE SET NULL,
        code varchar(64) NOT NULL,
        package_id uuid NULL REFERENCES entitlement_packages(id) ON DELETE SET NULL,
        grants_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        note text NULL,
        max_uses integer NOT NULL DEFAULT 1,
        used_count integer NOT NULL DEFAULT 0,
        expires_at timestamptz NULL,
        status varchar(16) NOT NULL DEFAULT 'active',
        void_reason text NULL,
        first_used_by_user_id uuid NULL,
        first_used_at timestamptz NULL,
        created_by_user_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (app_id, code)
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS entitlement_code_redemptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        code_id uuid NOT NULL REFERENCES entitlement_codes(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        applied_grants_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        revoked_at timestamptz NULL,
        revoked_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        revoke_reason text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (app_id, code_id, user_id)
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE entitlement_code_redemptions
      ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL
    `);
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE entitlement_code_redemptions
      ADD COLUMN IF NOT EXISTS revoked_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL
    `);
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE entitlement_code_redemptions
      ADD COLUMN IF NOT EXISTS revoke_reason text NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS user_entitlements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entitlement_key varchar(255) NOT NULL,
        scope varchar(48) NOT NULL,
        resource_id uuid NULL,
        language_code varchar(16) NULL,
        starts_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NULL,
        is_active boolean NOT NULL DEFAULT true,
        source_code_id uuid NULL REFERENCES entitlement_codes(id) ON DELETE SET NULL,
        source_redemption_id uuid NULL REFERENCES entitlement_code_redemptions(id) ON DELETE SET NULL,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (app_id, user_id, entitlement_key)
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS user_notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        notification_type varchar(64) NOT NULL DEFAULT 'system',
        title varchar(200) NOT NULL,
        message text NOT NULL,
        payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_read boolean NOT NULL DEFAULT false,
        read_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_packages_app_name_unique
       ON entitlement_packages(app_id, LOWER(name))`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_entitlement_package_items_package
       ON entitlement_package_items(app_id, package_id, sort_order)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_entitlement_code_batches_app
       ON entitlement_code_batches(app_id, created_at DESC)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_entitlement_codes_app_status
       ON entitlement_codes(app_id, status, created_at DESC)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_entitlement_codes_batch
       ON entitlement_codes(app_id, batch_id, created_at DESC)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_entitlement_redemptions_user
       ON entitlement_code_redemptions(app_id, user_id, created_at DESC)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_entitlement_redemptions_revoked
       ON entitlement_code_redemptions(app_id, revoked_at, created_at DESC)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_user_entitlements_active
       ON user_entitlements(app_id, user_id, is_active, expires_at)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
       ON user_notifications(app_id, user_id, is_read, created_at DESC)`,
    );

    const migrationName = 'entitlement_backfill_from_legacy_redeem_codes_v1';
    const migrationRows = await (this.prisma.$queryRawUnsafe(
      `SELECT name FROM redeem_runtime_migrations WHERE name = $1 LIMIT 1`,
      migrationName,
    ) as Promise<Array<{ name: string }>>);

    if (!migrationRows[0]) {
      await this.prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF to_regclass('public.redeem_codes') IS NOT NULL THEN
            INSERT INTO entitlement_codes (
              id,
              app_id,
              code,
              grants_json,
              note,
              max_uses,
              used_count,
              expires_at,
              status,
              first_used_by_user_id,
              first_used_at,
              created_by_user_id,
              created_at,
              updated_at
            )
            SELECT
              gen_random_uuid(),
              r.app_id,
              UPPER(TRIM(r.code)),
              jsonb_build_array(
                jsonb_build_object(
                  'scope', 'app_membership',
                  'resource_id', NULL,
                  'language_code', NULL,
                  'days', GREATEST(COALESCE(r.days, 0), 1),
                  'metadata', '{}'::jsonb
                )
              ),
              'legacy_import',
              1,
              CASE WHEN COALESCE(r.used, false) THEN 1 ELSE 0 END,
              r.expires_at,
              CASE WHEN COALESCE(r.voided, false) THEN 'voided' ELSE 'active' END,
              r.used_by_user_id,
              r.used_at,
              r.created_by_admin_id,
              COALESCE(r.created_at, now()),
              now()
            FROM redeem_codes r
            WHERE NULLIF(TRIM(r.code), '') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM entitlement_codes c
                WHERE c.app_id = r.app_id
                  AND c.code = UPPER(TRIM(r.code))
              );
          END IF;
        END $$;
      `);

      await this.prisma.$executeRawUnsafe(
        `INSERT INTO redeem_runtime_migrations (name, executed_at)
         VALUES ($1, now())
         ON CONFLICT (name) DO NOTHING`,
        migrationName,
      );
    }
  }
}
