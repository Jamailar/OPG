import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AdminType, AppStatus, MembershipType, Prisma, PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PRISMA_CLIENT } from '../../config/database.module';

const TEST_APP_SLUG = 'test';
const TEST_APP_NAME = 'Test';
const TEST_PASSWORD = 'TestPass123!';

type SeedUser = {
  email: string;
  fullName: string;
  displayName: string;
  phone: string | null;
  phoneVerified: boolean;
  role: UserRole;
  adminType: AdminType | null;
  isSuperuser: boolean;
  membershipType: MembershipType;
  membershipDays: number;
  accountType: string;
  authProvider: string;
  createdDaysAgo: number;
  lastLoginDaysAgo: number | null;
};

type SeedProduct = {
  code: string;
  name: string;
  description: string;
  type: 'ONE_TIME' | 'RECURRING';
  amount: string;
  membershipDays: number;
  pointsTopup: number;
  signScene: string | null;
  signValidityPeriod: number | null;
  periodType: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR' | null;
  period: number | null;
  executeTime: string | null;
};

type SeedOrder = {
  outTradeNo: string;
  userEmail: string;
  productCode: string;
  subject: string;
  amount: string;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'CLOSED' | 'REFUNDED';
  tradeStatus: string | null;
  paymentType: string;
  providerType: string;
  createdDaysAgo: number;
  paidDaysAgo: number | null;
};

type IdRow = {
  id: string;
};

@Injectable()
export class BuiltInTestAppSeedService implements OnModuleInit {
  private readonly logger = new Logger(BuiltInTestAppSeedService.name);

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleInit() {
    try {
      await this.ensureTestAppSeed();
    } catch (error: any) {
      this.logger.warn(`built-in Test app seed skipped: ${error?.message || error}`);
    }
  }

