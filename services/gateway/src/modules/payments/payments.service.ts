import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Interval } from '@nestjs/schedule';
import { createHash, createHmac, createPrivateKey, createSign, createVerify, randomBytes, timingSafeEqual } from 'crypto';
import { ConfigType } from '@nestjs/config';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { RedeemService } from '../redeem/redeem.service';
import { AiPointsService, DEFAULT_POINTS_PER_YUAN } from '../ai-chat/ai-points.service';

type TxClient = Prisma.TransactionClient;
type ProductType = 'ONE_TIME' | 'RECURRING';
type ProductStatus = 'ACTIVE' | 'INACTIVE';
type OrderStatus = 'PENDING' | 'PAID' | 'FAILED' | 'CLOSED' | 'REFUNDED';
type AgreementStatus = 'PENDING' | 'VALID' | 'INVALID' | 'UNSIGNED';
type DeductionStatus = 'PENDING' | 'SUCCESS' | 'FAILED';
type PeriodType = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

interface AppRow {
  id: string;
  slug: string;
  name: string;
}

interface AppSettingRow {
  app_id: string;
  app_url: string | null;
  alipay_notify_url: string | null;
  alipay_agreement_notify_url: string | null;
  extra_json: unknown;
  api_domain: string | null;
  user_web_domain: string | null;
}

interface UserRow {
  id: string;
  app_id: string;
  email: string;
  role: string | null;
  admin_type: string | null;
  is_active: boolean;
  is_superuser: boolean;
  membership_type: string | null;
  membership_expires_at: Date | null;
}

interface AdminPermissionRow {
  allowed_pages: unknown;
}

interface PaymentProductRow {
  id: string;
  app_id: string;
  code: string;
  name: string;
  description: string | null;
  type: ProductType;
  status: ProductStatus;
  amount: unknown;
  currency: string | null;
  membership_days: number | null;
  points_topup: number | null;
  sign_scene: string | null;
  sign_validity_period: number | null;
  period_type: string | null;
  period: number | null;
  execute_time: string | null;
  created_at: Date;
  updated_at: Date;
}

