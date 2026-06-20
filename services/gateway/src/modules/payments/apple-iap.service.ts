import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AppleIdentityService, AppleLoginConfig } from '../auth/apple-identity.service';

type TransactionPayload = {
  transactionId?: string;
  originalTransactionId?: string;
  webOrderLineItemId?: string;
  productId?: string;
  bundleId?: string;
  environment?: string;
  purchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  revocationReason?: number;
  revocationType?: string;
  revocationPercentage?: number;
  isUpgraded?: boolean;
  appAccountToken?: string;
  appTransactionId?: string;
  type?: string;
  currency?: string;
  price?: number;
  signedDate?: number;
};

type RenewalPayload = {
  originalTransactionId?: string;
  productId?: string;
  autoRenewProductId?: string;
  autoRenewStatus?: number;
  expirationIntent?: number;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number;
  renewalDate?: number;
  appAccountToken?: string;
  appTransactionId?: string;
  environment?: string;
  currency?: string;
  renewalPrice?: number;
  signedDate?: number;
};

type NotificationProcessPlan = {
  entitlementStatus: string | null;
  entitlementExpiresAt: Date | null | undefined;
  shouldPersistTransaction: boolean;
  shouldRefreshEntitlement: boolean;
  action: string;
};

type AppleIapMethodConfig = {
  bundle_id?: string;
  app_apple_id?: string;
  issuer_id?: string;
  key_id?: string;
  private_key?: string;
  environment?: string;
  root_certificates_pem?: string;
};

type AppleIapConfig = AppleLoginConfig & {
  rootCertificatesPem?: string | null;
};

function safeString(value: unknown): string {
  return String(value || '').trim();
}

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function millisToDate(value: unknown): Date | null {
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? new Date(num) : null;
}

