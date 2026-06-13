import { registerAs } from '@nestjs/config';

export interface AppConfig {
  port: number;
  env: string;
  app: {
    defaultSlug: string;
    platformSlug: string;
  };
  database: {
    url: string;
    queryLogEnabled: boolean;
  };
  redis: {
    url: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
    refreshInactivityDays: number;
    refreshAbsoluteDays: number;
  };
  cors: {
    origins: string[];
  };
  smtp: {
    host: string;
    port: number;
    user?: string;
    password?: string;
  };
  aliyun: {
    accessKeyId?: string;
    accessKeySecret?: string;
    oss?: {
      endpoint?: string;
      bucket?: string;
      timeoutMs?: number;
      cdnBaseUrl?: string;
      cdnAuthEnabled?: boolean;
      cdnAuthKey?: string;
      cdnAuthWindowSeconds?: number;
    };
  };
  alipay: {
    enabled: boolean;
    sandboxDebug: boolean;
    gatewayUrl: string;
    appId?: string;
    privateKey?: string;
    alipayPublicKey?: string;
    signType: string;
    notifyUrl?: string;
    returnUrl?: string;
    agreementNotifyUrl?: string;
    agreementReturnUrl?: string;
  };
  wechatPay: {
    enabled: boolean;
    gatewayUrl: string;
    appId?: string;
    mchId?: string;
    apiKey?: string;
    notifyUrl?: string;
  };
  payments: {
    autoDeductionEnabled: boolean;
    autoDeductionIntervalMs: number;
    autoDeductionBatchSize: number;
  };
  apple: {
    rootCertificatesPem: string;
  };
  wechatAuth: {
    redirectUri: string;
    allowedRedirectHosts: string[];
  };
}

function parseCorsOrigins(): string[] {
  const raw = [
    process.env.CORS_ALLOW_ORIGINS,
    process.env.CORS_ALLOWED_ORIGINS,
    process.env.CORS_ORIGINS,
    process.env.ALLOWED_ORIGINS,
    process.env.APPADMIN_URL,
    process.env.ADMIN_FRONTEND_URL,
    process.env.FRONTEND_URL,
  ]
    .filter(Boolean)
    .join(',');
  const origins = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (origins.length > 0) {
    return origins;
  }

  return ['http://localhost:3000'];
}