interface OrderRow {
  id: string;
  app_id: string;
  out_trade_no: string;
  user_id: string;
  product_id: string;
  subject: string;
  total_amount: unknown;
  original_amount: unknown | null;
  payable_amount: unknown | null;
  points_deduct_points: unknown | null;
  points_deduct_amount: unknown | null;
  points_deduct_ledger_id: string | null;
  points_refund_ledger_id: string | null;
  points_refund_status: string | null;
  points_topup_points: unknown | null;
  points_topup_ledger_id: string | null;
  points_topup_status: string | null;
  status: string;
  trade_no: string | null;
  trade_status: string | null;
  payment_type: string;
  provider_type: string | null;
  payment_method_id: string | null;
  external_object_id: string | null;
  external_customer_id: string | null;
  external_subscription_id: string | null;
  checkout_url: string | null;
  currency: string | null;
  idempotency_key: string | null;
  raw_status: string | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface OrderWithRefundStatsRow extends OrderRow {
  refunded_amount_total: unknown;
  refund_count: unknown;
  refunded_at: Date | null;
}

interface DashboardOrderAggRow {
  gross_amount: unknown;
  paid_order_count: unknown;
  paid_buyer_count: unknown;
  total_order_count: unknown;
}

interface DashboardRefundAggRow {
  refund_amount: unknown;
}

interface DashboardBehaviorAggRow {
  product_page_views: unknown;
}

interface DashboardTrendOrderRow {
  ts: Date | null;
  amount: unknown;
}

interface OrderRefundRow {
  id: string;
  app_id: string;
  order_id: string;
  out_trade_no: string;
  out_request_no: string;
  refund_amount: unknown;
  refund_reason: string | null;
  status: string;
  refund_fee: unknown;
  refund_no: string | null;
  gmt_refund_pay: Date | null;
  response_payload: unknown;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface AgreementRow {
  id: string;
  app_id: string;
  user_id: string;
  product_id: string;
  external_agreement_no: string;
  agreement_no: string | null;
  status: string;
  sign_scene: string | null;
  period_type: string | null;
  period: number | null;
  execute_time: string | null;
  sign_validity_period: number | null;
  signed_at: Date | null;
  invalid_at: Date | null;
  next_deduction_at: Date | null;
  last_deducted_at: Date | null;
  created_at: Date;
}

interface DeductionRow {
  id: string;
  app_id: string;
  agreement_id: string;
  user_id: string;
  product_id: string;
  out_trade_no: string;
  amount: unknown;
  status: string;
  trade_no: string | null;
  trade_status: string | null;
  executed_at: Date | null;
  created_at: Date;
}

interface EntitlementPackageRow {
  id: string;
  name: string;
  description: string | null;
  price_cny: unknown;
  is_active: boolean;
}

interface MembershipUpdateResult {
  updated: boolean;
  expiresAt: Date | null;
}

type PlatformPaymentProviderType = 'ALIPAY' | 'WECHAT' | 'STRIPE' | 'PADDLE' | 'LEMONSQUEEZY';
type SaasPaymentProviderType = 'STRIPE' | 'PADDLE' | 'LEMONSQUEEZY';

interface PlatformPaymentMethodRow {
  id: string;
  provider_type: PlatformPaymentProviderType;
  name: string;
  is_active: boolean;
  is_default: boolean;
  config_json: unknown;
  created_at: Date;
  updated_at: Date;
}

interface ResolvedPaymentMethod {
  row: PlatformPaymentMethodRow | null;
  providerType: PlatformPaymentProviderType;
  config: Record<string, unknown>;
}

interface EffectiveAlipayConfig {
  enabled: boolean;
  sandboxDebug: boolean;
  gatewayUrl: string;
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  signType: string;
  notifyUrl: string;
  returnUrl: string;
  agreementNotifyUrl: string;
  agreementReturnUrl: string;
}

interface EffectiveWechatPayConfig {
  enabled: boolean;
  gatewayUrl: string;
  appId: string;
  mchId: string;
  apiKey: string;
  notifyUrl: string;
}

interface RuntimePaymentSettings {
  apiBaseUrl: string;
  userWebBaseUrl: string;
  paymentReturnBaseUrl: string;
  schedulerEnabled: boolean | null;
  schedulerIntervalMs: number | null;
  schedulerBatchSize: number | null;
  allowLocalReturnUrl: boolean | null;
  adminTestDisabled: boolean | null;
}

const DEFAULT_POINTS_TOPUP_PRODUCT_CODE = 'SYS_POINTS_TOPUP';
const DEFAULT_POINTS_TOPUP_PRODUCT_NAME = '积分充值';
const DEFAULT_POINTS_TOPUP_PRODUCT_DESCRIPTION = '系统默认积分充值商品（无需手动创建）';
const DEFAULT_POINTS_TOPUP_SUBJECT = '积分充值';
const PAYMENTS_AUTO_DEDUCTION_TICK_MS = 60_000;

interface DueAgreementCandidateRow {
  id: string;
  app_id: string;
}

@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;
  private runtimeConfigLoadedAt = 0;
  private runtimeConfigLoading: Promise<void> | null = null;
  private effectiveAlipay: EffectiveAlipayConfig | null = null;
  private effectiveWechatPay: EffectiveWechatPayConfig | null = null;
  private runtimePaymentSettings: RuntimePaymentSettings = {
    apiBaseUrl: '',
    userWebBaseUrl: '',
    paymentReturnBaseUrl: '',
    schedulerEnabled: null,
    schedulerIntervalMs: null,
    schedulerBatchSize: null,
    allowLocalReturnUrl: null,
    adminTestDisabled: null,
  };
  private autoDeductionRunning = false;
  private autoDeductionLastRunAt = 0;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly redeemService: RedeemService,
    private readonly aiPointsService: AiPointsService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`payments startup warmup failed: ${error?.message || error}`);
    }
  }

  @Interval(PAYMENTS_AUTO_DEDUCTION_TICK_MS)
  private async runAutoDeductionInterval() {
    await this.ensureRuntimePaymentConfig();
    const autoDeduction = this.config.payments;
    const schedulerEnabled = this.runtimePaymentSettings.schedulerEnabled ?? autoDeduction.autoDeductionEnabled;
    if (!schedulerEnabled) {
      return;
    }

    const now = Date.now();
    const intervalMs = this.runtimePaymentSettings.schedulerIntervalMs || autoDeduction.autoDeductionIntervalMs;
    if (now - this.autoDeductionLastRunAt < intervalMs) {
      return;
    }
    if (this.autoDeductionRunning) {
      this.logger.warn('payments auto deduction skipped because the previous run is still active');
      return;
    }

    this.autoDeductionRunning = true;
    this.autoDeductionLastRunAt = now;
    try {
      await this.ensureSchema();
      this.assertAlipayRealGatewayReady();
      const summary = await this.runDueDeductionBatch({
        batchSize: this.runtimePaymentSettings.schedulerBatchSize || autoDeduction.autoDeductionBatchSize,
        source: 'auto_scheduler',
      });
      if (summary.total_due > 0 || summary.failed > 0) {
        this.logger.log(
          `payments auto deduction run total=${summary.total_due} success=${summary.success} failed=${summary.failed} skipped=${summary.skipped}`,
        );
      }
    } catch (error: any) {
      this.logger.error(`payments auto deduction run failed: ${error?.message || 'unknown error'}`);
    } finally {
      this.autoDeductionRunning = false;
    }
  }

  async listProducts(appSlug: string | undefined, userId: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    await this.ensureDefaultPointsTopupProduct(app.id);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM payment_products
       WHERE app_id = $1::uuid AND status = 'ACTIVE'
       ORDER BY created_at DESC`,
      app.id,
    ) as Promise<PaymentProductRow[]>);
    return {
      items: rows.map((row) => this.serializeProduct(row)),
    };
  }

  async getProductForPurchase(appSlug: string | undefined, userId: string, productId: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);
    const normalizedProductId = String(productId || '').trim();
    if (!normalizedProductId) {
      throw new BadRequestException('product_id is required');
    }
    const product = await this.getResolvableProduct(app.id, normalizedProductId);
    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    if (product.status !== 'ACTIVE') {
      throw new BadRequestException('商品未上架');
    }
    return this.serializeProduct(product);
  }

  private normalizePaymentProviderType(value: unknown): PlatformPaymentProviderType {
    const normalized = String(value || '')
      .trim()
      .toUpperCase();
    if (['ALIPAY', 'WECHAT', 'STRIPE', 'PADDLE', 'LEMONSQUEEZY'].includes(normalized)) {
      return normalized as PlatformPaymentProviderType;
    }
    throw new BadRequestException('provider_type must be ALIPAY, WECHAT, STRIPE, PADDLE or LEMONSQUEEZY');
  }

  private isSaasProvider(providerType: PlatformPaymentProviderType): providerType is SaasPaymentProviderType {
    return providerType === 'STRIPE' || providerType === 'PADDLE' || providerType === 'LEMONSQUEEZY';
  }

  private async hasPlatformPaymentMethodsTable() {
    const tableRows = await (this.prisma.$queryRawUnsafe(
      `SELECT to_regclass('public.platform_payment_methods')::text AS exists`,
    ) as Promise<Array<{ exists: string | null }>>);
    return !!String(tableRows[0]?.exists || '').trim();
  }

  private async getAllowedPaymentMethodIds(appId: string) {
    const settings = await this.getAppSettings(appId);
    const extra = this.asConfigMap(settings?.extra_json);
    const raw = extra.payment_method_ref_ids;
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((item) => String(item || '').trim()).filter(Boolean);
  }

  private async resolvePaymentMethodForApp(
    appId: string,
    providerType: PlatformPaymentProviderType,
    methodId?: string | null,
  ): Promise<ResolvedPaymentMethod> {
    if (!(await this.hasPlatformPaymentMethodsTable())) {
      return { row: null, providerType, config: {} };
    }

    const normalizedMethodId = String(methodId || '').trim();
    const allowedIds = await this.getAllowedPaymentMethodIds(appId);
    if (normalizedMethodId) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT *
         FROM platform_payment_methods
         WHERE id = $1::uuid
           AND provider_type = $2
           AND is_active = true
         LIMIT 1`,
        normalizedMethodId,
        providerType,
      ) as Promise<PlatformPaymentMethodRow[]>);
      const row = rows[0] || null;
      if (!row) {
        throw new BadRequestException('支付方式不可用');
      }
      if (allowedIds.length > 0 && !allowedIds.includes(row.id)) {
        throw new BadRequestException('当前租户未启用该支付方式');
      }
      return { row, providerType, config: this.asConfigMap(row.config_json) };
    }

    if (allowedIds.length > 0) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT *
         FROM platform_payment_methods
         WHERE provider_type = $1
           AND is_active = true
           AND id::text = ANY($2::text[])
         ORDER BY is_default DESC, updated_at DESC
         LIMIT 1`,
        providerType,
        allowedIds,
      ) as Promise<PlatformPaymentMethodRow[]>);
      const row = rows[0] || null;
      if (row) {
        return { row, providerType, config: this.asConfigMap(row.config_json) };
      }
      throw new BadRequestException('当前租户未启用可用的支付方式');
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_payment_methods
       WHERE provider_type = $1
         AND is_active = true
       ORDER BY is_default DESC, updated_at DESC
       LIMIT 1`,
      providerType,
    ) as Promise<PlatformPaymentMethodRow[]>);
    const row = rows[0] || null;
    return { row, providerType, config: row ? this.asConfigMap(row.config_json) : {} };
  }

  private async resolvePaymentMethodById(
    providerType: PlatformPaymentProviderType,
    methodId: string | null | undefined,
  ): Promise<ResolvedPaymentMethod> {
    const normalizedMethodId = String(methodId || '').trim();
    if (!normalizedMethodId || !(await this.hasPlatformPaymentMethodsTable())) {
      return { row: null, providerType, config: {} };
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM platform_payment_methods
       WHERE id = $1::uuid
         AND provider_type = $2
         AND is_active = true
       LIMIT 1`,
      normalizedMethodId,
      providerType,
    ) as Promise<PlatformPaymentMethodRow[]>);
    const row = rows[0] || null;
    return { row, providerType, config: row ? this.asConfigMap(row.config_json) : {} };
  }

  private async resolvePaymentMethodForOrder(
    appId: string,
    order: Pick<OrderRow, 'payment_method_id'>,
    providerType: PlatformPaymentProviderType,
  ) {
    const byId = await this.resolvePaymentMethodById(providerType, order.payment_method_id);
    if (byId.row) {
      return byId;
    }
    return this.resolvePaymentMethodForApp(appId, providerType);
  }

  private alipayConfigFromMethod(method: ResolvedPaymentMethod): EffectiveAlipayConfig {
    const cfg = method.row ? method.config : {};
    if (!method.row) {
      return this.alipayConfig();
    }
    const envAlipay = this.getDefaultEnvAlipayConfig();
    return {
      enabled: this.parseBooleanLike(cfg.enabled, true),
      sandboxDebug: this.parseBooleanLike(cfg.sandbox_debug, false),
      gatewayUrl: String(cfg.gateway_url || '').trim() || envAlipay.gatewayUrl,
      appId: String(cfg.app_id || '').trim(),
      privateKey: String(cfg.private_key || '').trim(),
      alipayPublicKey: String(cfg.alipay_public_key || '').trim(),
      signType: String(cfg.sign_type || 'RSA2').trim() || 'RSA2',
      notifyUrl: String(cfg.notify_url || '').trim(),
      returnUrl: String(cfg.return_url || '').trim(),
      agreementNotifyUrl: String(cfg.agreement_notify_url || '').trim(),
      agreementReturnUrl: String(cfg.agreement_return_url || '').trim(),
    };
  }

  private wechatConfigFromMethod(method: ResolvedPaymentMethod): EffectiveWechatPayConfig {
    const cfg = method.row ? method.config : {};
    if (!method.row) {
      return this.wechatPayConfig();
    }
    const envWechat = this.getDefaultEnvWechatPayConfig();
    return {
      enabled: this.parseBooleanLike(cfg.enabled, true),
      gatewayUrl: String(cfg.gateway_url || '').trim() || envWechat.gatewayUrl,
      appId: String(cfg.app_id || '').trim(),
      mchId: String(cfg.mch_id || '').trim(),
      apiKey: String(cfg.api_key || '').trim(),
      notifyUrl: String(cfg.notify_url || '').trim(),
    };
  }

  private isResolvedAlipayConfigured(cfg: EffectiveAlipayConfig) {
    return !!(cfg.enabled && cfg.appId && cfg.privateKey && cfg.alipayPublicKey);
  }

  private isResolvedWechatConfigured(cfg: EffectiveWechatPayConfig) {
    return !!(cfg.enabled && cfg.appId && cfg.mchId && cfg.apiKey);
  }

  async createPagePayOrder(
    appSlug: string | undefined,
    userId: string,
    payload: { product_id?: string; amount?: number | string; subject?: string; points_to_deduct?: number },
  ) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const user = await this.ensureUserInApp(app.id, userId);

    const productId = String(payload?.product_id || '').trim();
    let product: PaymentProductRow | null = null;
    let pointsPerYuan: number | null = null;
    let subject = String(payload?.subject || '').trim();
    let originalAmount = '0.00';
    let productTopupPoints = 0;
    if (productId) {
      product = await this.getResolvableProduct(app.id, productId);
      if (!product) {
        throw new NotFoundException('商品不存在');
      }
      if (product.status !== 'ACTIVE') {
        throw new BadRequestException('商品未上架');
      }
      if (product.type !== 'ONE_TIME') {
        throw new BadRequestException('该商品不是单次支付商品');
      }
      if (this.isSystemPointsTopupProduct(product)) {
        const amountInput = payload?.amount ?? product.amount;
        originalAmount = this.normalizeOrderAmount(amountInput, 'amount');
        const settings = await this.aiPointsService.getSettingsByAppId(app.id);
        pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
        productTopupPoints = this.calculateTopupPointsByAmount(originalAmount, pointsPerYuan);
        subject = DEFAULT_POINTS_TOPUP_SUBJECT;
      } else {
        originalAmount = this.formatAmount(product.amount);
        productTopupPoints = 0;
        subject = subject || product.name;
      }
    } else {
      if (payload?.amount === null || payload?.amount === undefined || payload?.amount === '') {
        throw new BadRequestException('product_id or amount is required');
      }
      originalAmount = this.normalizeOrderAmount(payload?.amount, 'amount');
      product = await this.ensureDefaultPointsTopupProduct(app.id);
      const settings = await this.aiPointsService.getSettingsByAppId(app.id);
      pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
      productTopupPoints = this.calculateTopupPointsByAmount(originalAmount, pointsPerYuan);
      subject = subject || DEFAULT_POINTS_TOPUP_SUBJECT;
    }

    if (!product) {
      throw new BadRequestException('创建订单失败：未找到可用商品');
    }

    const paymentMethod = await this.resolvePaymentMethodForApp(app.id, 'ALIPAY');
    const alipayCfg = this.alipayConfigFromMethod(paymentMethod);
    const outTradeNo = this.genTradeNo('ALI');
    const requestedPoints = this.normalizePointsValue(payload?.points_to_deduct, 'points_to_deduct');
    const originalAmountFen = this.amountToFen(originalAmount);
    const maxRateDeductPoints = Math.max(0, Math.floor(originalAmountFen * 0.3));
    const wallet =
      requestedPoints > 0 ? await this.aiPointsService.getOrCreateWalletByAppId(app.id, user.id) : null;
    const walletBalancePoints = wallet ? this.toSafeInteger(wallet.balance) : 0;
    const effectiveDeductPoints = Math.max(
      0,
      Math.min(requestedPoints, walletBalancePoints, maxRateDeductPoints),
    );
    const deductedAmount = this.fenToAmount(effectiveDeductPoints);
    const payableAmount = this.fenToAmount(Math.max(0, originalAmountFen - effectiveDeductPoints));

    let deductedLedgerId: string | null = null;
    if (effectiveDeductPoints > 0) {
      const charge = await this.aiPointsService.consumePoints({
        app_id: app.id,
        user_id: user.id,
        cost: effectiveDeductPoints,
        event_type: 'order_points_deduct',
        reference_type: 'payment_order',
        reference_id: outTradeNo,
        metadata: {
          out_trade_no: outTradeNo,
          product_id: product.id,
          original_amount: originalAmount,
          payable_amount: payableAmount,
          points_topup_points: productTopupPoints,
          points_per_yuan: pointsPerYuan,
          points_deduct_points: effectiveDeductPoints,
          points_deduct_amount: deductedAmount,
        },
      });
      deductedLedgerId = charge.ledger_id || null;
    }

    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO alipay_orders (
           id, app_id, out_trade_no, user_id, product_id, subject, total_amount,
           original_amount, payable_amount, points_deduct_points, points_deduct_amount,
           points_deduct_ledger_id, points_refund_status, points_topup_points, points_topup_status,
           status, payment_type, provider_type, payment_method_id, currency, created_at, updated_at
         )
         VALUES (
           gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5, $6::numeric,
           $7::numeric, $8::numeric, $9::bigint, $10::numeric,
           $11, 'NONE', $12::bigint, 'NONE',
           'PENDING', 'ONE_TIME', 'ALIPAY', $13::uuid, $14, now(), now()
         )`,
        app.id,
        outTradeNo,
        user.id,
        product.id,
        subject,
        payableAmount,
        originalAmount,
        payableAmount,
        effectiveDeductPoints,
        deductedAmount,
        deductedLedgerId,
        productTopupPoints,
        paymentMethod.row?.id || null,
        String(product.currency || 'CNY').trim() || 'CNY',
      );
    } catch (error) {
      if (effectiveDeductPoints > 0) {
        try {
          await this.aiPointsService.creditPoints({
            app_id: app.id,
            user_id: user.id,
            amount: effectiveDeductPoints,
            event_type: 'order_points_refund',
            reference_type: 'payment_order',
            reference_id: `${outTradeNo}:create_failed`,
            metadata: {
              out_trade_no: outTradeNo,
              reason: 'create_order_failed',
              points_deduct_points: effectiveDeductPoints,
            },
          });
        } catch (refundError: any) {
          this.logger.error(
            `page pay order compensation refund failed app=${app.id} user=${user.id} out_trade_no=${outTradeNo}: ${
              refundError?.message || 'unknown error'
            }`,
          );
        }
      }
      throw error;
    }

    const appSettings = await this.getAppSettings(app.id);
    if (this.isResolvedAlipayConfigured(alipayCfg)) {
      const paymentForm = this.buildAlipayPagePayForm({
        appSlug: app.slug,
        appSettings,
        outTradeNo,
        amount: payableAmount,
        subject,
        cfg: alipayCfg,
      });
      return {
        out_trade_no: outTradeNo,
        payment_form: paymentForm,
        amount: payableAmount,
        original_amount: originalAmount,
        payable_amount: payableAmount,
        points_topup_points: productTopupPoints,
        points_deduct_points: effectiveDeductPoints,
        points_deduct_amount: deductedAmount,
        subject,
        channel: 'alipay',
        payment_method_id: paymentMethod.row?.id || null,
      };
    }

    return {
      out_trade_no: outTradeNo,
      payment_form: `https://sandbox.dl.alipaydev.com/gateway.do?out_trade_no=${encodeURIComponent(outTradeNo)}`,
      amount: payableAmount,
      original_amount: originalAmount,
      payable_amount: payableAmount,
      points_topup_points: productTopupPoints,
      points_deduct_points: effectiveDeductPoints,
      points_deduct_amount: deductedAmount,
      subject,
      channel: 'mock',
    };
  }

  async createWechatNativeOrder(
    appSlug: string | undefined,
    userId: string,
    payload: { product_id?: string; amount?: number | string; description?: string; client_ip?: string },
  ) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const user = await this.ensureUserInApp(app.id, userId);
    const productId = String(payload?.product_id || '').trim();
    let product: PaymentProductRow | null = null;
    let pointsPerYuan: number | null = null;
    let amount = '0.00';
    let productTopupPoints = 0;
    let subject = String(payload?.description || '').trim();
    if (productId) {
      product = await this.getProductById(app.id, productId);
      if (!product) {
        throw new NotFoundException('商品不存在');
      }
      if (product.status !== 'ACTIVE') {
        throw new BadRequestException('商品未上架');
      }
      if (product.type !== 'ONE_TIME') {
        throw new BadRequestException('微信支付当前仅支持单次支付商品');
      }
      if (this.isSystemPointsTopupProduct(product)) {
        const amountInput = payload?.amount ?? product.amount;
        amount = this.normalizeOrderAmount(amountInput, 'amount');
        const settings = await this.aiPointsService.getSettingsByAppId(app.id);
        pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
        productTopupPoints = this.calculateTopupPointsByAmount(amount, pointsPerYuan);
        subject = DEFAULT_POINTS_TOPUP_SUBJECT;
      } else {
        amount = this.formatAmount(product.amount);
        productTopupPoints = 0;
        subject = subject || product.name;
      }
    } else {
      if (payload?.amount === null || payload?.amount === undefined || payload?.amount === '') {
        throw new BadRequestException('product_id or amount is required');
      }
      amount = this.normalizeOrderAmount(payload?.amount, 'amount');
      product = await this.ensureDefaultPointsTopupProduct(app.id);
      const settings = await this.aiPointsService.getSettingsByAppId(app.id);
      pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
      productTopupPoints = this.calculateTopupPointsByAmount(amount, pointsPerYuan);
      subject = subject || DEFAULT_POINTS_TOPUP_SUBJECT;
    }
    if (!product) {
      throw new BadRequestException('创建微信支付订单失败：未找到可用商品');
    }
    const paymentMethod = await this.resolvePaymentMethodForApp(app.id, 'WECHAT');
    const wechatCfg = this.wechatConfigFromMethod(paymentMethod);
    const outTradeNo = this.genTradeNo('WX');
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO alipay_orders (
         id, app_id, out_trade_no, user_id, product_id, subject, total_amount, points_topup_points,
         status, payment_type, provider_type, payment_method_id, currency, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5, $6::numeric, $7::bigint,
         'PENDING', 'WECHAT_NATIVE', 'WECHAT', $8::uuid, $9, now(), now()
       )`,
      app.id,
      outTradeNo,
      user.id,
      product.id,
      subject,
      amount,
      productTopupPoints,
      paymentMethod.row?.id || null,
      String(product.currency || 'CNY').trim() || 'CNY',
    );

    if (!this.isResolvedWechatConfigured(wechatCfg)) {
      return {
        out_trade_no: outTradeNo,
        payment_url: `weixin://wxpay/bizpayurl?pr=mock_${outTradeNo}`,
        code_url: null,
        amount,
        subject,
        points_topup_points: productTopupPoints,
        points_per_yuan: pointsPerYuan,
        channel: 'mock',
        payment_method_id: paymentMethod.row?.id || null,
      };
    }

    const appSettings = await this.getAppSettings(app.id);
    const notifyUrl = this.resolveWechatNotifyUrl(app.slug, appSettings, wechatCfg);
    const unifiedOrder = await this.wechatUnifiedOrder({
      appId: wechatCfg.appId,
      mchId: wechatCfg.mchId,
      apiKey: wechatCfg.apiKey,
      outTradeNo,
      body: subject,
      totalFee: this.amountToFen(amount),
      notifyUrl,
      clientIp: String(payload?.client_ip || '').trim() || '127.0.0.1',
    });

    if (String(unifiedOrder.return_code || '').toUpperCase() !== 'SUCCESS') {
      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET status = 'FAILED',
             trade_status = $1,
             notify_payload = $2::jsonb,
             updated_at = now()
         WHERE app_id = $3::uuid AND out_trade_no = $4`,
        String(unifiedOrder.return_msg || 'WECHAT_RETURN_FAILED'),
        JSON.stringify(unifiedOrder),
        app.id,
        outTradeNo,
      );
      throw new BadRequestException(`微信下单失败: ${String(unifiedOrder.return_msg || 'unknown')}`);
    }
    if (String(unifiedOrder.result_code || '').toUpperCase() !== 'SUCCESS' || !unifiedOrder.code_url) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET status = 'FAILED',
             trade_status = $1,
             notify_payload = $2::jsonb,
             updated_at = now()
         WHERE app_id = $3::uuid AND out_trade_no = $4`,
        String(unifiedOrder.err_code || unifiedOrder.result_code || 'WECHAT_RESULT_FAILED'),
        JSON.stringify(unifiedOrder),
        app.id,
        outTradeNo,
      );
      throw new BadRequestException(`微信下单失败: ${String(unifiedOrder.err_code_des || unifiedOrder.return_msg || 'unknown')}`);
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE alipay_orders
       SET notify_payload = $1::jsonb, updated_at = now()
       WHERE app_id = $2::uuid AND out_trade_no = $3`,
      JSON.stringify(unifiedOrder),
      app.id,
      outTradeNo,
    );

    return {
      out_trade_no: outTradeNo,
      payment_url: unifiedOrder.code_url,
      code_url: unifiedOrder.code_url,
      amount,
      subject,
      points_topup_points: productTopupPoints,
      points_per_yuan: pointsPerYuan,
      channel: 'wechat_native',
      payment_method_id: paymentMethod.row?.id || null,
    };
  }

  async createCheckoutOrder(
    appSlug: string | undefined,
    userId: string,
    payload: {
      provider_type?: string;
      payment_method_id?: string;
      product_id?: string;
      amount?: number | string;
      subject?: string;
      external_price_id?: string;
      external_variant_id?: string;
    },
  ) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const user = await this.ensureUserInApp(app.id, userId);
    const providerType = this.normalizePaymentProviderType(payload.provider_type);
    if (providerType === 'ALIPAY') {
      return this.createPagePayOrder(app.slug, user.id, payload);
    }
    if (providerType === 'WECHAT') {
      return this.createWechatNativeOrder(app.slug, user.id, {
        product_id: payload.product_id,
        amount: payload.amount,
        description: payload.subject,
      });
    }
    if (!this.isSaasProvider(providerType)) {
      throw new BadRequestException('unsupported provider_type');
    }

    const productId = String(payload?.product_id || '').trim();
    let product: PaymentProductRow | null = null;
    let amount = '0.00';
    let productTopupPoints = 0;
    let subject = String(payload?.subject || '').trim();
    if (productId) {
      product = await this.getResolvableProduct(app.id, productId);
      if (!product) {
        throw new NotFoundException('商品不存在');
      }
      if (product.status !== 'ACTIVE') {
        throw new BadRequestException('商品未上架');
      }
      if (product.type !== 'ONE_TIME') {
        throw new BadRequestException('SaaS checkout 当前仅支持单次支付商品');
      }
      if (this.isSystemPointsTopupProduct(product)) {
        const amountInput = payload?.amount ?? product.amount;
        amount = this.normalizeOrderAmount(amountInput, 'amount');
        const settings = await this.aiPointsService.getSettingsByAppId(app.id);
        productTopupPoints = this.calculateTopupPointsByAmount(amount, this.normalizePointsPerYuan(settings.points_per_yuan));
        subject = DEFAULT_POINTS_TOPUP_SUBJECT;
      } else {
        amount = this.formatAmount(product.amount);
        subject = subject || product.name;
      }
    } else {
      if (payload?.amount === null || payload?.amount === undefined || payload?.amount === '') {
        throw new BadRequestException('product_id or amount is required');
      }
      amount = this.normalizeOrderAmount(payload?.amount, 'amount');
      product = await this.ensureDefaultPointsTopupProduct(app.id);
      const settings = await this.aiPointsService.getSettingsByAppId(app.id);
      productTopupPoints = this.calculateTopupPointsByAmount(amount, this.normalizePointsPerYuan(settings.points_per_yuan));
      subject = subject || DEFAULT_POINTS_TOPUP_SUBJECT;
    }
    if (!product) {
      throw new BadRequestException('创建订单失败：未找到可用商品');
    }

    const paymentMethod = await this.resolvePaymentMethodForApp(app.id, providerType, payload.payment_method_id);
    if (!paymentMethod.row) {
      throw new BadRequestException(`${providerType} 支付方式未配置`);
    }
    const outTradeNo = this.genTradeNo(providerType.slice(0, 3));
    const currency = String(product.currency || (providerType === 'STRIPE' ? 'USD' : 'CNY')).trim().toUpperCase() || 'CNY';
    const appSettings = await this.getAppSettings(app.id);

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO alipay_orders (
         id, app_id, out_trade_no, user_id, product_id, subject, total_amount, points_topup_points,
         status, payment_type, provider_type, payment_method_id, currency, idempotency_key, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5, $6::numeric, $7::bigint,
         'PENDING', $8, $9, $10::uuid, $11, $12, now(), now()
       )`,
      app.id,
      outTradeNo,
      user.id,
      product.id,
      subject,
      amount,
      productTopupPoints,
      `${providerType}_CHECKOUT`,
      providerType,
      paymentMethod.row.id,
      currency,
      `${providerType}:${outTradeNo}`,
    );

    const checkout = await this.createSaasCheckout({
      app,
      appSettings,
      providerType,
      method: paymentMethod,
      outTradeNo,
      amount,
      currency,
      subject,
      user,
      product,
      externalPriceId: String(payload.external_price_id || '').trim(),
      externalVariantId: String(payload.external_variant_id || '').trim(),
    });

    await this.prisma.$executeRawUnsafe(
      `UPDATE alipay_orders
       SET external_object_id = $1,
           checkout_url = $2,
           raw_status = $3,
           notify_payload = $4::jsonb,
           updated_at = now()
       WHERE app_id = $5::uuid AND out_trade_no = $6`,
      checkout.external_object_id || null,
      checkout.checkout_url || null,
      checkout.raw_status || null,
      JSON.stringify(checkout.raw || {}),
      app.id,
      outTradeNo,
    );

    return {
      out_trade_no: outTradeNo,
      checkout_url: checkout.checkout_url,
      external_object_id: checkout.external_object_id,
      amount,
      currency,
      subject,
      channel: providerType.toLowerCase(),
      payment_method_id: paymentMethod.row.id,
    };
  }

  private async createSaasCheckout(input: {
    app: AppRow;
    appSettings: AppSettingRow | null;
    providerType: SaasPaymentProviderType;
    method: ResolvedPaymentMethod;
    outTradeNo: string;
    amount: string;
    currency: string;
    subject: string;
    user: UserRow;
    product: PaymentProductRow;
    externalPriceId?: string;
    externalVariantId?: string;
  }) {
    if (input.providerType === 'STRIPE') {
      return this.createStripeCheckout(input);
    }
    if (input.providerType === 'PADDLE') {
      return this.createPaddleCheckout(input);
    }
    return this.createLemonSqueezyCheckout(input);
  }

  async getOrderStatus(appSlug: string | undefined, actorUserId: string, outTradeNo: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const actor = await this.ensureUserInApp(app.id, actorUserId);

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM alipay_orders
       WHERE app_id = $1::uuid AND out_trade_no = $2
       LIMIT 1`,
      app.id,
      outTradeNo,
    ) as Promise<OrderRow[]>);
    const order = rows[0];
    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    const actorRole = String(actor.role || '').toUpperCase();
    if (actorRole !== 'ADMIN' && order.user_id !== actor.id) {
      throw new ForbiddenException('无权访问该订单');
    }

    const currentStatus = String(order.status || '').toUpperCase();
    if (currentStatus === 'PAID') {
      await this.grantOrderTopupPointsIfNeeded(app, order.id);
    } else if (currentStatus !== 'REFUNDED') {
      const paymentType = String(order.payment_type || '').toUpperCase();
      const providerType = String(order.provider_type || '').toUpperCase();
      if (paymentType.startsWith('WECHAT') || providerType === 'WECHAT') {
        const method = await this.resolvePaymentMethodForOrder(app.id, order, 'WECHAT');
        await this.syncWechatOrderStatus(app.id, order.out_trade_no, this.wechatConfigFromMethod(method));
      } else if (paymentType === 'ONE_TIME' || paymentType.startsWith('ALIPAY') || providerType === 'ALIPAY') {
        const method = await this.resolvePaymentMethodForOrder(app.id, order, 'ALIPAY');
        await this.syncAlipayOrderStatus(app.id, order.out_trade_no, this.alipayConfigFromMethod(method));
      }
    }

    const refreshedRows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM alipay_orders
       WHERE app_id = $1::uuid AND out_trade_no = $2
       LIMIT 1`,
      app.id,
      outTradeNo,
    ) as Promise<OrderRow[]>);
    const refreshed = refreshedRows[0] || order;
    if (String(refreshed.status || '').toUpperCase() === 'PAID') {
      await this.grantOrderTopupPointsIfNeeded(app, refreshed.id);
    }

    return {
      out_trade_no: refreshed.out_trade_no,
      status: String(refreshed.status || 'PENDING').toUpperCase(),
      trade_status: refreshed.trade_status,
      trade_no: refreshed.trade_no,
      paid_at: refreshed.paid_at,
      amount: this.formatAmount(refreshed.total_amount),
      points_topup_points: this.toSafeInteger(refreshed.points_topup_points),
      points_topup_status: String(refreshed.points_topup_status || 'NONE').toUpperCase(),
    };
  }

  async createAgreementSign(
    appSlug: string | undefined,
    userId: string,
    payload: { product_id: string; execute_time?: string },
  ) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const user = await this.ensureUserInApp(app.id, userId);

    const productId = String(payload?.product_id || '').trim();
    if (!productId) {
      throw new BadRequestException('product_id is required');
    }
    const product = await this.getProductById(app.id, productId);
    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    if (product.status !== 'ACTIVE') {
      throw new BadRequestException('商品未上架');
    }
    if (product.type !== 'RECURRING') {
      throw new BadRequestException('该商品不是周期扣款商品');
    }

    const executeTime = this.resolveExecuteTime(payload.execute_time, product.execute_time);
    const externalAgreementNo = this.genTradeNo('AGR');

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO alipay_agreements (
         id, app_id, user_id, product_id, external_agreement_no, status,
         sign_scene, period_type, period, execute_time, sign_validity_period, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, 'PENDING',
         $5, $6, $7, $8, $9, now(), now()
       )
       RETURNING id`,
      app.id,
      user.id,
      product.id,
      externalAgreementNo,
      product.sign_scene || 'INDUSTRY|DIGITAL_MEDIA',
      product.period_type || 'MONTH',
      product.period || 1,
      executeTime,
      product.sign_validity_period || 365,
    ) as Promise<Array<{ id: string }>>);

    const agreementId = rows[0]?.id;
    const appSettings = await this.getAppSettings(app.id);
    if (this.isAlipayConfigured()) {
      const signForm = this.buildAlipayAgreementSignForm({
        appSlug: app.slug,
        appSettings,
        externalAgreementNo,
        executeTime,
        product,
      });
      return {
        agreement_id: agreementId,
        external_agreement_no: externalAgreementNo,
        sign_form: signForm,
        channel: 'alipay',
      };
    }

    return {
      agreement_id: agreementId,
      external_agreement_no: externalAgreementNo,
      sign_form: `https://sandbox.dl.alipaydev.com/gateway.do?external_agreement_no=${encodeURIComponent(externalAgreementNo)}`,
      channel: 'mock',
    };
  }

  async listMyAgreements(appSlug: string | undefined, userId: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureUserInApp(app.id, userId);

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT a.*,
              p.name AS product_name,
              p.amount AS product_amount,
              p.membership_days
       FROM alipay_agreements a
       JOIN payment_products p ON p.id = a.product_id
       WHERE a.app_id = $1::uuid
         AND a.user_id = $2::uuid
       ORDER BY a.created_at DESC`,
      app.id,
      userId,
    ) as Promise<Array<AgreementRow & { product_name: string | null; product_amount: unknown; membership_days: number | null }>>);

    return {
      items: rows.map((row) => ({
        id: row.id,
        external_agreement_no: row.external_agreement_no,
        agreement_no: row.agreement_no,
        status: String(row.status || 'PENDING').toUpperCase(),
        product: {
          id: row.product_id,
          name: row.product_name || '',
          amount: this.formatAmount(row.product_amount),
          membership_days: Number(row.membership_days || 0),
        },
        signed_at: row.signed_at,
        next_deduction_at: row.next_deduction_at,
        last_deducted_at: row.last_deducted_at,
        created_at: row.created_at,
      })),
    };
  }

  async processTradeNotify(
    appSlug: string | undefined,
    payload: Record<string, unknown>,
    options?: { skipSignatureCheck?: boolean },
  ) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const outTradeNo = String(payload?.out_trade_no || '').trim();
    if (!outTradeNo) {
      return { success: false, message: 'missing out_trade_no' };
    }
    const tradeStatus = String(payload?.trade_status || '').trim().toUpperCase();
    const tradeNo = String(payload?.trade_no || '').trim() || null;
    const totalAmountInput = payload?.total_amount;
    const totalAmount = totalAmountInput === undefined ? null : this.tryFormatAmount(totalAmountInput);
    const shouldMarkPaid = tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED';
    const shouldMarkClosed = tradeStatus === 'TRADE_CLOSED';
    const shouldMarkFailed = ['TRADE_FAILED', 'FAILED', 'FAIL'].includes(tradeStatus);

    const orderRows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM alipay_orders
       WHERE app_id = $1::uuid AND out_trade_no = $2
       LIMIT 1`,
      app.id,
      outTradeNo,
    ) as Promise<OrderRow[]>);
    const order = orderRows[0];
    if (!order) {
      return { success: false, message: 'order not found' };
    }

    const paymentMethod = await this.resolvePaymentMethodForOrder(app.id, order, 'ALIPAY');
    const alipayCfg = this.alipayConfigFromMethod(paymentMethod);
    if (!options?.skipSignatureCheck && this.isResolvedAlipayConfigured(alipayCfg)) {
      const verified = this.verifyAlipayNotifySignature(payload, alipayCfg);
      if (!verified) {
        await this.syncAlipayOrderStatus(app.id, outTradeNo, alipayCfg);
        const refreshed = await this.getOrderByOutTradeNo(app.id, outTradeNo);
        if (refreshed && String(refreshed.status || '').toUpperCase() === 'PAID') {
          await this.grantOrderTopupPointsIfNeeded(app, refreshed.id);
          return { success: true, message: 'verified by trade query' };
        }
        return { success: false, message: 'invalid signature' };
      }
    }

    const currentStatus = String(order.status || '').toUpperCase();
    if (currentStatus === 'PAID') {
      await this.grantOrderTopupPointsIfNeeded(app, order.id);
      return { success: true, message: 'already paid' };
    }
    if (currentStatus === 'REFUNDED') {
      await this.refundOrderPointsIfNeeded(app.id, order.id);
      return { success: true, message: 'already finalized' };
    }
    if ((currentStatus === 'FAILED' || currentStatus === 'CLOSED') && !shouldMarkPaid) {
      await this.refundOrderPointsIfNeeded(app.id, order.id);
      return { success: true, message: 'already finalized' };
    }

    if (shouldMarkPaid && totalAmount && totalAmount !== this.formatAmount(order.total_amount)) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET status = 'FAILED', trade_status = $1, trade_no = $2, updated_at = now()
         WHERE id = $3::uuid`,
        tradeStatus || null,
        tradeNo,
        order.id,
      );
      await this.refundOrderPointsIfNeeded(app.id, order.id);
      return { success: false, message: 'amount mismatch' };
    }

    const product = await this.getProductById(app.id, order.product_id);
    let membershipUpdate: MembershipUpdateResult = { updated: false, expiresAt: null };
    let finalStatus: 'PAID' | 'FAILED' | 'CLOSED' | null = null;

    await this.prisma.$transaction(async (tx) => {
      if (shouldMarkPaid) {
        await tx.$executeRawUnsafe(
          `UPDATE alipay_orders
           SET status = 'PAID',
               trade_status = $1,
               trade_no = $2,
               paid_at = now(),
               notify_payload = $3::jsonb,
               updated_at = now()
           WHERE id = $4::uuid`,
          tradeStatus || null,
          tradeNo,
          JSON.stringify(payload || {}),
          order.id,
        );
        finalStatus = 'PAID';
        if (product && Number(product.membership_days || 0) > 0) {
          membershipUpdate = await this.extendMembership(tx, app.id, order.user_id, Number(product.membership_days || 0));
        }
      } else if (shouldMarkClosed) {
        await tx.$executeRawUnsafe(
          `UPDATE alipay_orders
           SET status = 'CLOSED', trade_status = $1, trade_no = $2, notify_payload = $3::jsonb, updated_at = now()
           WHERE id = $4::uuid`,
          tradeStatus || null,
          tradeNo,
          JSON.stringify(payload || {}),
          order.id,
        );
        finalStatus = 'CLOSED';
      } else if (shouldMarkFailed) {
        await tx.$executeRawUnsafe(
          `UPDATE alipay_orders
           SET status = 'FAILED', trade_status = $1, trade_no = $2, notify_payload = $3::jsonb, updated_at = now()
           WHERE id = $4::uuid`,
          tradeStatus || null,
          tradeNo,
          JSON.stringify(payload || {}),
          order.id,
        );
        finalStatus = 'FAILED';
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE alipay_orders
           SET trade_status = $1,
               trade_no = COALESCE($2, trade_no),
               notify_payload = $3::jsonb,
               updated_at = now()
           WHERE id = $4::uuid`,
          tradeStatus || null,
          tradeNo,
          JSON.stringify(payload || {}),
          order.id,
        );
        finalStatus = null;
      }
    });

    if (membershipUpdate.updated && product && Number(product.membership_days || 0) > 0) {
      await this.pushMembershipNotification(app, order.user_id, {
        channel: 'alipay_trade_notify',
        productName: product.name,
        membershipDays: Number(product.membership_days || 0),
        expiresAt: membershipUpdate.expiresAt,
      });
    }
    if (shouldMarkPaid) {
      await this.grantRedeemPackageForOrderIfNeeded(app, order, product);
      await this.grantOrderTopupPointsIfNeeded(app, order.id);
    }
    if (finalStatus === 'FAILED' || finalStatus === 'CLOSED') {
      await this.refundOrderPointsIfNeeded(app.id, order.id);
    }

    return { success: true };
  }

  async processTradeReturn(appSlug: string | undefined, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const appSettings = await this.getAppSettings(app.id);
    const outTradeNo = String(payload?.out_trade_no || '').trim();

    if (outTradeNo) {
      await this.syncAlipayOrderStatus(app.id, outTradeNo);
      await this.grantOrderTopupPointsByTradeNoIfNeeded(app, outTradeNo);
    } else if (payload && Object.keys(payload).length > 0) {
      await this.processTradeNotify(app.slug, payload, { skipSignatureCheck: true });
    }

    let orderStatus = 'PENDING';
    if (outTradeNo) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT status
         FROM alipay_orders
         WHERE app_id = $1::uuid AND out_trade_no = $2
         LIMIT 1`,
        app.id,
        outTradeNo,
      ) as Promise<Array<{ status: string | null }>>);
      orderStatus = String(rows[0]?.status || '').trim().toUpperCase() || 'PENDING';
    }

    const returnMode = this.resolveTradeReturnMode(appSettings);
    const redirectBase = this.resolveUserWebBaseUrl(app.slug, appSettings);
    const params = new URLSearchParams();
    if (outTradeNo) {
      params.set('out_trade_no', outTradeNo);
    }
    if (payload?.trade_no) {
      params.set('trade_no', String(payload.trade_no));
    }
    params.set('order_status', orderStatus.toLowerCase());
    const suffix = params.toString();
    const redirectUrl = `${redirectBase}/payment/success${suffix ? `?${suffix}` : ''}`;
    return {
      return_mode: returnMode,
      redirect_url: returnMode === 'redirect' ? redirectUrl : '',
      out_trade_no: outTradeNo,
      order_status: orderStatus,
      trade_no: payload?.trade_no ? String(payload.trade_no) : '',
    };
  }

  async processAgreementNotify(appSlug: string | undefined, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    if (this.isAlipayConfigured()) {
      const verified = this.verifyAlipayNotifySignature(payload);
      if (!verified) {
        return { success: false, message: 'invalid signature' };
      }
    }

    const externalAgreementNo = String(payload?.external_agreement_no || '').trim();
    if (!externalAgreementNo) {
      return { success: false, message: 'missing external_agreement_no' };
    }
    const agreementNo = String(payload?.agreement_no || '').trim() || null;
    const statusInput = String(payload?.status || payload?.agreement_status || '')
      .trim()
      .toUpperCase();

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM alipay_agreements
       WHERE app_id = $1::uuid AND external_agreement_no = $2
       LIMIT 1`,
      app.id,
      externalAgreementNo,
    ) as Promise<AgreementRow[]>);
    const agreement = rows[0];
    if (!agreement) {
      return { success: false, message: 'agreement not found' };
    }

    const mappedStatus: AgreementStatus =
      statusInput === 'VALID' || statusInput === 'NORMAL' || statusInput === 'SUCCESS' || statusInput === 'SIGNED'
        ? 'VALID'
        : statusInput === 'UNSIGNED' || statusInput === 'UNSIGN' || statusInput === 'STOP' || statusInput === 'CLOSED'
          ? 'UNSIGNED'
          : 'INVALID';

    if (mappedStatus === 'VALID') {
      const firstDue = this.parseExecuteTime(agreement.execute_time);
      const nextDue = this.rollForwardDueDate(firstDue, agreement.period_type, agreement.period);
      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_agreements
         SET status = 'VALID',
             agreement_no = COALESCE($1, agreement_no),
             notify_payload = $2::jsonb,
             signed_at = COALESCE(signed_at, now()),
             next_deduction_at = $3::timestamptz,
             updated_at = now()
         WHERE id = $4::uuid`,
        agreementNo,
        JSON.stringify(payload || {}),
        nextDue.toISOString(),
        agreement.id,
      );
    } else if (mappedStatus === 'UNSIGNED') {
      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_agreements
         SET status = 'UNSIGNED',
             agreement_no = COALESCE($1, agreement_no),
             notify_payload = $2::jsonb,
             invalid_at = now(),
             next_deduction_at = NULL,
             updated_at = now()
         WHERE id = $3::uuid`,
        agreementNo,
        JSON.stringify(payload || {}),
        agreement.id,
      );
    } else {
      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_agreements
         SET status = 'INVALID',
             agreement_no = COALESCE($1, agreement_no),
             notify_payload = $2::jsonb,
             invalid_at = now(),
             next_deduction_at = NULL,
             updated_at = now()
         WHERE id = $3::uuid`,
        agreementNo,
        JSON.stringify(payload || {}),
        agreement.id,
      );
    }

    return { success: true };
  }

  async processWechatNotify(appSlug: string | undefined, payloadRaw: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    if (!this.isWechatPayConfigured()) {
      return { success: false, message: 'wechat pay is not configured' };
    }

    const payload = this.parseWechatXml(payloadRaw || '');
    if (!payload || Object.keys(payload).length === 0) {
      return { success: false, message: 'invalid xml payload' };
    }
    const returnCode = String(payload.return_code || '').toUpperCase();
    const resultCode = String(payload.result_code || '').toUpperCase();
    if (returnCode !== 'SUCCESS' || resultCode !== 'SUCCESS') {
      return { success: false, message: String(payload.return_msg || payload.err_code_des || 'wechat notify failed') };
    }

    const outTradeNo = String(payload.out_trade_no || '').trim();
    if (!outTradeNo) {
      return { success: false, message: 'missing out_trade_no' };
    }

    const orderRows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM alipay_orders
       WHERE app_id = $1::uuid AND out_trade_no = $2
       LIMIT 1`,
      app.id,
      outTradeNo,
    ) as Promise<OrderRow[]>);
    const order = orderRows[0];
    if (!order) {
      return { success: false, message: 'order not found' };
    }
    const paymentMethod = await this.resolvePaymentMethodForOrder(app.id, order, 'WECHAT');
    const wechatCfg = this.wechatConfigFromMethod(paymentMethod);
    if (!this.verifyWechatSign(payload, wechatCfg.apiKey)) {
      return { success: false, message: 'invalid sign' };
    }

    if (String(order.status || '').toUpperCase() === 'PAID') {
      await this.grantOrderTopupPointsIfNeeded(app, order.id);
      return { success: true, message: 'already paid' };
    }

    const totalFee = Number(payload.total_fee || 0);
    if (!Number.isFinite(totalFee) || totalFee <= 0) {
      return { success: false, message: 'invalid total_fee' };
    }
    if (this.amountToFen(this.formatAmount(order.total_amount)) !== Math.floor(totalFee)) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET status = 'FAILED',
             trade_status = 'AMOUNT_MISMATCH',
             notify_payload = $1::jsonb,
             updated_at = now()
         WHERE id = $2::uuid`,
        JSON.stringify(payload),
        order.id,
      );
      return { success: false, message: 'amount mismatch' };
    }

    const product = await this.getProductById(app.id, order.product_id);
    let membershipUpdate: MembershipUpdateResult = { updated: false, expiresAt: null };
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET status = 'PAID',
             trade_no = $1,
             trade_status = 'SUCCESS',
             payment_type = 'WECHAT_NATIVE',
             paid_at = now(),
             notify_payload = $2::jsonb,
             updated_at = now()
         WHERE id = $3::uuid`,
        String(payload.transaction_id || ''),
        JSON.stringify(payload),
        order.id,
      );
      if (product && Number(product.membership_days || 0) > 0) {
        membershipUpdate = await this.extendMembership(tx, app.id, order.user_id, Number(product.membership_days || 0));
      }
    });

    if (membershipUpdate.updated && product && Number(product.membership_days || 0) > 0) {
      await this.pushMembershipNotification(app, order.user_id, {
        channel: 'wechat_trade_notify',
        productName: product.name,
        membershipDays: Number(product.membership_days || 0),
        expiresAt: membershipUpdate.expiresAt,
      });
    }
    await this.grantOrderTopupPointsIfNeeded(app, order.id);
    return { success: true, message: 'ok' };
  }

  async processSaasWebhook(
    appSlug: string | undefined,
    providerTypeRaw: string,
    methodId: string,
    payload: Record<string, any>,
    rawBody: Buffer | string | undefined,
    headers: Record<string, any>,
  ) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    const providerType = this.normalizePaymentProviderType(providerTypeRaw);
    if (!this.isSaasProvider(providerType)) {
      return { success: false, message: 'unsupported provider' };
    }
    const paymentMethod = await this.resolvePaymentMethodById(providerType, methodId);
    if (!paymentMethod.row) {
      return { success: false, message: 'payment method not found' };
    }
    const rawText = Buffer.isBuffer(rawBody)
      ? rawBody.toString('utf8')
      : typeof rawBody === 'string'
        ? rawBody
        : JSON.stringify(payload || {});
    if (!this.verifySaasWebhook(providerType, paymentMethod.config, rawText, headers)) {
      return { success: false, message: 'invalid signature' };
    }

    const event = this.extractSaasPaymentEvent(providerType, payload);
    if (!event.outTradeNo && !event.externalObjectId) {
      return { success: true, message: 'ignored' };
    }
    const orderRows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM alipay_orders
       WHERE app_id = $1::uuid
         AND provider_type = $2
         AND (
           ($3::text IS NOT NULL AND out_trade_no = $3)
           OR ($4::text IS NOT NULL AND external_object_id = $4)
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      app.id,
      providerType,
      event.outTradeNo || null,
      event.externalObjectId || null,
    ) as Promise<OrderRow[]>);
    const order = orderRows[0];
    if (!order) {
      return { success: false, message: 'order not found' };
    }

    if (event.status === 'PAID') {
      const totalAmount = event.amount === null ? null : this.fenToAmount(event.amount);
      if (totalAmount && totalAmount !== this.formatAmount(order.total_amount)) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE alipay_orders
           SET status = 'FAILED',
               trade_status = 'AMOUNT_MISMATCH',
               raw_status = $1,
               notify_payload = $2::jsonb,
               updated_at = now()
           WHERE id = $3::uuid`,
          event.rawStatus || null,
          JSON.stringify(payload || {}),
          order.id,
        );
        await this.refundOrderPointsIfNeeded(app.id, order.id);
        return { success: false, message: 'amount mismatch' };
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE alipay_orders
           SET status = 'PAID',
               trade_status = $1,
               trade_no = COALESCE($2, trade_no),
               external_object_id = COALESCE($3, external_object_id),
               external_customer_id = COALESCE($4, external_customer_id),
               external_subscription_id = COALESCE($5, external_subscription_id),
               raw_status = $6,
               notify_payload = $7::jsonb,
               paid_at = COALESCE(paid_at, now()),
               updated_at = now()
           WHERE id = $8::uuid`,
          event.rawStatus || 'PAID',
          event.transactionId || null,
          event.externalObjectId || null,
          event.customerId || null,
          event.subscriptionId || null,
          event.rawStatus || null,
          JSON.stringify(payload || {}),
          order.id,
        );
        const product = await this.getProductById(app.id, order.product_id);
        if (product && Number(product.membership_days || 0) > 0) {
          await this.extendMembership(tx, app.id, order.user_id, Number(product.membership_days || 0));
        }
      });
      await this.grantOrderTopupPointsIfNeeded(app, order.id);
      return { success: true, message: 'ok' };
    }

    if (event.status === 'FAILED' || event.status === 'CLOSED') {
      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET status = $1,
             trade_status = $2,
             raw_status = $2,
             notify_payload = $3::jsonb,
             updated_at = now()
         WHERE id = $4::uuid
           AND status <> 'PAID'`,
        event.status,
        event.rawStatus || event.status,
        JSON.stringify(payload || {}),
        order.id,
      );
      await this.refundOrderPointsIfNeeded(app.id, order.id);
    }
    return { success: true, message: 'ignored' };
  }

  async adminListProducts(appSlug: string | undefined, actorUserId: string) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    await this.ensureDefaultPointsTopupProduct(app.id);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM payment_products
       WHERE app_id = $1::uuid
       ORDER BY created_at DESC`,
      app.id,
    ) as Promise<PaymentProductRow[]>);
    return {
      items: rows.map((row) => this.serializeProduct(row)),
    };
  }

  async adminCreateProduct(appSlug: string | undefined, actorUserId: string, payload: Record<string, unknown>) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    const data = this.normalizeProductPayload(payload, true);

    try {
      const rows = await (this.prisma.$queryRawUnsafe(
        `INSERT INTO payment_products (
           id, app_id, code, name, description, type, status, amount, currency,
           membership_days, points_topup, sign_scene, sign_validity_period, period_type, period, execute_time, created_at, updated_at
         )
         VALUES (
           gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7::numeric, 'CNY',
           $8, $9, $10, $11, $12, $13, $14, now(), now()
         )
         RETURNING id`,
        app.id,
        data.code,
        data.name,
        data.description,
        data.type,
        data.status,
        data.amount,
        data.membership_days,
        data.points_topup,
        data.sign_scene,
        data.sign_validity_period,
        data.period_type,
        data.period,
        data.execute_time,
      ) as Promise<Array<{ id: string }>>);
      return {
        id: rows[0]?.id || null,
      };
    } catch (error: any) {
      if (String(error?.code || '') === '23505') {
        throw new BadRequestException('商品编码已存在');
      }
      throw error;
    }
  }

  async adminUpdateProduct(
    appSlug: string | undefined,
    actorUserId: string,
    productId: string,
    payload: Record<string, unknown>,
  ) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    const existing = await this.getProductById(app.id, productId);
    if (!existing) {
      throw new NotFoundException('商品不存在');
    }
    if (this.isSystemPointsTopupProduct(existing)) {
      throw new BadRequestException('系统积分商品为固定商品，不允许手动修改');
    }

    const data = this.normalizeProductPayload(payload, false, existing);

    await this.prisma.$executeRawUnsafe(
      `UPDATE payment_products
       SET name = $1,
           description = $2,
           status = $3,
           amount = $4::numeric,
           membership_days = $5,
           points_topup = $6,
           sign_scene = $7,
           sign_validity_period = $8,
           period_type = $9,
           period = $10,
           execute_time = $11,
           updated_at = now()
       WHERE app_id = $12::uuid AND id = $13::uuid`,
      data.name,
      data.description,
      data.status,
      data.amount,
      data.membership_days,
      data.points_topup,
      data.sign_scene,
      data.sign_validity_period,
      data.period_type,
      data.period,
      data.execute_time,
      app.id,
      productId,
    );

    return { message: '商品更新成功' };
  }

  async adminDeleteProduct(appSlug: string | undefined, actorUserId: string, productId: string) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    const existing = await this.getProductById(app.id, productId);
    if (!existing) {
      throw new NotFoundException('商品不存在');
    }
    if (this.isSystemPointsTopupProduct(existing)) {
      throw new BadRequestException('系统积分商品为固定商品，不允许删除');
    }

    const [orderCountRows, agreementCountRows, deductionCountRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count
         FROM alipay_orders
         WHERE app_id = $1::uuid AND product_id = $2::uuid`,
        app.id,
        productId,
      ) as Promise<Array<{ count: bigint }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count
         FROM alipay_agreements
         WHERE app_id = $1::uuid AND product_id = $2::uuid`,
        app.id,
        productId,
      ) as Promise<Array<{ count: bigint }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count
         FROM alipay_deductions
         WHERE app_id = $1::uuid AND product_id = $2::uuid`,
        app.id,
        productId,
      ) as Promise<Array<{ count: bigint }>>),
    ]);

    const relatedCount =
      Number(orderCountRows[0]?.count || 0) +
      Number(agreementCountRows[0]?.count || 0) +
      Number(deductionCountRows[0]?.count || 0);
    if (relatedCount > 0) {
      throw new BadRequestException('商品存在交易数据，不能删除，请改为下架');
    }

    await this.prisma.$executeRawUnsafe(
      `DELETE FROM payment_products
       WHERE app_id = $1::uuid AND id = $2::uuid`,
      app.id,
      productId,
    );

    return { message: '商品删除成功' };
  }

  async adminListOrders(
    appSlug: string | undefined,
    actorUserId: string,
    page = 1,
    pageSize = 20,
    status?: string,
  ) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    const normalizedStatus = this.normalizeOptionalStatus<OrderStatus>(status, [
      'PENDING',
      'PAID',
      'FAILED',
      'CLOSED',
      'REFUNDED',
    ]);
    const safePage = Math.max(Number(page || 1), 1);
    const safePageSize = Math.min(Math.max(Number(pageSize || 20), 1), 200);
    const offset = (safePage - 1) * safePageSize;

    const totalRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count
       FROM alipay_orders
       WHERE app_id = $1::uuid
         AND ($2::text IS NULL OR UPPER(status) = $2::text)`,
      app.id,
      normalizedStatus,
    ) as Promise<Array<{ count: bigint }>>);

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT o.*,
              COALESCE(r.refunded_amount_total, 0)::numeric AS refunded_amount_total,
              COALESCE(r.refund_count, 0)::bigint AS refund_count,
              r.refunded_at
       FROM alipay_orders o
       LEFT JOIN (
         SELECT order_id,
                COALESCE(SUM(refund_amount), 0)::numeric AS refunded_amount_total,
                COUNT(*)::bigint AS refund_count,
                MAX(created_at) AS refunded_at
         FROM alipay_refunds
         WHERE app_id = $1::uuid
           AND UPPER(status) = 'SUCCESS'
         GROUP BY order_id
       ) r ON r.order_id = o.id
       WHERE o.app_id = $1::uuid
         AND ($2::text IS NULL OR UPPER(o.status) = $2::text)
       ORDER BY o.created_at DESC
       LIMIT $3 OFFSET $4`,
      app.id,
      normalizedStatus,
      safePageSize,
      offset,
    ) as Promise<OrderWithRefundStatsRow[]>);

    return {
      total: Number(totalRows[0]?.count || 0),
      page: safePage,
      page_size: safePageSize,
      items: rows.map((row) => ({
        id: row.id,
        out_trade_no: row.out_trade_no,
        user_id: row.user_id,
        product_id: row.product_id,
        subject: row.subject,
        amount: this.formatAmount(row.total_amount),
        status: String(row.status || '').toUpperCase(),
        trade_status: row.trade_status,
        trade_no: row.trade_no,
        payment_type: row.payment_type,
        paid_at: row.paid_at,
        created_at: row.created_at,
        refunded_amount: this.formatAmount(row.refunded_amount_total),
        refund_count: Number(row.refund_count || 0),
        refunded_at: row.refunded_at,
        points_topup_points: this.toSafeInteger(row.points_topup_points),
        points_topup_status: String(row.points_topup_status || 'NONE').toUpperCase(),
      })),
    };
  }

  async adminDashboardMetrics(appSlug: string | undefined, actorUserId: string, range?: string) {
    await this.ensureSchema();
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    const { rangeKey, from, to, bucketCount, labelMode } = this.resolveDashboardRange(range);

    const [orderAggRows, refundAggRows, trendRows, behaviorTableExists] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT
           COALESCE(SUM(CASE WHEN UPPER(status) IN ('PAID', 'REFUNDED') THEN total_amount ELSE 0 END), 0)::numeric AS gross_amount,
           SUM(CASE WHEN UPPER(status) IN ('PAID', 'REFUNDED') THEN 1 ELSE 0 END)::bigint AS paid_order_count,
           COUNT(DISTINCT CASE WHEN UPPER(status) IN ('PAID', 'REFUNDED') THEN user_id ELSE NULL END)::bigint AS paid_buyer_count,
           COUNT(*)::bigint AS total_order_count
         FROM alipay_orders
         WHERE app_id = $1::uuid
           AND COALESCE(paid_at, created_at) >= $2::timestamptz
           AND COALESCE(paid_at, created_at) <= $3::timestamptz`,
        app.id,
        from,
        to,
      ) as Promise<DashboardOrderAggRow[]>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           COALESCE(SUM(refund_amount), 0)::numeric AS refund_amount
         FROM alipay_refunds
         WHERE app_id = $1::uuid
           AND UPPER(status) = 'SUCCESS'
           AND COALESCE(gmt_refund_pay, created_at) >= $2::timestamptz
           AND COALESCE(gmt_refund_pay, created_at) <= $3::timestamptz`,
        app.id,
        from,
        to,
      ) as Promise<DashboardRefundAggRow[]>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           COALESCE(paid_at, created_at) AS ts,
           total_amount AS amount
         FROM alipay_orders
         WHERE app_id = $1::uuid
           AND UPPER(status) IN ('PAID', 'REFUNDED')
           AND COALESCE(paid_at, created_at) >= $2::timestamptz
           AND COALESCE(paid_at, created_at) <= $3::timestamptz
         ORDER BY COALESCE(paid_at, created_at) ASC`,
        app.id,
        from,
        to,
      ) as Promise<DashboardTrendOrderRow[]>),
      this.tableExists('user_behavior_events'),
    ]);

    let productPageViews = 0;
    if (behaviorTableExists) {
      const behaviorRows = await (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS product_page_views
         FROM user_behavior_events
         WHERE app_id = $1::uuid
           AND occurred_at >= $2::timestamptz
           AND occurred_at <= $3::timestamptz
           AND event_name IN ('payment_page_open', 'product_payment_page_open')`,
        app.id,
        from,
        to,
      ) as Promise<DashboardBehaviorAggRow[]>);
      productPageViews = Number(behaviorRows[0]?.product_page_views || 0);
    }

    const orderAgg = orderAggRows[0] || {
      gross_amount: 0,
      paid_order_count: 0,
      paid_buyer_count: 0,
      total_order_count: 0,
    };
    const refundAgg = refundAggRows[0] || {
      refund_amount: 0,
    };
    const trend = this.buildDashboardTrend(trendRows, from, to, bucketCount, labelMode);

    return {
      range: rangeKey,
      from: from.toISOString(),
      to: to.toISOString(),
      captured_at: new Date().toISOString(),
      gross_amount: this.formatAmount(orderAgg.gross_amount),
      paid_order_count: Number(orderAgg.paid_order_count || 0),
      total_order_count: Number(orderAgg.total_order_count || 0),
      product_page_views: productPageViews,
      refund_amount: this.formatAmount(refundAgg.refund_amount),
      paid_buyer_count: Number(orderAgg.paid_buyer_count || 0),
      trend,
    };
  }

  async adminRefundOrder(
    appSlug: string | undefined,
    actorUserId: string,
    orderId: string,
    payload: { amount?: string; reason?: string },
  ) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    const normalizedOrderId = String(orderId || '').trim();
    if (!normalizedOrderId) {
      throw new BadRequestException('order_id is required');
    }

    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM alipay_orders
       WHERE app_id = $1::uuid AND id = $2::uuid
       LIMIT 1`,
      app.id,
      normalizedOrderId,
    ) as Promise<OrderRow[]>);
    const order = rows[0];
    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    const paymentType = String(order.payment_type || '').toUpperCase();
    if (paymentType.startsWith('WECHAT')) {
      throw new BadRequestException('当前仅支持支付宝订单退款');
    }
    if (!order.out_trade_no) {
      throw new BadRequestException('订单缺少 out_trade_no，无法退款');
    }

    const orderStatus = String(order.status || '').toUpperCase();
    if (orderStatus === 'PENDING' || orderStatus === 'FAILED' || orderStatus === 'CLOSED') {
      throw new BadRequestException(`当前订单状态不支持退款: ${orderStatus || '-'}`);
    }
    if (orderStatus === 'REFUNDED') {
      throw new BadRequestException('订单已全额退款');
    }
    if (orderStatus !== 'PAID') {
      throw new BadRequestException(`仅已支付订单可退款，当前状态: ${orderStatus || '-'}`);
    }

    const paidAmount = Number(this.formatAmount(order.total_amount));
    const refundedRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(refund_amount), 0)::numeric AS amount
       FROM alipay_refunds
       WHERE app_id = $1::uuid
         AND order_id = $2::uuid
         AND UPPER(status) = 'SUCCESS'`,
      app.id,
      order.id,
    ) as Promise<Array<{ amount: unknown }>>);
    const refundedAmount = Number(this.formatAmount(refundedRows[0]?.amount || 0));
    const refundableAmount = Number(Math.max(paidAmount - refundedAmount, 0).toFixed(2));
    if (refundableAmount <= 0) {
      throw new BadRequestException('订单已无可退金额');
    }

    const requestedAmount = payload?.amount
      ? Number(this.normalizeAmount(payload.amount, 'amount'))
      : refundableAmount;
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new BadRequestException('退款金额必须大于 0');
    }
    if (requestedAmount - refundableAmount > 0.0001) {
      throw new BadRequestException(`退款金额不能超过可退金额：${refundableAmount.toFixed(2)}`);
    }
    const refundAmount = requestedAmount.toFixed(2);
    const refundReason = String(payload?.reason || '').trim().slice(0, 128) || '管理员发起退款';
    const outRequestNo = this.genTradeNo('RFD');

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO alipay_refunds (
         id, app_id, order_id, out_trade_no, out_request_no, refund_amount, refund_reason, status, created_by_user_id, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::numeric, $6, 'PENDING', $7::uuid, now(), now()
       )`,
      app.id,
      order.id,
      order.out_trade_no,
      outRequestNo,
      refundAmount,
      refundReason,
      actorUserId,
    );

    let responsePayload: Record<string, unknown> = {};
    let refundFee = refundAmount;
    let refundNo: string | null = null;
    let refundPaidAt: Date | null = null;
    try {
      this.assertAlipayRealGatewayReady();
      const response = await this.alipayExecuteRequest('alipay.trade.refund', {
        out_trade_no: order.out_trade_no,
        trade_no: order.trade_no || undefined,
        refund_amount: refundAmount,
        refund_reason: refundReason,
        out_request_no: outRequestNo,
      });
      const code = String(response.content.code || '');
      if (code !== '10000') {
        const message = String(response.content.sub_msg || response.content.msg || 'unknown');
        await this.prisma.$executeRawUnsafe(
          `UPDATE alipay_refunds
           SET status = 'FAILED',
               response_payload = $1::jsonb,
               updated_at = now()
           WHERE app_id = $2::uuid AND out_request_no = $3`,
          JSON.stringify(response.raw),
          app.id,
          outRequestNo,
        );
        throw new BadRequestException(`支付宝退款失败: ${message}`);
      }

      responsePayload = response.raw;
      refundFee = this.formatAmount(response.content.refund_fee || refundAmount);
      refundNo = String(response.content.trade_no || '').trim() || null;
      const gmtRefundRaw = String(response.content.gmt_refund_pay || '').trim();
      if (gmtRefundRaw) {
        const parsed = new Date(gmtRefundRaw.replace(' ', 'T'));
        if (Number.isFinite(parsed.getTime())) {
          refundPaidAt = parsed;
        }
      }

      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_refunds
         SET status = 'SUCCESS',
             refund_fee = $1::numeric,
             refund_no = $2,
             gmt_refund_pay = $3::timestamptz,
             response_payload = $4::jsonb,
             updated_at = now()
         WHERE app_id = $5::uuid AND out_request_no = $6`,
        refundFee,
        refundNo,
        refundPaidAt ? refundPaidAt.toISOString() : null,
        JSON.stringify(responsePayload),
        app.id,
        outRequestNo,
      );
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_refunds
         SET status = 'FAILED',
             response_payload = $1::jsonb,
             updated_at = now()
         WHERE app_id = $2::uuid AND out_request_no = $3`,
        JSON.stringify({ error: String(error?.message || 'unknown error') }),
        app.id,
        outRequestNo,
      );
      throw new BadRequestException(`退款请求失败: ${String(error?.message || 'unknown error')}`);
    }

    const afterRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(refund_amount), 0)::numeric AS amount, COUNT(*)::bigint AS count
       FROM alipay_refunds
       WHERE app_id = $1::uuid
         AND order_id = $2::uuid
         AND UPPER(status) = 'SUCCESS'`,
      app.id,
      order.id,
    ) as Promise<Array<{ amount: unknown; count: bigint }>>);
    const refundedTotalAfter = Number(this.formatAmount(afterRows[0]?.amount || 0));
    const refundCountAfter = Number(afterRows[0]?.count || 0);
    const fullyRefunded = refundedTotalAfter >= paidAmount - 0.0001;

    await this.prisma.$executeRawUnsafe(
      `UPDATE alipay_orders
       SET status = $1,
           trade_status = $2,
           updated_at = now()
       WHERE app_id = $3::uuid AND id = $4::uuid`,
      fullyRefunded ? 'REFUNDED' : 'PAID',
      fullyRefunded ? 'TRADE_REFUND_SUCCESS' : 'TRADE_PARTIAL_REFUND',
      app.id,
      order.id,
    );

    return {
      order_id: order.id,
      out_trade_no: order.out_trade_no,
      out_request_no: outRequestNo,
      refund_amount: refundAmount,
      refunded_amount_total: refundedTotalAfter.toFixed(2),
      refund_count: refundCountAfter,
      order_amount: paidAmount.toFixed(2),
      status: fullyRefunded ? 'REFUNDED' : 'PARTIAL_REFUNDED',
      response: responsePayload,
    };
  }

  async adminListAgreements(
    appSlug: string | undefined,
    actorUserId: string,
    page = 1,
    pageSize = 20,
    status?: string,
  ) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    const normalizedStatus = this.normalizeOptionalStatus<AgreementStatus>(status, [
      'PENDING',
      'VALID',
      'INVALID',
      'UNSIGNED',
    ]);
    const safePage = Math.max(Number(page || 1), 1);
    const safePageSize = Math.min(Math.max(Number(pageSize || 20), 1), 200);
    const offset = (safePage - 1) * safePageSize;

    const totalRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count
       FROM alipay_agreements
       WHERE app_id = $1::uuid
         AND ($2::text IS NULL OR UPPER(status) = $2::text)`,
      app.id,
      normalizedStatus,
    ) as Promise<Array<{ count: bigint }>>);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM alipay_agreements
       WHERE app_id = $1::uuid
         AND ($2::text IS NULL OR UPPER(status) = $2::text)
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      app.id,
      normalizedStatus,
      safePageSize,
      offset,
    ) as Promise<AgreementRow[]>);

    return {
      total: Number(totalRows[0]?.count || 0),
      page: safePage,
      page_size: safePageSize,
      items: rows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        product_id: row.product_id,
        external_agreement_no: row.external_agreement_no,
        agreement_no: row.agreement_no,
        status: String(row.status || '').toUpperCase(),
        sign_scene: row.sign_scene,
        period_type: row.period_type,
        period: row.period,
        execute_time: row.execute_time,
        signed_at: row.signed_at,
        next_deduction_at: row.next_deduction_at,
        last_deducted_at: row.last_deducted_at,
        created_at: row.created_at,
      })),
    };
  }

  async adminListDeductions(appSlug: string | undefined, actorUserId: string, page = 1, pageSize = 20) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    const safePage = Math.max(Number(page || 1), 1);
    const safePageSize = Math.min(Math.max(Number(pageSize || 20), 1), 200);
    const offset = (safePage - 1) * safePageSize;

    const totalRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count
       FROM alipay_deductions
       WHERE app_id = $1::uuid`,
      app.id,
    ) as Promise<Array<{ count: bigint }>>);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM alipay_deductions
       WHERE app_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      app.id,
      safePageSize,
      offset,
    ) as Promise<DeductionRow[]>);

    return {
      total: Number(totalRows[0]?.count || 0),
      page: safePage,
      page_size: safePageSize,
      items: rows.map((row) => ({
        id: row.id,
        agreement_id: row.agreement_id,
        user_id: row.user_id,
        product_id: row.product_id,
        out_trade_no: row.out_trade_no,
        amount: this.formatAmount(row.amount),
        status: String(row.status || '').toUpperCase(),
        trade_status: row.trade_status,
        trade_no: row.trade_no,
        executed_at: row.executed_at,
        created_at: row.created_at,
      })),
    };
  }

  async adminRunOneTimeTest(
    appSlug: string | undefined,
    actorUserId: string,
    payload: { one_time_product_id: string; user_id?: string },
  ) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    this.assertAdminTestAllowed();
    this.assertAlipayRealGatewayReady();

    const targetUser = await this.resolveTargetUser(app.id, actorUserId, payload.user_id);
    const product = await this.getRequiredActiveProduct(app.id, payload.one_time_product_id, 'ONE_TIME');
    const created = await this.createPagePayOrder(app.slug, targetUser.id, {
      product_id: product.id,
      subject: `${product.name}-真实支付测试`,
    });

    return {
      user_id: targetUser.id,
      one_time_order: {
        out_trade_no: created.out_trade_no,
        status: 'PENDING',
        trade_status: null,
        amount: created.amount,
        subject: created.subject,
        channel: created.channel,
        payment_form: created.payment_form,
      },
    };
  }

  async adminRunWechatOneTimeTest(
    appSlug: string | undefined,
    actorUserId: string,
    payload: { one_time_product_id: string; user_id?: string },
  ) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    this.assertAdminTestAllowed();
    this.assertWechatRealGatewayReady();

    const targetUser = await this.resolveTargetUser(app.id, actorUserId, payload.user_id);
    const created = await this.createWechatNativeOrder(app.slug, targetUser.id, {
      product_id: payload.one_time_product_id,
      description: '微信真实支付测试订单',
      client_ip: '127.0.0.1',
    });
    return {
      user_id: targetUser.id,
      order: {
        out_trade_no: created.out_trade_no,
        status: 'PENDING',
        trade_status: null,
        trade_no: null,
        payment_type: 'WECHAT_NATIVE',
        code_url: created.code_url,
        payment_url: created.payment_url,
        channel: created.channel,
      },
    };
  }

  async adminRunRecurringTest(
    appSlug: string | undefined,
    actorUserId: string,
    payload: {
      recurring_product_id: string;
      user_id?: string;
      execute_time?: string;
    },
  ) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    this.assertAdminTestAllowed();
    this.assertAlipayRealGatewayReady();

    const targetUser = await this.resolveTargetUser(app.id, actorUserId, payload.user_id);
    const product = await this.getRequiredActiveProduct(app.id, payload.recurring_product_id, 'RECURRING');
    const executeTime = this.resolveExecuteTime(payload.execute_time, product.execute_time);
    const created = await this.createAgreementSign(app.slug, targetUser.id, {
      product_id: product.id,
      execute_time: executeTime,
    });

    return {
      user_id: targetUser.id,
      agreement: {
        id: created.agreement_id,
        external_agreement_no: created.external_agreement_no,
        status: 'PENDING',
        execute_time: executeTime,
        channel: created.channel,
        sign_form: created.sign_form,
      },
      tips: '请在支付宝签约页面完成签约。签约成功后可在“支付运营动作”里执行真实扣款。',
    };
  }

  async adminRunFullFlowTest(
    appSlug: string | undefined,
    actorUserId: string,
    payload: {
      one_time_product_id: string;
      recurring_product_id: string;
      user_id?: string;
    },
  ) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    this.assertAdminTestAllowed();
    this.assertAlipayRealGatewayReady();

    const targetUser = await this.resolveTargetUser(app.id, actorUserId, payload.user_id);
    const oneTimeProduct = await this.getRequiredActiveProduct(app.id, payload.one_time_product_id, 'ONE_TIME');
    const recurringProduct = await this.getRequiredActiveProduct(app.id, payload.recurring_product_id, 'RECURRING');
    const oneTime = await this.createPagePayOrder(app.slug, targetUser.id, {
      product_id: oneTimeProduct.id,
      subject: `${oneTimeProduct.name}-真实支付测试`,
    });
    const recurring = await this.createAgreementSign(app.slug, targetUser.id, {
      product_id: recurringProduct.id,
      execute_time: this.resolveExecuteTime(undefined, recurringProduct.execute_time),
    });

    return {
      user_id: targetUser.id,
      one_time_order: {
        out_trade_no: oneTime.out_trade_no,
        status: 'PENDING',
        trade_status: null,
        payment_form: oneTime.payment_form,
        channel: oneTime.channel,
      },
      agreement: {
        id: recurring.agreement_id,
        external_agreement_no: recurring.external_agreement_no,
        status: 'PENDING',
        sign_form: recurring.sign_form,
        channel: recurring.channel,
      },
      tips: '请先完成单次支付与签约，再使用“执行扣款”验证周期代扣。',
    };
  }

  async platformListProductsForApp(actorUserId: string, appId: string) {
    await this.ensureSchema();
    await this.ensurePlatformSuperAdmin(actorUserId);
    const app = await this.resolveAppById(appId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM payment_products
       WHERE app_id = $1::uuid
       ORDER BY created_at DESC`,
      app.id,
    ) as Promise<PaymentProductRow[]>);
    return {
      app: {
        id: app.id,
        slug: app.slug,
        name: app.name,
      },
      items: rows.map((row) => this.serializeProduct(row)),
    };
  }

  async platformRunOneTimeTest(
    actorUserId: string,
    payload: { app_id?: string; app_slug?: string; one_time_product_id: string; user_id?: string },
  ) {
    await this.ensureSchema();
    await this.ensurePlatformSuperAdmin(actorUserId);
    this.assertAdminTestAllowed();
    this.assertAlipayRealGatewayReady();

    const app = await this.resolveAppForPlatformTest(payload.app_id, payload.app_slug);
    const targetUser = await this.resolveTargetUserForPlatformTest(app.id, actorUserId, payload.user_id);
    const product = await this.getRequiredActiveProduct(app.id, payload.one_time_product_id, 'ONE_TIME');
    const created = await this.createPagePayOrder(app.slug, targetUser.id, {
      product_id: product.id,
      subject: `${product.name}-真实支付测试`,
    });

    return {
      app: { id: app.id, slug: app.slug, name: app.name },
      user_id: targetUser.id,
      one_time_order: {
        out_trade_no: created.out_trade_no,
        status: 'PENDING',
        trade_status: null,
        amount: created.amount,
        subject: created.subject,
        channel: created.channel,
        payment_form: created.payment_form,
      },
    };
  }

  async platformRunWechatOneTimeTest(
    actorUserId: string,
    payload: { app_id?: string; app_slug?: string; one_time_product_id: string; user_id?: string },
  ) {
    await this.ensureSchema();
    await this.ensurePlatformSuperAdmin(actorUserId);
    this.assertAdminTestAllowed();
    this.assertWechatRealGatewayReady();

    const app = await this.resolveAppForPlatformTest(payload.app_id, payload.app_slug);
    const targetUser = await this.resolveTargetUserForPlatformTest(app.id, actorUserId, payload.user_id);
    const created = await this.createWechatNativeOrder(app.slug, targetUser.id, {
      product_id: payload.one_time_product_id,
      description: '微信真实支付测试订单',
      client_ip: '127.0.0.1',
    });

    return {
      app: { id: app.id, slug: app.slug, name: app.name },
      user_id: targetUser.id,
      order: {
        out_trade_no: created.out_trade_no,
        status: 'PENDING',
        trade_status: null,
        trade_no: null,
        payment_type: 'WECHAT_NATIVE',
        code_url: created.code_url,
        payment_url: created.payment_url,
        channel: created.channel,
      },
    };
  }

  async platformRunRecurringTest(
    actorUserId: string,
    payload: { app_id?: string; app_slug?: string; recurring_product_id: string; user_id?: string; execute_time?: string },
  ) {
    await this.ensureSchema();
    await this.ensurePlatformSuperAdmin(actorUserId);
    this.assertAdminTestAllowed();
    this.assertAlipayRealGatewayReady();

    const app = await this.resolveAppForPlatformTest(payload.app_id, payload.app_slug);
    const targetUser = await this.resolveTargetUserForPlatformTest(app.id, actorUserId, payload.user_id);
    const product = await this.getRequiredActiveProduct(app.id, payload.recurring_product_id, 'RECURRING');
    const executeTime = this.resolveExecuteTime(payload.execute_time, product.execute_time);
    const created = await this.createAgreementSign(app.slug, targetUser.id, {
      product_id: product.id,
      execute_time: executeTime,
    });

    return {
      app: { id: app.id, slug: app.slug, name: app.name },
      user_id: targetUser.id,
      agreement: {
        id: created.agreement_id,
        external_agreement_no: created.external_agreement_no,
        status: 'PENDING',
        execute_time: executeTime,
        channel: created.channel,
        sign_form: created.sign_form,
      },
      tips: '请在支付宝签约页面完成签约。签约成功后可在“支付运营动作”里执行真实扣款。',
    };
  }

  async platformRunFullFlowTest(
    actorUserId: string,
    payload: { app_id?: string; app_slug?: string; one_time_product_id: string; recurring_product_id: string; user_id?: string },
  ) {
    await this.ensureSchema();
    await this.ensurePlatformSuperAdmin(actorUserId);
    this.assertAdminTestAllowed();
    this.assertAlipayRealGatewayReady();

    const app = await this.resolveAppForPlatformTest(payload.app_id, payload.app_slug);
    const targetUser = await this.resolveTargetUserForPlatformTest(app.id, actorUserId, payload.user_id);
    const oneTimeProduct = await this.getRequiredActiveProduct(app.id, payload.one_time_product_id, 'ONE_TIME');
    const recurringProduct = await this.getRequiredActiveProduct(app.id, payload.recurring_product_id, 'RECURRING');
    const oneTime = await this.createPagePayOrder(app.slug, targetUser.id, {
      product_id: oneTimeProduct.id,
      subject: `${oneTimeProduct.name}-真实支付测试`,
    });
    const recurring = await this.createAgreementSign(app.slug, targetUser.id, {
      product_id: recurringProduct.id,
      execute_time: this.resolveExecuteTime(undefined, recurringProduct.execute_time),
    });

    return {
      app: { id: app.id, slug: app.slug, name: app.name },
      user_id: targetUser.id,
      one_time_order: {
        out_trade_no: oneTime.out_trade_no,
        status: 'PENDING',
        trade_status: null,
        payment_form: oneTime.payment_form,
        channel: oneTime.channel,
      },
      agreement: {
        id: recurring.agreement_id,
        external_agreement_no: recurring.external_agreement_no,
        status: 'PENDING',
        sign_form: recurring.sign_form,
        channel: recurring.channel,
      },
      tips: '请先完成单次支付与签约，再使用“执行扣款”验证周期代扣。',
    };
  }

  async adminExecuteDeduction(
    appSlug: string | undefined,
    actorUserId: string,
    payload: { agreement_id: string; amount?: string },
  ) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    const agreementId = String(payload?.agreement_id || '').trim();
    if (!agreementId) {
      throw new BadRequestException('agreement_id is required');
    }
    const amount = payload?.amount ? this.normalizeAmount(payload.amount, 'amount') : undefined;

    const result = await this.prisma.$transaction(async (tx) => {
      return this.executeDeductionForAgreement(tx, {
        appId: app.id,
        agreementId,
        amount,
        source: 'admin_manual',
        mockSuccess: false,
      });
    });

    if (result.membershipDaysGranted > 0) {
      const agreement = await this.getAgreementById(app.id, agreementId);
      const product = agreement ? await this.getProductById(app.id, agreement.product_id) : null;
      await this.pushMembershipNotification(app, result.userId, {
        channel: 'admin_manual_deduction',
        productName: product?.name || '周期会员',
        membershipDays: result.membershipDaysGranted,
        expiresAt: result.membershipExpiresAt,
      });
    }
    if (!result.skipped && String(result.deductionStatus || '').toUpperCase() === 'SUCCESS' && result.outTradeNo) {
      await this.grantOrderTopupPointsByTradeNoIfNeeded(app, result.outTradeNo);
    }

    return {
      out_trade_no: result.outTradeNo,
      deduction_status: result.deductionStatus,
      trade_status: result.tradeStatus,
      skipped: result.skipped,
    };
  }

  async adminTriggerAutoRun(appSlug: string | undefined, actorUserId: string, batchSize = 50) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    const size = Math.min(Math.max(Number(batchSize || 50), 1), 500);
    this.assertAlipayRealGatewayReady();

    return this.runDueDeductionBatch({
      appId: app.id,
      batchSize: size,
      source: 'admin_trigger',
    });
  }

  private async runDueDeductionBatch(input: {
    appId?: string;
    batchSize: number;
    source: string;
  }) {
    const size = Math.min(Math.max(Number(input.batchSize || 50), 1), 500);
    const dueRows = input.appId
      ? await (this.prisma.$queryRawUnsafe(
          `SELECT id, app_id
           FROM alipay_agreements
           WHERE app_id = $1::uuid
             AND UPPER(status) = 'VALID'
             AND next_deduction_at IS NOT NULL
             AND next_deduction_at <= now()
           ORDER BY next_deduction_at ASC
           LIMIT $2`,
          input.appId,
          size,
        ) as Promise<DueAgreementCandidateRow[]>)
      : await (this.prisma.$queryRawUnsafe(
          `SELECT id, app_id
           FROM alipay_agreements
           WHERE UPPER(status) = 'VALID'
             AND next_deduction_at IS NOT NULL
             AND next_deduction_at <= now()
           ORDER BY next_deduction_at ASC
           LIMIT $1`,
          size,
        ) as Promise<DueAgreementCandidateRow[]>);

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const item of dueRows) {
      try {
        const result = await this.prisma.$transaction(async (tx) =>
          this.executeDeductionForAgreement(tx, {
            appId: item.app_id,
            agreementId: item.id,
            source: input.source,
            mockSuccess: false,
            requireDue: true,
          }),
        );
        if (result.skipped) {
          skipped += 1;
        } else if (String(result.deductionStatus || '').toUpperCase() === 'SUCCESS') {
          success += 1;
          if (result.outTradeNo) {
            const app = await this.resolveAppById(item.app_id);
            await this.grantOrderTopupPointsByTradeNoIfNeeded(app, result.outTradeNo);
          }
          if (result.membershipDaysGranted > 0) {
            const app = await this.resolveAppById(item.app_id);
            const agreement = await this.getAgreementById(item.app_id, item.id);
            const product = agreement ? await this.getProductById(item.app_id, agreement.product_id) : null;
            await this.pushMembershipNotification(app, result.userId, {
              channel: 'auto_deduction',
              productName: product?.name || '周期会员',
              membershipDays: result.membershipDaysGranted,
              expiresAt: result.membershipExpiresAt,
            });
          }
        } else {
          failed += 1;
        }
      } catch (error: any) {
        failed += 1;
        this.logger.warn(
          `auto deduction failed app_id=${item.app_id} agreement=${item.id}: ${error?.message || 'unknown error'}`,
        );
      }
    }

    return {
      total_due: dueRows.length,
      success,
      failed,
      skipped,
    };
  }

  async adminUnsignAgreement(appSlug: string | undefined, actorUserId: string, agreementId: string) {
    const { app } = await this.requireAdminPagePermission(appSlug, actorUserId);
    const agreement = await this.getAgreementById(app.id, agreementId);
    if (!agreement) {
      throw new NotFoundException('签约记录不存在');
    }

    let unsignResponse: Record<string, unknown> = { mock: true, message: 'agreement unsigned' };
    if (this.isAlipayConfigured()) {
      const response = await this.alipayExecuteRequest('alipay.user.agreement.unsign', {
        agreement_no: agreement.agreement_no || undefined,
        external_agreement_no: agreement.external_agreement_no,
        sign_scene: agreement.sign_scene || undefined,
      });
      const content = response.content;
      if (String(content.code || '') !== '10000') {
        throw new BadRequestException(`支付宝解约失败: ${String(content.sub_msg || content.msg || 'unknown')}`);
      }
      unsignResponse = response.raw;
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE alipay_agreements
       SET status = 'UNSIGNED',
           invalid_at = now(),
           next_deduction_at = NULL,
           updated_at = now()
       WHERE app_id = $1::uuid AND id = $2::uuid`,
      app.id,
      agreementId,
    );

    return {
      agreement_id: agreementId,
      status: 'UNSIGNED',
      response: unsignResponse,
    };
  }

  private async requireAdminPagePermission(appSlug: string | undefined, actorUserId: string) {
    await this.ensureSchema();
    const app = await this.resolveAppBySlug(appSlug);
    let actor: {
      id: string;
      role: string | null;
      admin_type: string | null;
      is_superuser: boolean;
    };
    try {
      const inAppActor = await this.ensureUserInApp(app.id, actorUserId);
      actor = {
        id: inAppActor.id,
        role: inAppActor.role,
        admin_type: inAppActor.admin_type,
        is_superuser: !!inAppActor.is_superuser,
      };
    } catch (error: any) {
      const message = String(error?.message || '').trim();
      const canFallback = error instanceof NotFoundException || message === '用户不存在';
      if (!canFallback) {
        throw error;
      }
      const superActor = await this.ensurePlatformSuperAdmin(actorUserId);
      actor = {
        id: superActor.id,
        role: superActor.role,
        admin_type: superActor.admin_type,
        is_superuser: !!superActor.is_superuser,
      };
    }
    const role = String(actor.role || '').toUpperCase();
    if (role !== 'ADMIN' && !actor.is_superuser) {
      throw new ForbiddenException('管理员权限不足');
    }
    const isSuper = String(actor.admin_type || '').toUpperCase() === 'SUPER_ADMIN' || !!actor.is_superuser;
    if (!isSuper) {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT allowed_pages
         FROM admin_page_permissions
         WHERE app_id = $1::uuid AND admin_user_id = $2::uuid
         LIMIT 1`,
        app.id,
        actor.id,
      ) as Promise<AdminPermissionRow[]>);
      const allowedPages = this.parseJsonStringArray(rows[0]?.allowed_pages);
      if (!allowedPages.includes('admin_product_payments')) {
        throw new ForbiddenException('无权访问产品与支付页面');
      }
    }
    return { app, actor };
  }

  private async executeDeductionForAgreement(
    tx: TxClient,
    input: {
      appId: string;
      agreementId: string;
      amount?: string;
      source: string;
      mockSuccess: boolean;
      requireDue?: boolean;
    },
  ): Promise<{
    skipped: boolean;
    outTradeNo: string | null;
    deductionStatus: string;
    tradeStatus: string | null;
    userId: string;
    productId: string | null;
    membershipDaysGranted: number;
    membershipExpiresAt: Date | null;
  }> {
    const agreementRows = await (tx.$queryRawUnsafe(
      `SELECT *
       FROM alipay_agreements
       WHERE app_id = $1::uuid AND id = $2::uuid
       LIMIT 1
       FOR UPDATE`,
      input.appId,
      input.agreementId,
    ) as Promise<AgreementRow[]>);
    const agreement = agreementRows[0];
    if (!agreement) {
      throw new NotFoundException('签约记录不存在');
    }
    if (String(agreement.status || '').toUpperCase() !== 'VALID') {
      throw new BadRequestException('签约状态不是 VALID');
    }
    if (!agreement.product_id) {
      throw new BadRequestException('签约记录缺少商品信息');
    }
    if (input.requireDue) {
      const dueAt = agreement.next_deduction_at;
      if (!dueAt || dueAt.getTime() > Date.now()) {
        return {
          skipped: true,
          outTradeNo: null,
          deductionStatus: 'NOT_DUE',
          tradeStatus: null,
          userId: agreement.user_id,
          productId: agreement.product_id,
          membershipDaysGranted: 0,
          membershipExpiresAt: null,
        };
      }
    }

    const product = await this.getProductById(input.appId, agreement.product_id);
    if (!product) {
      throw new NotFoundException('商品不存在');
    }

    const recentPending = await (tx.$queryRawUnsafe(
      `SELECT out_trade_no
       FROM alipay_deductions
       WHERE agreement_id = $1::uuid
         AND UPPER(status) = 'PENDING'
         AND created_at >= now() - interval '10 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      agreement.id,
    ) as Promise<Array<{ out_trade_no: string }>>);
    if (recentPending[0]) {
      return {
        skipped: true,
        outTradeNo: recentPending[0].out_trade_no,
        deductionStatus: 'PENDING',
        tradeStatus: null,
        userId: agreement.user_id,
        productId: agreement.product_id,
        membershipDaysGranted: 0,
        membershipExpiresAt: null,
      };
    }

    const outTradeNo = this.genTradeNo('DED');
    const tradeAmount = input.amount
      ? this.normalizeAmount(input.amount, 'amount')
      : this.formatAmount(product.amount);
    const productTopupPoints = this.normalizePointsValue(product.points_topup, 'product.points_topup');

    await tx.$executeRawUnsafe(
      `INSERT INTO alipay_deductions (
         id, app_id, agreement_id, user_id, product_id, out_trade_no, amount, status, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, 'PENDING', now(), now()
       )`,
      input.appId,
      agreement.id,
      agreement.user_id,
      agreement.product_id,
      outTradeNo,
      tradeAmount,
    );

    await tx.$executeRawUnsafe(
      `INSERT INTO alipay_orders (
         id, app_id, out_trade_no, user_id, product_id, subject, total_amount, points_topup_points, status, payment_type, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5, $6::numeric, $7::bigint, 'PENDING', $8, now(), now()
       )`,
      input.appId,
      outTradeNo,
      agreement.user_id,
      agreement.product_id,
      `${product.name}-周期扣款`,
      tradeAmount,
      productTopupPoints,
      this.buildRecurringPaymentType(input.source),
    );

    let paid = false;
    let tradeStatus = 'TRADE_SUCCESS';
    let tradeNo = this.genTradeNo('MOCK');
    let responsePayload: Record<string, unknown> = { mock: true, source: input.source, code: '10000', msg: 'Success' };

    if (!input.mockSuccess) {
      this.assertAlipayRealGatewayReady();
    }
    const forceMock = input.mockSuccess;
    if (!forceMock) {
      if (!agreement.agreement_no) {
        throw new BadRequestException('缺少 agreement_no，无法执行真实支付宝代扣');
      }
      const realResponse = await this.alipayExecuteRequest('alipay.trade.pay', {
        out_trade_no: outTradeNo,
        total_amount: tradeAmount,
        subject: `${product.name}-周期扣款`,
        product_code: 'GENERAL_WITHHOLDING',
        scene: 'ONLINE',
        agreement_params: {
          agreement_no: agreement.agreement_no,
        },
      });
      const code = String(realResponse.content.code || '');
      tradeStatus = String(realResponse.content.trade_status || '');
      tradeNo = String(realResponse.content.trade_no || '').trim() || this.genTradeNo('TRADE');
      responsePayload = realResponse.raw;
      paid = code === '10000' && ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(tradeStatus);
    } else {
      paid = true;
    }

    if (!paid) {
      await tx.$executeRawUnsafe(
        `UPDATE alipay_deductions
         SET status = 'FAILED',
             trade_no = $1,
             trade_status = $2,
             response_payload = $3::jsonb,
             updated_at = now()
         WHERE app_id = $4::uuid AND out_trade_no = $5`,
        tradeNo,
        tradeStatus || 'TRADE_FAILED',
        JSON.stringify(responsePayload),
        input.appId,
        outTradeNo,
      );
      await tx.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET status = 'FAILED',
             trade_no = $1,
             trade_status = $2,
             updated_at = now()
         WHERE app_id = $3::uuid AND out_trade_no = $4`,
        tradeNo,
        tradeStatus || 'TRADE_FAILED',
        input.appId,
        outTradeNo,
      );
      await tx.$executeRawUnsafe(
        `UPDATE alipay_agreements
         SET next_deduction_at = now() + interval '24 hours',
             updated_at = now()
         WHERE app_id = $1::uuid AND id = $2::uuid`,
        input.appId,
        agreement.id,
      );
      return {
        skipped: false,
        outTradeNo,
        deductionStatus: 'FAILED',
        tradeStatus: tradeStatus || 'TRADE_FAILED',
        userId: agreement.user_id,
        productId: agreement.product_id,
        membershipDaysGranted: 0,
        membershipExpiresAt: null,
      };
    }

    await tx.$executeRawUnsafe(
      `UPDATE alipay_deductions
       SET status = 'SUCCESS',
           trade_no = $1,
           trade_status = $2,
           response_payload = $3::jsonb,
           executed_at = now(),
           updated_at = now()
       WHERE app_id = $4::uuid AND out_trade_no = $5`,
      tradeNo,
      tradeStatus || 'TRADE_SUCCESS',
      JSON.stringify(responsePayload),
      input.appId,
      outTradeNo,
    );
    await tx.$executeRawUnsafe(
      `UPDATE alipay_orders
       SET status = 'PAID',
           trade_no = $1,
           trade_status = $2,
           paid_at = now(),
           notify_payload = $3::jsonb,
           updated_at = now()
       WHERE app_id = $4::uuid AND out_trade_no = $5`,
      tradeNo,
      tradeStatus || 'TRADE_SUCCESS',
      JSON.stringify(responsePayload),
      input.appId,
      outTradeNo,
    );

    const membershipDays = Math.max(Number(product.membership_days || 0), 0);
    const membershipUpdate =
      membershipDays > 0
        ? await this.extendMembership(tx, input.appId, agreement.user_id, membershipDays)
        : { updated: false, expiresAt: null };

    const baseDue = agreement.next_deduction_at || this.parseExecuteTime(agreement.execute_time);
    const nextDue = this.rollForwardDueDate(this.calculateNextDeduction(baseDue, agreement.period_type, agreement.period));
    await tx.$executeRawUnsafe(
      `UPDATE alipay_agreements
       SET last_deducted_at = now(),
           next_deduction_at = $1::timestamptz,
           updated_at = now()
       WHERE app_id = $2::uuid AND id = $3::uuid`,
      nextDue.toISOString(),
      input.appId,
      agreement.id,
    );

    return {
      skipped: false,
      outTradeNo,
      deductionStatus: 'SUCCESS',
      tradeStatus: tradeStatus || 'TRADE_SUCCESS',
      userId: agreement.user_id,
      productId: agreement.product_id,
      membershipDaysGranted: membershipDays,
      membershipExpiresAt: membershipUpdate.expiresAt,
    };
  }

  private async resolveTargetUser(appId: string, actorUserId: string, requestedUserId?: string) {
    const targetUserId = String(requestedUserId || '').trim() || actorUserId;
    const user = await this.ensureUserInApp(appId, targetUserId);
    return user;
  }

  private async extendMembership(
    tx: TxClient,
    appId: string,
    userId: string,
    membershipDays: number,
  ): Promise<MembershipUpdateResult> {
    if (!Number.isFinite(membershipDays) || membershipDays <= 0) {
      return { updated: false, expiresAt: null };
    }
    const userRows = await (tx.$queryRawUnsafe(
      `SELECT id, app_id, email, role::text AS role, admin_type::text AS admin_type, is_active, is_superuser,
              membership_type::text AS membership_type, membership_expires_at
       FROM users
       WHERE id = $1::uuid AND app_id = $2::uuid AND deleted_at IS NULL
       LIMIT 1
       FOR UPDATE`,
      userId,
      appId,
    ) as Promise<UserRow[]>);
    const user = userRows[0];
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    const now = new Date();
    const currentExpiry = user.membership_expires_at ? new Date(user.membership_expires_at) : null;
    const base = currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
    const expiresAt = new Date(base.getTime() + membershipDays * 24 * 60 * 60 * 1000);

    await tx.$executeRawUnsafe(
      `UPDATE users
       SET membership_type = 'PREMIUM',
           membership_expires_at = $1::timestamptz,
           updated_at = now()
       WHERE id = $2::uuid AND app_id = $3::uuid`,
      expiresAt.toISOString(),
      userId,
      appId,
    );

    return {
      updated: true,
      expiresAt,
    };
  }

  private async pushMembershipNotification(
    app: AppRow,
    userId: string,
    payload: { channel: string; productName: string; membershipDays: number; expiresAt: Date | null },
  ) {
    try {
      await this.redeemService.pushNotificationByAppId(app.id, userId, {
        type: 'product.payment_granted',
        title: '新的权益已到账',
        message: `你购买的产品「${payload.productName}」已到账。`,
        payload: {
          source: 'payment',
          channel: payload.channel,
          app_slug: app.slug,
          product_name: payload.productName,
          membership_days: payload.membershipDays,
          membership_expires_at: payload.expiresAt ? payload.expiresAt.toISOString() : null,
        },
      });
    } catch (error: any) {
      this.logger.warn(
        `membership notification failed app=${app.slug} user=${userId}: ${error?.message || 'unknown error'}`,
      );
    }
  }

  private async ensureUserInApp(appId: string, userId: string): Promise<UserRow> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, email, role::text AS role, admin_type::text AS admin_type, is_active, is_superuser,
              membership_type::text AS membership_type, membership_expires_at
       FROM users
       WHERE id = $1::uuid AND app_id = $2::uuid AND deleted_at IS NULL
       LIMIT 1`,
      userId,
      appId,
    ) as Promise<UserRow[]>);
    const user = rows[0];
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    if (!user.is_active) {
      throw new ForbiddenException('用户已禁用');
    }
    return user;
  }

  private async ensurePlatformSuperAdmin(userId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id,
              role::text AS role,
              admin_type::text AS admin_type,
              is_superuser,
              is_active,
              deleted_at
       FROM users
       WHERE id = $1::uuid
       LIMIT 1`,
      userId,
    ) as Promise<Array<{
        id: string;
        role: string | null;
        admin_type: string | null;
        is_superuser: boolean;
        is_active: boolean;
        deleted_at: Date | null;
      }>>);
    const user = rows[0];
    if (!user || user.deleted_at || !user.is_active) {
      throw new NotFoundException('Admin user not found');
    }
    const role = String(user.role || '').toUpperCase();
    const adminType = String(user.admin_type || '').toUpperCase();
    if (role !== 'ADMIN' || (adminType !== 'SUPER_ADMIN' && !user.is_superuser)) {
      throw new ForbiddenException('super admin required');
    }
    return user;
  }

  private async resolveAppById(appId: string): Promise<AppRow> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, slug, name
       FROM apps
       WHERE id = $1::uuid
       LIMIT 1`,
      appId,
    ) as Promise<AppRow[]>);
    const app = rows[0];
    if (!app) {
      throw new NotFoundException(`App not found: ${appId}`);
    }
    return app;
  }

  private async resolveAppForPlatformTest(appId?: string, appSlug?: string): Promise<AppRow> {
    const normalizedAppId = String(appId || '').trim();
    if (normalizedAppId) {
      return this.resolveAppById(normalizedAppId);
    }
    return this.resolveAppBySlug(appSlug);
  }

  private async resolveTargetUserForPlatformTest(appId: string, actorUserId: string, requestedUserId?: string) {
    const requested = String(requestedUserId || '').trim();
    if (requested) {
      return this.ensureUserInApp(appId, requested);
    }

    try {
      return await this.ensureUserInApp(appId, actorUserId);
    } catch {
      const rows = await (this.prisma.$queryRawUnsafe(
        `SELECT id, app_id, email, role::text AS role, admin_type::text AS admin_type, is_active, is_superuser,
                membership_type::text AS membership_type, membership_expires_at
         FROM users
         WHERE app_id = $1::uuid
           AND deleted_at IS NULL
           AND is_active = true
         ORDER BY created_at ASC
         LIMIT 1`,
        appId,
      ) as Promise<UserRow[]>);
      const user = rows[0];
      if (!user) {
        throw new NotFoundException('当前租户没有可用测试用户，请传入 user_id');
      }
      return user;
    }
  }

  private async resolveAppBySlug(appSlug?: string): Promise<AppRow> {
    const slug = String(appSlug || '').trim().toLowerCase() || this.config.app.defaultSlug;
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, slug, name
       FROM apps
       WHERE slug = $1
       LIMIT 1`,
      slug,
    ) as Promise<AppRow[]>);
    const app = rows[0];
    if (!app) {
      throw new NotFoundException(`App not found: ${slug}`);
    }
    return app;
  }

  private async getProductById(appId: string, productId: string): Promise<PaymentProductRow | null> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM payment_products
       WHERE app_id = $1::uuid AND id = $2::uuid
       LIMIT 1`,
      appId,
      productId,
    ) as Promise<PaymentProductRow[]>);
    return rows[0] || null;
  }

  private buildRedeemPackagePaymentCode(packageId: string): string {
    const raw = String(packageId || '').trim().replace(/-/g, '').toUpperCase();
    if (!raw) {
      return '';
    }
    return `PKG_${raw.slice(0, 32)}`;
  }

  private parseRedeemPackageIdFromPaymentCode(code: string | null | undefined): string | null {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized.startsWith('PKG_')) {
      return null;
    }
    const raw = normalized.slice(4);
    if (!/^[0-9A-F]{32}$/.test(raw)) {
      return null;
    }
    const value = raw.toLowerCase();
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
  }

  private async getProductByRedeemPackageId(appId: string, packageId: string): Promise<PaymentProductRow | null> {
    const code = this.buildRedeemPackagePaymentCode(packageId);
    if (!code) {
      return null;
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM payment_products
       WHERE app_id = $1::uuid AND code = $2
       LIMIT 1`,
      appId,
      code,
    ) as Promise<PaymentProductRow[]>);
    return rows[0] || null;
  }

  private async ensurePaymentProductByRedeemPackageId(appId: string, packageId: string): Promise<PaymentProductRow | null> {
    const code = this.buildRedeemPackagePaymentCode(packageId);
    if (!code) {
      return null;
    }

    const packageRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, name, description, price_cny, is_active
       FROM entitlement_packages
       WHERE app_id = $1::uuid AND id = $2::uuid
       LIMIT 1`,
      appId,
      packageId,
    ) as Promise<EntitlementPackageRow[]>);
    const pkg = packageRows[0];
    if (!pkg) {
      return null;
    }

    const amount = this.formatAmount(pkg.price_cny);
    if (Number(amount) <= 0) {
      return null;
    }
    const status = pkg.is_active ? 'ACTIVE' : 'INACTIVE';

    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO payment_products (
         id, app_id, code, name, description, type, status, amount, currency,
         membership_days, points_topup, sign_scene, sign_validity_period, period_type, period, execute_time, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3, $4, 'ONE_TIME', $5, $6::numeric, 'CNY',
         0, 0, NULL, NULL, NULL, NULL, NULL, now(), now()
       )
       ON CONFLICT (app_id, code)
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         amount = EXCLUDED.amount,
         updated_at = now()
       RETURNING *`,
      appId,
      code,
      String(pkg.name || '').trim() || '未命名产品',
      pkg.description || null,
      status,
      amount,
    ) as Promise<PaymentProductRow[]>);
    return rows[0] || null;
  }

  private async getResolvableProduct(appId: string, productId: string): Promise<PaymentProductRow | null> {
    const direct = await this.getProductById(appId, productId);
    if (direct) {
      return direct;
    }
    const mapped = await this.getProductByRedeemPackageId(appId, productId);
    if (mapped) {
      return mapped;
    }
    return this.ensurePaymentProductByRedeemPackageId(appId, productId);
  }

  private async ensureDefaultPointsTopupProduct(appId: string): Promise<PaymentProductRow> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO payment_products (
         id, app_id, code, name, description, type, status, amount, currency,
         membership_days, points_topup, sign_scene, sign_validity_period, period_type, period, execute_time, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3, $4, 'ONE_TIME', 'ACTIVE', 1.00::numeric, 'CNY',
         0, 0, NULL, NULL, NULL, NULL, NULL, now(), now()
       )
       ON CONFLICT (app_id, code)
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         type = 'ONE_TIME',
         status = 'ACTIVE',
         amount = 1.00::numeric,
         currency = 'CNY',
         membership_days = 0,
         points_topup = 0,
         sign_scene = NULL,
         sign_validity_period = NULL,
         period_type = NULL,
         period = NULL,
         execute_time = NULL,
         updated_at = now()
       RETURNING *`,
      appId,
      DEFAULT_POINTS_TOPUP_PRODUCT_CODE,
      DEFAULT_POINTS_TOPUP_PRODUCT_NAME,
      DEFAULT_POINTS_TOPUP_PRODUCT_DESCRIPTION,
    ) as Promise<PaymentProductRow[]>);
    const product = rows[0];
    if (!product) {
      throw new BadRequestException('初始化默认积分商品失败');
    }
    return product;
  }

  private async grantRedeemPackageForOrderIfNeeded(app: AppRow, order: OrderRow, product: PaymentProductRow | null) {
    const packageId = this.parseRedeemPackageIdFromPaymentCode(product?.code);
    if (!packageId) {
      return;
    }

    try {
      await this.redeemService.distributePackageToUserByAppId(app.id, packageId, order.user_id, {
        user_id: order.user_id,
        source: 'purchase',
        order_id: order.id,
        out_trade_no: order.out_trade_no,
        payment_channel: order.payment_type,
      });
    } catch (error: any) {
      this.logger.warn(
        `payment package grant failed app=${app.slug} order=${order.out_trade_no} package=${packageId}: ${error?.message || 'unknown error'}`,
      );
    }
  }

  private async getAgreementById(appId: string, agreementId: string): Promise<AgreementRow | null> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM alipay_agreements
       WHERE app_id = $1::uuid AND id = $2::uuid
       LIMIT 1`,
      appId,
      agreementId,
    ) as Promise<AgreementRow[]>);
    return rows[0] || null;
  }

  private async syncAlipayOrderStatus(appId: string, outTradeNo: string, cfgOverride?: EffectiveAlipayConfig) {
    const appRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, slug, name FROM apps WHERE id = $1::uuid LIMIT 1`,
      appId,
    ) as Promise<AppRow[]>);
    const app = appRows[0];
    const cfg = cfgOverride || this.alipayConfig();
    if (!app || !this.isResolvedAlipayConfigured(cfg)) {
      return;
    }
    try {
      const response = await this.alipayExecuteRequest('alipay.trade.query', { out_trade_no: outTradeNo }, cfg);
      const content = response.content;
      if (String(content.code || '') !== '10000') {
        return;
      }
      const tradeStatus = String(content.trade_status || '').toUpperCase();
      if (!tradeStatus) {
        return;
      }
      await this.processTradeNotify(
        app.slug,
        {
          out_trade_no: outTradeNo,
          trade_status: tradeStatus,
          trade_no: content.trade_no || null,
          total_amount: content.total_amount || null,
        },
        { skipSignatureCheck: true },
      );
    } catch (error: any) {
      this.logger.warn(`sync alipay order failed app=${app.slug} out_trade_no=${outTradeNo}: ${error?.message || 'unknown error'}`);
    }
  }

  private async syncWechatOrderStatus(appId: string, outTradeNo: string, cfgOverride?: EffectiveWechatPayConfig) {
    const wechatCfg = cfgOverride || this.wechatPayConfig();
    if (!this.isResolvedWechatConfigured(wechatCfg)) {
      return;
    }
    try {
      const result = await this.wechatOrderQuery({
        appId: wechatCfg.appId,
        mchId: wechatCfg.mchId,
        apiKey: wechatCfg.apiKey,
        outTradeNo,
      });
      if (
        String(result.return_code || '').toUpperCase() === 'SUCCESS' &&
        String(result.result_code || '').toUpperCase() === 'SUCCESS' &&
        String(result.trade_state || '').toUpperCase() === 'SUCCESS'
      ) {
        const appRows = await (this.prisma.$queryRawUnsafe(
          `SELECT id, slug, name FROM apps WHERE id = $1::uuid LIMIT 1`,
          appId,
        ) as Promise<AppRow[]>);
        const app = appRows[0];
        if (app) {
          const xml = this.buildWechatXml(result);
          await this.processWechatNotify(app.slug, xml);
        }
      }
    } catch (error: any) {
      this.logger.warn(`sync wechat order failed app_id=${appId} out_trade_no=${outTradeNo}: ${error?.message || 'unknown error'}`);
    }
  }

  private async getRequiredActiveProduct(appId: string, productId: string, expectedType: ProductType) {
    const normalizedProductId = String(productId || '').trim();
    if (!normalizedProductId) {
      throw new BadRequestException('product id is required');
    }
    const product = await this.getProductById(appId, normalizedProductId);
    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    if (String(product.status || '').toUpperCase() !== 'ACTIVE') {
      throw new BadRequestException('商品未上架');
    }
    if (String(product.type || '').toUpperCase() !== expectedType) {
      throw new BadRequestException(
        expectedType === 'ONE_TIME'
          ? '单次支付商品必须是 ACTIVE 且类型为 ONE_TIME'
          : '周期扣款商品必须是 ACTIVE 且类型为 RECURRING',
      );
    }
    return product;
  }

  buildWechatNotifyAck(success: boolean, message = 'OK') {
    return success
      ? `<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[${message}]]></return_msg></xml>`
      : `<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[${message}]]></return_msg></xml>`;
  }

  private async getAppSettings(appId: string): Promise<AppSettingRow | null> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT app_id,
              app_url,
              alipay_notify_url,
              alipay_agreement_notify_url,
              extra_json,
              (
                SELECT domain
                FROM app_domains
                WHERE app_id = $1::uuid AND domain_type = 'API'
                ORDER BY is_primary DESC, created_at ASC
                LIMIT 1
              ) AS api_domain,
              (
                SELECT domain
                FROM app_domains
                WHERE app_id = $1::uuid AND domain_type = 'USER_WEB'
                ORDER BY is_primary DESC, created_at ASC
                LIMIT 1
              ) AS user_web_domain
       FROM app_settings
       WHERE app_id = $1::uuid
       LIMIT 1`,
      appId,
    ) as Promise<AppSettingRow[]>);
    return rows[0] || null;
  }

  private getDefaultEnvAlipayConfig(): EffectiveAlipayConfig {
    return {
      enabled: !!this.config.alipay.enabled,
      sandboxDebug: !!this.config.alipay.sandboxDebug,
      gatewayUrl: String(this.config.alipay.gatewayUrl || '').trim(),
      appId: String(this.config.alipay.appId || '').trim(),
      privateKey: String(this.config.alipay.privateKey || '').trim(),
      alipayPublicKey: String(this.config.alipay.alipayPublicKey || '').trim(),
      signType: String(this.config.alipay.signType || 'RSA2').trim() || 'RSA2',
      notifyUrl: String(this.config.alipay.notifyUrl || '').trim(),
      returnUrl: String(this.config.alipay.returnUrl || '').trim(),
      agreementNotifyUrl: String(this.config.alipay.agreementNotifyUrl || '').trim(),
      agreementReturnUrl: String(this.config.alipay.agreementReturnUrl || '').trim(),
    };
  }

  private getDefaultEnvWechatPayConfig(): EffectiveWechatPayConfig {
    return {
      enabled: !!this.config.wechatPay.enabled,
      gatewayUrl: String(this.config.wechatPay.gatewayUrl || '').trim(),
      appId: String(this.config.wechatPay.appId || '').trim(),
      mchId: String(this.config.wechatPay.mchId || '').trim(),
      apiKey: String(this.config.wechatPay.apiKey || '').trim(),
      notifyUrl: String(this.config.wechatPay.notifyUrl || '').trim(),
    };
  }

  private parseBooleanLike(value: unknown, fallback: boolean) {
    if (typeof value === 'boolean') return value;
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
    return fallback;
  }

  private readBoundedInteger(value: unknown, min: number, max: number): number | null {
    if (value === null || value === undefined || String(value).trim() === '') {
      return null;
    }
    const parsed = Number.parseInt(String(value).trim(), 10);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return Math.min(Math.max(parsed, min), max);
  }

  private asConfigMap(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private async ensureRuntimePaymentConfig(force = false) {
    const now = Date.now();
    if (!force && this.runtimeConfigLoadedAt > 0 && now - this.runtimeConfigLoadedAt < 15000) {
      return;
    }
    if (this.runtimeConfigLoading) {
      await this.runtimeConfigLoading;
      return;
    }
    this.runtimeConfigLoading = this.loadRuntimePaymentConfig(force).finally(() => {
      this.runtimeConfigLoading = null;
    });
    await this.runtimeConfigLoading;
  }

  private async loadRuntimePaymentConfig(force = false) {
    const envAlipay = this.getDefaultEnvAlipayConfig();
    const envWechat = this.getDefaultEnvWechatPayConfig();
    let nextAlipay = { ...envAlipay };
    let nextWechat = { ...envWechat };
    let nextRuntimePaymentSettings: RuntimePaymentSettings = {
      apiBaseUrl: '',
      userWebBaseUrl: '',
      paymentReturnBaseUrl: '',
      schedulerEnabled: null,
      schedulerIntervalMs: null,
      schedulerBatchSize: null,
      allowLocalReturnUrl: null,
      adminTestDisabled: null,
    };

    try {
      const tableRows = await (this.prisma.$queryRawUnsafe(
        `SELECT to_regclass('public.platform_payment_methods')::text AS exists`,
      ) as Promise<Array<{ exists: string | null }>>);
      const tableExists = !!String(tableRows[0]?.exists || '').trim();
      if (tableExists) {
        const rows = await (this.prisma.$queryRawUnsafe(
          `SELECT *
           FROM platform_payment_methods
           WHERE is_active = true
           ORDER BY provider_type ASC, is_default DESC, updated_at DESC`,
        ) as Promise<PlatformPaymentMethodRow[]>);
        const methodByProvider = new Map<string, PlatformPaymentMethodRow>();
        for (const row of rows) {
          if (!methodByProvider.has(row.provider_type)) {
            methodByProvider.set(String(row.provider_type || '').toUpperCase(), row);
          }
        }

        const alipayRow = methodByProvider.get('ALIPAY');
        if (alipayRow) {
          const cfg = this.asConfigMap(alipayRow.config_json);
          nextAlipay = {
            enabled: this.parseBooleanLike(cfg.enabled, true),
            sandboxDebug: this.parseBooleanLike(cfg.sandbox_debug, false),
            gatewayUrl: String(cfg.gateway_url || '').trim() || envAlipay.gatewayUrl,
            appId: String(cfg.app_id || '').trim(),
            privateKey: String(cfg.private_key || '').trim(),
            alipayPublicKey: String(cfg.alipay_public_key || '').trim(),
            signType: String(cfg.sign_type || 'RSA2').trim() || 'RSA2',
            notifyUrl: String(cfg.notify_url || '').trim(),
            returnUrl: String(cfg.return_url || '').trim(),
            agreementNotifyUrl: String(cfg.agreement_notify_url || '').trim(),
            agreementReturnUrl: String(cfg.agreement_return_url || '').trim(),
          };
        }

        const wechatRow = methodByProvider.get('WECHAT');
        if (wechatRow) {
          const cfg = this.asConfigMap(wechatRow.config_json);
          nextWechat = {
            enabled: this.parseBooleanLike(cfg.enabled, true),
            gatewayUrl: String(cfg.gateway_url || '').trim() || envWechat.gatewayUrl,
            appId: String(cfg.app_id || '').trim(),
            mchId: String(cfg.mch_id || '').trim(),
            apiKey: String(cfg.api_key || '').trim(),
            notifyUrl: String(cfg.notify_url || '').trim(),
          };
        }
      }

      const runtimeRows = (await this.prisma.$queryRawUnsafe(
        `SELECT api_base_url, admin_frontend_url, payments_scheduler_json
         FROM platform_runtime_settings
         WHERE singleton_key = 'platform'
         LIMIT 1`,
      )) as Array<{
        api_base_url: string | null;
        admin_frontend_url: string | null;
        payments_scheduler_json: unknown;
      }>;
      const runtimeRow = runtimeRows[0] || null;
      const scheduler = this.asConfigMap(runtimeRow?.payments_scheduler_json);
      nextRuntimePaymentSettings = {
        apiBaseUrl: this.normalizeBaseUrl(String(scheduler.api_base_url || runtimeRow?.api_base_url || '')),
        userWebBaseUrl: this.normalizeBaseUrl(String(scheduler.user_web_base_url || scheduler.web_base_url || '')),
        paymentReturnBaseUrl: this.normalizeBaseUrl(String(scheduler.payment_return_base_url || scheduler.return_base_url || '')),
        schedulerEnabled: scheduler.enabled === undefined ? null : this.parseBooleanLike(scheduler.enabled, false),
        schedulerIntervalMs: this.readBoundedInteger(scheduler.interval_ms, 60_000, 86_400_000),
        schedulerBatchSize: this.readBoundedInteger(scheduler.batch_size, 1, 500),
        allowLocalReturnUrl:
          scheduler.allow_local_return_url === undefined
            ? null
            : this.parseBooleanLike(scheduler.allow_local_return_url, false),
        adminTestDisabled:
          scheduler.admin_test_disabled === undefined
            ? null
            : this.parseBooleanLike(scheduler.admin_test_disabled, false),
      };
    } catch (error: any) {
      if (force) {
        this.logger.warn(`load runtime payment config failed: ${error?.message || 'unknown error'}`);
      }
    }

    this.effectiveAlipay = nextAlipay;
    this.effectiveWechatPay = nextWechat;
    this.runtimePaymentSettings = nextRuntimePaymentSettings;
    this.runtimeConfigLoadedAt = Date.now();
  }

  async refreshRuntimePaymentConfig() {
    await this.ensureRuntimePaymentConfig(true);
    return {
      alipay_enabled: this.isAlipayConfigured(),
      wechat_enabled: this.isWechatPayConfigured(),
      loaded_at: this.runtimeConfigLoadedAt ? new Date(this.runtimeConfigLoadedAt).toISOString() : null,
    };
  }

  private alipayConfig() {
    return this.effectiveAlipay || this.getDefaultEnvAlipayConfig();
  }

  private wechatPayConfig() {
    return this.effectiveWechatPay || this.getDefaultEnvWechatPayConfig();
  }

  private isAlipayConfigured() {
    const cfg = this.alipayConfig();
    return !!(cfg.enabled && cfg.appId && cfg.privateKey && cfg.alipayPublicKey);
  }

  private isWechatPayConfigured() {
    const cfg = this.wechatPayConfig();
    return !!(cfg.enabled && cfg.appId && cfg.mchId && cfg.apiKey);
  }

  private normalizePem(value: string | undefined | null) {
    if (!value) return '';
    let normalized = String(value).trim();
    if (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      normalized = normalized.slice(1, -1).trim();
    }
    return normalized.replace(/\r/g, '').replace(/\\n/g, '\n');
  }

  private wrapPemBase64(base64Body: string, label: string) {
    const body = String(base64Body || '').replace(/\s+/g, '');
    if (!body) return '';
    const chunks = body.match(/.{1,64}/g) || [body];
    return `-----BEGIN ${label}-----\n${chunks.join('\n')}\n-----END ${label}-----`;
  }

  private buildPrivateKeyPemCandidates(rawValue: string) {
    const normalized = this.normalizePem(rawValue);
    const candidates = new Set<string>();
    if (normalized) {
      candidates.add(normalized);
    }
    const stripped = normalized
      .replace(/-----BEGIN [^-]+-----/g, '')
      .replace(/-----END [^-]+-----/g, '')
      .replace(/\s+/g, '');
    if (stripped) {
      const pkcs8 = this.wrapPemBase64(stripped, 'PRIVATE KEY');
      const pkcs1 = this.wrapPemBase64(stripped, 'RSA PRIVATE KEY');
      if (pkcs8) candidates.add(pkcs8);
      if (pkcs1) candidates.add(pkcs1);
    }
    return Array.from(candidates);
  }

  private resolveAlipayPrivateKey(rawValue: string) {
    const candidates = this.buildPrivateKeyPemCandidates(rawValue);
    if (!candidates.length) {
      throw new BadRequestException('ALIPAY_APP_PRIVATE_KEY 未配置');
    }
    let lastError: any = null;
    for (const candidate of candidates) {
      try {
        return createPrivateKey({ key: candidate, format: 'pem' });
      } catch (error: any) {
        lastError = error;
      }
    }
    const reason = String(lastError?.message || '').slice(0, 200) || 'unknown error';
    throw new BadRequestException(`ALIPAY_APP_PRIVATE_KEY 格式错误，无法解析（${reason}）`);
  }

  private alipayGatewayUrl(cfgOverride?: EffectiveAlipayConfig) {
    const cfg = cfgOverride || this.alipayConfig();
    const raw = String(cfg.gatewayUrl || '').trim();
    if (raw) {
      return raw;
    }
    if (cfg.sandboxDebug) {
      return 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
    }
    return 'https://openapi.alipay.com/gateway.do';
  }

  private normalizeBaseUrl(rawValue: string) {
    const input = String(rawValue || '').trim();
    if (!input) return '';
    const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    try {
      const parsed = new URL(candidate);
      const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
      return `${parsed.origin}${pathname}`;
    } catch {
      return '';
    }
  }

  private resolveSaasReturnUrl(appSlug: string, appSettings: AppSettingRow | null, cfg: Record<string, unknown>, field: string) {
    const override = String(cfg[field] || '').trim();
    const allowLocal = this.allowLocalReturnUrl();
    if (this.isAcceptableReturnUrl(override, allowLocal)) {
      return override;
    }
    const base = this.resolveUserWebBaseUrl(appSlug, appSettings);
    return `${base.replace(/\/+$/, '')}/payment/result`;
  }

  private async readJsonResponse(response: Response) {
    const text = await response.text();
    try {
      return text ? (JSON.parse(text) as Record<string, any>) : {};
    } catch {
      return { raw_text: text };
    }
  }

  private headerValue(headers: Record<string, any>, name: string) {
    const direct = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(direct)) {
      return String(direct[0] || '');
    }
    return String(direct || '');
  }

  private safeCompareHex(expected: string, provided: string) {
    const left = String(expected || '').trim();
    const right = String(provided || '').trim();
    if (!left || !right || left.length !== right.length) {
      return false;
    }
    try {
      return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
    } catch {
      return false;
    }
  }

  private verifySaasWebhook(
    providerType: SaasPaymentProviderType,
    cfg: Record<string, unknown>,
    rawText: string,
    headers: Record<string, any>,
  ) {
    if (providerType === 'STRIPE') {
      const secret = String(cfg.webhook_secret || '').trim();
      const signature = this.headerValue(headers, 'stripe-signature');
      const timestamp = signature.match(/(?:^|,)t=([^,]+)/)?.[1] || '';
      const provided = signature.match(/(?:^|,)v1=([^,]+)/)?.[1] || '';
      if (!secret || !timestamp || !provided) return false;
      const expected = createHmac('sha256', secret).update(`${timestamp}.${rawText}`, 'utf8').digest('hex');
      return this.safeCompareHex(expected, provided);
    }
    if (providerType === 'PADDLE') {
      const secret = String(cfg.webhook_secret || '').trim();
      const signature = this.headerValue(headers, 'paddle-signature');
      const timestamp = signature.match(/(?:^|;)ts=([^;]+)/)?.[1] || '';
      const provided = signature.match(/(?:^|;)h1=([^;]+)/)?.[1] || '';
      if (!secret || !timestamp || !provided) return false;
      const expected = createHmac('sha256', secret).update(`${timestamp}:${rawText}`, 'utf8').digest('hex');
      return this.safeCompareHex(expected, provided);
    }
    const secret = String(cfg.signing_secret || '').trim();
    const provided = this.headerValue(headers, 'x-signature');
    if (!secret || !provided) return false;
    const expected = createHmac('sha256', secret).update(rawText, 'utf8').digest('hex');
    return this.safeCompareHex(expected, provided);
  }

  private extractSaasPaymentEvent(providerType: SaasPaymentProviderType, payload: Record<string, any>) {
    if (providerType === 'STRIPE') {
      const obj = payload?.data?.object || {};
      const rawStatus = String(obj.payment_status || obj.status || payload.type || '').toUpperCase();
      const isPaid = rawStatus === 'PAID' || String(payload.type || '') === 'checkout.session.completed';
      const isClosed = String(payload.type || '') === 'checkout.session.expired';
      return {
        status: isPaid ? 'PAID' : isClosed ? 'CLOSED' : 'PENDING',
        rawStatus,
        outTradeNo: String(obj.metadata?.out_trade_no || obj.client_reference_id || '').trim(),
        externalObjectId: String(obj.id || '').trim(),
        transactionId: String(obj.payment_intent || obj.id || '').trim(),
        customerId: String(obj.customer || '').trim(),
        subscriptionId: String(obj.subscription || '').trim(),
        amount: Number.isFinite(Number(obj.amount_total)) ? Number(obj.amount_total) : null,
      };
    }
    if (providerType === 'PADDLE') {
      const obj = payload?.data || {};
      const custom = obj.custom_data || {};
      const rawStatus = String(obj.status || payload.event_type || '').toUpperCase();
      const isPaid = rawStatus === 'COMPLETED' || rawStatus === 'PAID' || String(payload.event_type || '') === 'transaction.completed';
      const isFailed = rawStatus === 'CANCELED' || rawStatus === 'PAST_DUE' || rawStatus === 'FAILED';
      return {
        status: isPaid ? 'PAID' : isFailed ? 'FAILED' : 'PENDING',
        rawStatus,
        outTradeNo: String(custom.out_trade_no || '').trim(),
        externalObjectId: String(obj.id || '').trim(),
        transactionId: String(obj.id || '').trim(),
        customerId: String(obj.customer_id || '').trim(),
        subscriptionId: String(obj.subscription_id || '').trim(),
        amount: Number.isFinite(Number(obj.details?.totals?.total)) ? Number(obj.details.totals.total) : null,
      };
    }
    const meta = payload?.meta || {};
    const obj = payload?.data || {};
    const attrs = obj.attributes || {};
    const custom = meta.custom_data || attrs.custom_data || attrs.checkout_data?.custom || {};
    const eventName = String(meta.event_name || '').trim();
    const rawStatus = String(attrs.status || eventName || '').toUpperCase();
    const isPaid = eventName === 'order_created' || eventName === 'subscription_created' || rawStatus === 'PAID';
    const isFailed = rawStatus === 'FAILED' || rawStatus === 'EXPIRED' || rawStatus === 'CANCELLED' || rawStatus === 'CANCELED';
    return {
      status: isPaid ? 'PAID' : isFailed ? 'FAILED' : 'PENDING',
      rawStatus,
      outTradeNo: String(custom.out_trade_no || '').trim(),
      externalObjectId: String(obj.id || '').trim(),
      transactionId: String(attrs.order_number || obj.id || '').trim(),
      customerId: String(attrs.customer_id || '').trim(),
      subscriptionId: String(attrs.subscription_id || '').trim(),
      amount: Number.isFinite(Number(attrs.total)) ? Number(attrs.total) : null,
    };
  }

  private async createStripeCheckout(input: {
    app: AppRow;
    appSettings: AppSettingRow | null;
    providerType: SaasPaymentProviderType;
    method: ResolvedPaymentMethod;
    outTradeNo: string;
    amount: string;
    currency: string;
    subject: string;
    user: UserRow;
    product: PaymentProductRow;
  }) {
    const cfg = input.method.config;
    const secretKey = String(cfg.secret_key || '').trim();
    if (!secretKey) {
      throw new BadRequestException('Stripe secret_key 未配置');
    }
    const base = String(cfg.api_base_url || '').trim() || 'https://api.stripe.com';
    const body = new URLSearchParams();
    body.set('mode', 'payment');
    body.set('success_url', this.resolveSaasReturnUrl(input.app.slug, input.appSettings, cfg, 'success_url'));
    body.set('cancel_url', this.resolveSaasReturnUrl(input.app.slug, input.appSettings, cfg, 'cancel_url'));
    body.set('client_reference_id', input.outTradeNo);
    body.set('customer_email', input.user.email || '');
    body.set('metadata[out_trade_no]', input.outTradeNo);
    body.set('metadata[app_id]', input.app.id);
    body.set('metadata[user_id]', input.user.id);
    body.set('line_items[0][quantity]', '1');
    body.set('line_items[0][price_data][currency]', input.currency.toLowerCase());
    body.set('line_items[0][price_data][unit_amount]', String(this.amountToFen(input.amount)));
    body.set('line_items[0][price_data][product_data][name]', input.subject);
    const response = await fetch(`${base.replace(/\/+$/, '')}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `checkout:${input.outTradeNo}`,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const data = await this.readJsonResponse(response);
    if (!response.ok) {
      throw new BadRequestException(`Stripe checkout 创建失败: ${String(data.error?.message || response.status)}`);
    }
    return {
      external_object_id: String(data.id || ''),
      checkout_url: String(data.url || ''),
      raw_status: String(data.payment_status || data.status || ''),
      raw: data,
    };
  }

  private async createPaddleCheckout(input: {
    app: AppRow;
    appSettings: AppSettingRow | null;
    providerType: SaasPaymentProviderType;
    method: ResolvedPaymentMethod;
    outTradeNo: string;
    amount: string;
    currency: string;
    subject: string;
    user: UserRow;
    product: PaymentProductRow;
    externalPriceId?: string;
  }) {
    const cfg = input.method.config;
    const apiKey = String(cfg.api_key || '').trim();
    const priceId = String(input.externalPriceId || cfg.default_price_id || cfg.price_id || '').trim();
    if (!apiKey || !priceId) {
      throw new BadRequestException('Paddle api_key/default_price_id 未配置');
    }
    const base = String(cfg.api_base_url || '').trim() || 'https://sandbox-api.paddle.com';
    const response = await fetch(`${base.replace(/\/+$/, '')}/transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        custom_data: {
          out_trade_no: input.outTradeNo,
          app_id: input.app.id,
          user_id: input.user.id,
          product_id: input.product.id,
        },
        checkout: {
          url: this.resolveSaasReturnUrl(input.app.slug, input.appSettings, cfg, 'success_url'),
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await this.readJsonResponse(response);
    if (!response.ok) {
      throw new BadRequestException(`Paddle checkout 创建失败: ${String(data.error?.detail || data.error?.message || response.status)}`);
    }
    const entity = data.data || data;
    return {
      external_object_id: String(entity.id || ''),
      checkout_url: String(entity.checkout?.url || entity.checkout_url || entity.url || ''),
      raw_status: String(entity.status || ''),
      raw: data,
    };
  }

  private async createLemonSqueezyCheckout(input: {
    app: AppRow;
    appSettings: AppSettingRow | null;
    providerType: SaasPaymentProviderType;
    method: ResolvedPaymentMethod;
    outTradeNo: string;
    amount: string;
    currency: string;
    subject: string;
    user: UserRow;
    product: PaymentProductRow;
    externalVariantId?: string;
  }) {
    const cfg = input.method.config;
    const apiKey = String(cfg.api_key || '').trim();
    const storeId = String(cfg.store_id || '').trim();
    const variantId = String(input.externalVariantId || cfg.default_variant_id || cfg.variant_id || '').trim();
    if (!apiKey || !storeId || !variantId) {
      throw new BadRequestException('LemonSqueezy api_key/store_id/default_variant_id 未配置');
    }
    const base = String(cfg.api_base_url || '').trim() || 'https://api.lemonsqueezy.com';
    const response = await fetch(`${base.replace(/\/+$/, '')}/v1/checkouts`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            custom_price: this.amountToFen(input.amount),
            product_options: {
              name: input.subject,
              redirect_url: this.resolveSaasReturnUrl(input.app.slug, input.appSettings, cfg, 'success_url'),
            },
            checkout_data: {
              email: input.user.email || undefined,
              custom: {
                out_trade_no: input.outTradeNo,
                app_id: input.app.id,
                user_id: input.user.id,
                product_id: input.product.id,
              },
            },
          },
          relationships: {
            store: { data: { type: 'stores', id: storeId } },
            variant: { data: { type: 'variants', id: variantId } },
          },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await this.readJsonResponse(response);
    if (!response.ok) {
      throw new BadRequestException(`LemonSqueezy checkout 创建失败: ${String(data.errors?.[0]?.detail || response.status)}`);
    }
    const entity = data.data || data;
    return {
      external_object_id: String(entity.id || ''),
      checkout_url: String(entity.attributes?.url || entity.url || ''),
      raw_status: String(entity.attributes?.status || ''),
      raw: data,
    };
  }

  private resolveApiBaseUrl(appSettings: AppSettingRow | null) {
    const extra = this.asConfigMap(appSettings?.extra_json);
    const candidates = [
      String(extra.api_base_url || ''),
      String(extra.api_url || ''),
      String(appSettings?.api_domain || ''),
      this.runtimePaymentSettings.apiBaseUrl,
      String(process.env.API_BASE_URL || ''),
    ];
    for (const candidate of candidates) {
      const normalized = this.normalizeBaseUrl(candidate);
      if (normalized) {
        return normalized;
      }
    }
    throw new BadRequestException('API base URL is not configured');
  }

  private resolveUserWebBaseUrl(appSlug: string, appSettings: AppSettingRow | null) {
    const allowLocal = this.allowLocalReturnUrl();
    const extra = this.asConfigMap(appSettings?.extra_json);
    const useGlobalFallbacks = appSlug === this.config.app.defaultSlug;
    const candidates = [
      String(extra.payment_return_base_url || ''),
      String(extra.user_web_base_url || ''),
      String(extra.web_base_url || ''),
      String(appSettings?.user_web_domain || ''),
      String(appSettings?.app_url || ''),
      this.runtimePaymentSettings.paymentReturnBaseUrl,
      this.runtimePaymentSettings.userWebBaseUrl,
      ...(useGlobalFallbacks
        ? [
            String(process.env.USER_WEB_BASE_URL || ''),
            String(process.env.PAYMENT_RETURN_BASE_URL || ''),
            String(process.env.WEB_APP_URL || ''),
          ]
        : []),
    ];
    for (const candidate of candidates) {
      const normalized = this.normalizeBaseUrl(candidate);
      if (normalized && this.isAcceptableReturnUrl(normalized, allowLocal)) {
        return normalized;
      }
    }
    const fallback = this.resolveApiBaseUrl(appSettings);
    this.logger.warn(`fallback user web base url to api base for payment return app=${appSlug}: ${fallback}`);
    return fallback;
  }

  private resolveTradeReturnMode(appSettings: AppSettingRow | null): 'redirect' | 'inline' {
    const extra = this.asConfigMap(appSettings?.extra_json);
    const modeRaw = String(extra.payment_return_mode || '').trim().toLowerCase();
    if (modeRaw === 'redirect') {
      return 'redirect';
    }
    return 'inline';
  }

  private resolveTradeNotifyUrl(appSlug: string, appSettings: AppSettingRow | null, cfgOverride?: EffectiveAlipayConfig) {
    const override = String((cfgOverride || this.alipayConfig()).notifyUrl || '').trim();
    if (override) return override;
    if (appSettings?.alipay_notify_url) return appSettings.alipay_notify_url;
    const base = this.resolveApiBaseUrl(appSettings);
    return `${base.replace(/\/+$/, '')}/${appSlug}/v1/payments/callbacks/trade-notify`;
  }

  private resolveTradeReturnUrl(appSlug: string, appSettings: AppSettingRow | null, cfgOverride?: EffectiveAlipayConfig) {
    const override = String((cfgOverride || this.alipayConfig()).returnUrl || '').trim();
    const allowLocal = this.allowLocalReturnUrl();
    if (this.isAcceptableReturnUrl(override, allowLocal)) return override;
    if (override) {
      this.logger.warn(`ignore unsafe alipay return_url: ${override}`);
    }
    const base = this.resolveApiBaseUrl(appSettings);
    return `${base.replace(/\/+$/, '')}/${appSlug}/v1/payments/callbacks/trade-return`;
  }

  private resolveAgreementNotifyUrl(appSlug: string, appSettings: AppSettingRow | null) {
    const override = String(this.alipayConfig().agreementNotifyUrl || '').trim();
    if (override) return override;
    if (appSettings?.alipay_agreement_notify_url) return appSettings.alipay_agreement_notify_url;
    const base = this.resolveApiBaseUrl(appSettings);
    return `${base.replace(/\/+$/, '')}/${appSlug}/v1/payments/callbacks/agreement-notify`;
  }

  private resolveAgreementReturnUrl(appSlug: string, appSettings: AppSettingRow | null) {
    const override = String(this.alipayConfig().agreementReturnUrl || '').trim();
    const allowLocal = this.allowLocalReturnUrl();
    if (this.isAcceptableReturnUrl(override, allowLocal)) return override;
    if (override) {
      this.logger.warn(`ignore unsafe alipay agreement_return_url: ${override}`);
    }
    const base = this.resolveUserWebBaseUrl(appSlug, appSettings);
    if (this.isAcceptableReturnUrl(base, allowLocal)) {
      return `${base.replace(/\/+$/, '')}/payment/agreement/success`;
    }
    return `${base.replace(/\/+$/, '')}/payment/agreement/success`;
  }

  private allowLocalReturnUrl() {
    if (this.runtimePaymentSettings.allowLocalReturnUrl !== null) {
      return this.runtimePaymentSettings.allowLocalReturnUrl;
    }
    const env = String(process.env.NODE_ENV || '').trim().toLowerCase();
    const flag = String(process.env.ALLOW_LOCAL_RETURN_URL || '').trim().toLowerCase();
    return env === 'development' || env === 'dev' || flag === 'true' || flag === '1';
  }

  private isAcceptableReturnUrl(rawUrl: string, allowLocal: boolean) {
    const url = String(rawUrl || '').trim();
    if (!url) return false;
    try {
      const parsed = new URL(url);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:') {
        return false;
      }
      if (!allowLocal && this.isLocalHostname(parsed.hostname)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private isLocalHostname(hostname: string) {
    const host = String(hostname || '').trim().toLowerCase();
    if (!host) return true;
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]') {
      return true;
    }
    if (host === '127.0.0.1' || host.startsWith('127.')) {
      return true;
    }
    return false;
  }

  private resolveWechatNotifyUrl(appSlug: string, appSettings: AppSettingRow | null, cfgOverride?: EffectiveWechatPayConfig) {
    const override = String((cfgOverride || this.wechatPayConfig()).notifyUrl || '').trim();
    if (override) return override;
    const base = this.resolveApiBaseUrl(appSettings);
    return `${base.replace(/\/+$/, '')}/${appSlug}/v1/payments/callbacks/wechat-notify`;
  }

  private buildAlipayPagePayForm(input: {
    appSlug: string;
    appSettings: AppSettingRow | null;
    outTradeNo: string;
    amount: string;
    subject: string;
    cfg?: EffectiveAlipayConfig;
  }) {
    const bizContent = {
      out_trade_no: input.outTradeNo,
      total_amount: input.amount,
      subject: input.subject,
      product_code: 'FAST_INSTANT_TRADE_PAY',
    };
    const params = this.buildAlipaySignedParams(
      'alipay.trade.page.pay',
      bizContent,
      {
        notify_url: this.resolveTradeNotifyUrl(input.appSlug, input.appSettings, input.cfg),
        return_url: this.resolveTradeReturnUrl(input.appSlug, input.appSettings, input.cfg),
      },
      input.cfg,
    );
    return this.buildAlipayFormHtml(params, input.cfg);
  }

  private buildAlipayAgreementSignForm(input: {
    appSlug: string;
    appSettings: AppSettingRow | null;
    externalAgreementNo: string;
    executeTime: string;
    product: PaymentProductRow;
  }) {
    const periodType = String(input.product.period_type || '').trim().toUpperCase() || 'MONTH';
    const period = Math.max(Number(input.product.period || 1), 1);
    const signValidityPeriod = Math.max(Number(input.product.sign_validity_period || 365), 1);
    const bizContent: Record<string, unknown> = {
      product_code: 'CYCLE_PAY_AUTH',
      sign_scene: input.product.sign_scene || 'INDUSTRY|DIGITAL_MEDIA',
      external_agreement_no: input.externalAgreementNo,
      sign_validity_period: String(signValidityPeriod),
      period_rule_params: {
        period_type: periodType,
        period: String(period),
        execute_time: input.executeTime,
        single_amount: this.formatAmount(input.product.amount),
      },
    };
    const params = this.buildAlipaySignedParams('alipay.user.agreement.page.sign', bizContent, {
      notify_url: this.resolveAgreementNotifyUrl(input.appSlug, input.appSettings),
      return_url: this.resolveAgreementReturnUrl(input.appSlug, input.appSettings),
    });
    return this.buildAlipayFormHtml(params);
  }

  private buildAlipaySignedParams(
    method: string,
    bizContent: Record<string, unknown>,
    extras?: Record<string, string>,
    cfgOverride?: EffectiveAlipayConfig,
  ) {
    const cfg = cfgOverride || this.alipayConfig();
    if (!this.isResolvedAlipayConfigured(cfg)) {
      throw new BadRequestException('支付宝配置不完整');
    }
    const timestamp = this.formatAlipayTimestamp(new Date());
    const params: Record<string, string> = {
      app_id: String(cfg.appId || ''),
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: String(cfg.signType || 'RSA2').toUpperCase(),
      timestamp,
      version: '1.0',
      biz_content: JSON.stringify(bizContent),
      ...(extras || {}),
    };
    const sign = this.signAlipayParams(params, cfg);
    return {
      ...params,
      sign,
    };
  }

  private signAlipayParams(params: Record<string, string>, cfgOverride?: EffectiveAlipayConfig) {
    const signContent = this.buildAlipaySignContent(params);
    const cfg = cfgOverride || this.alipayConfig();
    const signer = createSign(this.resolveAlipaySignAlgorithm(String(cfg.signType || 'RSA2')));
    signer.update(signContent, 'utf8');
    signer.end();
    const privateKey = this.resolveAlipayPrivateKey(String(cfg.privateKey || ''));
    try {
      return signer.sign(privateKey, 'base64');
    } catch (error: any) {
      const reason = String(error?.message || '').slice(0, 200) || 'unknown error';
      throw new BadRequestException(`ALIPAY_APP_PRIVATE_KEY 签名失败（${reason}）`);
    }
  }

  private buildAlipaySignContent(params: Record<string, string>) {
    return Object.keys(params)
      .filter((key) => key !== 'sign' && params[key] !== undefined && params[key] !== null && `${params[key]}` !== '')
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');
  }

  private verifyAlipayNotifySignature(payload: Record<string, unknown>, cfgOverride?: EffectiveAlipayConfig) {
    const sign = String(payload.sign || '').trim();
    if (!sign) {
      return false;
    }
    const cfg = cfgOverride || this.alipayConfig();
    const publicKey = this.normalizePem(cfg.alipayPublicKey);
    if (!publicKey) {
      return false;
    }
    const plain: Record<string, string> = {};
    Object.keys(payload || {}).forEach((key) => {
      if (key === 'sign' || key === 'sign_type') return;
      const value = payload[key];
      if (value === null || value === undefined) return;
      plain[key] = String(value);
    });
    const signContent = this.buildAlipaySignContent(plain);
    const signType = String(payload.sign_type || cfg.signType || 'RSA2');
    try {
      const verifier = createVerify(this.resolveAlipaySignAlgorithm(signType));
      verifier.update(signContent, 'utf8');
      verifier.end();
      return verifier.verify(publicKey, sign, 'base64');
    } catch (error: any) {
      this.logger.warn(`alipay signature verify error: ${error?.message || 'unknown error'}`);
      return false;
    }
  }

  private async getOrderByOutTradeNo(appId: string, outTradeNo: string): Promise<OrderRow | null> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM alipay_orders
       WHERE app_id = $1::uuid AND out_trade_no = $2
       LIMIT 1`,
      appId,
      outTradeNo,
    ) as Promise<OrderRow[]>);
    return rows[0] || null;
  }

  private resolveAlipaySignAlgorithm(signTypeRaw: string) {
    const signType = String(signTypeRaw || '').trim().toUpperCase();
    return signType === 'RSA' ? 'RSA-SHA1' : 'RSA-SHA256';
  }

  private buildAlipayFormHtml(params: Record<string, string>, cfgOverride?: EffectiveAlipayConfig) {
    const inputs = Object.entries(params)
      .map(([key, value]) => `<input type="hidden" name="${this.escapeHtml(key)}" value="${this.escapeHtml(value)}"/>`)
      .join('');
    return `<form id="alipaysubmit" name="alipaysubmit" action="${this.escapeHtml(
      this.alipayGatewayUrl(cfgOverride),
    )}?charset=utf-8" method="POST">${inputs}<input type="submit" value="ok" style="display:none"/></form><script>document.forms['alipaysubmit'].submit();</script>`;
  }

  private escapeHtml(value: string) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private formatAlipayTimestamp(date: Date) {
    const y = date.getFullYear();
    const m = `${date.getMonth() + 1}`.padStart(2, '0');
    const d = `${date.getDate()}`.padStart(2, '0');
    const hh = `${date.getHours()}`.padStart(2, '0');
    const mm = `${date.getMinutes()}`.padStart(2, '0');
    const ss = `${date.getSeconds()}`.padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  }

  private async alipayExecuteRequest(method: string, bizContent: Record<string, unknown>, cfgOverride?: EffectiveAlipayConfig) {
    const params = this.buildAlipaySignedParams(method, bizContent, undefined, cfgOverride);
    const body = new URLSearchParams(params);
    const response = await fetch(this.alipayGatewayUrl(cfgOverride), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: body.toString(),
    });
    const text = await response.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BadRequestException(`支付宝网关响应解析失败: ${text.slice(0, 240)}`);
    }

    const responseKey =
      Object.keys(parsed).find((key) => key.endsWith('_response')) ||
      `${method.replace(/\./g, '_')}_response`;
    const content = (parsed[responseKey] || parsed) as Record<string, any>;
    return {
      raw: parsed,
      content,
    };
  }

  private amountToFen(amount: string) {
    return Math.round(Number(amount) * 100);
  }

  private fenToAmount(fen: number) {
    return this.formatAmount(Number(fen || 0) / 100);
  }

  private normalizePointsValue(value: unknown, field: string) {
    if (value === null || value === undefined || value === '') {
      return 0;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new BadRequestException(`${field} must be an integer >= 0`);
    }
    return Math.floor(parsed);
  }

  private toSafeInteger(value: unknown) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return Math.floor(parsed);
  }

  private async refundOrderPointsIfNeeded(appId: string, orderId: string) {
    const reservationToken = `PROCESSING:${this.genUuid()}`;
    const reservedRows = await this.prisma.$transaction(async (tx) => {
      const rows = await (tx.$queryRawUnsafe(
        `SELECT *
         FROM alipay_orders
         WHERE app_id = $1::uuid AND id = $2::uuid
         FOR UPDATE`,
        appId,
        orderId,
      ) as Promise<OrderRow[]>);
      const order = rows[0];
      if (!order) {
        return [] as OrderRow[];
      }

      const status = String(order.status || '').toUpperCase();
      const refundStatus = String(order.points_refund_status || 'NONE').toUpperCase();
      const deductedPoints = this.toSafeInteger(order.points_deduct_points);
      if ((status !== 'FAILED' && status !== 'CLOSED') || deductedPoints <= 0) {
        return [] as OrderRow[];
      }
      if (refundStatus === 'SUCCESS' || refundStatus === 'PROCESSING') {
        return [] as OrderRow[];
      }
      if (String(order.points_refund_ledger_id || '').trim()) {
        return [] as OrderRow[];
      }

      await tx.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET points_refund_status = 'PROCESSING',
             points_refund_ledger_id = $1,
             updated_at = now()
         WHERE app_id = $2::uuid AND id = $3::uuid`,
        reservationToken,
        appId,
        orderId,
      );

      return [
        {
          ...order,
          points_refund_status: 'PROCESSING',
          points_refund_ledger_id: reservationToken,
        },
      ];
    });

    const reserved = reservedRows[0];
    if (!reserved) {
      return;
    }

    const deductedPoints = this.toSafeInteger(reserved.points_deduct_points);
    try {
      const refund = await this.aiPointsService.creditPoints({
        app_id: reserved.app_id,
        user_id: reserved.user_id,
        amount: deductedPoints,
        event_type: 'order_points_refund',
        reference_type: 'payment_order',
        reference_id: `${reserved.out_trade_no}:refund`,
        metadata: {
          order_id: reserved.id,
          out_trade_no: reserved.out_trade_no,
          original_amount: this.formatAmount(reserved.original_amount ?? reserved.total_amount),
          payable_amount: this.formatAmount(reserved.payable_amount ?? reserved.total_amount),
          refunded_points: deductedPoints,
          refunded_amount: this.formatAmount(reserved.points_deduct_amount || 0),
        },
      });

      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET points_refund_status = 'SUCCESS',
             points_refund_ledger_id = $1,
             updated_at = now()
         WHERE app_id = $2::uuid
           AND id = $3::uuid
           AND points_refund_ledger_id = $4`,
        refund.ledger_id || null,
        reserved.app_id,
        reserved.id,
        reservationToken,
      );
    } catch (error: any) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET points_refund_status = 'NONE',
             points_refund_ledger_id = NULL,
             updated_at = now()
         WHERE app_id = $1::uuid
           AND id = $2::uuid
           AND points_refund_ledger_id = $3`,
        reserved.app_id,
        reserved.id,
        reservationToken,
      );
      this.logger.error(
        `refund order points failed app=${reserved.app_id} order=${reserved.id} out_trade_no=${reserved.out_trade_no}: ${
          error?.message || 'unknown error'
        }`,
      );
    }
  }

  private async grantOrderTopupPointsByTradeNoIfNeeded(app: AppRow, outTradeNo: string) {
    const normalizedOutTradeNo = String(outTradeNo || '').trim();
    if (!normalizedOutTradeNo) {
      return;
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
       FROM alipay_orders
       WHERE app_id = $1::uuid AND out_trade_no = $2
       LIMIT 1`,
      app.id,
      normalizedOutTradeNo,
    ) as Promise<Array<{ id: string }>>);
    const orderId = rows[0]?.id;
    if (!orderId) {
      return;
    }
    await this.grantOrderTopupPointsIfNeeded(app, orderId);
  }

  private async grantOrderTopupPointsIfNeeded(app: AppRow, orderId: string) {
    const reservationToken = `PROCESSING:${this.genUuid()}`;
    const staleProcessingThresholdMs = 5 * 60 * 1000;
    const reservedRows = await this.prisma.$transaction(async (tx) => {
      const rows = await (tx.$queryRawUnsafe(
        `SELECT *
         FROM alipay_orders
         WHERE app_id = $1::uuid AND id = $2::uuid
         FOR UPDATE`,
        app.id,
        orderId,
      ) as Promise<OrderRow[]>);
      const order = rows[0];
      if (!order) {
        return [] as OrderRow[];
      }

      const status = String(order.status || '').toUpperCase();
      if (status !== 'PAID') {
        return [] as OrderRow[];
      }
      const topupStatus = String(order.points_topup_status || 'NONE').toUpperCase();
      const existingTopupLedgerId = String(order.points_topup_ledger_id || '').trim();
      if (topupStatus === 'SUCCESS') {
        if (existingTopupLedgerId) {
          return [] as OrderRow[];
        }
        await tx.$executeRawUnsafe(
          `UPDATE alipay_orders
           SET points_topup_status = 'NONE',
               updated_at = now()
           WHERE app_id = $1::uuid AND id = $2::uuid`,
          app.id,
          orderId,
        );
      }
      if (topupStatus === 'PROCESSING') {
        const isProcessingToken = existingTopupLedgerId.startsWith('PROCESSING:');
        const updatedAtMs = order.updated_at ? new Date(order.updated_at).getTime() : 0;
        const isStaleProcessing = updatedAtMs > 0 && Date.now() - updatedAtMs >= staleProcessingThresholdMs;
        if (!isProcessingToken || !isStaleProcessing) {
          return [] as OrderRow[];
        }
        await tx.$executeRawUnsafe(
          `UPDATE alipay_orders
           SET points_topup_status = 'NONE',
               points_topup_ledger_id = NULL,
               updated_at = now()
           WHERE app_id = $1::uuid AND id = $2::uuid`,
          app.id,
          orderId,
        );
      } else if (existingTopupLedgerId) {
        return [] as OrderRow[];
      }
      const productRows = await (tx.$queryRawUnsafe(
        `SELECT *
         FROM payment_products
         WHERE app_id = $1::uuid AND id = $2::uuid
         LIMIT 1`,
        app.id,
        order.product_id,
      ) as Promise<PaymentProductRow[]>);
      const product = productRows[0] || null;
      if (!this.isSystemPointsTopupProduct(product)) {
        if (this.toSafeInteger(order.points_topup_points) !== 0 || topupStatus !== 'NONE' || existingTopupLedgerId) {
          await tx.$executeRawUnsafe(
            `UPDATE alipay_orders
             SET points_topup_points = 0,
                 points_topup_status = 'NONE',
                 points_topup_ledger_id = NULL,
                 updated_at = now()
             WHERE app_id = $1::uuid AND id = $2::uuid`,
            app.id,
            orderId,
          );
        }
        return [] as OrderRow[];
      }

      const settings = await this.aiPointsService.getSettingsByAppId(app.id);
      const pointsPerYuan = this.normalizePointsPerYuan(settings.points_per_yuan);
      const topupPoints = this.calculateTopupPointsByAmount(this.formatAmount(order.total_amount), pointsPerYuan);
      if (this.toSafeInteger(order.points_topup_points) !== topupPoints) {
        await tx.$executeRawUnsafe(
          `UPDATE alipay_orders
           SET points_topup_points = $1::bigint,
               updated_at = now()
           WHERE app_id = $2::uuid AND id = $3::uuid`,
          topupPoints,
          app.id,
          orderId,
        );
      }
      if (topupPoints <= 0) {
        if (topupStatus !== 'NONE') {
          await tx.$executeRawUnsafe(
            `UPDATE alipay_orders
             SET points_topup_status = 'NONE',
                 points_topup_ledger_id = NULL,
                 updated_at = now()
             WHERE app_id = $1::uuid AND id = $2::uuid`,
            app.id,
            orderId,
          );
        }
        return [] as OrderRow[];
      }

      await tx.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET points_topup_status = 'PROCESSING',
             points_topup_ledger_id = $1,
             updated_at = now()
         WHERE app_id = $2::uuid AND id = $3::uuid`,
        reservationToken,
        app.id,
        orderId,
      );

      return [
        {
          ...order,
          points_topup_points: topupPoints,
          points_topup_status: 'PROCESSING',
          points_topup_ledger_id: reservationToken,
        },
      ];
    });

    const reserved = reservedRows[0];
    if (!reserved) {
      return;
    }

    const topupPoints = this.toSafeInteger(reserved.points_topup_points);
    const product = await this.getProductById(reserved.app_id, reserved.product_id);
    const topupReferenceId = `${reserved.out_trade_no}:topup`;
    try {
      const existingLedgerRows = await (this.prisma.$queryRawUnsafe(
        `SELECT id
         FROM user_ai_points_ledger
         WHERE app_id = $1::uuid
           AND user_id = $2::uuid
           AND event_type = 'order_points_topup'
           AND reference_type = 'payment_order'
           AND reference_id = $3
         ORDER BY created_at DESC
         LIMIT 1`,
        reserved.app_id,
        reserved.user_id,
        topupReferenceId,
      ) as Promise<Array<{ id: string }>>);
      const existingLedgerId = existingLedgerRows[0]?.id;
      if (existingLedgerId) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE alipay_orders
           SET points_topup_status = 'SUCCESS',
               points_topup_ledger_id = $1,
               updated_at = now()
           WHERE app_id = $2::uuid
             AND id = $3::uuid
             AND points_topup_ledger_id = $4`,
          existingLedgerId,
          reserved.app_id,
          reserved.id,
          reservationToken,
        );
        return;
      }
    } catch (_error) {
      // Keep compatibility when ai points ledger schema is not initialized yet.
    }
    try {
      const credit = await this.aiPointsService.creditPoints({
        app_id: reserved.app_id,
        user_id: reserved.user_id,
        amount: topupPoints,
        event_type: 'order_points_topup',
        reference_type: 'payment_order',
        reference_id: topupReferenceId,
        metadata: {
          order_id: reserved.id,
          out_trade_no: reserved.out_trade_no,
          product_id: reserved.product_id,
          product_name: product?.name || null,
          payment_type: reserved.payment_type,
          topup_points: topupPoints,
          amount: this.formatAmount(reserved.total_amount),
        },
      });

      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET points_topup_status = 'SUCCESS',
             points_topup_ledger_id = $1,
             updated_at = now()
         WHERE app_id = $2::uuid
           AND id = $3::uuid
           AND points_topup_ledger_id = $4`,
        credit.ledger_id || null,
        reserved.app_id,
        reserved.id,
        reservationToken,
      );
    } catch (error: any) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE alipay_orders
         SET points_topup_status = 'NONE',
             points_topup_ledger_id = NULL,
             updated_at = now()
         WHERE app_id = $1::uuid
           AND id = $2::uuid
           AND points_topup_ledger_id = $3`,
        reserved.app_id,
        reserved.id,
        reservationToken,
      );
      this.logger.error(
        `topup order points failed app=${app.slug} order=${reserved.id} out_trade_no=${reserved.out_trade_no}: ${
          error?.message || 'unknown error'
        }`,
      );
    }
  }

  private wechatGatewayUrl() {
    const base = String(this.wechatPayConfig().gatewayUrl || '').trim() || 'https://api.mch.weixin.qq.com';
    return base.replace(/\/+$/, '');
  }

  private buildWechatSign(data: Record<string, string>, apiKey: string) {
    const stringA = Object.keys(data)
      .filter((key) => key !== 'sign' && data[key] !== undefined && data[key] !== null && data[key] !== '')
      .sort()
      .map((key) => `${key}=${data[key]}`)
      .join('&');
    const stringSignTemp = `${stringA}&key=${apiKey}`;
    return createHash('md5').update(stringSignTemp, 'utf8').digest('hex').toUpperCase();
  }

  private buildWechatXml(data: Record<string, unknown>) {
    const fields = Object.entries(data)
      .filter(([key, value]) => key && value !== undefined && value !== null)
      .map(([key, value]) => `<${key}><![CDATA[${String(value)}]]></${key}>`)
      .join('');
    return `<xml>${fields}</xml>`;
  }

  private parseWechatXml(xml: string): Record<string, string> {
    const payload: Record<string, string> = {};
    if (!xml || typeof xml !== 'string') {
      return payload;
    }
    const cdataPattern = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>/gs;
    let match: RegExpExecArray | null;
    while ((match = cdataPattern.exec(xml)) !== null) {
      payload[match[1]] = match[2];
    }
    const plainPattern = /<(\w+)>([^<]+)<\/\1>/gs;
    while ((match = plainPattern.exec(xml)) !== null) {
      if (!(match[1] in payload)) {
        payload[match[1]] = match[2];
      }
    }
    return payload;
  }

  private verifyWechatSign(payload: Record<string, string>, apiKeyOverride?: string) {
    const provided = String(payload.sign || '').trim().toUpperCase();
    if (!provided) return false;
    const apiKey = String(apiKeyOverride || this.wechatPayConfig().apiKey || '').trim();
    if (!apiKey) return false;
    const expected = this.buildWechatSign(payload, apiKey);
    return expected === provided;
  }

  private async wechatUnifiedOrder(input: {
    appId: string;
    mchId: string;
    apiKey: string;
    outTradeNo: string;
    body: string;
    totalFee: number;
    notifyUrl: string;
    clientIp: string;
  }) {
    const payload: Record<string, string> = {
      appid: input.appId,
      mch_id: input.mchId,
      nonce_str: randomBytes(12).toString('hex'),
      body: input.body.slice(0, 64),
      out_trade_no: input.outTradeNo,
      total_fee: String(Math.max(Math.floor(input.totalFee), 1)),
      spbill_create_ip: input.clientIp,
      notify_url: input.notifyUrl,
      trade_type: 'NATIVE',
    };
    payload.sign = this.buildWechatSign(payload, input.apiKey);
    const response = await fetch(`${this.wechatGatewayUrl()}/pay/unifiedorder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
      },
      body: this.buildWechatXml(payload),
    });
    const text = await response.text();
    return this.parseWechatXml(text);
  }

  private async wechatOrderQuery(input: { appId: string; mchId: string; apiKey: string; outTradeNo: string }) {
    const payload: Record<string, string> = {
      appid: input.appId,
      mch_id: input.mchId,
      out_trade_no: input.outTradeNo,
      nonce_str: randomBytes(12).toString('hex'),
    };
    payload.sign = this.buildWechatSign(payload, input.apiKey);
    const response = await fetch(`${this.wechatGatewayUrl()}/pay/orderquery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
      },
      body: this.buildWechatXml(payload),
    });
    const text = await response.text();
    return this.parseWechatXml(text);
  }

  private normalizeProductPayload(
    payload: Record<string, unknown>,
    isCreate: boolean,
    existing?: PaymentProductRow,
  ): {
    code: string;
    name: string;
    description: string | null;
    type: ProductType;
    status: ProductStatus;
    amount: string;
    membership_days: number;
    points_topup: number;
    sign_scene: string | null;
    sign_validity_period: number | null;
    period_type: PeriodType | null;
    period: number | null;
    execute_time: string | null;
  } {
    const codeRaw = payload.code !== undefined ? String(payload.code || '').trim() : existing?.code || '';
    const nameRaw = payload.name !== undefined ? String(payload.name || '').trim() : existing?.name || '';
    const descriptionRaw =
      payload.description !== undefined
        ? this.nullableString(payload.description)
        : this.nullableString(existing?.description || null);
    const typeRaw = payload.type !== undefined ? String(payload.type || '').trim().toUpperCase() : existing?.type || 'ONE_TIME';
    const statusRaw =
      payload.status !== undefined ? String(payload.status || '').trim().toUpperCase() : existing?.status || 'ACTIVE';
    const amountRaw = payload.amount !== undefined ? payload.amount : existing?.amount;
    const membershipDaysRaw = payload.membership_days !== undefined ? payload.membership_days : existing?.membership_days;
    const pointsTopupRaw = payload.points_topup !== undefined ? payload.points_topup : existing?.points_topup;
    const signSceneRaw = payload.sign_scene !== undefined ? this.nullableString(payload.sign_scene) : this.nullableString(existing?.sign_scene || null);
    const signValidityRaw =
      payload.sign_validity_period !== undefined
        ? Number(payload.sign_validity_period)
        : existing?.sign_validity_period === null || existing?.sign_validity_period === undefined
          ? null
          : Number(existing.sign_validity_period);
    const periodTypeRaw =
      payload.period_type !== undefined
        ? String(payload.period_type || '').trim().toUpperCase()
        : String(existing?.period_type || '').trim().toUpperCase();
    const periodRaw =
      payload.period !== undefined
        ? Number(payload.period)
        : existing?.period === null || existing?.period === undefined
          ? null
          : Number(existing.period);
    const executeTimeRaw =
      payload.execute_time !== undefined
        ? this.normalizeExecuteTime(payload.execute_time)
        : this.normalizeExecuteTime(existing?.execute_time || null);

    if (isCreate && !codeRaw) {
      throw new BadRequestException('code is required');
    }
    if (!nameRaw) {
      throw new BadRequestException('name is required');
    }

    const type = (typeRaw || 'ONE_TIME') as ProductType;
    if (type !== 'ONE_TIME' && type !== 'RECURRING') {
      throw new BadRequestException('type must be ONE_TIME or RECURRING');
    }
    const status = (statusRaw || 'ACTIVE') as ProductStatus;
    if (status !== 'ACTIVE' && status !== 'INACTIVE') {
      throw new BadRequestException('status must be ACTIVE or INACTIVE');
    }
    const amount = this.normalizeAmount(amountRaw, 'amount');
    const membershipDays = Math.max(Math.floor(Number(membershipDaysRaw || 0)), 0);
    const pointsTopup = this.normalizePointsValue(pointsTopupRaw, 'points_topup');

    let periodType: PeriodType | null = null;
    let period: number | null = null;
    let signValidity: number | null = null;
    if (type === 'RECURRING') {
      const normalizedPeriodType = (periodTypeRaw || '').toUpperCase();
      if (!normalizedPeriodType || !['DAY', 'WEEK', 'MONTH', 'YEAR'].includes(normalizedPeriodType)) {
        throw new BadRequestException('周期商品必须配置 period_type (DAY/WEEK/MONTH/YEAR)');
      }
      const normalizedPeriod = Math.floor(Number(periodRaw || 0));
      if (!Number.isFinite(normalizedPeriod) || normalizedPeriod <= 0) {
        throw new BadRequestException('周期商品必须配置 period 且 > 0');
      }
      periodType = normalizedPeriodType as PeriodType;
      period = normalizedPeriod;
      if (signValidityRaw !== null && signValidityRaw !== undefined) {
        if (!Number.isFinite(signValidityRaw) || signValidityRaw <= 0) {
          throw new BadRequestException('sign_validity_period must be positive integer');
        }
        signValidity = Math.floor(signValidityRaw);
      } else {
        signValidity = 365;
      }
    }

    return {
      code: codeRaw,
      name: nameRaw,
      description: descriptionRaw,
      type,
      status,
      amount,
      membership_days: membershipDays,
      points_topup: pointsTopup,
      sign_scene: signSceneRaw,
      sign_validity_period: signValidity,
      period_type: periodType,
      period,
      execute_time: executeTimeRaw,
    };
  }

  private serializeProduct(row: PaymentProductRow) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description || '',
      type: String(row.type || 'ONE_TIME').toUpperCase(),
      status: String(row.status || 'ACTIVE').toUpperCase(),
      amount: this.formatAmount(row.amount),
      currency: row.currency || 'CNY',
      membership_days: Number(row.membership_days || 0),
      points_topup: Number(row.points_topup || 0),
      sign_scene: row.sign_scene,
      sign_validity_period: row.sign_validity_period,
      period_type: row.period_type,
      period: row.period,
      execute_time: row.execute_time,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private normalizeAmount(value: unknown, field: string): string {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      throw new BadRequestException(`${field} must be a valid number >= 0`);
    }
    return num.toFixed(2);
  }

  private normalizeOrderAmount(value: unknown, field: string): string {
    const amount = this.normalizeAmount(value, field);
    if (Number(amount) <= 0) {
      throw new BadRequestException(`${field} must be > 0`);
    }
    return amount;
  }

  private normalizePointsPerYuan(value: unknown): number {
    const parsed = this.toSafeInteger(value);
    if (parsed > 0) {
      return parsed;
    }
    return DEFAULT_POINTS_PER_YUAN;
  }

  private calculateTopupPointsByAmount(amount: string, pointsPerYuan: number): number {
    const safeRate = this.normalizePointsPerYuan(pointsPerYuan);
    const fen = this.amountToFen(amount);
    if (fen <= 0 || safeRate <= 0) {
      return 0;
    }
    const calculated = Math.floor((fen * safeRate) / 100);
    return calculated > 0 ? calculated : 1;
  }

  private isSystemPointsTopupProduct(product: PaymentProductRow | null | undefined): boolean {
    if (!product) {
      return false;
    }
    if (String(product.type || '').toUpperCase() !== 'ONE_TIME') {
      return false;
    }
    return String(product.code || '').trim().toUpperCase() === DEFAULT_POINTS_TOPUP_PRODUCT_CODE;
  }

  private tryFormatAmount(value: unknown): string | null {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return null;
    }
    return num.toFixed(2);
  }

  private formatAmount(value: unknown): string {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return '0.00';
    }
    return num.toFixed(2);
  }

  private resolveDashboardRange(value: string | undefined): {
    rangeKey: 'realtime' | '1d' | '7d' | '30d';
    from: Date;
    to: Date;
    bucketCount: number;
    labelMode: 'time' | 'date';
  } {
    const normalized = String(value || '').trim().toLowerCase();
    const now = new Date();
    const todayStart = this.getShanghaiDayStart(now);
    if (normalized === '1d') {
      const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayEnd = new Date(todayStart.getTime() - 1);
      return {
        rangeKey: '1d',
        from: yesterdayStart,
        to: yesterdayEnd,
        bucketCount: 24,
        labelMode: 'time',
      };
    }
    if (normalized === '7d') {
      return {
        rangeKey: '7d',
        from: new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000),
        to: now,
        bucketCount: 7,
        labelMode: 'date',
      };
    }
    if (normalized === '30d') {
      return {
        rangeKey: '30d',
        from: new Date(todayStart.getTime() - 29 * 24 * 60 * 60 * 1000),
        to: now,
        bucketCount: 30,
        labelMode: 'date',
      };
    }
    const realtimeBucketCount = Math.max(
      1,
      Math.min(24, Math.ceil((now.getTime() - todayStart.getTime()) / (60 * 60 * 1000))),
    );
    return {
      rangeKey: 'realtime',
      from: todayStart,
      to: now,
      bucketCount: realtimeBucketCount,
      labelMode: 'time',
    };
  }

  private buildDashboardTrend(
    rows: DashboardTrendOrderRow[],
    from: Date,
    to: Date,
    bucketCount: number,
    labelMode: 'time' | 'date',
  ) {
    const safeBucketCount = Math.max(1, Math.floor(bucketCount));
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const durationMs = Math.max(1, toMs - fromMs);
    const stepMs = Math.max(1, Math.floor(durationMs / safeBucketCount));
    const buckets = Array.from({ length: safeBucketCount }, (_, index) => ({
      startMs: fromMs + index * stepMs,
      amount: 0,
    }));

    rows.forEach((row) => {
      const tsMs = row.ts instanceof Date ? row.ts.getTime() : Number.NaN;
      if (!Number.isFinite(tsMs) || tsMs < fromMs || tsMs > toMs) {
        return;
      }
      const rawIndex = Math.floor((tsMs - fromMs) / stepMs);
      const index = Math.min(Math.max(rawIndex, 0), safeBucketCount - 1);
      buckets[index].amount += Number(row.amount || 0);
    });

    return buckets.map((bucket) => {
      const date = new Date(bucket.startMs);
      return {
        key: date.toISOString(),
        label: this.formatDashboardTrendLabel(date, labelMode),
        gross_amount: this.formatAmount(bucket.amount),
      };
    });
  }

  private formatDashboardTrendLabel(date: Date, labelMode: 'time' | 'date') {
    const pad = (value: number) => String(value).padStart(2, '0');
    if (labelMode === 'time') {
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  private getShanghaiDayStart(date: Date): Date {
    const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
    const shifted = new Date(date.getTime() + shanghaiOffsetMs);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth();
    const day = shifted.getUTCDate();
    return new Date(Date.UTC(year, month, day) - shanghaiOffsetMs);
  }

  private async tableExists(tableName: string): Promise<boolean> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT to_regclass($1)::text AS table_name`,
      `public.${tableName}`,
    ) as Promise<Array<{ table_name: string | null }>>);
    return Boolean(rows[0]?.table_name);
  }

  private normalizeOptionalStatus<T extends string>(value: string | undefined, whitelist: string[]): T | null {
    if (!value) {
      return null;
    }
    const status = String(value || '').trim().toUpperCase();
    if (!status) {
      return null;
    }
    if (!whitelist.includes(status)) {
      throw new BadRequestException(`invalid status: ${status}`);
    }
    return status as T;
  }

  private normalizeExecuteTime(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const normalized = String(value).trim();
    return normalized || null;
  }

  private resolveExecuteTime(payloadExecuteTime: unknown, productExecuteTime: unknown): string {
    const fromPayload = this.normalizeExecuteTime(payloadExecuteTime);
    if (fromPayload) {
      return fromPayload;
    }
    const fromProduct = this.normalizeExecuteTime(productExecuteTime);
    if (fromProduct) {
      return fromProduct;
    }
    const now = new Date();
    const y = now.getFullYear();
    const m = `${now.getMonth() + 1}`.padStart(2, '0');
    const d = `${now.getDate()}`.padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private parseExecuteTime(value: string | null): Date {
    const now = new Date();
    if (!value) {
      return now;
    }
    const raw = String(value).trim();
    if (!raw) {
      return now;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return new Date(`${raw}T00:00:00+08:00`);
    }
    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(raw)) {
      return new Date(`${raw.replace(/\s+/, 'T')}:00+08:00`);
    }
    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(raw)) {
      return new Date(`${raw.replace(/\s+/, 'T')}+08:00`);
    }
    const parsed = new Date(raw);
    return Number.isFinite(parsed.getTime()) ? parsed : now;
  }

  private calculateNextDeduction(base: Date, periodType: string | null, period: number | null): Date {
    const current = new Date(base.getTime());
    const interval = Math.max(Number(period || 1), 1);
    const normalized = String(periodType || 'DAY').toUpperCase();
    if (normalized === 'DAY') {
      current.setUTCDate(current.getUTCDate() + interval);
      return current;
    }
    if (normalized === 'WEEK') {
      current.setUTCDate(current.getUTCDate() + interval * 7);
      return current;
    }
    if (normalized === 'MONTH') {
      current.setUTCMonth(current.getUTCMonth() + interval);
      return current;
    }
    if (normalized === 'YEAR') {
      current.setUTCFullYear(current.getUTCFullYear() + interval);
      return current;
    }
    current.setUTCDate(current.getUTCDate() + interval);
    return current;
  }

  private rollForwardDueDate(initialDate: Date, periodType?: string | null, period?: number | null): Date {
    let due = new Date(initialDate.getTime());
    const now = new Date();
    while (due.getTime() <= now.getTime()) {
      due = this.calculateNextDeduction(due, periodType || null, period || null);
    }
    return due;
  }

  private buildRecurringPaymentType(source: string) {
    const normalized = String(source || 'manual')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_');
    const suffix = normalized.slice(0, 12) || 'MANUAL';
    return `RECURRING_DEDUCTION:${suffix}`.slice(0, 32);
  }

  private assertAdminTestAllowed() {
    const envDisabled = String(process.env.PAYMENTS_ADMIN_TEST_DISABLED || '')
      .trim()
      .toLowerCase();
    const disabled = this.runtimePaymentSettings.adminTestDisabled ?? (envDisabled === 'true' || envDisabled === '1');
    if (disabled) {
      throw new ForbiddenException('支付测试接口已禁用');
    }
  }

  private assertAlipayRealGatewayReady() {
    if (!this.isAlipayConfigured()) {
      throw new BadRequestException('支付宝未完成真实网关配置，请先在平台设置中配置 app_id / private_key / alipay_public_key');
    }
    const gateway = this.alipayGatewayUrl();
    if (this.isSandboxGateway(gateway) || this.alipayConfig().sandboxDebug) {
      throw new BadRequestException(`当前支付宝网关仍是沙盒地址，请切换到正式网关后再测试: ${gateway}`);
    }
  }

  private assertWechatRealGatewayReady() {
    if (!this.isWechatPayConfigured()) {
      throw new BadRequestException('微信支付未完成真实网关配置，请先在平台设置中配置 app_id / mch_id / api_key');
    }
    const gateway = this.wechatGatewayUrl();
    if (this.isSandboxGateway(gateway)) {
      throw new BadRequestException(`当前微信网关疑似沙盒地址，请切换到正式网关后再测试: ${gateway}`);
    }
  }

  private isSandboxGateway(url: string) {
    const normalized = String(url || '').trim().toLowerCase();
    return normalized.includes('sandbox') || normalized.includes('alipaydev');
  }

  private parseJsonStringArray(value: unknown): string[] {
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

  private nullableString(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const normalized = String(value).trim();
    return normalized || null;
  }

  private genTradeNo(prefix: string) {
    const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const rand = randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}${ts}${rand}`.slice(0, 64);
  }

  private genUuid() {
    const hex = randomBytes(16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  private async ensureSchema() {
    if (!this.schemaReady) {
      if (!this.schemaPromise) {
        this.schemaPromise = this.initializeSchema();
      }
      await this.schemaPromise;
      this.schemaReady = true;
    }
    await this.ensureRuntimePaymentConfig();
  }

  private async initializeSchema() {
    const ddlStatements = [
      `CREATE TABLE IF NOT EXISTS payment_products (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
         code varchar(64) NOT NULL,
         name varchar(128) NOT NULL,
         description text NULL,
         type varchar(32) NOT NULL DEFAULT 'ONE_TIME',
         status varchar(32) NOT NULL DEFAULT 'ACTIVE',
         amount numeric(10, 2) NOT NULL,
         currency varchar(8) NOT NULL DEFAULT 'CNY',
         membership_days integer NOT NULL DEFAULT 0,
         points_topup integer NOT NULL DEFAULT 0,
         sign_scene varchar(64) NULL,
         sign_validity_period integer NULL DEFAULT 365,
         period_type varchar(16) NULL,
         period integer NULL,
         execute_time varchar(32) NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         UNIQUE (app_id, code)
       )`,
      `CREATE TABLE IF NOT EXISTS alipay_orders (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
         out_trade_no varchar(64) NOT NULL UNIQUE,
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         product_id uuid NOT NULL REFERENCES payment_products(id) ON DELETE RESTRICT,
         subject varchar(256) NOT NULL,
         total_amount numeric(10, 2) NOT NULL,
         original_amount numeric(10, 2) NULL,
         payable_amount numeric(10, 2) NULL,
         points_deduct_points bigint NOT NULL DEFAULT 0,
         points_deduct_amount numeric(10, 2) NOT NULL DEFAULT 0,
         points_deduct_ledger_id varchar(128) NULL,
         points_refund_ledger_id varchar(128) NULL,
         points_refund_status varchar(16) NOT NULL DEFAULT 'NONE',
         points_topup_points bigint NOT NULL DEFAULT 0,
         points_topup_ledger_id varchar(128) NULL,
         points_topup_status varchar(16) NOT NULL DEFAULT 'NONE',
         status varchar(32) NOT NULL DEFAULT 'PENDING',
         trade_no varchar(64) NULL,
         trade_status varchar(64) NULL,
         payment_type varchar(32) NOT NULL DEFAULT 'ONE_TIME',
         provider_type varchar(32) NULL,
         payment_method_id uuid NULL,
         external_object_id varchar(128) NULL,
         external_customer_id varchar(128) NULL,
         external_subscription_id varchar(128) NULL,
         checkout_url text NULL,
         currency varchar(8) NULL,
         idempotency_key varchar(128) NULL,
         raw_status varchar(64) NULL,
         notify_payload jsonb NULL,
         paid_at timestamptz NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS alipay_agreements (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         product_id uuid NOT NULL REFERENCES payment_products(id) ON DELETE RESTRICT,
         external_agreement_no varchar(64) NOT NULL UNIQUE,
         agreement_no varchar(64) NULL UNIQUE,
         status varchar(32) NOT NULL DEFAULT 'PENDING',
         sign_scene varchar(64) NULL,
         period_type varchar(16) NULL,
         period integer NULL,
         execute_time varchar(32) NULL,
         sign_validity_period integer NULL,
         notify_payload jsonb NULL,
         signed_at timestamptz NULL,
         invalid_at timestamptz NULL,
         next_deduction_at timestamptz NULL,
         last_deducted_at timestamptz NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS alipay_deductions (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
         agreement_id uuid NOT NULL REFERENCES alipay_agreements(id) ON DELETE CASCADE,
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         product_id uuid NOT NULL REFERENCES payment_products(id) ON DELETE RESTRICT,
         out_trade_no varchar(64) NOT NULL UNIQUE,
         amount numeric(10, 2) NOT NULL,
         status varchar(32) NOT NULL DEFAULT 'PENDING',
         trade_no varchar(64) NULL,
         trade_status varchar(64) NULL,
         response_payload jsonb NULL,
         executed_at timestamptz NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS alipay_refunds (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
         order_id uuid NOT NULL REFERENCES alipay_orders(id) ON DELETE CASCADE,
         out_trade_no varchar(64) NOT NULL,
         out_request_no varchar(64) NOT NULL,
         refund_amount numeric(10, 2) NOT NULL,
         refund_reason varchar(256) NULL,
         status varchar(32) NOT NULL DEFAULT 'PENDING',
         refund_fee numeric(10, 2) NULL,
         refund_no varchar(64) NULL,
         gmt_refund_pay timestamptz NULL,
         response_payload jsonb NULL,
         created_by_user_id uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         UNIQUE (app_id, out_request_no)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_payment_products_app_created
       ON payment_products(app_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_created
       ON alipay_orders(app_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_user
       ON alipay_orders(app_id, user_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_status_created
       ON alipay_orders(app_id, status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_provider_created
       ON alipay_orders(app_id, provider_type, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_orders_external_object
       ON alipay_orders(provider_type, external_object_id)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_agreements_app_status
       ON alipay_agreements(app_id, status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_agreements_due
       ON alipay_agreements(app_id, next_deduction_at)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_deductions_app_created
       ON alipay_deductions(app_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_deductions_agreement_created
       ON alipay_deductions(agreement_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_refunds_app_created
       ON alipay_refunds(app_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_refunds_order_created
       ON alipay_refunds(order_id, created_at DESC)`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS original_amount numeric(10, 2) NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS payable_amount numeric(10, 2) NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS points_deduct_points bigint NOT NULL DEFAULT 0`,
      `ALTER TABLE alipay_orders
       ALTER COLUMN points_deduct_points TYPE bigint
       USING points_deduct_points::bigint`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS points_deduct_amount numeric(10, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS points_deduct_ledger_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS points_refund_ledger_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS points_refund_status varchar(16) NOT NULL DEFAULT 'NONE'`,
      `ALTER TABLE payment_products
       ADD COLUMN IF NOT EXISTS points_topup integer NOT NULL DEFAULT 0`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS points_topup_points bigint NOT NULL DEFAULT 0`,
      `ALTER TABLE alipay_orders
       ALTER COLUMN points_topup_points TYPE bigint
       USING points_topup_points::bigint`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS points_topup_ledger_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS points_topup_status varchar(16) NOT NULL DEFAULT 'NONE'`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS provider_type varchar(32) NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS payment_method_id uuid NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS external_object_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS external_customer_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS external_subscription_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS checkout_url text NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS currency varchar(8) NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS idempotency_key varchar(128) NULL`,
      `ALTER TABLE alipay_orders
       ADD COLUMN IF NOT EXISTS raw_status varchar(64) NULL`,
      `UPDATE alipay_orders
       SET provider_type = CASE
         WHEN UPPER(payment_type) LIKE 'WECHAT%' THEN 'WECHAT'
         WHEN provider_type IS NULL OR provider_type = '' THEN 'ALIPAY'
         ELSE provider_type
       END
       WHERE provider_type IS NULL OR provider_type = ''`,
    ];

    for (const ddl of ddlStatements) {
      await this.prisma.$executeRawUnsafe(ddl);
    }
  }
}
