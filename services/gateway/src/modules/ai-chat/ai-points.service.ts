import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';

type AppAiPointsSettingsRow = {
  app_id: string;
  initial_points: number | string;
  points_per_yuan: number | string;
  updated_at: Date;
};

type UserAiPointsWalletRow = {
  id: string;
  app_id: string;
  user_id: string;
  balance: number | string;
  total_earned: number | string;
  total_spent: number | string;
  updated_at: Date;
};

type LedgerInsertRow = {
  id: string;
};

type AiPointsReservationRow = {
  id: string;
  app_id: string;
  user_id: string;
  reservation_key: string;
  external_task_id: string | null;
  usage_reference_id: string | null;
  capability: string;
  reserved_points: number | string;
  settled_points: number | string;
  status: string;
  metadata_json: unknown;
  created_at: Date;
  updated_at: Date;
  settled_at: Date | null;
};

export type AiPointsSettings = {
  app_id: string;
  initial_points: number;
  points_per_yuan: number;
  updated_at: string | null;
};

export type AiPointsWalletSummary = {
  app_id: string;
  user_id: string;
  balance: number;
  total_earned: number;
  total_spent: number;
  updated_at: string | null;
};

export type AiPointsChargeResult = {
  ledger_id: string;
  app_id: string;
  user_id: string;
  charged: number;
  balance_before: number;
  balance_after: number;
};

export type AiPointsReservationSummary = {
  id: string;
  app_id: string;
  user_id: string;
  reservation_key: string;
  external_task_id: string | null;
  usage_reference_id: string | null;
  capability: string;
  reserved_points: number;
  settled_points: number;
  status: 'pending' | 'captured' | 'released';
  metadata: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
  settled_at: string | null;
};

export class InsufficientAiPointsError extends Error {
  readonly appId: string;
  readonly userId: string;
  readonly required: number;
  readonly balance: number;

  constructor(input: { appId: string; userId: string; required: number; balance: number }) {
    super(`积分不足：当前 ${input.balance.toFixed(2)}，需要 ${input.required.toFixed(2)}`);
    this.appId = input.appId;
    this.userId = input.userId;
    this.required = input.required;
    this.balance = input.balance;
  }
}

const DEFAULT_INITIAL_POINTS = 200;
export const DEFAULT_POINTS_PER_YUAN = 100;
const SETTINGS_CACHE_TTL_MS = 60_000;

