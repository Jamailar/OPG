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
  const refreshInactivityDays = 30;
  const refreshAbsoluteDays = 180;

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
      expiresIn: '24h',
      refreshInactivityDays,
      refreshAbsoluteDays,
    },
    cors: {
      origins: parseCorsOrigins(),
    },
    smtp: {
      host: '',
      port: 465,
      user: undefined,
      password: undefined,
    },
    aliyun: {
      accessKeyId: undefined,
      accessKeySecret: undefined,
      oss: {
        endpoint: undefined,
        bucket: undefined,
        timeoutMs: 300_000,
        cdnBaseUrl: undefined,
        cdnAuthEnabled: false,
        cdnAuthKey: '',
        cdnAuthWindowSeconds: 120,
      },
    },
    alipay: {
      enabled: false,
      sandboxDebug: false,
      gatewayUrl: '',
      appId: undefined,
      privateKey: undefined,
      alipayPublicKey: undefined,
      signType: 'RSA2',
      notifyUrl: undefined,
      returnUrl: undefined,
      agreementNotifyUrl: undefined,
      agreementReturnUrl: undefined,
    },
    wechatPay: {
      enabled: false,
      gatewayUrl: 'https://api.mch.weixin.qq.com',
      appId: undefined,
      mchId: undefined,
      apiKey: undefined,
      notifyUrl: undefined,
    },
    payments: {
      autoDeductionEnabled: false,
      autoDeductionIntervalMs: 5 * 60 * 1000,
      autoDeductionBatchSize: 50,
    },
    apple: {
      rootCertificatesPem: '',
    },
    wechatAuth: {
      redirectUri: '',
      allowedRedirectHosts: [],
    },
  };
});