  private async ensureTestAppSeed() {
    await this.ensurePaymentFixtureSchema();
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('opg_builtin_test_app_seed'))`);

      const app = await tx.app.upsert({
        where: { slug: TEST_APP_SLUG },
        create: {
          slug: TEST_APP_SLUG,
          name: TEST_APP_NAME,
          status: AppStatus.ACTIVE,
        },
        update: {
          name: TEST_APP_NAME,
          status: AppStatus.ACTIVE,
        },
      });

      await this.ensureAppSettings(tx, app.id);
      const usersByEmail = await this.ensureUsers(tx, app.id, passwordHash);
      const productsByCode = await this.ensurePaymentProducts(tx, app.id);
      await this.ensurePaymentOrders(tx, app.id, usersByEmail, productsByCode);
      await this.ensurePaymentAgreement(tx, app.id, usersByEmail, productsByCode);
      await this.ensureUserEntitlements(tx, app.id, usersByEmail, productsByCode);
    });

    this.logger.log('built-in Test app seed is ready');
  }

  private async ensureAppSettings(tx: Prisma.TransactionClient, appId: string) {
    const fixtureExtra = {
      fixture: {
        built_in: true,
        source: 'opg_builtin_test_app_seed',
        data: ['users', 'payment_products', 'payment_orders', 'payment_agreement', 'entitlements'],
      },
      payment_return_mode: 'mock',
    };

    await tx.appSetting.upsert({
      where: { appId },
      create: {
        appId,
        appUrl: 'https://test.local',
        brandName: TEST_APP_NAME,
        senderName: 'OPG Test',
        senderNickname: 'Test',
        extraJson: fixtureExtra,
        notes: 'Built-in Test app with simulated users and payment data.',
        emailPrimaryColor: '#111827',
        emailSecondaryColor: '#0f766e',
      },
      update: {},
    });

    await tx.$executeRawUnsafe(
      `UPDATE app_settings
       SET brand_name = COALESCE(NULLIF(brand_name, ''), $2),
           sender_name = COALESCE(NULLIF(sender_name, ''), 'OPG Test'),
           sender_nickname = COALESCE(NULLIF(sender_nickname, ''), 'Test'),
           notes = COALESCE(NULLIF(notes, ''), 'Built-in Test app with simulated users and payment data.'),
           extra_json = COALESCE(extra_json, '{}'::jsonb) || $3::jsonb,
           updated_at = now()
       WHERE app_id = $1::uuid`,
      appId,
      TEST_APP_NAME,
      JSON.stringify(fixtureExtra),
    );
  }

  private async ensureUsers(tx: Prisma.TransactionClient, appId: string, passwordHash: string) {
    const fixtures: SeedUser[] = [
      {
        email: 'owner@test.local',
        fullName: 'Test Owner',
        displayName: 'Owner',
        phone: '+8613800000001',
        phoneVerified: true,
        role: UserRole.ADMIN,
        adminType: AdminType.ADMIN,
        isSuperuser: false,
        membershipType: MembershipType.PREMIUM,
        membershipDays: 365,
        accountType: 'REGISTERED',
        authProvider: 'email',
        createdDaysAgo: 45,
        lastLoginDaysAgo: 0,
      },
      {
        email: 'premium@test.local',
        fullName: 'Premium User',
        displayName: 'Premium',
        phone: '+8613800000002',
        phoneVerified: true,
        role: UserRole.USER,
        adminType: null,
        isSuperuser: false,
        membershipType: MembershipType.PREMIUM,
        membershipDays: 90,
        accountType: 'REGISTERED',
        authProvider: 'email',
        createdDaysAgo: 30,
        lastLoginDaysAgo: 1,
      },
      {
        email: 'free@test.local',
        fullName: 'Free User',
        displayName: 'Free',
        phone: '+8613800000003',
        phoneVerified: true,
        role: UserRole.USER,
        adminType: null,
        isSuperuser: false,
        membershipType: MembershipType.FREE,
        membershipDays: 0,
        accountType: 'REGISTERED',
        authProvider: 'sms',
        createdDaysAgo: 14,
        lastLoginDaysAgo: 2,
      },
      {
        email: 'newcomer@test.local',
        fullName: 'New User',
        displayName: 'Newcomer',
        phone: null,
        phoneVerified: false,
        role: UserRole.USER,
        adminType: null,
        isSuperuser: false,
        membershipType: MembershipType.FREE,
        membershipDays: 0,
        accountType: 'REGISTERED',
        authProvider: 'email',
        createdDaysAgo: 2,
        lastLoginDaysAgo: null,
      },
    ];

    const usersByEmail = new Map<string, string>();
    for (const user of fixtures) {
      const rows = await (tx.$queryRawUnsafe(
        `INSERT INTO users (
           id, app_id, email, hashed_password, full_name, display_name, role, admin_type,
           is_active, is_superuser, session_token, phone, phone_verified, membership_type,
           membership_expires_at, account_type, primary_auth_provider, is_anonymous,
           last_login_at, created_at, updated_at
         )
         VALUES (
           gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::"UserRole", $7::"AdminType",
           true, $8, $9, $10, $11, $12::"MembershipType",
           CASE WHEN $13::int > 0 THEN now() + ($13::text || ' days')::interval ELSE NULL END,
           $14, $15, false,
           CASE WHEN $16::int IS NULL THEN NULL ELSE now() - ($16::text || ' days')::interval END,
           now() - ($17::text || ' days')::interval,
           now()
         )
         ON CONFLICT (email, app_id) DO UPDATE
         SET full_name = EXCLUDED.full_name,
             display_name = EXCLUDED.display_name,
             role = EXCLUDED.role,
             admin_type = EXCLUDED.admin_type,
             is_active = true,
             is_superuser = EXCLUDED.is_superuser,
             phone = EXCLUDED.phone,
             phone_verified = EXCLUDED.phone_verified,
             membership_type = EXCLUDED.membership_type,
             membership_expires_at = EXCLUDED.membership_expires_at,
             account_type = EXCLUDED.account_type,
             primary_auth_provider = EXCLUDED.primary_auth_provider,
             deleted_at = NULL,
             deactivated_at = NULL,
             deactivation_reason = NULL,
             updated_at = now()
         RETURNING id`,
        appId,
        user.email,
        passwordHash,
        user.fullName,
        user.displayName,
        user.role,
        user.adminType,
        user.isSuperuser,
        `test-${user.email}-${Date.now()}`,
        user.phone,
        user.phoneVerified,
        user.membershipType,
        user.membershipDays,
        user.accountType,
        user.authProvider,
        user.lastLoginDaysAgo,
        user.createdDaysAgo,
      ) as Promise<IdRow[]>);
      usersByEmail.set(user.email, rows[0].id);
    }
    return usersByEmail;
  }

  private async ensurePaymentProducts(tx: Prisma.TransactionClient, appId: string) {
    const fixtures: SeedProduct[] = [
      {
        code: 'TEST_STARTER',
        name: 'Test Starter',
        description: 'One-time simulated payment product for Test app.',
        type: 'ONE_TIME',
        amount: '19.90',
        membershipDays: 30,
        pointsTopup: 0,
        signScene: null,
        signValidityPeriod: null,
        periodType: null,
        period: null,
        executeTime: null,
      },
      {
        code: 'TEST_PRO_MONTHLY',
        name: 'Test Pro Monthly',
        description: 'Recurring simulated subscription product for Test app.',
        type: 'RECURRING',
        amount: '49.90',
        membershipDays: 31,
        pointsTopup: 0,
        signScene: 'INDUSTRY|DIGITAL_MEDIA',
        signValidityPeriod: 365,
        periodType: 'MONTH',
        period: 1,
        executeTime: '10:00:00',
      },
      {
        code: 'TEST_POINTS_100',
        name: 'Test 100 Points',
        description: 'Simulated points top-up product for Test app.',
        type: 'ONE_TIME',
        amount: '9.90',
        membershipDays: 0,
        pointsTopup: 100,
        signScene: null,
        signValidityPeriod: null,
        periodType: null,
        period: null,
        executeTime: null,
      },
    ];

    const productsByCode = new Map<string, string>();
    for (const product of fixtures) {
      const rows = await (tx.$queryRawUnsafe(
        `INSERT INTO payment_products (
           id, app_id, code, name, description, type, status, amount, currency,
           membership_days, points_topup, sign_scene, sign_validity_period,
           period_type, period, execute_time, created_at, updated_at
         )
         VALUES (
           gen_random_uuid(), $1::uuid, $2, $3, $4, $5, 'ACTIVE', $6::numeric, 'CNY',
           $7, $8, $9, $10, $11, $12, $13, now(), now()
         )
         ON CONFLICT (app_id, code) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             type = EXCLUDED.type,
             status = 'ACTIVE',
             amount = EXCLUDED.amount,
             currency = 'CNY',
             membership_days = EXCLUDED.membership_days,
             points_topup = EXCLUDED.points_topup,
             sign_scene = EXCLUDED.sign_scene,
             sign_validity_period = EXCLUDED.sign_validity_period,
             period_type = EXCLUDED.period_type,
             period = EXCLUDED.period,
             execute_time = EXCLUDED.execute_time,
             updated_at = now()
         RETURNING id`,
        appId,
        product.code,
        product.name,
        product.description,
        product.type,
        product.amount,
        product.membershipDays,
        product.pointsTopup,
        product.signScene,
        product.signValidityPeriod,
        product.periodType,
        product.period,
        product.executeTime,
      ) as Promise<IdRow[]>);
      productsByCode.set(product.code, rows[0].id);
    }
    return productsByCode;
  }

  private async ensurePaymentOrders(
    tx: Prisma.TransactionClient,
    appId: string,
    usersByEmail: Map<string, string>,
    productsByCode: Map<string, string>,
  ) {
    const fixtures: SeedOrder[] = [
      {
        outTradeNo: 'TEST_FIXTURE_PAID_001',
        userEmail: 'premium@test.local',
        productCode: 'TEST_PRO_MONTHLY',
        subject: 'Test Pro Monthly',
        amount: '49.90',
        status: 'PAID',
        tradeStatus: 'TRADE_SUCCESS',
        paymentType: 'ALIPAY_PAGE',
        providerType: 'ALIPAY',
        createdDaysAgo: 8,
        paidDaysAgo: 8,
      },
      {
        outTradeNo: 'TEST_FIXTURE_PENDING_001',
        userEmail: 'newcomer@test.local',
        productCode: 'TEST_STARTER',
        subject: 'Test Starter',
        amount: '19.90',
        status: 'PENDING',
        tradeStatus: 'WAIT_BUYER_PAY',
        paymentType: 'ALIPAY_PAGE',
        providerType: 'ALIPAY',
        createdDaysAgo: 1,
        paidDaysAgo: null,
      },
      {
        outTradeNo: 'TEST_FIXTURE_WECHAT_PAID_001',
        userEmail: 'free@test.local',
        productCode: 'TEST_POINTS_100',
        subject: 'Test 100 Points',
        amount: '9.90',
        status: 'PAID',
        tradeStatus: 'SUCCESS',
        paymentType: 'WECHAT_NATIVE',
        providerType: 'WECHAT',
        createdDaysAgo: 3,
        paidDaysAgo: 3,
      },
      {
        outTradeNo: 'TEST_FIXTURE_FAILED_001',
        userEmail: 'free@test.local',
        productCode: 'TEST_STARTER',
        subject: 'Test Starter',
        amount: '19.90',
        status: 'FAILED',
        tradeStatus: 'PAYMENT_FAILED',
        paymentType: 'ALIPAY_PAGE',
        providerType: 'ALIPAY',
        createdDaysAgo: 12,
        paidDaysAgo: null,
      },
      {
        outTradeNo: 'TEST_FIXTURE_REFUNDED_001',
        userEmail: 'premium@test.local',
        productCode: 'TEST_STARTER',
        subject: 'Test Starter',
        amount: '19.90',
        status: 'REFUNDED',
        tradeStatus: 'TRADE_SUCCESS',
        paymentType: 'ALIPAY_PAGE',
        providerType: 'ALIPAY',
        createdDaysAgo: 20,
        paidDaysAgo: 20,
      },
    ];

    for (const order of fixtures) {
      const userId = usersByEmail.get(order.userEmail);
      const productId = productsByCode.get(order.productCode);
      if (!userId || !productId) {
        continue;
      }
      const rows = await (tx.$queryRawUnsafe(
        `INSERT INTO alipay_orders (
           id, app_id, out_trade_no, user_id, product_id, subject, total_amount,
           original_amount, payable_amount, status, trade_no, trade_status,
           payment_type, provider_type, currency, raw_status, notify_payload,
           paid_at, created_at, updated_at
         )
         VALUES (
           gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5, $6::numeric,
           $6::numeric, $6::numeric, $7, $8, $9,
           $10, $11, 'CNY', $9, $12::jsonb,
           CASE WHEN $13::int IS NULL THEN NULL ELSE now() - ($13::text || ' days')::interval END,
           now() - ($14::text || ' days')::interval,
           now()
         )
         ON CONFLICT (out_trade_no) DO UPDATE
         SET app_id = EXCLUDED.app_id,
             user_id = EXCLUDED.user_id,
             product_id = EXCLUDED.product_id,
             subject = EXCLUDED.subject,
             total_amount = EXCLUDED.total_amount,
             original_amount = EXCLUDED.original_amount,
             payable_amount = EXCLUDED.payable_amount,
             status = EXCLUDED.status,
             trade_no = EXCLUDED.trade_no,
             trade_status = EXCLUDED.trade_status,
             payment_type = EXCLUDED.payment_type,
             provider_type = EXCLUDED.provider_type,
             currency = EXCLUDED.currency,
             raw_status = EXCLUDED.raw_status,
             notify_payload = EXCLUDED.notify_payload,
             paid_at = EXCLUDED.paid_at,
             updated_at = now()
         RETURNING id`,
        appId,
        order.outTradeNo,
        userId,
        productId,
        order.subject,
        order.amount,
        order.status,
        order.status === 'PENDING' ? null : `TEST-${order.outTradeNo}`,
        order.tradeStatus,
        order.paymentType,
        order.providerType,
        JSON.stringify({ fixture: true, provider: order.providerType, status: order.status }),
        order.paidDaysAgo,
        order.createdDaysAgo,
      ) as Promise<IdRow[]>);

      if (order.status === 'REFUNDED' && rows[0]?.id) {
        await tx.$executeRawUnsafe(
          `INSERT INTO alipay_refunds (
             id, app_id, order_id, out_trade_no, out_request_no, refund_amount,
             refund_reason, status, refund_fee, refund_no, gmt_refund_pay,
             response_payload, created_at, updated_at
           )
           VALUES (
             gen_random_uuid(), $1::uuid, $2::uuid, $3, 'TEST_FIXTURE_REFUND_001',
             $4::numeric, 'Test fixture refund', 'SUCCESS', $4::numeric,
             'TEST-REFUND-001', now() - interval '19 days', $5::jsonb,
             now() - interval '19 days', now()
           )
           ON CONFLICT (app_id, out_request_no) DO UPDATE
           SET order_id = EXCLUDED.order_id,
               refund_amount = EXCLUDED.refund_amount,
               refund_reason = EXCLUDED.refund_reason,
               status = 'SUCCESS',
               refund_fee = EXCLUDED.refund_fee,
               refund_no = EXCLUDED.refund_no,
               gmt_refund_pay = EXCLUDED.gmt_refund_pay,
               response_payload = EXCLUDED.response_payload,
               updated_at = now()`,
          appId,
          rows[0].id,
          order.outTradeNo,
          order.amount,
          JSON.stringify({ fixture: true, status: 'SUCCESS' }),
        );
      }
    }
  }

  private async ensurePaymentAgreement(
    tx: Prisma.TransactionClient,
    appId: string,
    usersByEmail: Map<string, string>,
    productsByCode: Map<string, string>,
  ) {
    const userId = usersByEmail.get('premium@test.local');
    const productId = productsByCode.get('TEST_PRO_MONTHLY');
    if (!userId || !productId) {
      return;
    }

    const agreementRows = await (tx.$queryRawUnsafe(
      `INSERT INTO alipay_agreements (
         id, app_id, user_id, product_id, external_agreement_no, agreement_no,
         status, sign_scene, period_type, period, execute_time, sign_validity_period,
         signed_at, next_deduction_at, last_deducted_at, notify_payload,
         created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'TEST_FIXTURE_AGREEMENT_001',
         'TEST_AGREEMENT_001', 'VALID', 'INDUSTRY|DIGITAL_MEDIA', 'MONTH', 1,
         '10:00:00', 365, now() - interval '8 days', now() + interval '23 days',
         now() - interval '1 day', $4::jsonb, now() - interval '8 days', now()
       )
       ON CONFLICT (external_agreement_no) DO UPDATE
       SET app_id = EXCLUDED.app_id,
           user_id = EXCLUDED.user_id,
           product_id = EXCLUDED.product_id,
           agreement_no = EXCLUDED.agreement_no,
           status = 'VALID',
           next_deduction_at = EXCLUDED.next_deduction_at,
           last_deducted_at = EXCLUDED.last_deducted_at,
           notify_payload = EXCLUDED.notify_payload,
           updated_at = now()
       RETURNING id`,
      appId,
      userId,
      productId,
      JSON.stringify({ fixture: true, status: 'VALID' }),
    ) as Promise<IdRow[]>);

    const agreementId = agreementRows[0]?.id;
    if (!agreementId) {
      return;
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO alipay_deductions (
         id, app_id, agreement_id, user_id, product_id, out_trade_no, amount,
         status, trade_no, trade_status, response_payload, executed_at,
         created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         'TEST_FIXTURE_DEDUCTION_001', 49.90, 'SUCCESS', 'TEST-DEDUCTION-001',
         'TRADE_SUCCESS', $5::jsonb, now() - interval '1 day',
         now() - interval '1 day', now()
       )
       ON CONFLICT (out_trade_no) DO UPDATE
       SET app_id = EXCLUDED.app_id,
           agreement_id = EXCLUDED.agreement_id,
           user_id = EXCLUDED.user_id,
           product_id = EXCLUDED.product_id,
           amount = EXCLUDED.amount,
           status = 'SUCCESS',
           trade_no = EXCLUDED.trade_no,
           trade_status = EXCLUDED.trade_status,
           response_payload = EXCLUDED.response_payload,
           executed_at = EXCLUDED.executed_at,
           updated_at = now()`,
      appId,
      agreementId,
      userId,
      productId,
      JSON.stringify({ fixture: true, status: 'SUCCESS' }),
    );
  }

  private async ensureUserEntitlements(
    tx: Prisma.TransactionClient,
    appId: string,
    usersByEmail: Map<string, string>,
    productsByCode: Map<string, string>,
  ) {
    const premiumUserId = usersByEmail.get('premium@test.local');
    const ownerUserId = usersByEmail.get('owner@test.local');
    const proProductId = productsByCode.get('TEST_PRO_MONTHLY');
    if (premiumUserId && proProductId) {
      await this.ensureUserEntitlement(tx, appId, premiumUserId, proProductId, 'TEST_PRO_MONTHLY', 90);
    }
    if (ownerUserId && proProductId) {
      await this.ensureUserEntitlement(tx, appId, ownerUserId, proProductId, 'TEST_PRO_MONTHLY', 365);
    }
  }

  private async ensureUserEntitlement(
    tx: Prisma.TransactionClient,
    appId: string,
    userId: string,
    productId: string,
    productCode: string,
    days: number,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO user_entitlements (
         id, app_id, user_id, source, product_code, product_id, status,
         starts_at, expires_at, metadata_json, created_at, updated_at
       )
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'test_fixture', $3, $4,
              'ACTIVE', now() - interval '1 day',
              now() + ($5::text || ' days')::interval,
              $6::jsonb, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM user_entitlements
         WHERE app_id = $1::uuid
           AND user_id = $2::uuid
           AND source = 'test_fixture'
           AND product_code = $3
           AND status = 'ACTIVE'
       )`,
      appId,
      userId,
      productCode,
      productId,
      days,
      JSON.stringify({ fixture: true }),
    );
  }

  private async ensurePaymentFixtureSchema() {
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
      `ALTER TABLE payment_products ADD COLUMN IF NOT EXISTS points_topup integer NOT NULL DEFAULT 0`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS original_amount numeric(10, 2) NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS payable_amount numeric(10, 2) NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_deduct_points bigint NOT NULL DEFAULT 0`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_deduct_amount numeric(10, 2) NOT NULL DEFAULT 0`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_deduct_ledger_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_refund_ledger_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_refund_status varchar(16) NOT NULL DEFAULT 'NONE'`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_topup_points bigint NOT NULL DEFAULT 0`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_topup_ledger_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS points_topup_status varchar(16) NOT NULL DEFAULT 'NONE'`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS provider_type varchar(32) NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS payment_method_id uuid NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS external_object_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS external_customer_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS external_subscription_id varchar(128) NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS checkout_url text NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS currency varchar(8) NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS idempotency_key varchar(128) NULL`,
      `ALTER TABLE alipay_orders ADD COLUMN IF NOT EXISTS raw_status varchar(64) NULL`,
      `ALTER TABLE alipay_refunds ADD COLUMN IF NOT EXISTS response_payload jsonb NULL`,
      `ALTER TABLE alipay_agreements ADD COLUMN IF NOT EXISTS notify_payload jsonb NULL`,
      `CREATE INDEX IF NOT EXISTS idx_payment_products_app_created ON payment_products(app_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_created ON alipay_orders(app_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_orders_app_user ON alipay_orders(app_id, user_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_refunds_app_created ON alipay_refunds(app_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_refunds_order_created ON alipay_refunds(order_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_agreements_app_status ON alipay_agreements(app_id, status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_agreements_due ON alipay_agreements(app_id, next_deduction_at)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_deductions_app_created ON alipay_deductions(app_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alipay_deductions_agreement_created ON alipay_deductions(agreement_id, created_at DESC)`,
    ];

    for (const ddl of ddlStatements) {
      await this.prisma.$executeRawUnsafe(ddl);
    }
  }
}