function parseCommaSeparatedList(value?: string): string[] {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function appendDbUrlParam(rawUrl: string, key: string, value?: string): string {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return rawUrl;
  }
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, normalizedValue);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export default registerAs('app', (): AppConfig => {
  const port = parseInt(process.env.PORT || '3000', 10);
  let databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.JWT_SECRET_KEY;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  if (!jwtSecret) {
    throw new Error('JWT_SECRET_KEY environment variable is required');
  }

  databaseUrl = appendDbUrlParam(
    databaseUrl,
    'connection_limit',
    process.env.DATABASE_CONNECTION_LIMIT || process.env.PRISMA_CONNECTION_LIMIT,
  );
  databaseUrl = appendDbUrlParam(
    databaseUrl,
    'pool_timeout',
    process.env.DATABASE_POOL_TIMEOUT_SECONDS || process.env.PRISMA_POOL_TIMEOUT_SECONDS,
  );
  databaseUrl = appendDbUrlParam(
    databaseUrl,
    'connect_timeout',
    process.env.DATABASE_CONNECT_TIMEOUT_SECONDS || process.env.PRISMA_CONNECT_TIMEOUT_SECONDS,
  );
  const refreshInactivityDays = parsePositiveInt(process.env.JWT_REFRESH_INACTIVITY_DAYS, 30, 1, 3650);
  const refreshAbsoluteDays = Math.max(
    refreshInactivityDays,
    parsePositiveInt(process.env.JWT_REFRESH_ABSOLUTE_DAYS, 180, refreshInactivityDays, 3650),
  );

  return {
    port,
    env: process.env.NODE_ENV || 'development',
    app: {
      defaultSlug: process.env.DEFAULT_APP_SLUG || 'demo',
      platformSlug: process.env.PLATFORM_APP_SLUG || 'platform',
    },
    database: {
      url: databaseUrl,
      queryLogEnabled: String(process.env.PRISMA_QUERY_LOG || '').trim().toLowerCase() === 'true',
    },
    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379/0',
    },
    jwt: {
      secret: jwtSecret,
      expiresIn: process.env.JWT_EXPIRES_IN || '24h',
      refreshInactivityDays,
      refreshAbsoluteDays,
    },
    cors: {
      origins: parseCorsOrigins(),
    },
    smtp: {
      host: process.env.SMTP_SERVER || 'smtp.qiye.aliyun.com',
      port: parseInt(process.env.SMTP_PORT || '465', 10),
      user: process.env.SENDER_EMAIL,
      password: process.env.SENDER_PASSWORD,
    },
    aliyun: {
      accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID || process.env.ALIYUN_OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET || process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
      oss: {
        endpoint: process.env.ALIYUN_OSS_ENDPOINT,
        bucket: process.env.ALIYUN_OSS_BUCKET,
        timeoutMs: Math.max(30_000, Math.min(900_000, parseInt(process.env.ALIYUN_OSS_TIMEOUT_MS || '300000', 10) || 300_000)),
        cdnBaseUrl: process.env.ALIYUN_OSS_CDN_BASE_URL,
        cdnAuthEnabled: String(process.env.ALIYUN_OSS_CDN_AUTH_ENABLED || '').trim().toLowerCase() === 'true',
        cdnAuthKey: process.env.ALIYUN_OSS_CDN_AUTH_KEY || '',
        cdnAuthWindowSeconds: Math.max(30, Math.min(3600, parseInt(process.env.ALIYUN_OSS_CDN_AUTH_WINDOW_SECONDS || '120', 10) || 120)),
      },
    },
    alipay: {
      enabled: process.env.ALIPAY_ENABLED === 'true',
      sandboxDebug: process.env.ALIPAY_SANDBOX_DEBUG === 'true',
      gatewayUrl: process.env.ALIPAY_GATEWAY_URL || '',
      appId: process.env.ALIPAY_APP_ID,
      privateKey: process.env.ALIPAY_APP_PRIVATE_KEY,
      alipayPublicKey: process.env.ALIPAY_ALIPAY_PUBLIC_KEY,
      signType: process.env.ALIPAY_SIGN_TYPE || 'RSA2',
      notifyUrl: process.env.ALIPAY_NOTIFY_URL,
      returnUrl: process.env.ALIPAY_RETURN_URL,
      agreementNotifyUrl: process.env.ALIPAY_AGREEMENT_NOTIFY_URL,
      agreementReturnUrl: process.env.ALIPAY_AGREEMENT_RETURN_URL,
    },
    wechatPay: {
      enabled: process.env.WECHAT_PAY_ENABLED === 'true',
      gatewayUrl: process.env.WECHAT_PAY_GATEWAY_URL || 'https://api.mch.weixin.qq.com',
      appId: process.env.WECHAT_PAY_APP_ID,
      mchId: process.env.WECHAT_PAY_MCH_ID,
      apiKey: process.env.WECHAT_PAY_API_KEY,
      notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL,
    },
    payments: {
      autoDeductionEnabled: String(process.env.PAYMENTS_AUTO_DEDUCTION_ENABLED || '').trim().toLowerCase() === 'true',
      autoDeductionIntervalMs: parsePositiveInt(
        process.env.PAYMENTS_AUTO_DEDUCTION_INTERVAL_MS,
        5 * 60 * 1000,
        60 * 1000,
        24 * 60 * 60 * 1000,
      ),
      autoDeductionBatchSize: parsePositiveInt(process.env.PAYMENTS_AUTO_DEDUCTION_BATCH_SIZE, 50, 1, 500),
    },
    apple: {
      rootCertificatesPem: process.env.APPLE_ROOT_CERTIFICATES_PEM || '',
    },
    wechatAuth: {
      redirectUri:
        process.env.WECHAT_AUTH_REDIRECT_URI
        || process.env.WECHAT_REDIRECT_URI
        || '',
      allowedRedirectHosts: parseCommaSeparatedList(
        process.env.WECHAT_AUTH_ALLOWED_REDIRECT_HOSTS || process.env.WECHAT_AUTH_ALLOWED_CALLBACK_HOSTS,
      ).map((item) => item.toLowerCase()),
    },
  };
});