@Injectable()
export class AiPointsService implements OnModuleInit {
  private readonly logger = new Logger(AiPointsService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;
  private readonly settingsCache = new Map<string, { value: AiPointsSettings; expiresAt: number }>();

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`ai points startup warmup failed: ${error?.message || error}`);
    }
  }

  async getSettingsByAppId(appId: string): Promise<AiPointsSettings> {
    await this.ensureSchema();
    const now = Date.now();
    const cached = this.settingsCache.get(appId);
    if (cached && cached.expiresAt > now) {
      return { ...cached.value };
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT app_id, initial_points, points_per_yuan, updated_at
         FROM app_ai_points_settings
        WHERE app_id = $1::uuid
        LIMIT 1`,
      appId,
    ) as Promise<AppAiPointsSettingsRow[]>);
    const row = rows[0];
    if (!row) {
      const fallbackSettings: AiPointsSettings = {
        app_id: appId,
        initial_points: DEFAULT_INITIAL_POINTS,
        points_per_yuan: DEFAULT_POINTS_PER_YUAN,
        updated_at: null,
      };
      this.settingsCache.set(appId, {
        value: fallbackSettings,
        expiresAt: now + SETTINGS_CACHE_TTL_MS,
      });
      return { ...fallbackSettings };
    }
    const pointsPerYuan = this.toFiniteInteger(row.points_per_yuan, DEFAULT_POINTS_PER_YUAN);
    const settings: AiPointsSettings = {
      app_id: row.app_id,
      initial_points: this.toFiniteInteger(row.initial_points, DEFAULT_INITIAL_POINTS),
      points_per_yuan: pointsPerYuan > 0 ? pointsPerYuan : DEFAULT_POINTS_PER_YUAN,
      updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    };
    this.settingsCache.set(appId, {
      value: settings,
      expiresAt: now + SETTINGS_CACHE_TTL_MS,
    });
    return { ...settings };
  }

  async getWalletByAppId(appId: string, userId: string): Promise<AiPointsWalletSummary | null> {
    await this.ensureSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, user_id, balance, total_earned, total_spent, updated_at
         FROM user_ai_points_wallets
        WHERE app_id = $1::uuid
          AND user_id = $2::uuid
        LIMIT 1`,
      appId,
      userId,
    ) as Promise<UserAiPointsWalletRow[]>);
    return rows[0] ? this.serializeWallet(rows[0]) : null;
  }

  async upsertSettingsByAppId(
    appId: string,
    actorUserId: string,
    payload: Record<string, unknown>,
  ): Promise<AiPointsSettings> {
    await this.ensureSchema();
    const current = await this.getSettingsByAppId(appId);
    const initialPoints = this.normalizeNonNegativeInteger(
      payload.initial_points,
      current.initial_points,
      'initial_points',
    );
    const pointsPerYuan = this.normalizeNonNegativeInteger(
      payload.points_per_yuan,
      current.points_per_yuan || DEFAULT_POINTS_PER_YUAN,
      'points_per_yuan',
    );
    if (pointsPerYuan <= 0) {
      throw new BadRequestException('points_per_yuan must be > 0');
    }

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO app_ai_points_settings (
         app_id, initial_points, points_per_yuan, updated_by_user_id
       )
       VALUES ($1::uuid, $2::integer, $3::integer, $4::uuid)
       ON CONFLICT (app_id)
       DO UPDATE SET
         initial_points = EXCLUDED.initial_points,
         points_per_yuan = EXCLUDED.points_per_yuan,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = now()`,
      appId,
      initialPoints,
      pointsPerYuan,
      actorUserId,
    );
    this.settingsCache.delete(appId);

    return this.getSettingsByAppId(appId);
  }

  async getOrCreateWalletByAppId(
    appId: string,
    userId: string,
    settingsOverride?: AiPointsSettings,
  ): Promise<AiPointsWalletSummary> {
    await this.ensureSchema();
    const settings = settingsOverride || (await this.getSettingsByAppId(appId));
    const existingRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, user_id, balance, total_earned, total_spent, updated_at
         FROM user_ai_points_wallets
        WHERE app_id = $1::uuid
          AND user_id = $2::uuid
        LIMIT 1`,
      appId,
      userId,
    ) as Promise<UserAiPointsWalletRow[]>);
    if (existingRows[0]) {
      return this.serializeWallet(existingRows[0]);
    }

    const inserted = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO user_ai_points_wallets (
         id, app_id, user_id, balance, total_earned, total_spent
       )
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::numeric, $3::numeric, 0::numeric)
       ON CONFLICT (app_id, user_id) DO NOTHING
       RETURNING id, app_id, user_id, balance, total_earned, total_spent, updated_at`,
      appId,
      userId,
      this.roundTo2(settings.initial_points),
    ) as Promise<UserAiPointsWalletRow[]>);

    if (inserted[0] && settings.initial_points > 0) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO user_ai_points_ledger (
           id, app_id, user_id, delta, balance_after, event_type, reference_type, reference_id, metadata_json
         )
         VALUES (
           gen_random_uuid(),
           $1::uuid,
           $2::uuid,
           $3::numeric,
           $3::numeric,
           'wallet_init',
           'wallet',
           NULL,
           $4::jsonb
         )`,
        appId,
        userId,
        this.roundTo2(settings.initial_points),
        JSON.stringify({
          note: 'initial wallet grant',
          initial_points: settings.initial_points,
        }),
      );
      return this.serializeWallet(inserted[0]);
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, user_id, balance, total_earned, total_spent, updated_at
         FROM user_ai_points_wallets
        WHERE app_id = $1::uuid
          AND user_id = $2::uuid
        LIMIT 1`,
      appId,
      userId,
    ) as Promise<UserAiPointsWalletRow[]>);

    const wallet = rows[0];
    if (!wallet) {
      this.logger.error(`wallet create/read failed app=${appId} user=${userId}`);
      throw new BadRequestException('无法初始化积分钱包');
    }
    return this.serializeWallet(wallet);
  }

  async consumePoints(input: {
    app_id: string;
    user_id: string;
    cost: number;
    event_type: string;
    reference_type?: string;
    reference_id?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<AiPointsChargeResult> {
    await this.ensureSchema();
    const cost = this.normalizeNonNegativeDecimal2(input.cost, 0, 'cost');
    const appId = input.app_id;
    const userId = input.user_id;
    const wallet = await this.getOrCreateWalletByAppId(appId, userId);
    if (cost === 0) {
      return {
        ledger_id: '',
        app_id: appId,
        user_id: userId,
        charged: 0,
        balance_before: wallet.balance,
        balance_after: wallet.balance,
      };
    }

    return this.prisma.$transaction(async (tx) => {
      const lockedRows = await (tx.$queryRawUnsafe(
        `SELECT id, app_id, user_id, balance, total_earned, total_spent, updated_at
           FROM user_ai_points_wallets
          WHERE app_id = $1::uuid AND user_id = $2::uuid
          FOR UPDATE`,
        appId,
        userId,
      ) as Promise<UserAiPointsWalletRow[]>);
      const locked = lockedRows[0];
      if (!locked) {
        throw new BadRequestException('积分钱包不存在');
      }
      const balanceBefore = this.toFiniteDecimal2(locked.balance, 0);
      if (balanceBefore + 0.000001 < cost) {
        throw new InsufficientAiPointsError({
          appId,
          userId,
          required: cost,
          balance: balanceBefore,
        });
      }

      const updatedRows = await (tx.$queryRawUnsafe(
        `UPDATE user_ai_points_wallets
            SET balance = balance - $3::numeric,
                total_spent = total_spent + $3::numeric,
                updated_at = now()
          WHERE app_id = $1::uuid
            AND user_id = $2::uuid
          RETURNING id, app_id, user_id, balance, total_earned, total_spent, updated_at`,
        appId,
        userId,
        cost,
      ) as Promise<UserAiPointsWalletRow[]>);
      const updated = updatedRows[0];
      if (!updated) {
        throw new BadRequestException('积分扣减失败');
      }

      const balanceAfter = this.toFiniteDecimal2(updated.balance, balanceBefore - cost);
      const metadata = {
        ...(input.metadata || {}),
        charged: cost,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
      };
      const ledgerRows = await (tx.$queryRawUnsafe(
        `INSERT INTO user_ai_points_ledger (
           id, app_id, user_id, delta, balance_after, event_type, reference_type, reference_id, metadata_json
         )
         VALUES (
           gen_random_uuid(),
           $1::uuid,
           $2::uuid,
           $3::numeric,
           $4::numeric,
           $5::text,
           $6::text,
           $7::text,
           $8::jsonb
         )
         RETURNING id`,
        appId,
        userId,
        -cost,
        balanceAfter,
        String(input.event_type || 'ai_consume'),
        String(input.reference_type || 'ai'),
        input.reference_id || null,
        JSON.stringify(metadata),
      ) as Promise<LedgerInsertRow[]>);

      return {
        ledger_id: ledgerRows[0]?.id || '',
        app_id: appId,
        user_id: userId,
        charged: cost,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
      };
    });
  }

  async creditPoints(input: {
    app_id: string;
    user_id: string;
    amount: number;
    event_type: string;
    reference_type?: string;
    reference_id?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<AiPointsChargeResult> {
    await this.ensureSchema();
    const amount = this.normalizeNonNegativeDecimal2(input.amount, 0, 'amount');
    if (amount <= 0) {
      throw new BadRequestException('amount must be > 0');
    }

    const appId = input.app_id;
    const userId = input.user_id;
    await this.getOrCreateWalletByAppId(appId, userId);

    return this.prisma.$transaction(async (tx) => {
      const lockedRows = await (tx.$queryRawUnsafe(
        `SELECT id, app_id, user_id, balance, total_earned, total_spent, updated_at
           FROM user_ai_points_wallets
          WHERE app_id = $1::uuid AND user_id = $2::uuid
          FOR UPDATE`,
        appId,
        userId,
      ) as Promise<UserAiPointsWalletRow[]>);
      const locked = lockedRows[0];
      if (!locked) {
        throw new BadRequestException('积分钱包不存在');
      }
      const balanceBefore = this.toFiniteDecimal2(locked.balance, 0);
      const updatedRows = await (tx.$queryRawUnsafe(
        `UPDATE user_ai_points_wallets
            SET balance = balance + $3::numeric,
                total_earned = total_earned + $3::numeric,
                updated_at = now()
          WHERE app_id = $1::uuid
            AND user_id = $2::uuid
          RETURNING id, app_id, user_id, balance, total_earned, total_spent, updated_at`,
        appId,
        userId,
        amount,
      ) as Promise<UserAiPointsWalletRow[]>);
      const updated = updatedRows[0];
      if (!updated) {
        throw new BadRequestException('积分入账失败');
      }
      const balanceAfter = this.toFiniteDecimal2(updated.balance, balanceBefore + amount);
      const ledgerRows = await (tx.$queryRawUnsafe(
        `INSERT INTO user_ai_points_ledger (
           id, app_id, user_id, delta, balance_after, event_type, reference_type, reference_id, metadata_json
         )
         VALUES (
           gen_random_uuid(),
           $1::uuid,
           $2::uuid,
           $3::numeric,
           $4::numeric,
           $5::text,
           $6::text,
           $7::text,
           $8::jsonb
         )
         RETURNING id`,
        appId,
        userId,
        amount,
        balanceAfter,
        String(input.event_type || 'points_credit'),
        String(input.reference_type || 'system'),
        input.reference_id || null,
        JSON.stringify(input.metadata || {}),
      ) as Promise<LedgerInsertRow[]>);
      return {
        ledger_id: ledgerRows[0]?.id || '',
        app_id: appId,
        user_id: userId,
        charged: -amount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
      };
    });
  }

  async reservePoints(input: {
    app_id: string;
    user_id: string;
    amount: number;
    capability?: string;
    reservation_key: string;
    external_task_id?: string | null;
    usage_reference_id?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<AiPointsReservationSummary> {
    await this.ensureSchema();
    const amount = this.normalizeNonNegativeDecimal2(input.amount, 0, 'amount');
    if (amount <= 0) {
      throw new BadRequestException('amount must be > 0');
    }
    const appId = input.app_id;
    const userId = input.user_id;
    const reservationKey = this.normalizeReservationKey(input.reservation_key, 'reservation_key');
    await this.getOrCreateWalletByAppId(appId, userId);

    return this.prisma.$transaction(async (tx) => {
      const existing = await (tx.$queryRawUnsafe(
        `SELECT * FROM user_ai_points_reservations
         WHERE app_id = $1::uuid AND user_id = $2::uuid AND reservation_key = $3
         LIMIT 1`,
        appId,
        userId,
        reservationKey,
      ) as Promise<AiPointsReservationRow[]>);
      if (existing[0]) {
        return this.serializeReservation(existing[0]);
      }

      const lockedRows = await (tx.$queryRawUnsafe(
        `SELECT id, app_id, user_id, balance, total_earned, total_spent, updated_at
           FROM user_ai_points_wallets
          WHERE app_id = $1::uuid AND user_id = $2::uuid
          FOR UPDATE`,
        appId,
        userId,
      ) as Promise<UserAiPointsWalletRow[]>);
      const locked = lockedRows[0];
      if (!locked) {
        throw new BadRequestException('积分钱包不存在');
      }
      const balanceBefore = this.toFiniteDecimal2(locked.balance, 0);
      if (balanceBefore + 0.000001 < amount) {
        throw new InsufficientAiPointsError({
          appId,
          userId,
          required: amount,
          balance: balanceBefore,
        });
      }

      const updatedRows = await (tx.$queryRawUnsafe(
        `UPDATE user_ai_points_wallets
            SET balance = balance - $3::numeric,
                updated_at = now()
          WHERE app_id = $1::uuid
            AND user_id = $2::uuid
          RETURNING id, app_id, user_id, balance, total_earned, total_spent, updated_at`,
        appId,
        userId,
        amount,
      ) as Promise<UserAiPointsWalletRow[]>);
      const updated = updatedRows[0];
      if (!updated) {
        throw new BadRequestException('积分冻结失败');
      }
      const balanceAfter = this.toFiniteDecimal2(updated.balance, balanceBefore - amount);
      await (tx.$queryRawUnsafe(
        `INSERT INTO user_ai_points_ledger (
           id, app_id, user_id, delta, balance_after, event_type, reference_type, reference_id, metadata_json
         )
         VALUES (
           gen_random_uuid(),
           $1::uuid,
           $2::uuid,
           $3::numeric,
           $4::numeric,
           'ai_usage_reserve',
           'ai_usage_reservation',
           $5::text,
           $6::jsonb
         )
         RETURNING id`,
        appId,
        userId,
        -amount,
        balanceAfter,
        reservationKey,
        JSON.stringify({
          ...(input.metadata || {}),
          reserved_points: amount,
          balance_before: balanceBefore,
          balance_after: balanceAfter,
          capability: String(input.capability || 'video'),
          external_task_id: input.external_task_id || null,
          usage_reference_id: input.usage_reference_id || null,
        }),
      ) as Promise<LedgerInsertRow[]>);

      const inserted = await (tx.$queryRawUnsafe(
        `INSERT INTO user_ai_points_reservations (
           id, app_id, user_id, reservation_key, external_task_id, usage_reference_id, capability,
           reserved_points, settled_points, status, metadata_json
         )
         VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6,
           $7::numeric, 0::numeric, 'pending', $8::jsonb
         )
         RETURNING *`,
        appId,
        userId,
        reservationKey,
        this.normalizeNullableString(input.external_task_id, 128),
        this.normalizeNullableString(input.usage_reference_id, 128),
        String(input.capability || 'video'),
        amount,
        JSON.stringify(input.metadata || {}),
      ) as Promise<AiPointsReservationRow[]>);
      return this.serializeReservation(inserted[0]);
    });
  }

  async attachReservationTask(input: {
    app_id: string;
    user_id: string;
    reservation_key: string;
    external_task_id: string;
    usage_reference_id?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<AiPointsReservationSummary | null> {
    await this.ensureSchema();
    const appId = input.app_id;
    const userId = input.user_id;
    const reservationKey = this.normalizeReservationKey(input.reservation_key, 'reservation_key');
    const externalTaskId = this.normalizeReservationKey(input.external_task_id, 'external_task_id');
    const usageReferenceId = this.normalizeNullableString(input.usage_reference_id, 128);
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE user_ai_points_reservations
       SET external_task_id = $4,
           usage_reference_id = COALESCE($5, usage_reference_id),
           metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $6::jsonb,
           updated_at = now()
       WHERE app_id = $1::uuid
         AND user_id = $2::uuid
         AND reservation_key = $3
       RETURNING *`,
      appId,
      userId,
      reservationKey,
      externalTaskId,
      usageReferenceId,
      JSON.stringify({
        ...(input.metadata || {}),
        external_task_id: externalTaskId,
        ...(usageReferenceId ? { usage_reference_id: usageReferenceId } : {}),
      }),
    ) as Promise<AiPointsReservationRow[]>);
    return rows[0] ? this.serializeReservation(rows[0]) : null;
  }

  async findReservationByTask(input: {
    app_id: string;
    user_id: string;
    external_task_id: string;
  }): Promise<AiPointsReservationSummary | null> {
    await this.ensureSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM user_ai_points_reservations
        WHERE app_id = $1::uuid
          AND user_id = $2::uuid
          AND external_task_id = $3
        LIMIT 1`,
      input.app_id,
      input.user_id,
      this.normalizeReservationKey(input.external_task_id, 'external_task_id'),
    ) as Promise<AiPointsReservationRow[]>);
    return rows[0] ? this.serializeReservation(rows[0]) : null;
  }

  async settleReservation(input: {
    app_id: string;
    user_id: string;
    external_task_id: string;
    success: boolean;
    settled_points?: number;
    usage_reference_id?: string | null;
    request_id?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<AiPointsReservationSummary | null> {
    await this.ensureSchema();
    const appId = input.app_id;
    const userId = input.user_id;
    const externalTaskId = this.normalizeReservationKey(input.external_task_id, 'external_task_id');
    const settledPoints = this.normalizeNonNegativeDecimal2(input.settled_points ?? 0, 0, 'settled_points');
    const usageReferenceId = this.normalizeNullableString(input.usage_reference_id, 128);

    return this.prisma.$transaction(async (tx) => {
      const reservationRows = await (tx.$queryRawUnsafe(
        `SELECT *
           FROM user_ai_points_reservations
          WHERE app_id = $1::uuid
            AND user_id = $2::uuid
            AND external_task_id = $3
          FOR UPDATE`,
        appId,
        userId,
        externalTaskId,
      ) as Promise<AiPointsReservationRow[]>);
      const reservation = reservationRows[0];
      if (!reservation) {
        return null;
      }
      if (reservation.status === 'captured' || reservation.status === 'released') {
        return this.serializeReservation(reservation);
      }

      const walletRows = await (tx.$queryRawUnsafe(
        `SELECT id, app_id, user_id, balance, total_earned, total_spent, updated_at
           FROM user_ai_points_wallets
          WHERE app_id = $1::uuid AND user_id = $2::uuid
          FOR UPDATE`,
        appId,
        userId,
      ) as Promise<UserAiPointsWalletRow[]>);
      const wallet = walletRows[0];
      if (!wallet) {
        throw new BadRequestException('积分钱包不存在');
      }

      const reservedPoints = this.toFiniteDecimal2(reservation.reserved_points, 0);
      const capturePoints = input.success ? Math.min(reservedPoints, settledPoints) : 0;
      const refundPoints = Math.max(0, reservedPoints - capturePoints);
      let balanceAfter = this.toFiniteDecimal2(wallet.balance, 0);

      if (refundPoints > 0) {
        const updatedRows = await (tx.$queryRawUnsafe(
          `UPDATE user_ai_points_wallets
              SET balance = balance + $3::numeric,
                  updated_at = now(),
                  total_spent = total_spent + $4::numeric
            WHERE app_id = $1::uuid
              AND user_id = $2::uuid
            RETURNING id, app_id, user_id, balance, total_earned, total_spent, updated_at`,
          appId,
          userId,
          refundPoints,
          capturePoints,
        ) as Promise<UserAiPointsWalletRow[]>);
        const updated = updatedRows[0];
        if (!updated) {
          throw new BadRequestException('积分结算失败');
        }
        balanceAfter = this.toFiniteDecimal2(updated.balance, balanceAfter + refundPoints);
        await (tx.$queryRawUnsafe(
          `INSERT INTO user_ai_points_ledger (
             id, app_id, user_id, delta, balance_after, event_type, reference_type, reference_id, metadata_json
           )
           VALUES (
             gen_random_uuid(),
             $1::uuid,
             $2::uuid,
             $3::numeric,
             $4::numeric,
             'ai_usage_reserve_release',
             'ai_usage_reservation',
             $5::text,
             $6::jsonb
           )
           RETURNING id`,
          appId,
          userId,
          refundPoints,
          balanceAfter,
          reservation.reservation_key,
          JSON.stringify({
            refund_points: refundPoints,
            captured_points: capturePoints,
            reserved_points: reservedPoints,
            success: input.success,
            ...(input.metadata || {}),
          }),
        ) as Promise<LedgerInsertRow[]>);
      } else {
        const updatedRows = await (tx.$queryRawUnsafe(
          `UPDATE user_ai_points_wallets
              SET total_spent = total_spent + $3::numeric,
                  updated_at = now()
            WHERE app_id = $1::uuid
              AND user_id = $2::uuid
            RETURNING id, app_id, user_id, balance, total_earned, total_spent, updated_at`,
          appId,
          userId,
          capturePoints,
        ) as Promise<UserAiPointsWalletRow[]>);
        const updated = updatedRows[0];
        if (!updated) {
          throw new BadRequestException('积分结算失败');
        }
        balanceAfter = this.toFiniteDecimal2(updated.balance, balanceAfter);
      }

      if (capturePoints > 0) {
        await (tx.$queryRawUnsafe(
          `INSERT INTO user_ai_points_ledger (
             id, app_id, user_id, delta, balance_after, event_type, reference_type, reference_id, metadata_json
           )
           VALUES (
             gen_random_uuid(),
             $1::uuid,
             $2::uuid,
             0::numeric,
             $3::numeric,
             'ai_usage_capture',
             'ai_usage',
             $4::text,
             $5::jsonb
           )
           RETURNING id`,
          appId,
          userId,
          balanceAfter,
          usageReferenceId || reservation.usage_reference_id || reservation.reservation_key,
          JSON.stringify({
            points_cost: capturePoints,
            points_pricing_source: 'reserved_points_capture',
            request_id: input.request_id || null,
            external_task_id: externalTaskId,
            reserved_points: reservedPoints,
            captured_points: capturePoints,
            ...(input.metadata || {}),
          }),
        ) as Promise<LedgerInsertRow[]>);
      }

      const updatedReservationRows = await (tx.$queryRawUnsafe(
        `UPDATE user_ai_points_reservations
         SET
           status = $4,
           settled_points = $5::numeric,
           usage_reference_id = COALESCE($6, usage_reference_id),
           metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $7::jsonb,
           settled_at = now(),
           updated_at = now()
         WHERE id = $1::uuid
           AND app_id = $2::uuid
           AND user_id = $3::uuid
         RETURNING *`,
        reservation.id,
        appId,
        userId,
        input.success ? 'captured' : 'released',
        capturePoints,
        usageReferenceId,
        JSON.stringify({
          success: input.success,
          refund_points: refundPoints,
          captured_points: capturePoints,
          request_id: input.request_id || null,
          external_task_id: externalTaskId,
          ...(input.metadata || {}),
        }),
      ) as Promise<AiPointsReservationRow[]>);
      return updatedReservationRows[0] ? this.serializeReservation(updatedReservationRows[0]) : null;
    });
  }

  async releaseReservationByKey(input: {
    app_id: string;
    user_id: string;
    reservation_key: string;
    metadata?: Record<string, unknown>;
  }): Promise<AiPointsReservationSummary | null> {
    await this.ensureSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM user_ai_points_reservations
        WHERE app_id = $1::uuid
          AND user_id = $2::uuid
          AND reservation_key = $3
        LIMIT 1`,
      input.app_id,
      input.user_id,
      this.normalizeReservationKey(input.reservation_key, 'reservation_key'),
    ) as Promise<AiPointsReservationRow[]>);
    const reservation = rows[0];
    if (!reservation) {
      return null;
    }
    if (reservation.external_task_id) {
      return this.settleReservation({
        app_id: input.app_id,
        user_id: input.user_id,
        external_task_id: reservation.external_task_id,
        success: false,
        settled_points: 0,
        metadata: input.metadata,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const lockedReservationRows = await (tx.$queryRawUnsafe(
        `SELECT *
           FROM user_ai_points_reservations
          WHERE app_id = $1::uuid
            AND user_id = $2::uuid
            AND reservation_key = $3
          FOR UPDATE`,
        input.app_id,
        input.user_id,
        this.normalizeReservationKey(input.reservation_key, 'reservation_key'),
      ) as Promise<AiPointsReservationRow[]>);
      const lockedReservation = lockedReservationRows[0];
      if (!lockedReservation) {
        return null;
      }
      if (lockedReservation.status !== 'pending') {
        return this.serializeReservation(lockedReservation);
      }
      const walletRows = await (tx.$queryRawUnsafe(
        `SELECT id, app_id, user_id, balance, total_earned, total_spent, updated_at
           FROM user_ai_points_wallets
          WHERE app_id = $1::uuid AND user_id = $2::uuid
          FOR UPDATE`,
        input.app_id,
        input.user_id,
      ) as Promise<UserAiPointsWalletRow[]>);
      const wallet = walletRows[0];
      if (!wallet) {
        throw new BadRequestException('积分钱包不存在');
      }
      const refundPoints = this.toFiniteDecimal2(lockedReservation.reserved_points, 0);
      const updatedRows = await (tx.$queryRawUnsafe(
        `UPDATE user_ai_points_wallets
            SET balance = balance + $3::numeric,
                updated_at = now()
          WHERE app_id = $1::uuid
            AND user_id = $2::uuid
          RETURNING id, app_id, user_id, balance, total_earned, total_spent, updated_at`,
        input.app_id,
        input.user_id,
        refundPoints,
      ) as Promise<UserAiPointsWalletRow[]>);
      const updated = updatedRows[0];
      if (!updated) {
        throw new BadRequestException('积分释放失败');
      }
      const balanceAfter = this.toFiniteDecimal2(updated.balance, this.toFiniteDecimal2(wallet.balance, 0) + refundPoints);
      await (tx.$queryRawUnsafe(
        `INSERT INTO user_ai_points_ledger (
           id, app_id, user_id, delta, balance_after, event_type, reference_type, reference_id, metadata_json
         )
         VALUES (
           gen_random_uuid(),
           $1::uuid,
           $2::uuid,
           $3::numeric,
           $4::numeric,
           'ai_usage_reserve_release',
           'ai_usage_reservation',
           $5::text,
           $6::jsonb
         )
         RETURNING id`,
        input.app_id,
        input.user_id,
        refundPoints,
        balanceAfter,
        lockedReservation.reservation_key,
        JSON.stringify({
          refund_points: refundPoints,
          success: false,
          ...(input.metadata || {}),
        }),
      ) as Promise<LedgerInsertRow[]>);
      const settledRows = await (tx.$queryRawUnsafe(
        `UPDATE user_ai_points_reservations
         SET status = 'released',
             settled_points = 0::numeric,
             metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
             settled_at = now(),
             updated_at = now()
         WHERE id = $1::uuid
           AND app_id = $2::uuid
           AND user_id = $3::uuid
         RETURNING *`,
        lockedReservation.id,
        input.app_id,
        input.user_id,
        JSON.stringify({
          success: false,
          refund_points: refundPoints,
          ...(input.metadata || {}),
        }),
      ) as Promise<AiPointsReservationRow[]>);
      return settledRows[0] ? this.serializeReservation(settledRows[0]) : null;
    });
  }

  private serializeWallet(row: UserAiPointsWalletRow): AiPointsWalletSummary {
    return {
      app_id: row.app_id,
      user_id: row.user_id,
      balance: this.toFiniteDecimal2(row.balance, 0),
      total_earned: this.toFiniteDecimal2(row.total_earned, 0),
      total_spent: this.toFiniteDecimal2(row.total_spent, 0),
      updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    };
  }

  private serializeReservation(row: AiPointsReservationRow): AiPointsReservationSummary {
    return {
      id: row.id,
      app_id: row.app_id,
      user_id: row.user_id,
      reservation_key: row.reservation_key,
      external_task_id: row.external_task_id || null,
      usage_reference_id: row.usage_reference_id || null,
      capability: String(row.capability || 'video'),
      reserved_points: this.toFiniteDecimal2(row.reserved_points, 0),
      settled_points: this.toFiniteDecimal2(row.settled_points, 0),
      status: this.normalizeReservationStatus(row.status),
      metadata: this.normalizeJsonObject(row.metadata_json),
      created_at: row.created_at ? row.created_at.toISOString() : null,
      updated_at: row.updated_at ? row.updated_at.toISOString() : null,
      settled_at: row.settled_at ? row.settled_at.toISOString() : null,
    };
  }

  private normalizeNonNegativeDecimal2(value: unknown, fallback: number, fieldName: string): number {
    if (value === null || value === undefined || value === '') {
      return this.roundTo2(Math.max(0, Number(fallback || 0)));
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new BadRequestException(`${fieldName} must be a finite number`);
    }
    if (parsed < 0) {
      throw new BadRequestException(`${fieldName} must be >= 0`);
    }
    if (parsed > 1_000_000_000) {
      throw new BadRequestException(`${fieldName} is too large`);
    }
    return this.roundTo2(parsed);
  }

  private normalizeNonNegativeInteger(value: unknown, fallback: number, fieldName: string): number {
    if (value === null || value === undefined || value === '') {
      return Math.max(0, Math.floor(fallback));
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new BadRequestException(`${fieldName} must be a finite number`);
    }
    if (parsed < 0) {
      throw new BadRequestException(`${fieldName} must be >= 0`);
    }
    if (parsed > 1_000_000_000) {
      throw new BadRequestException(`${fieldName} is too large`);
    }
    return Math.floor(parsed);
  }

  private toFiniteInteger(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.trunc(parsed);
  }

  private toFiniteDecimal2(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return this.roundTo2(fallback);
    }
    return this.roundTo2(parsed);
  }

  private roundTo2(value: number): number {
    return Number((Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100).toFixed(2));
  }

  private normalizeReservationKey(raw: unknown, fieldName: string): string {
    const value = String(raw || '').trim();
    if (!value) {
      throw new BadRequestException(`${fieldName} is required`);
    }
    if (value.length > 128) {
      throw new BadRequestException(`${fieldName} is too long`);
    }
    return value;
  }

  private normalizeReservationStatus(raw: unknown): 'pending' | 'captured' | 'released' {
    const normalized = String(raw || '').trim().toLowerCase();
    if (normalized === 'captured') {
      return 'captured';
    }
    if (normalized === 'released') {
      return 'released';
    }
    return 'pending';
  }

  private normalizeNullableString(value: unknown, maxLength = 255): string | null {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      return null;
    }
    return normalized.slice(0, maxLength);
  }

  private normalizeJsonObject(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return {};
    }
    return { ...(input as Record<string, unknown>) };
  }

  private async ensureSchema() {
    if (this.schemaReady) {
      return;
    }
    if (this.schemaPromise) {
      await this.schemaPromise;
      return;
    }
    this.schemaPromise = this.initSchema();
    try {
      await this.schemaPromise;
      this.schemaReady = true;
    } finally {
      this.schemaPromise = null;
    }
  }

  private async initSchema() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS app_ai_points_settings (
        app_id uuid PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
        initial_points integer NOT NULL DEFAULT ${DEFAULT_INITIAL_POINTS},
        points_per_yuan integer NOT NULL DEFAULT ${DEFAULT_POINTS_PER_YUAN},
        updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE app_ai_points_settings
      ADD COLUMN IF NOT EXISTS points_per_yuan integer NOT NULL DEFAULT ${DEFAULT_POINTS_PER_YUAN}
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS user_ai_points_wallets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        balance numeric(20, 2) NOT NULL DEFAULT 0,
        total_earned numeric(20, 2) NOT NULL DEFAULT 0,
        total_spent numeric(20, 2) NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (app_id, user_id)
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS user_ai_points_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delta numeric(20, 2) NOT NULL,
        balance_after numeric(20, 2) NOT NULL,
        event_type varchar(64) NOT NULL,
        reference_type varchar(64) NULL,
        reference_id varchar(128) NULL,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_user_ai_points_wallets_app_user
      ON user_ai_points_wallets(app_id, user_id)
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE user_ai_points_wallets
      ALTER COLUMN balance TYPE numeric(20, 2)
      USING balance::numeric(20, 2)
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE user_ai_points_wallets
      ALTER COLUMN total_earned TYPE numeric(20, 2)
      USING total_earned::numeric(20, 2)
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE user_ai_points_wallets
      ALTER COLUMN total_spent TYPE numeric(20, 2)
      USING total_spent::numeric(20, 2)
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE user_ai_points_ledger
      ALTER COLUMN delta TYPE numeric(20, 2)
      USING delta::numeric(20, 2)
    `);

    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE user_ai_points_ledger
      ALTER COLUMN balance_after TYPE numeric(20, 2)
      USING balance_after::numeric(20, 2)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_user_ai_points_ledger_lookup
      ON user_ai_points_ledger(app_id, user_id, created_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_user_ai_points_ledger_reference_lookup
      ON user_ai_points_ledger(app_id, reference_type, reference_id, created_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_user_ai_points_ledger_request_id_lookup
      ON user_ai_points_ledger(app_id, reference_type, ((metadata_json->>'request_id')), created_at DESC)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS user_ai_points_reservations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reservation_key varchar(128) NOT NULL,
        external_task_id varchar(128) NULL,
        usage_reference_id varchar(128) NULL,
        capability varchar(32) NOT NULL DEFAULT 'video',
        reserved_points numeric(20, 2) NOT NULL DEFAULT 0,
        settled_points numeric(20, 2) NOT NULL DEFAULT 0,
        status varchar(32) NOT NULL DEFAULT 'pending',
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        settled_at timestamptz NULL
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_ai_points_reservations_unique_key
      ON user_ai_points_reservations(app_id, user_id, reservation_key)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_ai_points_reservations_unique_task
      ON user_ai_points_reservations(app_id, user_id, external_task_id)
      WHERE external_task_id IS NOT NULL
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_user_ai_points_reservations_lookup
      ON user_ai_points_reservations(app_id, user_id, status, created_at DESC)
    `);
  }
}
