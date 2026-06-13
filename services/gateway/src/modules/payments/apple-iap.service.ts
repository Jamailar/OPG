import { BadRequestException, Inject, Injectable } from '@nestjs/common';
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
  signedDate?: number;
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
export class AppleIapService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly appleIdentityService: AppleIdentityService,
  ) {}

  async verifyTransaction(appSlug: string | undefined, userId: string, body: { transaction_id?: string; signed_transaction_info?: string }) {
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
    const data = decoded.data || {};
    const transactionPayload = data.signedTransactionInfo
      ? await this.decodeSignedTransaction(appleConfig, String(data.signedTransactionInfo))
      : ({} as TransactionPayload);
    const renewalPayload = data.signedRenewalInfo ? await this.decodeSignedRenewal(appleConfig, String(data.signedRenewalInfo)) : {};
    const originalTransactionId = safeString(transactionPayload.originalTransactionId || (renewalPayload as any).originalTransactionId);
    const transactionId = safeString(transactionPayload.transactionId);
    const uuid = notificationUuid || `${notificationType}:${transactionId || originalTransactionId}:${safeString(decoded.signedDate)}`;

    const inserted = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO apple_iap_notifications (
         app_id, notification_uuid, notification_type, subtype, transaction_id, original_transaction_id,
         environment, signed_payload, decoded_payload, processed_at
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now()
       )
       ON CONFLICT (notification_uuid) DO NOTHING
       RETURNING true AS inserted`,
      app.id,
      uuid,
      notificationType,
      subtype,
      transactionId || null,
      originalTransactionId || null,
      safeString(data.environment || transactionPayload.environment) || null,
      signedPayload,
      JSON.stringify(decoded),
    ) as Promise<Array<{ inserted: boolean }>>);
    if (!inserted[0]?.inserted) {
      return { success: true, duplicate: true };
    }

    if (transactionId || originalTransactionId) {
      const userId = await this.findUserIdForOriginalTransaction(app.id, originalTransactionId);
      await this.persistTransaction(app.id, userId, transactionPayload, {
        signedTransactionInfo: data.signedTransactionInfo || null,
        signedRenewalInfo: data.signedRenewalInfo || null,
        raw: decoded,
      });
    }
    return { success: true, duplicate: false, notification_type: notificationType };
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
    options: { signedTransactionInfo: string | null; signedRenewalInfo: string | null; raw: Record<string, unknown> },
  ) {
    const transactionId = safeString(payload.transactionId);
    const originalTransactionId = safeString(payload.originalTransactionId || payload.transactionId);
    const appleProductId = safeString(payload.productId);
    if (!transactionId && !originalTransactionId) {
      throw new BadRequestException('Apple transaction id is required');
    }
    const status = payload.revocationDate ? 'REVOKED' : payload.expiresDate && Number(payload.expiresDate) < Date.now() ? 'EXPIRED' : 'ACTIVE';
    const productId = await this.findPaymentProductId(appId, appleProductId);
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO apple_iap_transactions (
         app_id, user_id, transaction_id, original_transaction_id, web_order_line_item_id,
         product_id, apple_product_id, environment, status, purchase_date, expires_date, revocation_date,
         signed_transaction_info, signed_renewal_info, raw_json
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5,
         $6::uuid, $7, $8, $9, $10, $11, $12,
         $13, $14, $15::jsonb
       )
       ON CONFLICT (transaction_id) DO UPDATE
       SET user_id = COALESCE(EXCLUDED.user_id, apple_iap_transactions.user_id),
           status = EXCLUDED.status,
           expires_date = EXCLUDED.expires_date,
           revocation_date = EXCLUDED.revocation_date,
           signed_transaction_info = COALESCE(EXCLUDED.signed_transaction_info, apple_iap_transactions.signed_transaction_info),
           signed_renewal_info = COALESCE(EXCLUDED.signed_renewal_info, apple_iap_transactions.signed_renewal_info),
           raw_json = EXCLUDED.raw_json,
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
    ) as Promise<Array<Record<string, unknown>>>);
    if (userId && originalTransactionId) {
      await this.upsertEntitlement(appId, userId, {
        productId,
        appleProductId,
        originalTransactionId,
        status,
        expiresAt: millisToDate(payload.expiresDate),
        metadata: options.raw,
      });
    }
    return { success: true, item: rows[0] };
  }

  private async refreshEntitlementFromLatestTransaction(appId: string, userId: string, originalTransactionId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT product_id, apple_product_id, original_transaction_id, status, expires_date, raw_json
         FROM apple_iap_transactions
        WHERE app_id = $1::uuid AND original_transaction_id = $2
        ORDER BY expires_date DESC NULLS LAST, created_at DESC
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
      expiresAt: row.expires_date instanceof Date ? row.expires_date : null,
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
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO user_entitlements (
         app_id, user_id, source, product_code, product_id, external_product_id,
         original_transaction_id, status, starts_at, expires_at, metadata_json
       ) VALUES (
         $1::uuid, $2::uuid, 'APPLE_IAP', $3, $4::uuid, $5,
         $6, $7, now(), $8, $9::jsonb
       )
       ON CONFLICT (app_id, user_id, source, original_transaction_id) WHERE original_transaction_id IS NOT NULL DO UPDATE
       SET product_code = EXCLUDED.product_code,
           product_id = EXCLUDED.product_id,
           external_product_id = EXCLUDED.external_product_id,
           status = EXCLUDED.status,
           expires_at = EXCLUDED.expires_at,
           metadata_json = EXCLUDED.metadata_json,
           updated_at = now()`,
      appId,
      userId,
      input.appleProductId || 'apple_iap',
      input.productId,
      input.appleProductId || null,
      input.originalTransactionId,
      input.status,
      input.expiresAt,
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
}