@Injectable()
export class AppleIapService implements OnModuleInit {
  private readonly logger = new Logger(AppleIapService.name);
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly appleIdentityService: AppleIdentityService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (error: any) {
      this.logger.warn(`apple iap schema warmup failed: ${error?.message || error}`);
    }
  }

  async verifyTransaction(appSlug: string | undefined, userId: string, body: { transaction_id?: string; signed_transaction_info?: string }) {
    await this.ensureSchema();
    const app = await this.appleIdentityService.resolveAppWithSettings(appSlug);
    const appleConfig = await this.requireAppleConfig(app);
    const signedTransaction = safeString(body.signed_transaction_info);
    const transactionId = safeString(body.transaction_id);
    if (!signedTransaction && !transactionId) {
      throw new BadRequestException('transaction_id or signed_transaction_info is required');
    }
    const verifiedSignedTransaction = signedTransaction || await this.fetchSignedTransactionInfo(appleConfig, transactionId);
    const payload = await this.decodeSignedTransaction(appleConfig, verifiedSignedTransaction);
    return this.persistTransaction(app.id, userId, payload, {
      signedTransactionInfo: verifiedSignedTransaction,
      signedRenewalInfo: null,
      raw: payload,
    });
  }

  async restorePurchases(appSlug: string | undefined, userId: string, body: { original_transaction_id?: string; transaction_id?: string }) {
    await this.ensureSchema();
    const app = await this.appleIdentityService.resolveAppWithSettings(appSlug);
    const appleConfig = await this.requireAppleConfig(app);
    const originalTransactionId = safeString(body.original_transaction_id || body.transaction_id);
    if (!originalTransactionId) {
      throw new BadRequestException('original_transaction_id or transaction_id is required');
    }
    await this.syncTransactionHistory(app.id, userId, appleConfig, originalTransactionId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, transaction_id, original_transaction_id, apple_product_id, status, expires_date
         FROM apple_iap_transactions
        WHERE app_id = $1::uuid
          AND original_transaction_id = $2
        ORDER BY expires_date DESC NULLS LAST, created_at DESC`,
      app.id,
      originalTransactionId,
    ) as Promise<Array<Record<string, unknown>>>);
    if (!rows.length) {
      return { restored: false, items: [] };
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE apple_iap_transactions
          SET user_id = $3::uuid, updated_at = now()
        WHERE app_id = $1::uuid AND original_transaction_id = $2`,
      app.id,
      originalTransactionId,
      userId,
    );
    await this.refreshEntitlementFromLatestTransaction(app.id, userId, originalTransactionId);
    return { restored: true, items: rows };
  }

  async listMySubscriptions(appSlug: string | undefined, userId: string) {
    await this.ensureSchema();
    const app = await this.appleIdentityService.resolveAppWithSettings(appSlug);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, source, product_code, external_product_id, original_transaction_id, status, starts_at, expires_at
         FROM user_entitlements
        WHERE app_id = $1::uuid AND user_id = $2::uuid
        ORDER BY expires_at DESC NULLS LAST, created_at DESC`,
      app.id,
      userId,
    ) as Promise<Array<Record<string, unknown>>>);
    return { items: rows };
  }

  async processNotification(appSlug: string | undefined, body: { signedPayload?: string; signed_payload?: string }) {
    await this.ensureSchema();
    const signedPayload = safeString(body.signedPayload || body.signed_payload);
    if (!signedPayload) {
      throw new BadRequestException('signedPayload is required');
    }
    const app = await this.appleIdentityService.resolveAppWithSettings(appSlug);
    const appleConfig = await this.requireAppleConfig(app);
    const decoded = await this.decodeSignedNotification(appleConfig, signedPayload);
    const notificationUuid = safeString(decoded.notificationUUID || decoded.notificationUuid || decoded.notification_uuid);
    const notificationType = safeString(decoded.notificationType || decoded.notification_type) || 'UNKNOWN';
    const subtype = safeString(decoded.subtype) || null;
    const signedDate = millisToDate(decoded.signedDate);
    const data = asPlainObject(decoded.data);
    const transactionPayload = data.signedTransactionInfo
      ? await this.decodeSignedTransaction(appleConfig, String(data.signedTransactionInfo))
      : null;
    const renewalPayload = data.signedRenewalInfo
      ? await this.decodeSignedRenewal(appleConfig, String(data.signedRenewalInfo)) as RenewalPayload
      : null;
    const originalTransactionId = safeString(transactionPayload?.originalTransactionId || renewalPayload?.originalTransactionId);
    const transactionId = safeString(transactionPayload?.transactionId);
    const uuid = notificationUuid || `${notificationType}:${transactionId || originalTransactionId}:${safeString(decoded.signedDate)}`;
    const plan = this.buildNotificationProcessPlan(notificationType, subtype, transactionPayload, renewalPayload);

    const inserted = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO apple_iap_notifications (
         app_id, notification_uuid, notification_type, subtype, transaction_id, original_transaction_id,
         environment, signed_payload, decoded_payload, signed_date, processing_status
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'RECEIVED'
       )
       ON CONFLICT (notification_uuid) DO NOTHING
       RETURNING true AS inserted`,
      app.id,
      uuid,
      notificationType,
      subtype,
      transactionId || null,
      originalTransactionId || null,
      safeString(data.environment || transactionPayload?.environment || renewalPayload?.environment) || null,
      signedPayload,
      JSON.stringify(decoded),
      signedDate,
    ) as Promise<Array<{ inserted: boolean }>>);
    if (!inserted[0]?.inserted) {
      return { success: true, duplicate: true };
    }

    try {
      const actions: string[] = [];
      if (plan.shouldPersistTransaction && transactionPayload && (transactionId || originalTransactionId)) {
        const userId = await this.resolveUserIdForAppleEvent(app.id, transactionPayload, renewalPayload, originalTransactionId);
        await this.persistTransaction(app.id, userId, transactionPayload, {
          signedTransactionInfo: data.signedTransactionInfo ? String(data.signedTransactionInfo) : null,
          signedRenewalInfo: data.signedRenewalInfo ? String(data.signedRenewalInfo) : null,
          raw: decoded,
          renewal: renewalPayload,
          notificationType,
          subtype,
          notificationSignedDate: signedDate,
          effectiveStatus: plan.entitlementStatus,
          effectiveExpiresAt: plan.entitlementExpiresAt,
        });
        if (plan.shouldRefreshEntitlement && userId && originalTransactionId) {
          await this.refreshEntitlementFromLatestTransaction(app.id, userId, originalTransactionId);
        }
        actions.push(userId ? 'transaction_linked' : 'transaction_recorded_unlinked');
      } else {
        actions.push(plan.action);
      }
      await this.markNotificationProcessed(uuid, 'PROCESSED', null, actions);
      return {
        success: true,
        duplicate: false,
        notification_type: notificationType,
        subtype,
        action: plan.action,
        transaction_id: transactionId || null,
        original_transaction_id: originalTransactionId || null,
      };
    } catch (error: any) {
      await this.markNotificationProcessed(uuid, 'FAILED', error?.message || String(error), [plan.action]);
      throw error;
    }
  }

  private async requireAppleConfig(app: { id: string; extra_json: unknown }) {
    const loginConfig = await this.appleIdentityService.resolveAppleLoginConfig(app as any);
    const methodConfig = await this.resolveAppleIapMethodConfig(app);
    const config = this.mergeAppleIapConfig(loginConfig, methodConfig);
    if (!config) {
      throw new BadRequestException('当前租户未配置 Apple IAP');
    }
    return config;
  }

  private async decodeSignedTransaction(config: AppleIapConfig, signedPayload: string): Promise<TransactionPayload> {
    const verifier = await this.createSignedDataVerifier(config);
    return verifier.verifyAndDecodeTransaction(signedPayload) as Promise<TransactionPayload>;
  }

  private async decodeSignedRenewal(config: AppleIapConfig, signedPayload: string): Promise<Record<string, unknown>> {
    const verifier = await this.createSignedDataVerifier(config);
    return verifier.verifyAndDecodeRenewalInfo(signedPayload) as Promise<Record<string, unknown>>;
  }

  private async decodeSignedNotification(config: AppleIapConfig, signedPayload: string): Promise<Record<string, any>> {
    const verifier = await this.createSignedDataVerifier(config);
    return verifier.verifyAndDecodeNotification(signedPayload) as Promise<Record<string, any>>;
  }

  private async createSignedDataVerifier(config: AppleIapConfig) {
    const rootCertificates = this.loadAppleRootCertificates(config);
    const { SignedDataVerifier } = await import('@apple/app-store-server-library');
    return new SignedDataVerifier(
      rootCertificates,
      true,
      await this.resolveAppleEnvironment(config),
      config.bundleId,
      config.appAppleId ? Number(config.appAppleId) : undefined,
    );
  }

  private async createAppStoreClient(config: AppleIapConfig) {
    if (!config.privateKey || !config.keyId || !config.issuerId || !config.bundleId) {
      throw new BadRequestException('Apple IAP Server API 凭证不完整');
    }
    const { AppStoreServerAPIClient } = await import('@apple/app-store-server-library');
    return new AppStoreServerAPIClient(
      config.privateKey,
      config.keyId,
      config.issuerId,
      config.bundleId,
      await this.resolveAppleEnvironment(config),
    );
  }

  private async resolveAppleEnvironment(config: AppleIapConfig) {
    const { Environment } = await import('@apple/app-store-server-library');
    return config.environment === 'SANDBOX' ? Environment.SANDBOX : Environment.PRODUCTION;
  }

  private async resolveAppleIapMethodConfig(app: { id: string; extra_json: unknown }): Promise<AppleIapMethodConfig | null> {
    const tableRows = (await this.prisma.$queryRawUnsafe(
      `SELECT to_regclass('public.platform_payment_methods')::text AS exists`,
    )) as Array<{ exists: string | null }>;
    if (!String(tableRows[0]?.exists || '').trim()) {
      return null;
    }
    const extra = asPlainObject(app.extra_json);
    const allowedIds = Array.isArray(extra.payment_method_ref_ids)
      ? extra.payment_method_ref_ids.map((item) => safeString(item)).filter(Boolean)
      : [];
    const rows = allowedIds.length > 0
      ? (await this.prisma.$queryRawUnsafe(
          `SELECT config_json
             FROM platform_payment_methods
            WHERE provider_type = 'APPLE_IAP'
              AND is_active = true
              AND id::text = ANY($1::text[])
            ORDER BY is_default DESC, updated_at DESC
            LIMIT 1`,
          allowedIds,
        )) as Array<{ config_json: unknown }>
      : (await this.prisma.$queryRawUnsafe(
          `SELECT config_json
             FROM platform_payment_methods
            WHERE provider_type = 'APPLE_IAP'
              AND is_active = true
            ORDER BY is_default DESC, updated_at DESC
            LIMIT 1`,
        )) as Array<{ config_json: unknown }>;
    return asPlainObject(rows[0]?.config_json) as AppleIapMethodConfig;
  }

  private mergeAppleIapConfig(
    loginConfig: AppleLoginConfig | null,
    methodConfig: AppleIapMethodConfig | null,
  ): AppleIapConfig | null {
    const bundleId = safeString(methodConfig?.bundle_id) || loginConfig?.bundleId || '';
    const teamId = loginConfig?.teamId || '';
    const config: AppleIapConfig = {
      credentialId: loginConfig?.credentialId || null,
      bundleId,
      serviceId: loginConfig?.serviceId || null,
      teamId,
      keyId: safeString(methodConfig?.key_id) || loginConfig?.keyId || null,
      issuerId: safeString(methodConfig?.issuer_id) || loginConfig?.issuerId || null,
      privateKey: safeString(methodConfig?.private_key) || loginConfig?.privateKey || null,
      environment: safeString(methodConfig?.environment).toUpperCase() === 'SANDBOX'
        ? 'SANDBOX'
        : loginConfig?.environment || 'PRODUCTION',
      appAppleId: safeString(methodConfig?.app_apple_id) || loginConfig?.appAppleId || null,
      appAttestMode: loginConfig?.appAttestMode || 'OFF',
      rootCertificatesPem: safeString(methodConfig?.root_certificates_pem) || null,
    };
    if (!config.bundleId || !config.issuerId || !config.keyId || !config.privateKey) {
      return loginConfig && config.bundleId ? config : null;
    }
    return config;
  }

  private loadAppleRootCertificates(config: AppleIapConfig): Buffer[] {
    const pem = safeString(config.rootCertificatesPem || this.config.apple.rootCertificatesPem);
    const matches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    const certs = matches.map((block) =>
      Buffer.from(block.replace(/-----BEGIN CERTIFICATE-----/g, '').replace(/-----END CERTIFICATE-----/g, '').replace(/\s+/g, ''), 'base64'),
    );
    if (!certs.length) {
      throw new BadRequestException('Apple IAP root certificates are required for verification');
    }
    return certs;
  }

  private async fetchSignedTransactionInfo(config: AppleIapConfig, transactionId: string): Promise<string> {
    if (!transactionId) {
      throw new BadRequestException('transaction_id is required');
    }
    const client = await this.createAppStoreClient(config);
    const response = await client.getTransactionInfo(transactionId);
    const signedTransactionInfo = safeString(response.signedTransactionInfo);
    if (!signedTransactionInfo) {
      throw new BadRequestException('Apple transaction not found');
    }
    return signedTransactionInfo;
  }

  private async syncTransactionHistory(appId: string, userId: string, config: AppleIapConfig, transactionId: string) {
    const client = await this.createAppStoreClient(config);
    const { GetTransactionHistoryVersion, Order, ProductType } = await import('@apple/app-store-server-library');
    let revision: string | null = null;
    do {
      const response = await client.getTransactionHistory(
        transactionId,
        revision,
        {
          sort: Order.ASCENDING,
          productTypes: [ProductType.AUTO_RENEWABLE, ProductType.NON_CONSUMABLE, ProductType.CONSUMABLE],
        },
        GetTransactionHistoryVersion.V2,
      );
      const signedTransactions = response.signedTransactions || [];
      for (const signedTransactionInfo of signedTransactions) {
        const payload = await this.decodeSignedTransaction(config, signedTransactionInfo);
        await this.persistTransaction(appId, userId, payload, {
          signedTransactionInfo,
          signedRenewalInfo: null,
          raw: payload,
        });
      }
      revision = response.hasMore ? response.revision || null : null;
    } while (revision);
  }

  private async persistTransaction(
    appId: string,
    userId: string | null,
    payload: TransactionPayload,
    options: {
      signedTransactionInfo: string | null;
      signedRenewalInfo: string | null;
      raw: Record<string, unknown>;
      renewal?: RenewalPayload | null;
      notificationType?: string | null;
      subtype?: string | null;
      notificationSignedDate?: Date | null;
      effectiveStatus?: string | null;
      effectiveExpiresAt?: Date | null;
    },
  ) {
    const transactionId = safeString(payload.transactionId);
    const originalTransactionId = safeString(payload.originalTransactionId || payload.transactionId);
    const appleProductId = safeString(payload.productId);
    if (!transactionId && !originalTransactionId) {
      throw new BadRequestException('Apple transaction id is required');
    }
    const status = options.effectiveStatus || this.deriveTransactionStatus(payload);
    const renewal = options.renewal || null;
    const effectiveExpiresAt = options.effectiveExpiresAt !== undefined
      ? options.effectiveExpiresAt
      : this.deriveEntitlementExpiresAt(payload, renewal, status);
    const productId = await this.findPaymentProductId(appId, appleProductId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO apple_iap_transactions (
         app_id, user_id, transaction_id, original_transaction_id, web_order_line_item_id,
         product_id, apple_product_id, environment, status, purchase_date, expires_date, revocation_date,
         signed_transaction_info, signed_renewal_info, raw_json,
         last_notification_type, last_notification_subtype, last_notification_signed_date,
         app_account_token, app_transaction_id, auto_renew_status, expiration_intent,
         is_in_billing_retry_period, grace_period_expires_date, renewal_date,
         revocation_reason, revocation_type, revocation_percentage,
         currency, price_milliunits, renewal_price_milliunits
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5,
         $6::uuid, $7, $8, $9, $10, $11, $12,
         $13, $14, $15::jsonb,
         $16, $17, $18,
         $19, $20, $21, $22,
         $23, $24, $25,
         $26, $27, $28,
         $29, $30, $31
       )
       ON CONFLICT (transaction_id) DO UPDATE
       SET user_id = COALESCE(EXCLUDED.user_id, apple_iap_transactions.user_id),
           status = CASE
             WHEN apple_iap_transactions.last_notification_signed_date IS NULL
               OR EXCLUDED.last_notification_signed_date IS NULL
               OR EXCLUDED.last_notification_signed_date >= apple_iap_transactions.last_notification_signed_date
             THEN EXCLUDED.status
             ELSE apple_iap_transactions.status
           END,
           expires_date = EXCLUDED.expires_date,
           revocation_date = EXCLUDED.revocation_date,
           signed_transaction_info = COALESCE(EXCLUDED.signed_transaction_info, apple_iap_transactions.signed_transaction_info),
           signed_renewal_info = COALESCE(EXCLUDED.signed_renewal_info, apple_iap_transactions.signed_renewal_info),
           raw_json = CASE
             WHEN apple_iap_transactions.last_notification_signed_date IS NULL
               OR EXCLUDED.last_notification_signed_date IS NULL
               OR EXCLUDED.last_notification_signed_date >= apple_iap_transactions.last_notification_signed_date
             THEN EXCLUDED.raw_json
             ELSE apple_iap_transactions.raw_json
           END,
           last_notification_type = COALESCE(EXCLUDED.last_notification_type, apple_iap_transactions.last_notification_type),
           last_notification_subtype = COALESCE(EXCLUDED.last_notification_subtype, apple_iap_transactions.last_notification_subtype),
           last_notification_signed_date = GREATEST(
             COALESCE(EXCLUDED.last_notification_signed_date, apple_iap_transactions.last_notification_signed_date),
             COALESCE(apple_iap_transactions.last_notification_signed_date, EXCLUDED.last_notification_signed_date)
           ),
           app_account_token = COALESCE(EXCLUDED.app_account_token, apple_iap_transactions.app_account_token),
           app_transaction_id = COALESCE(EXCLUDED.app_transaction_id, apple_iap_transactions.app_transaction_id),
           auto_renew_status = COALESCE(EXCLUDED.auto_renew_status, apple_iap_transactions.auto_renew_status),
           expiration_intent = COALESCE(EXCLUDED.expiration_intent, apple_iap_transactions.expiration_intent),
           is_in_billing_retry_period = COALESCE(EXCLUDED.is_in_billing_retry_period, apple_iap_transactions.is_in_billing_retry_period),
           grace_period_expires_date = COALESCE(EXCLUDED.grace_period_expires_date, apple_iap_transactions.grace_period_expires_date),
           renewal_date = COALESCE(EXCLUDED.renewal_date, apple_iap_transactions.renewal_date),
           revocation_reason = COALESCE(EXCLUDED.revocation_reason, apple_iap_transactions.revocation_reason),
           revocation_type = COALESCE(EXCLUDED.revocation_type, apple_iap_transactions.revocation_type),
           revocation_percentage = COALESCE(EXCLUDED.revocation_percentage, apple_iap_transactions.revocation_percentage),
           currency = COALESCE(EXCLUDED.currency, apple_iap_transactions.currency),
           price_milliunits = COALESCE(EXCLUDED.price_milliunits, apple_iap_transactions.price_milliunits),
           renewal_price_milliunits = COALESCE(EXCLUDED.renewal_price_milliunits, apple_iap_transactions.renewal_price_milliunits),
           updated_at = now()
       RETURNING id, transaction_id, original_transaction_id, apple_product_id, status, expires_date`,
      appId,
      userId,
      transactionId || originalTransactionId,
      originalTransactionId || transactionId,
      safeString(payload.webOrderLineItemId) || null,
      productId,
      appleProductId || 'unknown',
      safeString(payload.environment) || 'PRODUCTION',
      status,
      millisToDate(payload.purchaseDate),
      millisToDate(payload.expiresDate),
      millisToDate(payload.revocationDate),
      options.signedTransactionInfo,
      options.signedRenewalInfo,
      JSON.stringify(options.raw || payload),
      options.notificationType || null,
      options.subtype || null,
      options.notificationSignedDate || millisToDate(payload.signedDate) || millisToDate(renewal?.signedDate),
      uuidOrNull(payload.appAccountToken || renewal?.appAccountToken),
      safeString(payload.appTransactionId || renewal?.appTransactionId) || null,
      numberOrNull(renewal?.autoRenewStatus),
      numberOrNull(renewal?.expirationIntent),
      typeof renewal?.isInBillingRetryPeriod === 'boolean' ? renewal.isInBillingRetryPeriod : null,
      millisToDate(renewal?.gracePeriodExpiresDate),
      millisToDate(renewal?.renewalDate),
      numberOrNull(payload.revocationReason),
      safeString(payload.revocationType) || null,
      numberOrNull(payload.revocationPercentage),
      safeString(payload.currency || renewal?.currency) || null,
      numberOrNull(payload.price),
      numberOrNull(renewal?.renewalPrice),
    ) as Promise<Array<Record<string, unknown>>>);
    if (userId && originalTransactionId) {
      await this.upsertEntitlement(appId, userId, {
        productId,
        appleProductId,
        originalTransactionId,
        status,
        expiresAt: effectiveExpiresAt === undefined ? millisToDate(payload.expiresDate) : effectiveExpiresAt,
        metadata: options.raw,
      });
    }
    return { success: true, item: rows[0] };
  }

  private async refreshEntitlementFromLatestTransaction(appId: string, userId: string, originalTransactionId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT product_id, apple_product_id, original_transaction_id, status, expires_date, grace_period_expires_date, raw_json
         FROM apple_iap_transactions
        WHERE app_id = $1::uuid AND original_transaction_id = $2
        ORDER BY COALESCE(grace_period_expires_date, expires_date) DESC NULLS LAST, created_at DESC
        LIMIT 1`,
      appId,
      originalTransactionId,
    ) as Promise<Array<Record<string, unknown>>>);
    const row = rows[0];
    if (!row) return;
    await this.upsertEntitlement(appId, userId, {
      productId: safeString(row.product_id) || null,
      appleProductId: safeString(row.apple_product_id),
      originalTransactionId,
      status: safeString(row.status) || 'ACTIVE',
      expiresAt: row.grace_period_expires_date instanceof Date ? row.grace_period_expires_date : row.expires_date instanceof Date ? row.expires_date : null,
      metadata: row.raw_json as Record<string, unknown>,
    });
  }

  private async upsertEntitlement(
    appId: string,
    userId: string,
    input: {
      productId: string | null;
      appleProductId: string;
      originalTransactionId: string;
      status: string;
      expiresAt: Date | null;
      metadata: Record<string, unknown>;
    },
  ) {
    const entitlementKey = `apple_iap:${input.originalTransactionId}`;
    const isActive = this.isEntitlementActive(input.status, input.expiresAt);
    const existing = await (this.prisma.$queryRawUnsafe(
      `SELECT id
         FROM user_entitlements
        WHERE app_id = $1::uuid
          AND user_id = $2::uuid
          AND (
            entitlement_key = $3
            OR (source = 'APPLE_IAP' AND original_transaction_id = $4)
          )
        ORDER BY updated_at DESC
        LIMIT 1`,
      appId,
      userId,
      entitlementKey,
      input.originalTransactionId,
    ) as Promise<Array<{ id: string }>>);
    if (existing[0]?.id) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE user_entitlements
            SET entitlement_key = $4,
                scope = 'apple_iap',
                product_code = $5,
                product_id = $6::uuid,
                external_product_id = $7,
                original_transaction_id = $8,
                status = $9,
                expires_at = $10,
                is_active = $11,
                metadata_json = $12::jsonb,
                updated_at = now()
          WHERE id = $1::uuid AND app_id = $2::uuid AND user_id = $3::uuid`,
        existing[0].id,
        appId,
        userId,
        entitlementKey,
        input.appleProductId || 'apple_iap',
        input.productId,
        input.appleProductId || null,
        input.originalTransactionId,
        input.status,
        input.expiresAt,
        isActive,
        JSON.stringify(input.metadata || {}),
      );
      return;
    }
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO user_entitlements (
         app_id, user_id, entitlement_key, scope, source, product_code, product_id, external_product_id,
         original_transaction_id, status, starts_at, expires_at, is_active, metadata_json
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'apple_iap', 'APPLE_IAP', $4, $5::uuid, $6,
         $7, $8, now(), $9, $10, $11::jsonb
       )
       ON CONFLICT (app_id, user_id, entitlement_key) DO UPDATE
       SET scope = 'apple_iap',
           source = 'APPLE_IAP',
           product_code = EXCLUDED.product_code,
           product_id = EXCLUDED.product_id,
           external_product_id = EXCLUDED.external_product_id,
           original_transaction_id = EXCLUDED.original_transaction_id,
           status = EXCLUDED.status,
           expires_at = EXCLUDED.expires_at,
           is_active = EXCLUDED.is_active,
           metadata_json = EXCLUDED.metadata_json,
           updated_at = now()`,
      appId,
      userId,
      entitlementKey,
      input.appleProductId || 'apple_iap',
      input.productId,
      input.appleProductId || null,
      input.originalTransactionId,
      input.status,
      input.expiresAt,
      isActive,
      JSON.stringify(input.metadata || {}),
    );
  }

  private async findPaymentProductId(appId: string, appleProductId: string) {
    if (!appleProductId) return null;
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
         FROM payment_products
        WHERE app_id = $1::uuid AND apple_product_id = $2
        LIMIT 1`,
      appId,
      appleProductId,
    ) as Promise<Array<{ id: string }>>).catch(() => []);
    return rows[0]?.id || null;
  }

  private async findUserIdForOriginalTransaction(appId: string, originalTransactionId: string) {
    if (!originalTransactionId) return null;
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT user_id
         FROM apple_iap_transactions
        WHERE app_id = $1::uuid
          AND original_transaction_id = $2
          AND user_id IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      appId,
      originalTransactionId,
    ) as Promise<Array<{ user_id: string | null }>>);
    return rows[0]?.user_id || null;
  }

  private async resolveUserIdForAppleEvent(
    appId: string,
    transaction: TransactionPayload | null,
    renewal: RenewalPayload | null,
    originalTransactionId: string,
  ) {
    const existingUserId = await this.findUserIdForOriginalTransaction(appId, originalTransactionId);
    if (existingUserId) return existingUserId;
    const appAccountToken = safeString(transaction?.appAccountToken || renewal?.appAccountToken);
    if (!this.looksLikeUuid(appAccountToken)) return null;
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id
         FROM users
        WHERE app_id = $1::uuid
          AND id = $2::uuid
          AND deleted_at IS NULL
          AND is_active = true
        LIMIT 1`,
      appId,
      appAccountToken,
    ) as Promise<Array<{ id: string }>>);
    return rows[0]?.id || null;
  }

  private buildNotificationProcessPlan(
    notificationType: string,
    subtype: string | null,
    transaction: TransactionPayload | null,
    renewal: RenewalPayload | null,
  ): NotificationProcessPlan {
    const type = notificationType.toUpperCase();
    const normalizedSubtype = safeString(subtype).toUpperCase();
    if (type === 'TEST') {
      return { entitlementStatus: null, entitlementExpiresAt: null, shouldPersistTransaction: false, shouldRefreshEntitlement: false, action: 'ack_test' };
    }
    if (!transaction) {
      return { entitlementStatus: null, entitlementExpiresAt: null, shouldPersistTransaction: false, shouldRefreshEntitlement: false, action: 'record_metadata_only' };
    }
    const baseExpiresAt = this.deriveEntitlementExpiresAt(transaction, renewal, '');
    switch (type) {
      case 'SUBSCRIBED':
      case 'DID_RENEW':
      case 'OFFER_REDEEMED':
      case 'RENEWAL_EXTENDED':
      case 'REFUND_REVERSED':
      case 'ONE_TIME_CHARGE':
      case 'MIGRATION':
        return { entitlementStatus: 'ACTIVE', entitlementExpiresAt: baseExpiresAt, shouldPersistTransaction: true, shouldRefreshEntitlement: true, action: 'grant_or_extend' };
      case 'DID_FAIL_TO_RENEW':
        if (normalizedSubtype === 'GRACE_PERIOD' && renewal?.gracePeriodExpiresDate) {
          return {
            entitlementStatus: 'GRACE_PERIOD',
            entitlementExpiresAt: millisToDate(renewal.gracePeriodExpiresDate),
            shouldPersistTransaction: true,
            shouldRefreshEntitlement: true,
            action: 'enter_grace_period',
          };
        }
        return { entitlementStatus: 'BILLING_RETRY', entitlementExpiresAt: baseExpiresAt, shouldPersistTransaction: true, shouldRefreshEntitlement: true, action: 'enter_billing_retry' };
      case 'GRACE_PERIOD_EXPIRED':
      case 'EXPIRED':
        return { entitlementStatus: 'EXPIRED', entitlementExpiresAt: baseExpiresAt, shouldPersistTransaction: true, shouldRefreshEntitlement: true, action: 'expire' };
      case 'REFUND':
      case 'REVOKE':
        return { entitlementStatus: 'REVOKED', entitlementExpiresAt: millisToDate(transaction.revocationDate) || new Date(), shouldPersistTransaction: true, shouldRefreshEntitlement: true, action: 'revoke' };
      case 'DID_CHANGE_RENEWAL_PREF':
        if (normalizedSubtype === 'UPGRADE' || transaction.isUpgraded) {
          return { entitlementStatus: 'UPGRADED', entitlementExpiresAt: baseExpiresAt, shouldPersistTransaction: true, shouldRefreshEntitlement: true, action: 'mark_upgraded' };
        }
        return { entitlementStatus: this.deriveTransactionStatus(transaction), entitlementExpiresAt: baseExpiresAt, shouldPersistTransaction: true, shouldRefreshEntitlement: true, action: 'update_renewal_preference' };
      case 'DID_CHANGE_RENEWAL_STATUS':
      case 'PRICE_INCREASE':
      case 'PRICE_CHANGE':
      case 'REFUND_DECLINED':
      case 'CONSUMPTION_REQUEST':
      case 'RENEWAL_EXTENSION':
      case 'METADATA_UPDATE':
        return { entitlementStatus: this.deriveTransactionStatus(transaction), entitlementExpiresAt: baseExpiresAt, shouldPersistTransaction: true, shouldRefreshEntitlement: true, action: 'update_metadata' };
      default:
        return { entitlementStatus: this.deriveTransactionStatus(transaction), entitlementExpiresAt: baseExpiresAt, shouldPersistTransaction: true, shouldRefreshEntitlement: true, action: 'record_unknown_type' };
    }
  }

  private deriveTransactionStatus(payload: TransactionPayload) {
    if (payload.revocationDate) return 'REVOKED';
    if (payload.isUpgraded) return 'UPGRADED';
    if (payload.expiresDate && Number(payload.expiresDate) < Date.now()) return 'EXPIRED';
    return 'ACTIVE';
  }

  private deriveEntitlementExpiresAt(payload: TransactionPayload, renewal: RenewalPayload | null | undefined, status: string) {
    if (status === 'GRACE_PERIOD' && renewal?.gracePeriodExpiresDate) {
      return millisToDate(renewal.gracePeriodExpiresDate);
    }
    return millisToDate(payload.expiresDate);
  }

  private isEntitlementActive(status: string, expiresAt: Date | null) {
    const normalized = safeString(status).toUpperCase();
    if (['REVOKED', 'REFUNDED', 'EXPIRED', 'UPGRADED', 'BILLING_RETRY'].includes(normalized)) {
      return false;
    }
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return false;
    }
    return true;
  }

  private async markNotificationProcessed(notificationUuid: string, status: string, error: string | null, actions: string[]) {
    await this.prisma.$executeRawUnsafe(
      `UPDATE apple_iap_notifications
          SET processing_status = $2,
              processing_error = $3,
              processed_actions = $4::jsonb,
              processed_at = now()
        WHERE notification_uuid = $1`,
      notificationUuid,
      status,
      error ? error.slice(0, 2000) : null,
      JSON.stringify(actions || []),
    );
  }

  private async ensureSchema() {
    if (this.schemaReady) return;
    if (!this.schemaPromise) {
      this.schemaPromise = this.initializeSchema();
    }
    await this.schemaPromise;
    this.schemaReady = true;
  }

  private async initializeSchema() {
    const statements = [
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS last_notification_type varchar(128) NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS last_notification_subtype varchar(128) NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS last_notification_signed_date timestamptz NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS app_account_token uuid NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS app_transaction_id varchar(128) NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS auto_renew_status integer NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS expiration_intent integer NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS is_in_billing_retry_period boolean NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS grace_period_expires_date timestamptz NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS renewal_date timestamptz NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS revocation_reason integer NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS revocation_type varchar(64) NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS revocation_percentage integer NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS currency varchar(8) NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS price_milliunits bigint NULL`,
      `ALTER TABLE apple_iap_transactions ADD COLUMN IF NOT EXISTS renewal_price_milliunits bigint NULL`,
      `CREATE INDEX IF NOT EXISTS idx_apple_iap_transactions_app_account_token ON apple_iap_transactions(app_id, app_account_token) WHERE app_account_token IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_apple_iap_transactions_notification_signed ON apple_iap_transactions(app_id, original_transaction_id, last_notification_signed_date DESC)`,
      `ALTER TABLE apple_iap_notifications ADD COLUMN IF NOT EXISTS signed_date timestamptz NULL`,
      `ALTER TABLE apple_iap_notifications ADD COLUMN IF NOT EXISTS processing_status varchar(32) NOT NULL DEFAULT 'PROCESSED'`,
      `ALTER TABLE apple_iap_notifications ADD COLUMN IF NOT EXISTS processing_error text NULL`,
      `ALTER TABLE apple_iap_notifications ADD COLUMN IF NOT EXISTS processed_actions jsonb NOT NULL DEFAULT '[]'::jsonb`,
      `CREATE INDEX IF NOT EXISTS idx_apple_iap_notifications_status_created ON apple_iap_notifications(processing_status, created_at DESC)`,
    ];
    for (const statement of statements) {
      await this.prisma.$executeRawUnsafe(statement);
    }
  }

  private looksLikeUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}

function numberOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function uuidOrNull(value: unknown): string | null {
  const text = safeString(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}
