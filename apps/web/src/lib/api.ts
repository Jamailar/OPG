/**
 * API 客户端
 */
import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { runtimeContext } from '@/lib/runtime-context';

function isNotFoundError(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 404) {
    return false;
  }
  const message = String((error.response?.data as any)?.message || '').trim();
  if (!message) {
    return false;
  }
  return /^Cannot\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+/i.test(message) || message === 'Not Found';
}

async function withRedeemProductPathFallback<T>(
  request: (segment: 'packages' | 'products') => Promise<T>,
): Promise<T> {
  try {
    return await request('packages');
  } catch (error) {
    if (isNotFoundError(error)) {
      return request('products');
    }
    throw error;
  }
}

async function withNotFoundFallback<T>(requests: Array<() => Promise<T>>): Promise<T> {
  let lastError: unknown = null;
  for (let i = 0; i < requests.length; i += 1) {
    try {
      return await requests[i]();
    } catch (error) {
      lastError = error;
      if (isNotFoundError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('request failed');
}

class ApiClient {
  private client: AxiosInstance;
  private isRefreshing = false;
  private failedQueue: Array<{
    resolve: (value?: unknown) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  private normalizeApiPath(inputUrl: string): string {
    let raw = (inputUrl || '').trim();
    if (!raw) return '';
    try {
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        const parsed = new URL(raw);
        raw = `${parsed.pathname}${parsed.search || ''}`;
      }
    } catch {
      // ignore URL parse errors and keep raw
    }
    if (!raw.startsWith('/')) raw = `/${raw}`;
    raw = raw.replace(/^\/api\/v1(?=\/)/, '');
    raw = raw.replace(/^\/platform\/v1(?=\/)/, '');
    return raw;
  }

  private shouldRetryPathFallback(path: string): boolean {
    if (!runtimeContext.isPlatformPortal) return false;
    return path.startsWith('/platform-admin/') || path.startsWith('/upload/');
  }

  private buildFallbackUrl(normalizedPath: string, stage: number): string | null {
    const base = (runtimeContext.apiBaseUrl || '').replace(/\/+$/, '');
    if (!base || !normalizedPath) return null;
    if (stage === 1) return `${base}/platform/v1${normalizedPath}`;
    if (stage === 2) return `${base}${normalizedPath}`;
    return null;
  }

  constructor() {
    this.client = axios.create({
      baseURL: runtimeContext.apiV1BaseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      withCredentials: true, // 发送 cookies 用于 refresh token
    });

    // 请求拦截器 - 添加 token
    this.client.interceptors.request.use(
      (config) => {
        if (runtimeContext.apiV1BaseUrl) {
          config.baseURL = runtimeContext.apiV1BaseUrl;
        }
        // 从 localStorage 获取 token
        const token = this.getToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // 响应拦截器 - 处理 401 错误并自动刷新 token
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config as InternalAxiosRequestConfig & {
          _retry?: boolean;
          _pathFallbackStage?: number;
        };

        // 平台管理端：网关路径存在历史差异时，按顺序回退重试
        if (error.response?.status === 404 && originalRequest?.url) {
          const currentStage = Number(originalRequest._pathFallbackStage || 0);
          const normalizedPath = this.normalizeApiPath(originalRequest.url);
          if (currentStage < 2 && this.shouldRetryPathFallback(normalizedPath)) {
            const nextStage = currentStage + 1;
            const nextUrl = this.buildFallbackUrl(normalizedPath, nextStage);
            if (nextUrl) {
              const retryRequest: InternalAxiosRequestConfig & { _pathFallbackStage?: number } = {
                ...originalRequest,
                baseURL: undefined,
                url: nextUrl,
              };
              retryRequest._pathFallbackStage = nextStage;
              return this.client.request(retryRequest);
            }
          }
        }

        // 如果不是 401 错误，直接返回
        if (error.response?.status !== 401) {
          return Promise.reject(error);
        }

        // 如果是 refresh 请求本身失败，不再重试
        if (originalRequest.url?.includes('/auth/refresh')) {
          this.clearTokenAndRedirect();
          return Promise.reject(error);
        }

        // 如果已经重试过，放弃
        if (originalRequest._retry) {
          this.clearTokenAndRedirect();
          return Promise.reject(error);
        }

        // 如果正在刷新 token，将请求加入队列
        if (this.isRefreshing) {
          return new Promise((resolve, reject) => {
            this.failedQueue.push({ resolve, reject });
          }).then((token) => {
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            return this.client(originalRequest);
          }).catch((err) => {
            return Promise.reject(err);
          });
        }

        // 标记正在刷新
        originalRequest._retry = true;
        this.isRefreshing = true;

        try {
          const newToken = await this.refreshAccessToken();

          // 处理队列中的请求
          this.processQueue(null, newToken);

          // 使用新 token 重试原始请求
          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
          }
          return this.client(originalRequest);
        } catch (refreshError) {
          // 刷新失败，处理队列并跳转登录
          this.processQueue(refreshError, null);
          this.clearTokenAndRedirect();
          return Promise.reject(refreshError);
        } finally {
          this.isRefreshing = false;
        }
      }
    );
  }

  // 处理队列中的请求
  private processQueue(error: unknown, token: string | null = null): void {
    this.failedQueue.forEach((prom) => {
      if (error) {
        prom.reject(error);
      } else {
        prom.resolve(token);
      }
    });
    this.failedQueue = [];
  }

  // 尝试刷新 token
  private async refreshAccessToken(): Promise<string> {
    const localRefreshToken = this.getRefreshToken();
    const response = await axios.post(
      `${runtimeContext.apiV1BaseUrl}/auth/refresh`,
      localRefreshToken ? { refresh_token: localRefreshToken } : {},
      { withCredentials: true } // 发送 cookies
    );

    const { access_token, refresh_token } = response.data;

    // 保存新 token
    this.setToken(access_token);
    if (refresh_token) {
      this.setRefreshToken(refresh_token);
    }

    return access_token;
  }

  // 清除 token 并跳转登录
  private clearTokenAndRedirect(): void {
    this.clearToken();
    if (typeof window !== 'undefined') {
      window.location.href = runtimeContext.loginPath;
    }
  }

  private getToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('access_token');
  }

  private getRefreshToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('refresh_token');
  }

  private clearToken(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('user');
    localStorage.removeItem('user_info');
  }

  setToken(token: string): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem('access_token', token);
  }

  setRefreshToken(token: string): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem('refresh_token', token);
  }

  getClient(): AxiosInstance {
    return this.client;
  }
}

export const apiClient = new ApiClient();

export interface OpgSdkManifest {
  manifest_version: string;
  app: {
    id: string;
    slug: string;
    name: string;
    status: string;
    api_base_url: string;
    bare_api_base_url: string;
  };
  sdk: {
    package: string;
    cli_package: string;
    min_node_version: string;
  };
  auth: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  routes: Record<string, string>;
  codex: {
    install_command: string;
    mcp_server_command: string;
    mcp_server_args: string[];
    environment: string[];
  };
}

export interface OpgSdkSmokeResult {
  ok: boolean;
  app: OpgSdkManifest['app'];
  actor: Record<string, unknown> | null;
  checks: Array<{ key: string; ok: boolean; message: string }>;
  next: Record<string, string>;
}

export interface PlatformAppSchemaColumn {
  id: string;
  slug: string;
  physical_column_name: string;
  data_type: string;
  is_nullable: boolean;
  is_unique?: boolean;
  is_indexed?: boolean;
  is_hidden?: boolean;
  is_readonly?: boolean;
  ordinal_position?: number;
}

export interface PlatformAppSchemaTable {
  id: string;
  slug: string;
  physical_table_name: string;
  display_name?: string | null;
  description?: string | null;
  primary_key: string;
  owner_column?: string | null;
  soft_delete_column?: string | null;
  status: string;
  columns: PlatformAppSchemaColumn[];
}

export interface PlatformAppSchemaManifest {
  manifest_version: string;
  app: {
    id: string;
    slug: string;
    name: string;
    status: string;
  };
  namespace: string;
  capabilities: Record<string, unknown>;
  schema: {
    tables: PlatformAppSchemaTable[];
  };
  migrations: {
    total: number;
    applied: number;
    latest_applied_at?: string | null;
  };
}

export interface PlatformAppBuildSummary {
  app: { id: string; slug: string; name?: string };
  summary: Record<string, number>;
}

export interface PlatformAppBuildEventItem {
  source: string;
  event: string;
  resource_type: string;
  resource_id: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export interface AppApiKeyItem {
  id: string;
  name: string;
  key_prefix: string;
  key_last4: string;
  is_active: boolean;
  created_at: string;
  last_used_at?: string | null;
}

export interface AppApiKeyCreateResult {
  created?: boolean;
  app_slug: string;
  key?: string;
  api_key?: AppApiKeyItem;
  id?: string;
  name?: string;
  key_prefix?: string;
  key_last4?: string;
  created_at?: string;
  message?: string;
}

export interface DeveloperAuthorizationScope {
  key: string;
  label: string;
  group: string;
  risk: 'low' | 'medium' | 'high';
}

export interface DeveloperAuthorizationGrant {
  id: string;
  name: string;
  key_prefix: string;
  key_last4: string;
  user_id?: string | null;
  user_email?: string | null;
  scopes: string[];
  allowed_app_ids: string[];
  allowed_apps: Array<{ id: string; slug: string; name: string }>;
  status: string;
  last_used_at?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
  created_by_email?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BootstrapStatus {
  needs_setup: boolean;
  platform_app_slug: string;
  platform_app_exists: boolean;
  platform_super_admin_exists: boolean;
}

const BOOTSTRAP_REQUEST_TIMEOUT_MS = 15000;

function buildBootstrapUrlCandidates(path: string): string[] {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const apiBaseUrl = (runtimeContext.apiBaseUrl || '').replace(/\/+$/, '');
  const apiV1BaseUrl = (runtimeContext.apiV1BaseUrl || '').replace(/\/+$/, '');
  const browserOrigin = typeof window !== 'undefined' ? window.location.origin.replace(/\/+$/, '') : '';
  const rootBaseUrls = [apiBaseUrl, browserOrigin].filter(Boolean);
  const apiV1BaseUrls = [
    apiV1BaseUrl,
    apiBaseUrl ? `${apiBaseUrl}/api/v1` : '',
    browserOrigin ? `${browserOrigin}/api/v1` : '',
  ].filter(Boolean);
  const candidates = [
    ...rootBaseUrls.map((baseUrl) => `${baseUrl}${normalizedPath}`),
    ...apiV1BaseUrls.map((baseUrl) => `${baseUrl}${normalizedPath}`),
  ];

  if (candidates.length === 0) {
    candidates.push(normalizedPath, `/api/v1${normalizedPath}`);
  }

  return Array.from(new Set(candidates));
}

function canRetryBootstrapCandidate(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  if (!error.response) {
    return true;
  }
  return error.response.status === 404;
}

async function requestBootstrap<T>(
  path: string,
  options: { method: 'GET' | 'POST'; data?: unknown },
): Promise<T> {
  const candidates = buildBootstrapUrlCandidates(path);
  let lastError: unknown = null;

  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const response = await axios.request<T>({
        url: candidates[index],
        method: options.method,
        data: options.data,
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: BOOTSTRAP_REQUEST_TIMEOUT_MS,
        withCredentials: true,
      });
      if (!response.data || typeof response.data !== 'object') {
        lastError = new Error(`bootstrap endpoint returned invalid response: ${candidates[index]}`);
        if (index < candidates.length - 1) {
          continue;
        }
        throw lastError;
      }
      return response.data;
    } catch (error) {
      lastError = error;
      if (index < candidates.length - 1 && canRetryBootstrapCandidate(error)) {
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('bootstrap request failed');
}

export const bootstrapApi = {
  getStatus: async (): Promise<BootstrapStatus> => {
    return requestBootstrap<BootstrapStatus>('/bootstrap/status', { method: 'GET' });
  },

  createPlatformAdmin: async (data: { email: string; password: string; display_name?: string }) => {
    return requestBootstrap('/bootstrap/platform-admin', { method: 'POST', data });
  },
};

// API 方法
export const authApi = {
  // 注册
  register: async (data: { email: string; password: string; username?: string }) => {
    const response = await apiClient.getClient().post('/auth/register', data);
    if (response.data.access_token) {
      apiClient.setToken(response.data.access_token);
      if (response.data.refresh_token) {
        apiClient.setRefreshToken(response.data.refresh_token);
      }
      if (typeof window !== 'undefined') {
        localStorage.setItem('user', JSON.stringify(response.data.user));
      }
    }
    return response.data;
  },

  // 登录
  login: async (data: { email: string; password: string }) => {
    const response = await apiClient.getClient().post('/auth/login', data);
    if (response.data.access_token) {
      apiClient.setToken(response.data.access_token);
      if (response.data.refresh_token) {
        apiClient.setRefreshToken(response.data.refresh_token);
      }
      if (typeof window !== 'undefined') {
        localStorage.setItem('user', JSON.stringify(response.data.user));
      }
    }
    return response.data;
  },

  // Google 登录
  loginGoogle: async (data: { id_token: string }) => {
    const response = await apiClient.getClient().post('/auth/login/google', { id_token: data.id_token });
    if (response.data.access_token) {
      apiClient.setToken(response.data.access_token);
      if (response.data.refresh_token) {
        apiClient.setRefreshToken(response.data.refresh_token);
      }
      if (typeof window !== 'undefined') {
        localStorage.setItem('user', JSON.stringify(response.data.user));
      }
    }
    return response.data;
  },

  // Apple 登录
  loginApple: async (data: { identity_token: string; authorization_code: string; user?: any }) => {
    const response = await apiClient.getClient().post('/auth/login/apple', data);
    if (response.data.access_token) {
      apiClient.setToken(response.data.access_token);
      if (response.data.refresh_token) {
        apiClient.setRefreshToken(response.data.refresh_token);
      }
      if (typeof window !== 'undefined') {
        localStorage.setItem('user', JSON.stringify(response.data.user));
      }
    }
    return response.data;
  },

  // 微信登录
  loginWeChat: async (data: { code: string }) => {
    const response = await apiClient.getClient().post('/auth/login/wechat', data);
    if (response.data.access_token) {
      apiClient.setToken(response.data.access_token);
      if (response.data.refresh_token) {
        apiClient.setRefreshToken(response.data.refresh_token);
      }
      if (typeof window !== 'undefined') {
        localStorage.setItem('user', JSON.stringify(response.data.user));
      }
    }
    return response.data;
  },

  // 发送验证码
  sendVerificationCode: async (email: string) => {
    const response = await apiClient.getClient().post('/auth/send-verification-code', { email });
    return response.data;
  },

  // 验证邮箱
  verifyEmail: async (data: { email: string; code: string }) => {
    const response = await apiClient.getClient().post('/auth/verify-email', data);
    return response.data;
  },

  // 获取当前用户
  getCurrentUser: async () => {
    const response = await apiClient.getClient().get('/users/me');
    return response.data;
  },

  // 登出
  logout: () => {
    apiClient.getClient().defaults.headers.common['Authorization'] = '';
    if (typeof window !== 'undefined') {
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
      localStorage.removeItem('user_info');
    }
  },
};


export interface PlatformAppDomainInput {
  domain: string;
  domain_type: 'BUSINESS_ADMIN' | 'PLATFORM_ADMIN' | 'API' | 'USER_WEB';
  is_primary?: boolean;
}

export type PlatformAppKind = 'DESKTOP' | 'WEBSITE' | 'MOBILE';

export interface PlatformAppSettingsInput {
  app_url?: string;
  brand_name?: string;
  sender_name?: string;
  sender_nickname?: string;
  wechat_redirect_uri?: string;
  wechat_open_app_ref_id?: string;
  wechat_open_app_id?: string;
  wechat_open_app_secret?: string;
  google_oauth_client_ref_id?: string;
  google_client_id?: string;
  github_oauth_app_ref_id?: string;
  github_client_id?: string;
  apple_login_credential_ref_id?: string;
  ios_app_attest_mode?: string;
  apple_app_apple_id?: string;
  payment_method_ref_ids?: string[];
  sms_template_ref_id?: string;
  sms_provider_ref_id?: string;
  sms_signature_ref_id?: string;
  alipay_notify_url?: string;
  alipay_agreement_notify_url?: string;
  extra_json?: Record<string, unknown>;
  notes?: string;
  email_primary_color?: string;
  email_secondary_color?: string;
  email_greeting?: string;
  email_code_label?: string;
  email_expire_text?: string;
  email_footer_text?: string;
}

export interface PlatformAppItem {
  id: string;
  slug: string;
  slug_aliases?: string[];
  name: string;
  kind: PlatformAppKind;
  status: 'ACTIVE' | 'INACTIVE';
  created_at?: string;
  updated_at?: string;
  domains: PlatformAppDomainInput[];
  settings?: PlatformAppSettingsInput | null;
}

export interface PlatformTenantSiteDownloadItem {
  label?: string;
  version?: string;
  url?: string;
  file_key?: string;
  file_name?: string;
  file_size?: string;
  content_type?: string;
  checksum?: string;
  updated_at?: string;
  minimum_os?: string;
  architecture?: string;
}

export interface PlatformTenantSiteDownloadUploadUrl {
  platform: 'macos' | 'windows';
  upload_url: string;
  file_url: string;
  file_key: string;
  headers?: Record<string, string>;
  expires_in?: number;
}

export interface PlatformTenantSiteSettings {
  support_email?: string;
  login_url?: string;
  app_deep_link?: string;
  downloads?: {
    macos?: PlatformTenantSiteDownloadItem;
    windows?: PlatformTenantSiteDownloadItem;
  };
  legal?: {
    updated_at?: string;
    privacy_contact?: string;
    terms_contact?: string;
  };
}

export interface PlatformTenantSiteMessageItem {
  id: string;
  app_id: string;
  type: 'newsletter' | 'contact';
  email?: string | null;
  name?: string | null;
  category?: string | null;
  subject?: string | null;
  message?: string | null;
  locale?: string | null;
  source?: string | null;
  context?: Record<string, unknown>;
  status: 'new' | 'read' | 'archived';
  admin_note?: string | null;
  handled_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PlatformTenantSiteMessageSummary {
  total: number;
  new: number;
  read: number;
  archived: number;
}

export interface PlatformTenantSiteCookieConsentItem {
  id: string;
  app_id: string;
  consent_id: string;
  region_mode: 'eu' | 'us' | 'other';
  essential: boolean;
  analytics: boolean;
  marketing: boolean;
  do_not_sell_share: boolean;
  locale?: string | null;
  source?: string | null;
  context?: Record<string, unknown>;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PlatformTenantSiteCookieConsentSummary {
  total: number;
  analytics_enabled: number;
  marketing_enabled: number;
  do_not_sell_share: number;
  eu: number;
  us: number;
  other: number;
}

export interface PlatformEmailCfAccountItem {
  id: string;
  name: string;
  account_id: string;
  status: 'ACTIVE' | 'INACTIVE';
  notes?: string | null;
  last_verified_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export type PlatformEmailProviderType = 'CLOUDFLARE_EMAIL' | 'SMTP' | 'RESEND' | 'SENDGRID' | 'POSTMARK' | 'MAILGUN';

export interface PlatformEmailProviderCatalogItem {
  provider_type: PlatformEmailProviderType;
  label: string;
  required_config: string[];
  required_secrets: string[];
  optional_config: string[];
}

export interface PlatformEmailProviderItem {
  id: string;
  provider_type: PlatformEmailProviderType;
  name: string;
  external_account_id?: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  config?: Record<string, any>;
  cloudflare_account_id?: string | null;
  notes?: string | null;
  last_verified_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PlatformEmailCloudflareTokenAccount {
  id: string;
  name: string;
  type?: string | null;
}

export interface PlatformEmailCloudflareSendingDomain {
  id: string;
  name: string;
  enabled: boolean;
  zone_id: string;
  zone_name: string;
}

export interface PlatformEmailSenderItem {
  id: string;
  provider_id: string;
  provider_name?: string | null;
  provider_type?: PlatformEmailProviderType | null;
  cf_account_id?: string | null;
  cf_account_name?: string | null;
  app_id?: string | null;
  app_slug?: string | null;
  app_name?: string | null;
  email: string;
  display_name?: string | null;
  domain: string;
  purpose: 'marketing' | 'notification' | 'both';
  status: 'ACTIVE' | 'INACTIVE';
  is_default: boolean;
  last_tested_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PlatformAppEmailSettings {
  app_id?: string;
  marketing_sender_id?: string | null;
  notification_sender_id?: string | null;
  unsubscribe_base_url?: string | null;
  brand_name?: string | null;
  footer_text?: string | null;
  reply_to_email?: string | null;
  updated_at?: string | null;
}

export interface PlatformEmailContactItem {
  id: string;
  app_id: string;
  email: string;
  display_name?: string | null;
  source: string;
  status: 'subscribed' | 'unsubscribed' | 'bounced' | 'suppressed';
  updated_at?: string | null;
}

export interface PlatformEmailTemplateItem {
  id: string;
  app_id: string;
  name: string;
  subject: string;
  html: string;
  text?: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  updated_at?: string | null;
}

export interface PlatformEmailCampaignItem {
  id: string;
  app_id: string;
  sender_id?: string | null;
  sender_email?: string | null;
  name: string;
  subject: string;
  status: string;
  scheduled_at?: string | null;
  recipient_total: number;
  delivered_count: number;
  failed_count: number;
  skipped_count: number;
  retry_count?: number;
  updated_at?: string | null;
}

export type PlatformNotificationChannelType = 'FEISHU_ROBOT' | 'EMAIL';
export type PlatformNotificationSeverity = 'info' | 'warning' | 'high' | 'critical';

export interface PlatformNotificationEventCatalogItem {
  event_type: string;
  label: string;
  min_severity: PlatformNotificationSeverity;
}

export interface PlatformNotificationChannelItem {
  id: string;
  app_id?: string | null;
  app_slug?: string | null;
  app_name?: string | null;
  channel_type: PlatformNotificationChannelType;
  name: string;
  status: 'ACTIVE' | 'INACTIVE' | 'DELETED' | string;
  config?: Record<string, any>;
  secret_configured?: boolean;
  created_by_user_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PlatformNotificationRuleItem {
  id?: string;
  app_id?: string | null;
  event_type: string;
  min_severity: PlatformNotificationSeverity;
  channel_ids: string[];
  enabled: boolean;
  dedupe_window_seconds: number;
  aggregation_window_seconds: number;
  quiet_hours?: Record<string, any>;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PlatformNotificationEventItem {
  id: string;
  app_id?: string | null;
  app_slug?: string | null;
  app_name?: string | null;
  event_type: string;
  severity: PlatformNotificationSeverity | string;
  title: string;
  message?: string | null;
  source_module?: string | null;
  source_id?: string | null;
  dedupe_key?: string | null;
  payload?: Record<string, any>;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PlatformNotificationDeliveryItem {
  id: string;
  event_id: string;
  channel_id: string;
  app_id?: string | null;
  event_type?: string | null;
  severity?: string | null;
  title?: string | null;
  channel_type?: PlatformNotificationChannelType | string;
  channel_name?: string | null;
  status: string;
  attempts: number;
  error_message?: string | null;
  sent_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export type PlatformNotificationChannelInput = {
  app_id?: string | null;
  channel_type: PlatformNotificationChannelType;
  name: string;
  status?: 'ACTIVE' | 'INACTIVE';
  webhook_url?: string;
  secret?: string;
  recipients?: string[];
  sender_id?: string | null;
};

export interface PlatformWechatOpenAppItem {
  id: string;
  name: string;
  app_id: string;
  is_active: boolean;
  has_app_secret: boolean;
  app_secret_masked: string;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformGoogleOAuthClientItem {
  id: string;
  name: string;
  client_id: string;
  outbound_proxy_id?: string | null;
  outbound_proxy?: PlatformOutboundProxySummary | null;
  is_active: boolean;
  has_client_secret: boolean;
  client_secret_masked: string;
  created_at?: string;
  updated_at?: string;
}

export type PlatformOutboundProxyProtocol = 'http' | 'https' | 'socks5';
export type PlatformOutboundProxyStatus = 'active' | 'unhealthy' | 'disabled' | 'checking';

export interface PlatformOutboundProxySummary {
  id: string;
  name: string;
  protocol: PlatformOutboundProxyProtocol | string;
  status: PlatformOutboundProxyStatus | string;
  latency_ms?: number | null;
  detected_ip?: string | null;
  region?: string | null;
}

export interface PlatformOutboundProxyItem extends PlatformOutboundProxySummary {
  host: string;
  port: number;
  username?: string;
  has_password: boolean;
  password_masked?: string;
  fail_count: number;
  last_checked_at?: string | null;
  ai_source_count: number;
  google_oauth_client_count: number;
  reference_count: number;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformOutboundProxyCheckResult {
  check_type: string;
  target_url: string;
  success: boolean;
  status_code: number | null;
  latency_ms: number | null;
  detected_ip?: string | null;
  region?: string | null;
  error_message?: string | null;
}

export interface PlatformOutboundProxyTestResult {
  proxy_id: string;
  ok: boolean;
  status: PlatformOutboundProxyStatus | string;
  success_count: number;
  total_count: number;
  results: PlatformOutboundProxyCheckResult[];
}

export interface PlatformOutboundProxyCheckLogItem extends PlatformOutboundProxyCheckResult {
  id: string;
  proxy_id: string;
  created_at: string;
}

export interface PlatformGitHubOAuthAppItem {
  id: string;
  name: string;
  client_id: string;
  is_active: boolean;
  has_client_secret: boolean;
  client_secret_masked: string;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformOAuthCredentialTestResult {
  success: boolean;
  provider: 'wechat' | 'google' | 'github';
  message: string;
}

export interface PlatformAgentVersionItem {
  id: string;
  version_number: number;
  system_prompt_template: string;
  developer_prompt_template?: string | null;
  default_model?: string | null;
  max_steps: number;
  max_tool_calls: number;
  timeout_ms: number;
  output_mode: 'text' | 'json';
  input_schema_json: Record<string, unknown>;
  output_schema_json: Record<string, unknown>;
  tool_policy_json: Record<string, unknown>;
  created_at?: string;
}

export interface PlatformAgentToolBindingItem {
  tool_key: string;
  is_enabled: boolean;
  config_json: Record<string, unknown>;
}

export interface PlatformAgentBindingItem {
  id: string;
  app_id: string;
  app_slug?: string;
  app_name?: string;
  agent_id: string;
  agent_slug?: string;
  agent_name?: string;
  agent_status?: string;
  route_slug: string;
  is_enabled: boolean;
  auth_policy: 'public' | 'user' | 'admin';
  points_cost: number;
  model_override?: string | null;
  system_prompt_override?: string | null;
  tool_override_json: Record<string, unknown>;
  published_version_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAgentItem {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  scope: 'global' | 'app';
  owner_app_id?: string | null;
  status: 'draft' | 'published' | 'archived';
  visibility: 'private' | 'internal' | 'public';
  latest_version?: PlatformAgentVersionItem | null;
  published_version?: PlatformAgentVersionItem | null;
  latest_version_detail?: (PlatformAgentVersionItem & {
    available_tool_packs?: PlatformAgentToolPackItem[];
    tool_bindings: PlatformAgentToolBindingItem[];
  }) | null;
  published_version_detail?: PlatformAgentVersionItem | null;
  binding_count?: number;
  bindings?: PlatformAgentBindingItem[];
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAgentToolCatalogItem {
  key: string;
  name: string;
  description: string;
  tool_pack: string;
  safety_level: 'readonly';
  input_schema: Record<string, unknown>;
}

export interface PlatformAgentToolPackItem {
  key: string;
  name: string;
  description: string;
}

export interface PlatformAgentRunItem {
  id: string;
  status: string;
  agent_id: string;
  agent_name: string;
  app_id: string;
  app_slug: string;
  user_id?: string | null;
  input_text?: string | null;
  output_text?: string | null;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tool_calls: number;
  points_charged: number;
  started_at?: string;
  completed_at?: string | null;
  created_at?: string;
}

export interface PlatformAgentTestResult {
  run_id: string;
  status: string;
  output_text?: string;
  output_json?: Record<string, unknown>;
  total_tool_calls: number;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
  steps?: Array<Record<string, unknown>>;
}

export type PlatformPaymentProviderType = 'ALIPAY' | 'WECHAT' | 'STRIPE' | 'PADDLE' | 'LEMONSQUEEZY' | 'APPLE_IAP';

export interface PlatformPaymentMethodConfig {
  enabled?: boolean;
  sandbox_debug?: boolean;
  gateway_url?: string;
  app_id?: string;
  sign_type?: string;
  notify_url?: string;
  return_url?: string;
  agreement_notify_url?: string;
  agreement_return_url?: string;
  mch_id?: string;
  private_key?: string;
  alipay_public_key?: string;
  api_key?: string;
  mode?: 'test' | 'live' | 'sandbox' | string;
  api_base_url?: string;
  publishable_key?: string;
  secret_key?: string;
  webhook_secret?: string;
  client_token?: string;
  default_price_id?: string;
  store_id?: string;
  default_variant_id?: string;
  signing_secret?: string;
  success_url?: string;
  cancel_url?: string;
  environment?: 'SANDBOX' | 'PRODUCTION' | string;
  bundle_id?: string;
  app_apple_id?: string;
  issuer_id?: string;
  key_id?: string;
  root_certificates_pem?: string;
  private_key_masked?: string;
  root_certificates_pem_masked?: string;
  alipay_public_key_masked?: string;
  api_key_masked?: string;
  has_private_key?: boolean;
  has_root_certificates_pem?: boolean;
  has_alipay_public_key?: boolean;
  has_api_key?: boolean;
  has_secret_key?: boolean;
  has_webhook_secret?: boolean;
  has_signing_secret?: boolean;
  secret_key_masked?: string;
  webhook_secret_masked?: string;
  signing_secret_masked?: string;
}

export interface PlatformAppleLoginCredentialItem {
  id: string;
  name: string;
  bundle_id: string;
  service_id?: string | null;
  team_id: string;
  key_id?: string | null;
  issuer_id?: string | null;
  environment: string;
  is_active: boolean;
  has_private_key?: boolean;
  private_key_masked?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformPaymentMethodItem {
  id: string;
  provider_type: PlatformPaymentProviderType;
  name: string;
  is_active: boolean;
  is_default: boolean;
  notes?: string | null;
  config: PlatformPaymentMethodConfig;
  created_at?: string;
  updated_at?: string;
}

export type PlatformStorageProviderType = 'ALIYUN_OSS' | 'S3' | 'R2';

export interface PlatformStorageProviderConfig {
  endpoint?: string;
  bucket?: string;
  region?: string;
  cdn_base_url?: string;
  cdn_auth_enabled?: boolean;
  cdn_auth_window_seconds?: number;
  timeout_ms?: number;
}

export interface PlatformStorageProviderItem {
  id: string;
  provider_type: PlatformStorageProviderType;
  name: string;
  is_active: boolean;
  is_default: boolean;
  config: PlatformStorageProviderConfig;
  secret_status?: Record<string, { configured: boolean; last_four?: string }>;
  notes?: string | null;
  updated_at?: string;
}

export interface PlatformStorageProviderInput {
  provider_type?: PlatformStorageProviderType;
  name?: string;
  is_active?: boolean;
  is_default?: boolean;
  config?: PlatformStorageProviderConfig;
  secrets?: {
    access_key_id?: string;
    access_key_secret?: string;
    cdn_auth_key?: string;
  };
  notes?: string;
}

export interface PlatformSmtpProviderConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  from_email?: string;
  from_name?: string;
}

export interface PlatformSmtpProviderItem {
  id: string;
  name: string;
  is_active: boolean;
  is_default: boolean;
  config: PlatformSmtpProviderConfig;
  secret_status?: Record<string, { configured: boolean; last_four?: string }>;
  notes?: string | null;
  updated_at?: string;
}

export interface PlatformSmtpProviderInput {
  name?: string;
  is_active?: boolean;
  is_default?: boolean;
  config?: PlatformSmtpProviderConfig;
  secrets?: {
    username?: string;
    password?: string;
  };
  notes?: string;
}

export type PlatformSmsProviderType =
  | 'GENERIC_API'
  | 'ALIYUN_SMS'
  | 'TENCENT_SMS'
  | 'HUAWEI_SMS'
  | 'VOLCENGINE_SMS'
  | 'TWILIO_SMS'
  | 'VONAGE_SMS'
  | 'MESSAGEBIRD_SMS'
  | 'PLIVO_SMS'
  | 'AWS_SNS';

export interface PlatformSmsProviderConfig {
  enabled?: boolean;
  dispatch_mode?: 'SYNC' | 'ASYNC' | string;
  async_dispatch?: boolean;
  endpoint_url?: string;
  http_method?: 'GET' | 'POST' | string;
  auth_type?: 'NONE' | 'BEARER' | 'API_KEY' | string;
  auth_header_name?: string;
  auth_token?: string;
  api_key?: string;
  content_type?: 'JSON' | 'FORM' | string;
  phone_field?: string;
  code_field?: string;
  sign_field?: string;
  template_field?: string;
  timeout_ms?: number;
  region_id?: string;
  access_key_id?: string;
  access_key_secret?: string;
  secret_id?: string;
  secret_key?: string;
  sdk_app_id?: string;
  app_key?: string;
  app_secret?: string;
  sender?: string;
  sms_account?: string;
  account_sid?: string;
  from?: string;
  messaging_service_sid?: string;
  api_secret?: string;
  access_key?: string;
  originator?: string;
  auth_id?: string;
  src?: string;
  secret_access_key?: string;
  sender_id?: string;
  status_callback?: string;
  has_auth_token?: boolean;
  auth_token_masked?: string;
  has_api_key?: boolean;
  api_key_masked?: string;
  has_access_key_secret?: boolean;
  access_key_secret_masked?: string;
  [key: string]: unknown;
}

export interface PlatformSmsProviderItem {
  id: string;
  provider_type: PlatformSmsProviderType;
  provider_label?: string;
  name: string;
  is_active: boolean;
  is_default: boolean;
  notes?: string | null;
  config: PlatformSmsProviderConfig;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformSmsProviderCatalogItem {
  provider_type: PlatformSmsProviderType;
  label: string;
  region: 'CN' | 'GLOBAL' | string;
  mode_default: 'SYNC' | 'ASYNC' | string;
  required_config: string[];
  optional_config: string[];
}

export interface PlatformSmsEventItem {
  id: string;
  trace_id: string;
  app_id?: string | null;
  purpose: string;
  provider_id?: string | null;
  provider_type: string;
  provider_name?: string | null;
  signature_id?: string | null;
  signature_name?: string | null;
  template_id?: string | null;
  template_code?: string | null;
  dispatch_mode: string;
  phone_masked?: string | null;
  status: string;
  status_code?: number | null;
  response_code?: string | null;
  response_message?: string | null;
  provider_message_id?: string | null;
  duration_ms: number;
  error_json?: Record<string, unknown> | null;
  response_json?: Record<string, unknown> | string | null;
  created_at: string;
}

export interface PlatformSmsSignatureItem {
  id: string;
  provider_id: string;
  sign_name: string;
  is_active: boolean;
  is_default: boolean;
  notes?: string | null;
  meta?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformSmsTemplateItem {
  id: string;
  provider_id: string;
  template_code: string;
  template_name?: string | null;
  is_active: boolean;
  is_default: boolean;
  notes?: string | null;
  meta?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAppSmsTestResult {
  message?: string;
  app_id: string;
  app_slug: string;
  phone: string;
  code?: string;
  code_persisted?: boolean;
  resend_after_seconds?: number;
  expires_in_seconds?: number;
  route?: {
    provider_id?: string;
    provider_name?: string;
    provider_type?: string;
    signature_id?: string;
    signature_name?: string;
    template_id?: string | null;
    template_code?: string | null;
    template_name?: string | null;
  };
}

export interface PlatformTenantStats {
  app_id: string;
  app_slug: string;
  app_name: string;
  users_total: number;
  users_active: number;
  admins_total: number;
  super_admins_total: number;
  new_users_7d: number;
}

export interface PlatformTenantBusinessAnalytics {
  app_id: string;
  app_slug: string;
  app_name: string;
  range: {
    days: number;
    from: string;
    to: string;
  };
  tables: {
    products: boolean;
    orders: boolean;
    agreements: boolean;
    deductions: boolean;
    behavior_events: boolean;
  };
  users: {
    overview: {
      users_total: number;
      users_active: number;
      users_new_in_range: number;
      users_new_7d: number;
      users_new_30d: number;
      premium_users: number;
      free_users: number;
      login_users_7d: number;
      login_users_30d: number;
      active_ratio: number;
    };
    membership_distribution: Array<{
      membership_type: string;
      users_count: number;
    }>;
    daily: Array<{
      day: string;
      users_new: number;
      users_login: number;
    }>;
  };
  orders: {
    overview: {
      orders_total: number;
      orders_paid: number;
      orders_pending: number;
      orders_failed: number;
      orders_closed: number;
      gmv_amount: number;
      paid_amount: number;
      avg_order_amount: number;
      paid_ratio: number;
    };
    by_status: Array<{
      status: string;
      orders_count: number;
      amount_total: number;
    }>;
    by_payment_type: Array<{
      payment_type: string;
      orders_count: number;
      amount_total: number;
    }>;
    daily: Array<{
      day: string;
      orders_total: number;
      orders_paid: number;
      amount_total: number;
      amount_paid: number;
    }>;
    recent_orders: Array<{
      id: string;
      out_trade_no: string;
      status: string;
      trade_status?: string | null;
      payment_type: string;
      total_amount: number;
      paid_at?: string;
      created_at?: string;
      user_email?: string | null;
      product_name?: string | null;
    }>;
  };
  billing: {
    overview: {
      agreements_total: number;
      agreements_valid: number;
      agreements_pending: number;
      agreements_invalid: number;
      agreements_unsigned: number;
      agreements_new_in_range: number;
      agreements_due_in_7d: number;
      deductions_total: number;
      deductions_success: number;
      deductions_failed: number;
      deductions_pending: number;
      deductions_amount_total: number;
      deductions_success_amount: number;
      deductions_success_ratio: number;
    };
    agreements_by_status: Array<{
      status: string;
      agreements_count: number;
    }>;
    deductions_by_status: Array<{
      status: string;
      deductions_count: number;
      amount_total: number;
    }>;
    deductions_daily: Array<{
      day: string;
      deductions_total: number;
      deductions_success: number;
      amount_total: number;
      amount_success: number;
    }>;
    recent_deductions: Array<{
      id: string;
      out_trade_no: string;
      status: string;
      trade_status?: string | null;
      amount: number;
      executed_at?: string;
      created_at?: string;
      user_email?: string | null;
      product_name?: string | null;
      agreement_no?: string | null;
    }>;
  };
  behavior: {
    overview: {
      events_total: number;
      page_views: number;
      interaction_events: number;
      active_users: number;
      active_sessions: number;
      unique_routes: number;
      avg_events_per_user: number;
      avg_events_per_session: number;
    };
    daily: Array<{
      day: string;
      events_total: number;
      page_views: number;
      active_users: number;
      active_sessions: number;
    }>;
    top_routes: Array<{
      route_path: string;
      views: number;
      active_users: number;
    }>;
    top_events: Array<{
      event_name: string;
      events_count: number;
      active_users: number;
    }>;
    frequency_distribution: Array<{
      bucket: string;
      users_count: number;
    }>;
    path_transitions: Array<{
      from_path: string;
      to_path: string;
      transitions: number;
    }>;
  };
  generated_at: string;
}

export interface PlatformTenantAnalyticsRange {
  days: number;
  from: string;
  to: string;
  timezone: string;
  granularity: 'day' | 'week' | 'month';
}

export interface PlatformTenantAnalyticsOverview {
  app_id: string;
  app_slug: string;
  app_name: string;
  range: PlatformTenantAnalyticsRange;
  tables: {
    orders: boolean;
    agreements: boolean;
    deductions: boolean;
    behavior_events: boolean;
    ai_usage_logs: boolean;
    points_wallets: boolean;
    points_ledger: boolean;
  };
  facts_status?: {
    daily: 'ready' | 'initializing' | 'empty' | 'missing_source';
    cohort: 'ready' | 'initializing' | 'empty' | 'missing_source';
    conversion: 'ready' | 'initializing' | 'empty' | 'missing_source';
    segments: 'ready' | 'initializing' | 'empty' | 'missing_source';
  };
  summary: {
    users_total: number;
    valid_users_total: number;
    deleted_users_total: number;
    paid_users_total: number;
    recharge_users_total: number;
    active_users_in_range: number;
    users_new_in_range: number;
    activated_users_in_range: number;
    activation_rate: number;
    paid_users_in_range: number;
    pay_rate: number;
    paid_amount_in_range: number;
    paid_amount_7d: number;
    arr_estimate: number;
    arpu: number;
    arppu: number;
    dau_latest: number;
    wau_latest: number;
    mau_latest: number;
  };
  highlights: Array<{
    key: string;
    label: string;
    value: number;
    note: string;
  }>;
  trends: Array<{
    period: string;
    registrations: number;
    users_total: number;
    active_users: number;
    paid_users: number;
    revenue: number;
  }>;
  generated_at?: string;
}

export interface PlatformTenantGrowthAnalytics {
  app_id: string;
  app_slug: string;
  app_name: string;
  range: PlatformTenantAnalyticsRange;
  summary: {
    registered_today: number;
    registered_7d: number;
    registered_30d: number;
    registered_in_range: number;
    activated_in_range: number;
    first_login_in_range: number;
    activation_rate: number;
    dau_latest: number;
    wau_latest: number;
    mau_latest: number;
  };
  registrations_trend: Array<{
    period: string;
    registrations: number;
    users_total: number;
    activated_users: number;
    login_users: number;
    active_users: number;
  }>;
  login_method_distribution: Array<{
    login_method: string;
    users_count: number;
  }>;
  source_distribution: Array<{
    source: string;
    users_count: number;
  }>;
  generated_at?: string;
}

export interface PlatformTenantRetentionAnalytics {
  app_id: string;
  app_slug: string;
  app_name: string;
  range: PlatformTenantAnalyticsRange;
  summary: {
    d1_retention: number;
    d3_retention: number;
    d7_retention: number;
    d14_retention: number;
    d30_retention: number;
    reactivated_users: number;
    dormant_users: number;
    churned_users: number;
  };
  cohorts: Array<{
    cohort_period: string;
    cohort_size: number;
    d1: number;
    d3: number;
    d7: number;
    d14: number;
    d30: number;
  }>;
  lifecycle_distribution: Array<{
    segment: string;
    users_count: number;
  }>;
  reactivation_trend: Array<{
    period: string;
    users_total: number;
    reactivated_users: number;
  }>;
  generated_at?: string;
}

export interface PlatformTenantProfileAnalytics {
  app_id: string;
  app_slug: string;
  app_name: string;
  range: PlatformTenantAnalyticsRange;
  membership_distribution: Array<{
    membership_type: string;
    users_count: number;
  }>;
  login_method_distribution: Array<{
    login_method: string;
    users_count: number;
  }>;
  source_distribution: Array<{
    source: string;
    users_count: number;
  }>;
  activity_segments: Array<{
    segment: string;
    users_count: number;
  }>;
  payment_segments: Array<{
    segment: string;
    users_count: number;
  }>;
  data_gaps: Array<{
    key: string;
    label: string;
    ready: boolean;
    note: string;
  }>;
  generated_at?: string;
}

export interface PlatformTenantConversionAnalytics {
  app_id: string;
  app_slug: string;
  app_name: string;
  range: PlatformTenantAnalyticsRange;
  funnel: Array<{
    key: string;
    label: string;
    users: number;
    conversion_from_start: number;
    conversion_from_previous: number;
  }>;
  payment_trend: Array<{
    period: string;
    users_total: number;
    paid_users: number;
    revenue: number;
    repeat_buyers: number;
  }>;
  generated_at?: string;
}

export interface PlatformTenantUsersAnalytics {
  app_id: string;
  app_slug: string;
  app_name: string;
  range: PlatformTenantAnalyticsRange;
  filters: {
    segment: string;
    created_scope: string;
    last_login_scope: string;
    membership_type: string;
    login_method: string;
    source: string;
    paid_status: string;
    account_status: string;
    sort_by: string;
    sort_order: string;
    page: number;
    page_size: number;
  };
  pagination: {
    page: number;
    page_size: number;
    total: number;
  };
  items: Array<{
    id: string;
    email: string;
    phone: string | null;
    display_name: string | null;
    is_active: boolean;
    deleted_at: string | null;
    deactivated_at: string | null;
    deactivated_email: string | null;
    deactivated_phone: string | null;
    membership_type: string;
    login_method: string;
    source: string;
    created_at: string;
    last_login_at: string | null;
    last_activity_at: string | null;
    paid_orders_total: number;
    paid_amount_total: number;
    points_balance: number;
    ai_requests_total: number;
    ai_total_tokens: number;
    ai_points_spent_total: number;
    recent_event: string | null;
    recent_order: string | null;
    recent_recharge: string | null;
  }>;
  generated_at?: string;
}

export interface PlatformPermissionCatalogItem {
  key: string;
  module?: string;
  module_name?: string;
  name: string;
  description: string;
  level?: 'read' | 'write' | 'manage' | 'sensitive';
  action?: string;
  sensitive?: boolean;
  requires_super_admin?: boolean;
}

export interface PlatformAdminRoleItem {
  id: string;
  app_id?: string | null;
  key: string;
  name: string;
  description?: string | null;
  is_system: boolean;
  status: string;
  permission_keys: string[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PlatformAdminRoleAssignmentItem {
  role_id: string;
  role_key: string;
  role_name: string;
  is_system: boolean;
  permission_keys: string[];
  created_at?: string;
}

export interface PlatformAdminPermissionOverrideItem {
  permission_key: string;
  effect: 'ALLOW';
  reason?: string | null;
  expires_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformTenantAdminItem {
  id: string;
  app_id: string;
  email: string;
  display_name?: string;
  role: 'ADMIN';
  admin_type: 'SUPER_ADMIN' | 'ADMIN';
  is_active: boolean;
  page_permissions: string[];
  role_assignments?: PlatformAdminRoleAssignmentItem[];
  permission_overrides?: PlatformAdminPermissionOverrideItem[];
  created_at?: string;
  updated_at?: string;
  last_login_at?: string;
}

export interface PlatformMyAppAdminPermissions {
  app_id: string;
  app_slug: string;
  is_super_admin: boolean;
  page_permissions: string[];
  permission_catalog: PlatformPermissionCatalogItem[];
  role_catalog?: PlatformAdminRoleItem[];
  role_assignments?: PlatformAdminRoleAssignmentItem[];
  permission_overrides?: PlatformAdminPermissionOverrideItem[];
  sensitive_actions_super_admin_only?: string[];
}

export interface PlatformAiSourceItem {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  custom_headers: Record<string, string>;
  credentials?: {
    auth_mode?: string;
    project_id?: string;
    location?: string;
    has_service_account_json?: boolean;
    service_account_email?: string;
  };
  outbound_proxy_id?: string | null;
  outbound_proxy?: PlatformOutboundProxySummary | null;
  is_active: boolean;
  has_api_key: boolean;
  api_key_masked: string;
  api_key_count?: number;
  active_api_key_count?: number;
  api_keys?: PlatformAiSourceApiKeyItem[];
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAiSourceApiKeyItem {
  id: string;
  label: string;
  is_active: boolean;
  sort_order: number;
  api_key_masked: string;
  last_used_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAiSourceConnectivityTestResult {
  ok: boolean;
  status_code: number | null;
  latency_ms: number;
  endpoint_url: string;
  provider_type: string;
  message: string;
  response_excerpt: string;
}

export interface PlatformAiGatewayRuntime {
  generated_at: string;
  usage_queue?: {
    active_workers?: number;
    worker_count?: number;
    queue_length?: number;
    max_queue_size?: number;
    overflow_policy?: string;
    dropped_tasks?: number;
    completed_tasks?: number;
    failed_tasks?: number;
  };
  throttle?: {
    backend?: string;
    redis_available?: boolean;
    source_rpm?: number;
    user_rpm?: number;
    api_key_rpm?: number;
    account_rpm?: number;
    active?: Array<{ key: string; active: number }>;
    cooldowns?: Array<{
      key: string;
      cooldown_until: string;
      consecutive_failures: number;
      last_status?: number | null;
      last_failure_category?: string;
      last_failure_message?: string;
    }>;
  };
  scheduler?: {
    sticky_ttl_ms?: number;
    active_sticky_sessions?: number;
  };
}

export interface PlatformObservabilityRuntimeModule {
  module: string;
  events_count: string | number;
  failures_count: string | number;
  slow_count: string | number;
  avg_latency_ms?: string | number | null;
  last_event_at?: string | null;
}

export interface PlatformObservabilityRequestEvent {
  id: string;
  request_id?: string | null;
  trace_id?: string | null;
  app_id?: string | null;
  app_slug?: string | null;
  actor_user_id?: string | null;
  module: string;
  operation: string;
  resource_type?: string | null;
  resource_id?: string | null;
  stage?: string | null;
  method?: string | null;
  request_path?: string | null;
  success?: boolean | null;
  status_code?: number | null;
  error_category?: string | null;
  error_message?: string | null;
  latency_ms?: number | null;
  metadata_json?: Record<string, unknown>;
  created_at?: string;
}

export interface PlatformObservabilityAuditEvent {
  id: string;
  request_id?: string | null;
  actor_user_id?: string | null;
  app_id?: string | null;
  app_slug?: string | null;
  module: string;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  before_hash?: string | null;
  after_hash?: string | null;
  metadata_json?: Record<string, unknown>;
  created_at?: string;
}

export interface PlatformObservabilityRuntime {
  schema_ready: boolean;
  tables?: Array<{
    name: string;
    ready: boolean;
    estimated_rows: number;
    latest_created_at?: string | null;
  }>;
  retention?: {
    request_event_days: number;
    audit_event_days: number;
    batch_size: number;
  };
  modules: PlatformObservabilityRuntimeModule[];
  recent_errors: PlatformObservabilityRequestEvent[];
}

export interface PlatformObservabilityEventsResponse<T> {
  items: T[];
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface PlatformObservabilityEventsQuery {
  app_id?: string;
  actor_user_id?: string;
  request_id?: string;
  module?: string;
  operation?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  success?: string;
  status_min?: string;
  days?: string;
  page?: string | number;
  page_size?: string | number;
}

export interface PlatformTaskItem {
  id: string;
  app_id?: string | null;
  environment_key: string;
  module: string;
  action: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'retrying' | 'expired' | string;
  idempotency_key?: string | null;
  queue_name: string;
  worker_id?: string | null;
  source_type?: string | null;
  source_id?: string | null;
  actor_user_id?: string | null;
  request_id?: string | null;
  priority?: number | string;
  attempts?: number | string;
  max_attempts?: number | string;
  timeout_ms?: number | string;
  progress?: number | string;
  input_summary_json?: Record<string, unknown>;
  output_summary_json?: Record<string, unknown>;
  cost_estimate_json?: Record<string, unknown>;
  result_json?: Record<string, unknown> | null;
  error_code?: string | null;
  error_message?: string | null;
  locked_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  cancelled_at?: string | null;
  next_retry_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformTaskEventItem {
  id: string;
  task_id: string;
  seq: number | string;
  event_type: string;
  stage?: string | null;
  payload_json?: Record<string, unknown>;
  created_at?: string;
}

export interface PlatformTaskLogItem {
  id: string;
  task_id: string;
  seq: number | string;
  stream: 'stdout' | 'stderr' | 'system' | string;
  message_redacted: string;
  metadata_json?: Record<string, unknown>;
  created_at?: string;
}

export interface PlatformTaskDetail {
  task: PlatformTaskItem;
  events: PlatformTaskEventItem[];
  logs: PlatformTaskLogItem[];
}

export interface PlatformTasksResponse {
  items: PlatformTaskItem[];
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface PlatformTasksQuery {
  app_id?: string;
  module?: string;
  action?: string;
  status?: string;
  queue_name?: string;
  request_id?: string;
  source_type?: string;
  source_id?: string;
  days?: string | number;
  page?: string | number;
  page_size?: string | number;
}

export interface PlatformTaskRuntime {
  schema_ready: boolean;
  queue: {
    backend: 'bullmq' | 'db';
    available: boolean;
    queue_name: string;
    redis_url_configured: boolean;
    last_error?: string | null;
  };
  summary?: {
    by_status?: Array<{ status: string; count: string | number }>;
    by_module?: Array<{ module: string; count: string | number; failed_count?: string | number; last_updated_at?: string | null }>;
    recent_failures?: PlatformTaskItem[];
    workers?: Array<Record<string, unknown>>;
  } | null;
}

export interface PlatformRuntimeTemplate {
  key: string;
  version: string;
  name: string;
  category: string;
  summary?: string;
  modules: string[];
  creates?: {
    ai_blocks?: number;
    video_blocks?: number;
    functions?: number;
    workflows?: number;
    storage_buckets?: number;
  };
}

export interface PlatformRuntimeModule {
  id?: string;
  app_id: string;
  module_key: string;
  display_name: string;
  category: string;
  status: 'active' | 'warning' | 'unhealthy' | 'disabled' | string;
  source?: string;
  resource_count?: number | string;
  run_count_24h?: number | string;
  failure_count_24h?: number | string;
  quality_score?: number | string;
  runtime_config_json?: Record<string, unknown>;
  health_json?: Record<string, unknown>;
  last_run_at?: string | null;
  last_failure_at?: string | null;
  updated_at?: string;
}

export interface PlatformRuntimeOverview {
  apps?: { total?: number | string; active?: number | string };
  modules?: {
    by_status?: Array<{ status: string; count: number | string }>;
    by_category?: Array<{
      category: string;
      module_count: number | string;
      avg_quality_score?: number | string;
      failures_24h?: number | string;
    }>;
  };
  task_runtime?: PlatformTaskRuntime | null;
  templates?: {
    available?: number;
    recent_applications?: Array<Record<string, unknown>>;
  };
  next_actions?: Array<Record<string, unknown>>;
}

export interface PlatformAppRuntimeOverview {
  app: { id: string; slug: string; name?: string | null; status?: string | null };
  modules: PlatformRuntimeModule[];
  runs: Array<Record<string, unknown>>;
  tasks: PlatformTaskItem[];
  templates: Array<Record<string, unknown>>;
  available_templates: PlatformRuntimeTemplate[];
  next_actions?: Array<Record<string, unknown>>;
}

export interface PlatformConnectorItem {
  id: string;
  app_id: string;
  slug: string;
  name: string;
  base_url: string;
  outbound_proxy_id?: string | null;
  timeout_ms?: number;
  retry?: Record<string, unknown>;
  rate_limit?: Record<string, unknown>;
  security?: Record<string, unknown>;
  status: string;
  notes?: string | null;
  action_count?: number | string;
  credential_count?: number | string;
  run_count_24h?: number | string;
  failure_count_24h?: number | string;
  last_run_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformConnectorCredentialItem {
  id: string;
  app_id: string;
  connector_id: string;
  slug: string;
  auth_mode: string;
  public_config?: Record<string, unknown>;
  secret_status?: Record<string, { configured: boolean; last_four?: string }>;
  status: string;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformConnectorActionItem {
  id: string;
  app_id: string;
  connector_id: string;
  credential_id?: string | null;
  slug: string;
  name?: string | null;
  method: string;
  path_template: string;
  input_schema?: Record<string, unknown>;
  request_mapping?: Record<string, unknown>;
  response_mapping?: Record<string, unknown>;
  error_mapping?: Record<string, unknown>;
  execution_mode: string;
  poller?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformConnectorRunItem {
  id: string;
  connector_id: string;
  action_id: string;
  credential_id?: string | null;
  trigger_type: string;
  input?: unknown;
  request_summary?: Record<string, unknown>;
  response_summary?: Record<string, unknown>;
  output?: unknown;
  status: string;
  status_code?: number | null;
  latency_ms?: number | null;
  error?: unknown;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAiModelConnectivityTestResult {
  ok: boolean;
  status_code: number | null;
  latency_ms: number;
  endpoint_url: string;
  model_key: string;
  upstream_model: string;
  source_id: string;
  source_name: string;
  provider_type: string;
  message: string;
  response_excerpt: string;
  audio_detected?: boolean;
  async_task_id?: string | null;
}

export interface PlatformAiPlaygroundRouteInfo {
  app_id: string;
  app_slug: string;
  model_id: string;
  model_key: string;
  display_name: string;
  capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  source_id: string;
  source_name: string;
  provider_type: string;
  upstream_model: string;
  endpoint_path: string;
  api_type: string;
  execution_mode: 'sync' | 'async';
}

export interface PlatformAiPlaygroundImageItem {
  url?: string | null;
  b64_json?: string | null;
  mime_type?: string | null;
}

export interface PlatformAiPlaygroundVideoItem {
  url?: string | null;
  mime_type?: string | null;
}

export interface PlatformAiPlaygroundResult {
  capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  result_type: 'text' | 'audio' | 'image' | 'video' | 'embedding' | 'json' | 'binary';
  route: PlatformAiPlaygroundRouteInfo;
  text?: string | null;
  audio_base64?: string | null;
  audio_url?: string | null;
  audio_mime_type?: string | null;
  mime_type?: string | null;
  binary_base64?: string | null;
  bytes?: number;
  images: PlatformAiPlaygroundImageItem[];
  videos: PlatformAiPlaygroundVideoItem[];
  video_url?: string | null;
  task_id?: string | null;
  task_status?: string | null;
  embedding_count: number;
  embedding_dimensions: number;
  embedding_preview: number[];
  raw_data?: Record<string, unknown>;
  response_excerpt: string;
}

export interface PlatformAiModelBatchConnectivityTestItem extends PlatformAiModelConnectivityTestResult {
  model_id: string;
  capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  is_active: boolean;
  default_source_id: string;
}

export interface PlatformAiModelBatchConnectivityTestResult {
  capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  only_active: boolean;
  total: number;
  success: number;
  failed: number;
  started_at: string;
  finished_at: string;
  items: PlatformAiModelBatchConnectivityTestItem[];
}

export interface PlatformAiModelSourceRouteItem {
  id: string | null;
  route_key?: string;
  app_id?: string | null;
  global_model_id?: string;
  source_id: string;
  source_name: string;
  source_provider_type: string;
  source_is_active: boolean;
  sort_order: number;
  is_active: boolean;
  upstream_model?: string;
  endpoint_path?: string;
  api_type?: string;
  request_overrides?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAiModelItem {
  id: string;
  model_key: string;
  display_name: string;
  capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  execution_mode: 'sync' | 'async';
  pricing_mode: 'per_mtoken' | 'per_call' | 'per_minute' | 'per_second' | 'per_mchar';
  rmb_per_mtoken: number;
  input_rmb_per_mtoken: number;
  cached_input_rmb_per_mtoken: number;
  cache_write_5m_rmb_per_mtoken: number;
  cache_write_1h_rmb_per_mtoken: number;
  output_rmb_per_mtoken: number;
  rmb_per_call: number;
  rmb_per_minute: number;
  points_per_mtoken: number;
  points_input_per_mtoken: number;
  points_cached_input_per_mtoken: number;
  points_cache_write_5m_per_mtoken: number;
  points_cache_write_1h_per_mtoken: number;
  points_output_per_mtoken: number;
  points_per_call: number;
  points_per_minute: number;
  default_source_id: string;
  default_source_name: string;
  default_source_provider_type: string;
  default_source_is_active: boolean;
  source_routes?: PlatformAiModelSourceRouteItem[];
  upstream_model: string;
  endpoint_path: string;
  api_type: string;
  request_overrides: Record<string, unknown>;
  is_default: boolean;
  is_active: boolean;
  is_visible: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAiUsageOverview {
  requests_total: number;
  success_total: number;
  error_total: number;
  total_tokens: number;
  total_billed_units: number;
  total_cost_rmb: number;
  total_points_cost: number;
  active_users_total: number;
  avg_latency_ms: number;
  estimated_points_requests: number;
}

export interface PlatformAiUsageByCapabilityItem {
  capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  requests_total: number;
  success_total: number;
  error_total: number;
  total_tokens: number;
  total_billed_units: number;
  total_cost_rmb: number;
  total_points_cost: number;
  active_users_total: number;
  avg_latency_ms: number;
}

export interface PlatformAiUsageByModelItem {
  model_id: string;
  model_key: string;
  display_name: string;
  capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  unit_price_rmb_per_mtoken: number;
  unit_price_rmb_per_call: number;
  unit_price_rmb_per_minute: number;
  unit_price_mode: 'per_mtoken' | 'per_call' | 'per_minute' | 'per_second' | 'per_mchar';
  requests_total: number;
  success_total: number;
  error_total: number;
  total_tokens: number;
  total_billed_units: number;
  total_cost_rmb: number;
  total_points_cost: number;
  active_users_total: number;
  avg_latency_ms: number;
  avg_tokens_per_request: number;
  billed_unit_label: 'output_token' | 'token' | 'minute' | 'second' | 'image' | 'call' | 'character';
  cost_ratio: number;
  last_called_at?: string;
}

export interface PlatformAiUsageBySourceItem {
  source_id: string;
  source_name: string;
  provider_type: string;
  requests_total: number;
  success_total: number;
  error_total: number;
  total_tokens: number;
  total_billed_units: number;
  total_cost_rmb: number;
  total_points_cost: number;
  active_users_total: number;
  avg_latency_ms: number;
  last_called_at?: string;
}

export interface PlatformAiUsageTopUserItem {
  user_id: string;
  user_display_name: string;
  user_email?: string | null;
  requests_total: number;
  success_total: number;
  total_tokens: number;
  total_billed_units: number;
  total_cost_rmb: number;
  total_points_cost: number;
  last_called_at?: string;
}

export interface PlatformAiUsageDailyItem {
  day: string;
  requests_total: number;
  success_total: number;
  total_tokens: number;
  total_billed_units: number;
  total_cost_rmb: number;
  total_points_cost: number;
  active_users: number;
  estimated_points_requests: number;
}

export interface PlatformAiUsageSummary {
  range: {
    days: number;
    from: string;
    to: string;
  };
  overview: PlatformAiUsageOverview;
  daily: PlatformAiUsageDailyItem[];
}

export interface PlatformAiUsageBreakdown {
  range: {
    days: number;
    from: string;
    to: string;
  };
  by_capability: PlatformAiUsageByCapabilityItem[];
  by_model: PlatformAiUsageByModelItem[];
  by_source: PlatformAiUsageBySourceItem[];
  top_users: PlatformAiUsageTopUserItem[];
}

export type PlatformAppAiUsageSummary = PlatformAiUsageSummary;
export type PlatformAppAiUsageBreakdown = PlatformAiUsageBreakdown;

export interface PlatformAiUsageLogItem {
  id: string;
  app_id: string;
  app_slug: string;
  user_id?: string | null;
  model_id: string;
  model_key: string;
  display_name: string;
  upstream_model: string;
  capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  source_id: string;
  source_name: string;
  provider_type: string;
  endpoint_path: string;
  request_path?: string | null;
  request_id?: string | null;
  is_stream: boolean;
  success: boolean;
  error_message?: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  unit_price_rmb_per_mtoken: number;
  unit_price_rmb_per_call: number;
  unit_price_rmb_per_minute: number;
  unit_price_mode: 'per_mtoken' | 'per_call' | 'per_minute' | 'per_second' | 'per_mchar';
  billed_units: number;
  billed_unit_label: 'output_token' | 'token' | 'minute' | 'second' | 'image' | 'call' | 'character';
  billed_duration_seconds: number;
  estimated_cost_rmb: number;
  points_cost: number;
  points_pricing_source?: string | null;
  points_cost_is_estimated: boolean;
  usage_reference_id?: string | null;
  user_display_name?: string | null;
  user_email?: string | null;
  latency_ms: number;
  created_at?: string;
}

export interface PlatformAiUsageLogsResponse {
  range: {
    days: number;
    from: string;
    to: string;
  };
  page: number;
  page_size: number;
  total: number;
  items: PlatformAiUsageLogItem[];
}

export type PlatformAppAiUsageLogsResponse = PlatformAiUsageLogsResponse;

export interface PlatformAiUsageQueryParams {
  days?: number;
  from?: string;
  to?: string;
  app_id?: string;
  capability?: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  model_id?: string;
  model_key?: string;
  source_id?: string;
  success?: boolean;
}

export interface PlatformAiUsageLogsQueryParams extends PlatformAiUsageQueryParams {
  page?: number;
  page_size?: number;
}

export interface PlatformAppAiModelRouteItem {
  model_id: string;
  model: {
    model_key: string;
    display_name: string;
    capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
    execution_mode: 'sync' | 'async';
    pricing_mode: 'per_mtoken' | 'per_call' | 'per_minute' | 'per_mchar';
    rmb_per_mtoken: number;
    input_rmb_per_mtoken: number;
    cached_input_rmb_per_mtoken: number;
    cache_write_5m_rmb_per_mtoken: number;
    cache_write_1h_rmb_per_mtoken: number;
    output_rmb_per_mtoken: number;
    rmb_per_call: number;
    rmb_per_minute: number;
    points_per_mtoken: number;
    points_input_per_mtoken: number;
    points_cached_input_per_mtoken: number;
    points_cache_write_5m_per_mtoken: number;
    points_cache_write_1h_per_mtoken: number;
    points_output_per_mtoken: number;
    points_per_call: number;
    points_per_minute: number;
    upstream_model: string;
    endpoint_path: string;
    api_type: string;
    request_overrides: Record<string, unknown>;
    is_default: boolean;
    is_active: boolean;
    is_visible: boolean;
  };
  default_source: {
    id: string;
    name: string;
    provider_type: string;
    is_active: boolean;
  };
  app_visibility: {
    is_visible: boolean;
    is_explicit: boolean;
    global_is_visible: boolean;
    effective_is_visible: boolean;
    updated_at?: string | null;
  };
  override: {
    route_id: string;
    source_id: string;
    source_name: string;
    source_provider_type: string;
    source_is_active: boolean;
    is_active: boolean;
    request_overrides: Record<string, unknown>;
    updated_at?: string;
  } | null;
  effective_source: {
    id: string;
    name: string;
    provider_type: string;
    is_active: boolean;
    from_override: boolean;
  };
  effective_request_overrides: Record<string, unknown>;
}

export interface PlatformAppAiCapabilityDefaultItem {
  capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  source: 'app' | 'global' | 'none';
  effective_model: {
    model_id: string;
    model_key: string;
    display_name: string;
  } | null;
  app_override: {
    model_id: string;
    model_key: string;
    display_name: string;
    is_active: boolean;
  } | null;
  global_default: {
    model_id: string;
    model_key: string;
    display_name: string;
  } | null;
}

export type PlatformAppAiDefaultModelSlotKey =
  | 'reasoning'
  | 'visual_index'
  | 'visual_analysis'
  | 'tts'
  | 'embedding'
  | 'transcription'
  | 'image_generation'
  | 'video_text_to_video'
  | 'video_image_to_video'
  | 'video_reference_to_video';

export interface PlatformAppAiDefaultModelSlotModel {
  model_id: string;
  model_key: string;
  display_name: string;
  capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
  is_active: boolean;
}

export interface PlatformAppAiDefaultModelSlotItem {
  slot_key: PlatformAppAiDefaultModelSlotKey;
  allowed_capabilities: Array<'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video'>;
  primary_model: PlatformAppAiDefaultModelSlotModel | null;
  fallback_model: PlatformAppAiDefaultModelSlotModel | null;
  effective_model: PlatformAppAiDefaultModelSlotModel | null;
  updated_at: string | null;
}

export interface PlatformAppAiPointsSettings {
  app_id: string;
  initial_points: number;
  points_per_yuan: number;
  updated_at: string | null;
}

export interface PlatformAppAiPointsGrantResult {
  app_id: string;
  user_id: string;
  user_email: string;
  user_display_name: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  ledger_id: string;
  reason: string | null;
  created_at: string;
}

export type PlatformRedeemGrantScope = 'app_membership' | 'ai_membership';

export interface PlatformRedeemGrantInput {
  scope: PlatformRedeemGrantScope;
  days?: number;
  metadata?: Record<string, unknown>;
}

export interface PlatformRedeemPackageItem {
  id: string;
  app_id: string;
  name: string;
  description?: string | null;
  cover_url?: string | null;
  language_code?: string | null;
  price_cny: number;
  is_active: boolean;
  grants: PlatformRedeemGrantInput[];
  payment_product?: {
    id: string;
    code: string;
    type: 'ONE_TIME' | 'RECURRING' | string;
    status: 'ACTIVE' | 'INACTIVE' | string;
    amount: number;
    membership_days: number;
    points_topup?: number;
    sign_scene?: string | null;
    sign_validity_period?: number | null;
    period_type?: string | null;
    period?: number | null;
    execute_time?: string | null;
    updated_at?: string | null;
  } | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformPaymentOrderItem {
  id: string;
  out_trade_no: string;
  user_id: string;
  product_id: string;
  subject: string;
  amount: string;
  status: string;
  trade_status?: string | null;
  trade_no?: string | null;
  payment_type: string;
  paid_at?: string | null;
  created_at?: string | null;
  refunded_amount?: string;
  refund_count?: number;
  refunded_at?: string | null;
}

export interface PlatformRedeemCodeItem {
  id: string;
  code: string;
  status: string;
  max_uses: number;
  used_count: number;
  expires_at?: string | null;
  batch_id?: string | null;
  batch_name?: string | null;
  package_id?: string | null;
  package_name?: string | null;
  first_used_by_email?: string | null;
  created_at: string;
  updated_at: string;
  grants: PlatformRedeemGrantInput[];
}

export interface PlatformRedeemCodeBatchItem {
  id: string;
  name: string;
  note?: string | null;
  code_prefix?: string | null;
  total_count: number;
  max_uses: number;
  expires_at?: string | null;
  package_id?: string | null;
  package_name?: string | null;
  grants: PlatformRedeemGrantInput[];
  created_at: string;
  updated_at: string;
}

export interface PlatformRedeemCodeRedemptionItem {
  id: string;
  code_id: string;
  code: string;
  user_id: string;
  user_email?: string | null;
  user_display_name?: string | null;
  batch_id?: string | null;
  batch_name?: string | null;
  package_id?: string | null;
  package_name?: string | null;
  package_cover_url?: string | null;
  redeemed_at: string;
  revoked_at?: string | null;
  revoked_by_user_id?: string | null;
  revoked_by_email?: string | null;
  revoke_reason?: string | null;
  total_entitlements: number;
  active_entitlements: number;
}

export interface PlatformAppFeedbackItem {
  id: string;
  app_id: string;
  user_id: string;
  user_email?: string | null;
  user_display_name?: string | null;
  title: string;
  content: string;
  context?: Record<string, unknown>;
  category?: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'pending' | 'triaged' | 'in_progress' | 'resolved' | 'closed' | 'useless' | 'thanks' | 'useful';
  reward_points: number;
  admin_note?: string | null;
  assignee_user_id?: string | null;
  assignee_email?: string | null;
  assignee_display_name?: string | null;
  handled_by_user_id?: string | null;
  handled_at?: string | null;
  closed_at?: string | null;
  comment_count?: number;
  created_at: string;
  updated_at: string;
}

export interface PlatformAppFeedbackComment {
  id: string;
  feedback_id: string;
  app_id: string;
  author_user_id: string;
  author_email?: string | null;
  author_display_name?: string | null;
  body: string;
  is_internal: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlatformAcquisitionSourceOption {
  id: string;
  app_id: string;
  key: string;
  label: string;
  is_active: boolean;
  allow_free_text: boolean;
  sort_order: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAcquisitionUserSource {
  id: string;
  app_id: string;
  user_id: string;
  user_email?: string | null;
  user_display_name?: string | null;
  source_key: string;
  source_label: string;
  free_text?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  referrer?: string | null;
  landing_path?: string | null;
  session_id?: string | null;
  submitted_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAcquisitionSummary {
  range: {
    from: string;
    to: string;
  };
  total: number;
  users: number;
  by_source: Array<{
    source_key: string;
    source_label: string;
    submissions: number;
    users: number;
    first_submitted_at?: string | null;
    last_submitted_at?: string | null;
  }>;
}

export type PlatformAppFormQuestionType =
  | 'short_text'
  | 'long_text'
  | 'email'
  | 'url'
  | 'phone'
  | 'number'
  | 'single_select'
  | 'multi_select'
  | 'source_select'
  | 'rating'
  | 'nps'
  | 'opinion_scale'
  | 'boolean'
  | 'consent'
  | 'date'
  | 'statement'
  | 'hidden';

export interface PlatformAppFormOption {
  key: string;
  label: string;
  allow_free_text?: boolean;
  sort_order?: number;
}

export interface PlatformAppFormQuestion {
  id: string;
  app_id: string;
  form_id: string;
  question_key: string;
  type: PlatformAppFormQuestionType;
  title: string;
  description?: string;
  required: boolean;
  sort_order: number;
  options: PlatformAppFormOption[];
  validation?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  visibility?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAppFormMetrics {
  responses: number;
  users: number;
  average_score?: number | null;
  first_submitted_at?: string | null;
  last_submitted_at?: string | null;
  nps?: {
    scored: number;
    promoters: number;
    passives: number;
    detractors: number;
    score?: number | null;
  };
}

export interface PlatformAppFormItem {
  id: string;
  app_id: string;
  form_key: string;
  name: string;
  description?: string;
  form_type: 'SYSTEM_USER_SOURCE' | 'SYSTEM_NPS' | 'CUSTOM' | string;
  status: 'DRAFT' | 'ACTIVE' | 'DELETED' | string;
  title: string;
  subtitle?: string;
  submit_label?: string;
  success_title?: string;
  success_message?: string;
  published_version_id?: string | null;
  published_version?: number | null;
  published_at?: string | null;
  response_count?: number;
  last_response_at?: string | null;
  hosted_path?: string;
  theme?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  endings?: unknown[];
  notification?: Record<string, unknown>;
  questions?: PlatformAppFormQuestion[];
  logic_rules?: unknown[];
  actions?: unknown[];
  versions?: Array<Record<string, unknown>>;
  metrics?: PlatformAppFormMetrics;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformAppFormResponseItem {
  id: string;
  app_id: string;
  form_id: string;
  form_version_id?: string | null;
  user_id?: string | null;
  user_email?: string | null;
  user_display_name?: string | null;
  respondent_key?: string | null;
  session_id?: string | null;
  status: string;
  score?: number | null;
  score_label?: string | null;
  answers: Array<Record<string, unknown>>;
  submitted_at?: string;
  created_at?: string;
}

export const platformApi = {
  getDeveloperSdkManifest: async (appSlug: string): Promise<OpgSdkManifest> => {
    const base = runtimeContext.apiBaseUrl.replace(/\/+$/, '');
    const response = await apiClient.getClient().get(`${base}/${appSlug}/v1/sdk/manifest`);
    return response.data?.data || response.data;
  },

  getDeveloperSdkExamples: async (appSlug: string, target: 'node' | 'react' | 'codex' = 'node') => {
    const base = runtimeContext.apiBaseUrl.replace(/\/+$/, '');
    const response = await apiClient.getClient().get(`${base}/${appSlug}/v1/sdk/examples`, { params: { target } });
    return response.data?.data || response.data;
  },

  runDeveloperSdkSmokeTest: async (appSlug: string): Promise<OpgSdkSmokeResult> => {
    const base = runtimeContext.apiBaseUrl.replace(/\/+$/, '');
    const response = await apiClient.getClient().post(`${base}/${appSlug}/v1/sdk/smoke-test`, {});
    return response.data?.data || response.data;
  },

  listMyAppApiKeys: async (appSlug: string): Promise<{ items: AppApiKeyItem[] }> => {
    const base = runtimeContext.apiBaseUrl.replace(/\/+$/, '');
    const response = await apiClient.getClient().get(`${base}/${appSlug}/v1/users/me/api-keys`);
    return response.data?.data || response.data;
  },

  createMyAppApiKey: async (appSlug: string, name: string): Promise<AppApiKeyCreateResult> => {
    const base = runtimeContext.apiBaseUrl.replace(/\/+$/, '');
    const response = await apiClient.getClient().post(`${base}/${appSlug}/v1/users/me/api-keys`, { name });
    return response.data?.data || response.data;
  },

  revokeMyAppApiKey: async (appSlug: string, keyId: string) => {
    const base = runtimeContext.apiBaseUrl.replace(/\/+$/, '');
    const response = await apiClient.getClient().post(`${base}/${appSlug}/v1/users/me/api-keys/${keyId}/revoke`);
    return response.data?.data || response.data;
  },

  getAppSchemaManifest: async (appId: string): Promise<PlatformAppSchemaManifest> => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/schema/manifest`);
    return response.data?.data || response.data;
  },

  createAppDataTable: async (appId: string, payload: Record<string, unknown>) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/schema/tables`, payload);
    return response.data?.data || response.data;
  },

  addAppDataColumn: async (appId: string, table: string, payload: Record<string, unknown>) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/schema/tables/${table}/columns`, payload);
    return response.data?.data || response.data;
  },

  getAppBuildSummary: async (appId: string): Promise<PlatformAppBuildSummary> => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/build/summary`);
    return response.data?.data || response.data;
  },

  getAppBuildEvents: async (appId: string, limit = 20): Promise<{ items: PlatformAppBuildEventItem[]; limit: number }> => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/build/events`, { params: { limit } });
    return response.data?.data || response.data;
  },

  listEmailCloudflareAccounts: async () => {
    const response = await apiClient.getClient().get('/platform-admin/email/cloudflare/accounts');
    return response.data as { items: PlatformEmailCfAccountItem[] };
  },

  listEmailProviderCatalog: async () => {
    const response = await apiClient.getClient().get('/platform-admin/email/providers/catalog');
    return response.data as { items: PlatformEmailProviderCatalogItem[] };
  },

  listEmailProviders: async () => {
    const response = await apiClient.getClient().get('/platform-admin/email/providers');
    return response.data as { items: PlatformEmailProviderItem[] };
  },

  createEmailProvider: async (payload: {
    provider_type: PlatformEmailProviderType;
    name?: string;
    status?: 'ACTIVE' | 'INACTIVE';
    config?: Record<string, unknown>;
    secrets?: Record<string, unknown>;
    notes?: string;
    account_id?: string;
    api_token?: string;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/email/providers', payload);
    return response.data as PlatformEmailProviderItem;
  },

  updateEmailProvider: async (providerId: string, payload: Partial<{
    name: string;
    status: 'ACTIVE' | 'INACTIVE';
    config: Record<string, unknown>;
    secrets: Record<string, unknown>;
    notes: string;
    account_id: string;
    api_token: string;
  }>) => {
    const response = await apiClient.getClient().patch(`/platform-admin/email/providers/${providerId}`, payload);
    return response.data as PlatformEmailProviderItem;
  },

  deleteEmailProvider: async (providerId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/email/providers/${providerId}`);
    return response.data as { deleted: boolean };
  },

  testEmailProvider: async (providerId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/email/providers/${providerId}/test`);
    return response.data as { ok: boolean };
  },

  listNotificationEventCatalog: async () => {
    const response = await apiClient.getClient().get('/platform-admin/notifications/catalog');
    return response.data as { items: PlatformNotificationEventCatalogItem[] };
  },

  listNotificationChannels: async (params?: { app_id?: string; channel_type?: PlatformNotificationChannelType }) => {
    const response = await apiClient.getClient().get('/platform-admin/notifications/channels', { params });
    return response.data as { items: PlatformNotificationChannelItem[] };
  },

  createNotificationChannel: async (payload: PlatformNotificationChannelInput) => {
    const response = await apiClient.getClient().post('/platform-admin/notifications/channels', payload);
    return response.data as { item: PlatformNotificationChannelItem };
  },

  updateNotificationChannel: async (channelId: string, payload: Partial<PlatformNotificationChannelInput>) => {
    const response = await apiClient.getClient().patch(`/platform-admin/notifications/channels/${channelId}`, payload);
    return response.data as { item: PlatformNotificationChannelItem };
  },

  deleteNotificationChannel: async (channelId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/notifications/channels/${channelId}`);
    return response.data as { deleted: boolean };
  },

  testNotificationChannel: async (channelId: string, payload?: { title?: string; message?: string }) => {
    const response = await apiClient.getClient().post(`/platform-admin/notifications/channels/${channelId}/test`, payload || {});
    return response.data as { ok: boolean; result?: unknown };
  },

  listNotificationRules: async () => {
    const response = await apiClient.getClient().get('/platform-admin/notifications/rules');
    return response.data as { event_catalog: PlatformNotificationEventCatalogItem[]; items: PlatformNotificationRuleItem[] };
  },

  updateNotificationRules: async (payload: { items: PlatformNotificationRuleItem[] }) => {
    const response = await apiClient.getClient().put('/platform-admin/notifications/rules', payload);
    return response.data as { items: PlatformNotificationRuleItem[] };
  },

  listNotificationEvents: async (params?: { app_id?: string; event_type?: string; severity?: string; status?: string; limit?: number }) => {
    const response = await apiClient.getClient().get('/platform-admin/notifications/events', { params });
    return response.data as { items: PlatformNotificationEventItem[] };
  },

  listNotificationDeliveries: async (params?: { app_id?: string; status?: string; limit?: number }) => {
    const response = await apiClient.getClient().get('/platform-admin/notifications/deliveries', { params });
    return response.data as { items: PlatformNotificationDeliveryItem[] };
  },

  listAppNotificationEventCatalog: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/notifications/catalog`);
    return response.data as { items: PlatformNotificationEventCatalogItem[] };
  },

  listAppNotificationChannels: async (appId: string, params?: { channel_type?: PlatformNotificationChannelType }) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/notifications/channels`, { params });
    return response.data as { items: PlatformNotificationChannelItem[] };
  },

  createAppNotificationChannel: async (appId: string, payload: PlatformNotificationChannelInput) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/notifications/channels`, payload);
    return response.data as { item: PlatformNotificationChannelItem };
  },

  updateAppNotificationChannel: async (appId: string, channelId: string, payload: Partial<PlatformNotificationChannelInput>) => {
    const response = await apiClient.getClient().patch(`/platform-admin/apps/${appId}/notifications/channels/${channelId}`, payload);
    return response.data as { item: PlatformNotificationChannelItem };
  },

  deleteAppNotificationChannel: async (appId: string, channelId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/apps/${appId}/notifications/channels/${channelId}`);
    return response.data as { deleted: boolean };
  },

  testAppNotificationChannel: async (appId: string, channelId: string, payload?: { title?: string; message?: string }) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/notifications/channels/${channelId}/test`, payload || {});
    return response.data as { ok: boolean; result?: unknown };
  },

  listAppNotificationRules: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/notifications/rules`);
    return response.data as { event_catalog: PlatformNotificationEventCatalogItem[]; items: PlatformNotificationRuleItem[] };
  },

  updateAppNotificationRules: async (appId: string, payload: { items: PlatformNotificationRuleItem[] }) => {
    const response = await apiClient.getClient().put(`/platform-admin/apps/${appId}/notifications/rules`, payload);
    return response.data as { items: PlatformNotificationRuleItem[] };
  },

  listAppNotificationEvents: async (appId: string, params?: { event_type?: string; severity?: string; status?: string; limit?: number }) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/notifications/events`, { params });
    return response.data as { items: PlatformNotificationEventItem[] };
  },

  listAppNotificationDeliveries: async (appId: string, params?: { status?: string; limit?: number }) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/notifications/deliveries`, { params });
    return response.data as { items: PlatformNotificationDeliveryItem[] };
  },

  listEmailProviderSendingDomains: async (providerId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/email/providers/${providerId}/sending-domains`);
    return response.data as { items: PlatformEmailCloudflareSendingDomain[] };
  },

  createEmailCloudflareAccount: async (payload: {
    name?: string;
    account_id?: string;
    api_token: string;
    status?: 'ACTIVE' | 'INACTIVE';
    notes?: string;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/email/cloudflare/accounts', payload);
    return response.data as PlatformEmailCfAccountItem;
  },

  updateEmailCloudflareAccount: async (accountId: string, payload: Partial<{
    name: string;
    account_id: string;
    api_token: string;
    status: 'ACTIVE' | 'INACTIVE';
    notes: string;
  }>) => {
    const response = await apiClient.getClient().patch(`/platform-admin/email/cloudflare/accounts/${accountId}`, payload);
    return response.data as PlatformEmailCfAccountItem;
  },

  verifyEmailCloudflareToken: async (payload: { api_token: string }) => {
    const response = await apiClient.getClient().post('/platform-admin/email/cloudflare/accounts/verify-token', payload);
    return response.data as {
      ok: boolean;
      token: Record<string, unknown>;
      accounts: PlatformEmailCloudflareTokenAccount[];
    };
  },

  deleteEmailCloudflareAccount: async (accountId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/email/cloudflare/accounts/${accountId}`);
    return response.data as { deleted: boolean };
  },

  testEmailCloudflareAccount: async (accountId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/email/cloudflare/accounts/${accountId}/test`);
    return response.data as { ok: boolean; token?: Record<string, unknown> };
  },

  listEmailCloudflareSendingDomains: async (accountId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/email/cloudflare/accounts/${accountId}/sending-domains`);
    return response.data as { items: PlatformEmailCloudflareSendingDomain[] };
  },

  listEmailSenders: async (appId?: string) => {
    const response = await apiClient.getClient().get('/platform-admin/email/senders', { params: { app_id: appId } });
    return response.data as { items: PlatformEmailSenderItem[] };
  },

  createEmailSender: async (payload: {
    provider_id: string;
    cf_account_id?: string;
    app_id?: string | null;
    email: string;
    display_name?: string;
    purpose?: 'marketing' | 'notification' | 'both';
    status?: 'ACTIVE' | 'INACTIVE';
    is_default?: boolean;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/email/senders', payload);
    return response.data as PlatformEmailSenderItem;
  },

  updateEmailSender: async (senderId: string, payload: Partial<{
    provider_id: string;
    cf_account_id: string;
    app_id: string | null;
    email: string;
    display_name: string;
    purpose: 'marketing' | 'notification' | 'both';
    status: 'ACTIVE' | 'INACTIVE';
    is_default: boolean;
  }>) => {
    const response = await apiClient.getClient().patch(`/platform-admin/email/senders/${senderId}`, payload);
    return response.data as PlatformEmailSenderItem;
  },

  deleteEmailSender: async (senderId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/email/senders/${senderId}`);
    return response.data as { deleted: boolean };
  },

  testEmailSender: async (senderId: string, payload: { to: string }) => {
    const response = await apiClient.getClient().post(`/platform-admin/email/senders/${senderId}/test`, payload);
    return response.data as { ok: boolean };
  },

  listGlobalWechatOpenApps: async () => {
    const response = await apiClient.getClient().get('/platform-admin/wechat/open-apps');
    return response.data;
  },

  createGlobalWechatOpenApp: async (payload: {
    name: string;
    app_id: string;
    app_secret: string;
    is_active?: boolean;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/wechat/open-apps', payload);
    return response.data;
  },

  updateGlobalWechatOpenApp: async (
    openAppId: string,
    payload: {
      name?: string;
      app_id?: string;
      app_secret?: string;
      is_active?: boolean;
    }
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/wechat/open-apps/${openAppId}`, payload);
    return response.data;
  },

  deleteGlobalWechatOpenApp: async (openAppId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/wechat/open-apps/${openAppId}`);
    return response.data;
  },

  testGlobalWechatOpenApp: async (openAppId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/wechat/open-apps/${openAppId}/test`);
    return response.data;
  },

  listOutboundProxies: async (params?: { q?: string; protocol?: string; status?: string }) => {
    const response = await apiClient.getClient().get('/platform-admin/proxies', { params });
    return response.data;
  },

  createOutboundProxy: async (payload: {
    name: string;
    protocol: PlatformOutboundProxyProtocol | string;
    host: string;
    port: number | string;
    username?: string | null;
    password?: string | null;
    region?: string | null;
    status?: PlatformOutboundProxyStatus | string;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/proxies', payload);
    return response.data;
  },

  updateOutboundProxy: async (
    proxyId: string,
    payload: {
      name?: string;
      protocol?: PlatformOutboundProxyProtocol | string;
      host?: string;
      port?: number | string;
      username?: string | null;
      password?: string | null;
      clear_password?: boolean;
      region?: string | null;
      status?: PlatformOutboundProxyStatus | string;
    }
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/proxies/${proxyId}`, payload);
    return response.data;
  },

  deleteOutboundProxy: async (proxyId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/proxies/${proxyId}`);
    return response.data;
  },

  testOutboundProxy: async (proxyId: string, payload?: { target_url?: string; quality?: boolean }) => {
    const response = await apiClient.getClient().post(`/platform-admin/proxies/${proxyId}/test`, payload || {});
    return response.data;
  },

  batchTestOutboundProxies: async (payload?: { ids?: string[]; quality?: boolean; concurrency?: number }) => {
    const response = await apiClient.getClient().post('/platform-admin/proxies/batch-test', payload || {});
    return response.data;
  },

  importOutboundProxies: async (payload: { text?: string; items?: Array<Record<string, unknown>> }) => {
    const response = await apiClient.getClient().post('/platform-admin/proxies/import', payload);
    return response.data;
  },

  exportOutboundProxies: async () => {
    const response = await apiClient.getClient().get('/platform-admin/proxies/export');
    return response.data;
  },

  listOutboundProxyCheckLogs: async (proxyId: string, params?: { limit?: number }) => {
    const response = await apiClient.getClient().get(`/platform-admin/proxies/${proxyId}/check-logs`, { params });
    return response.data;
  },

  listGlobalGoogleOAuthClients: async () => {
    const response = await apiClient.getClient().get('/platform-admin/google/oauth-clients');
    return response.data;
  },

  createGlobalGoogleOAuthClient: async (payload: {
    name: string;
    client_id: string;
    client_secret?: string;
    outbound_proxy_id?: string | null;
    is_active?: boolean;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/google/oauth-clients', payload);
    return response.data;
  },

  updateGlobalGoogleOAuthClient: async (
    clientId: string,
    payload: {
      name?: string;
      client_id?: string;
      client_secret?: string;
      outbound_proxy_id?: string | null;
      is_active?: boolean;
    }
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/google/oauth-clients/${clientId}`, payload);
    return response.data;
  },

  deleteGlobalGoogleOAuthClient: async (clientId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/google/oauth-clients/${clientId}`);
    return response.data;
  },

  testGlobalGoogleOAuthClient: async (clientId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/google/oauth-clients/${clientId}/test`);
    return response.data;
  },

  listGlobalGitHubOAuthApps: async () => {
    const response = await apiClient.getClient().get('/platform-admin/github/oauth-apps');
    return response.data;
  },

  createGlobalGitHubOAuthApp: async (payload: {
    name: string;
    client_id: string;
    client_secret: string;
    is_active?: boolean;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/github/oauth-apps', payload);
    return response.data;
  },

  updateGlobalGitHubOAuthApp: async (
    appId: string,
    payload: {
      name?: string;
      client_id?: string;
      client_secret?: string;
      is_active?: boolean;
    }
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/github/oauth-apps/${appId}`, payload);
    return response.data;
  },

  deleteGlobalGitHubOAuthApp: async (appId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/github/oauth-apps/${appId}`);
    return response.data;
  },

  testGlobalGitHubOAuthApp: async (appId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/github/oauth-apps/${appId}/test`);
    return response.data;
  },

  listGlobalAppleLoginCredentials: async () => {
    const response = await apiClient.getClient().get('/platform-admin/apple/login-credentials');
    return response.data;
  },

  createGlobalAppleLoginCredential: async (payload: {
    name: string;
    bundle_id: string;
    service_id?: string;
    team_id: string;
    key_id?: string;
    issuer_id?: string;
    private_key: string;
    environment?: string;
    is_active?: boolean;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/apple/login-credentials', payload);
    return response.data;
  },

  updateGlobalAppleLoginCredential: async (
    credentialId: string,
    payload: Partial<{
      name: string;
      bundle_id: string;
      service_id: string;
      team_id: string;
      key_id: string;
      issuer_id: string;
      private_key: string;
      environment: string;
      is_active: boolean;
    }>
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/apple/login-credentials/${credentialId}`, payload);
    return response.data;
  },

  deleteGlobalAppleLoginCredential: async (credentialId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/apple/login-credentials/${credentialId}`);
    return response.data;
  },

  testGlobalAppleLoginCredential: async (credentialId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/apple/login-credentials/${credentialId}/test`);
    return response.data;
  },

  listGlobalPaymentMethods: async () => {
    const response = await apiClient.getClient().get('/platform-admin/payments/methods');
    return response.data;
  },

  createGlobalPaymentMethod: async (payload: {
    provider_type: PlatformPaymentProviderType;
    name: string;
    is_active?: boolean;
    is_default?: boolean;
    notes?: string;
    config?: PlatformPaymentMethodConfig;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/payments/methods', payload);
    return response.data;
  },

  updateGlobalPaymentMethod: async (
    methodId: string,
    payload: {
      provider_type?: PlatformPaymentProviderType;
      name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      config?: PlatformPaymentMethodConfig;
    }
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/payments/methods/${methodId}`, payload);
    return response.data;
  },

  deleteGlobalPaymentMethod: async (methodId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/payments/methods/${methodId}`);
    return response.data;
  },

  testGlobalPaymentMethod: async (payload: { method_id: string; timeout_ms?: number }) => {
    const response = await apiClient.getClient().post('/platform-admin/payments/methods/test', payload);
    return response.data;
  },

  listStorageProviders: async (): Promise<{ items: PlatformStorageProviderItem[] }> => {
    const response = await apiClient.getClient().get('/platform-admin/storage/providers');
    return response.data?.data || response.data;
  },

  createStorageProvider: async (payload: PlatformStorageProviderInput): Promise<PlatformStorageProviderItem> => {
    const response = await apiClient.getClient().post('/platform-admin/storage/providers', payload);
    return response.data?.data || response.data;
  },

  updateStorageProvider: async (providerId: string, payload: PlatformStorageProviderInput): Promise<PlatformStorageProviderItem> => {
    const response = await apiClient.getClient().patch(`/platform-admin/storage/providers/${providerId}`, payload);
    return response.data?.data || response.data;
  },

  deleteStorageProvider: async (providerId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/storage/providers/${providerId}`);
    return response.data?.data || response.data;
  },

  testStorageProvider: async (providerId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/storage/providers/${providerId}/test`);
    return response.data?.data || response.data;
  },

  listDeveloperAuthorizationScopes: async (): Promise<{ items: DeveloperAuthorizationScope[]; default_scopes: string[] }> => {
    const response = await apiClient.getClient().get('/platform-admin/developer-authorizations/scopes');
    return response.data?.data || response.data;
  },

  listDeveloperAuthorizationGrants: async (): Promise<{ items: DeveloperAuthorizationGrant[]; scope_catalog: DeveloperAuthorizationScope[] }> => {
    const response = await apiClient.getClient().get('/platform-admin/developer-authorizations/grants');
    return response.data?.data || response.data;
  },

  updateDeveloperAuthorizationGrant: async (
    grantId: string,
    payload: { name?: string; scopes?: string[]; allowed_app_ids?: string[]; expires_at?: string | null },
  ): Promise<DeveloperAuthorizationGrant> => {
    const response = await apiClient.getClient().patch(`/platform-admin/developer-authorizations/grants/${grantId}`, payload);
    return response.data?.data || response.data;
  },

  revokeDeveloperAuthorizationGrant: async (grantId: string): Promise<DeveloperAuthorizationGrant> => {
    const response = await apiClient.getClient().post(`/platform-admin/developer-authorizations/grants/${grantId}/revoke`);
    return response.data?.data || response.data;
  },

  listSmtpProviders: async (): Promise<{ items: PlatformSmtpProviderItem[] }> => {
    const response = await apiClient.getClient().get('/platform-admin/smtp/providers');
    return response.data?.data || response.data;
  },

  createSmtpProvider: async (payload: PlatformSmtpProviderInput): Promise<PlatformSmtpProviderItem> => {
    const response = await apiClient.getClient().post('/platform-admin/smtp/providers', payload);
    return response.data?.data || response.data;
  },

  updateSmtpProvider: async (providerId: string, payload: PlatformSmtpProviderInput): Promise<PlatformSmtpProviderItem> => {
    const response = await apiClient.getClient().patch(`/platform-admin/smtp/providers/${providerId}`, payload);
    return response.data?.data || response.data;
  },

  deleteSmtpProvider: async (providerId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/smtp/providers/${providerId}`);
    return response.data?.data || response.data;
  },

  testSmtpProvider: async (providerId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/smtp/providers/${providerId}/test`);
    return response.data?.data || response.data;
  },

  listGlobalSmsProviders: async () => {
    const response = await apiClient.getClient().get('/platform-admin/sms/providers');
    return response.data;
  },

  listSmsProviderCatalog: async () => {
    const response = await apiClient.getClient().get('/platform-admin/sms/provider-catalog');
    return response.data;
  },

  createGlobalSmsProvider: async (payload: {
    provider_type: PlatformSmsProviderType;
    name: string;
    is_active?: boolean;
    is_default?: boolean;
    notes?: string;
    config?: PlatformSmsProviderConfig;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/sms/providers', payload);
    return response.data;
  },

  updateGlobalSmsProvider: async (
    providerId: string,
    payload: {
      provider_type?: PlatformSmsProviderType;
      name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      config?: PlatformSmsProviderConfig;
    }
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/sms/providers/${providerId}`, payload);
    return response.data;
  },

  deleteGlobalSmsProvider: async (providerId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/sms/providers/${providerId}`);
    return response.data;
  },

  testGlobalSmsProvider: async (payload: { provider_id: string; timeout_ms?: number }) => {
    const response = await apiClient.getClient().post('/platform-admin/sms/providers/test', payload);
    return response.data;
  },

  listGlobalSmsSignatures: async (providerId?: string) => {
    const response = await apiClient.getClient().get('/platform-admin/sms/signatures', {
      params: providerId ? { provider_id: providerId } : undefined,
    });
    return response.data;
  },

  createGlobalSmsSignature: async (payload: {
    provider_id: string;
    sign_name: string;
    is_active?: boolean;
    is_default?: boolean;
    notes?: string;
    meta?: Record<string, unknown>;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/sms/signatures', payload);
    return response.data;
  },

  updateGlobalSmsSignature: async (
    signatureId: string,
    payload: {
      provider_id?: string;
      sign_name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      meta?: Record<string, unknown>;
    }
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/sms/signatures/${signatureId}`, payload);
    return response.data;
  },

  deleteGlobalSmsSignature: async (signatureId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/sms/signatures/${signatureId}`);
    return response.data;
  },

  listGlobalSmsTemplates: async (providerId?: string) => {
    const response = await apiClient.getClient().get('/platform-admin/sms/templates', {
      params: providerId ? { provider_id: providerId } : undefined,
    });
    return response.data;
  },

  createGlobalSmsTemplate: async (payload: {
    provider_id: string;
    template_code: string;
    template_name?: string;
    is_active?: boolean;
    is_default?: boolean;
    notes?: string;
    meta?: Record<string, unknown>;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/sms/templates', payload);
    return response.data;
  },

  updateGlobalSmsTemplate: async (
    templateId: string,
    payload: {
      provider_id?: string;
      template_code?: string;
      template_name?: string;
      is_active?: boolean;
      is_default?: boolean;
      notes?: string;
      meta?: Record<string, unknown>;
    }
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/sms/templates/${templateId}`, payload);
    return response.data;
  },

  deleteGlobalSmsTemplate: async (templateId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/sms/templates/${templateId}`);
    return response.data;
  },

  listSmsEvents: async (params?: {
    app_id?: string;
    provider_id?: string;
    provider_type?: string;
    status?: string;
    trace_id?: string;
    phone?: string;
    page?: number;
    page_size?: number;
  }) => {
    const response = await apiClient.getClient().get('/platform-admin/sms/events', { params });
    return response.data;
  },

  getSmsSummary: async (params?: { app_id?: string; hours?: number }) => {
    const response = await apiClient.getClient().get('/platform-admin/sms/summary', { params });
    return response.data;
  },

  listAppPaymentProductsForTest: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/payments/apps/${appId}/products`);
    return response.data;
  },

  runPlatformPaymentOneTimeTest: async (payload: {
    app_id?: string;
    app_slug?: string;
    one_time_product_id: string;
    user_id?: string;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/payments/testing/one-time', payload);
    return response.data;
  },

  runPlatformPaymentWechatOneTimeTest: async (payload: {
    app_id?: string;
    app_slug?: string;
    one_time_product_id: string;
    user_id?: string;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/payments/testing/wechat/one-time', payload);
    return response.data;
  },

  runPlatformPaymentRecurringTest: async (payload: {
    app_id?: string;
    app_slug?: string;
    recurring_product_id: string;
    user_id?: string;
    execute_time?: string;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/payments/testing/recurring', payload);
    return response.data;
  },

  runPlatformPaymentFullFlowTest: async (payload: {
    app_id?: string;
    app_slug?: string;
    one_time_product_id: string;
    recurring_product_id: string;
    user_id?: string;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/payments/testing/full-flow', payload);
    return response.data;
  },

  listApps: async (includeInactive: boolean = true) => {
    const response = await apiClient.getClient().get('/platform-admin/apps', {
      params: { include_inactive: includeInactive },
    });
    return response.data;
  },

  getAppDetail: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}`);
    return response.data;
  },

  createApp: async (payload: {
    slug: string;
    slug_aliases?: string[];
    name: string;
    kind?: PlatformAppKind;
    status?: 'ACTIVE' | 'INACTIVE';
    domains?: PlatformAppDomainInput[];
    settings?: PlatformAppSettingsInput;
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/apps', payload);
    return response.data;
  },

  updateApp: async (
    appId: string,
    payload: {
      name?: string;
      kind?: PlatformAppKind;
      slug_aliases?: string[];
      status?: 'ACTIVE' | 'INACTIVE';
      domains?: PlatformAppDomainInput[];
      settings?: PlatformAppSettingsInput;
    }
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/apps/${appId}`, payload);
    return response.data;
  },

  sendAppSmsTest: async (
    appId: string,
    payload: {
      phone: string;
      code?: string;
      persist_code?: boolean;
      respect_cooldown?: boolean;
    }
  ) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/sms/test-send`, payload);
    return response.data;
  },

  getAppStats: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/stats`);
    return response.data;
  },

  getAppEmailSettings: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/email/settings`);
    return response.data as { settings: PlatformAppEmailSettings; senders: PlatformEmailSenderItem[] };
  },

  updateAppEmailSettings: async (appId: string, payload: PlatformAppEmailSettings) => {
    const response = await apiClient.getClient().put(`/platform-admin/apps/${appId}/email/settings`, payload);
    return response.data as { settings: PlatformAppEmailSettings };
  },

  listAppEmailContacts: async (appId: string, params?: { page?: number; page_size?: number; status?: string; q?: string }) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/email/contacts`, { params });
    return response.data as { items: PlatformEmailContactItem[]; total: number; page: number; page_size: number };
  },

  importAppEmailContacts: async (appId: string, payload: { text?: string; items?: Array<{ email: string; display_name?: string }> }) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/email/contacts/import`, payload);
    return response.data as { imported: number };
  },

  updateAppEmailContact: async (appId: string, contactId: string, payload: Partial<Pick<PlatformEmailContactItem, 'status' | 'display_name'>>) => {
    const response = await apiClient.getClient().patch(`/platform-admin/apps/${appId}/email/contacts/${contactId}`, payload);
    return response.data as PlatformEmailContactItem;
  },

  listAppEmailTemplates: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/email/templates`);
    return response.data as { items: PlatformEmailTemplateItem[] };
  },

  createAppEmailTemplate: async (appId: string, payload: Pick<PlatformEmailTemplateItem, 'name' | 'subject' | 'html'> & { text?: string }) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/email/templates`, payload);
    return response.data as PlatformEmailTemplateItem;
  },

  updateAppEmailTemplate: async (appId: string, templateId: string, payload: Pick<PlatformEmailTemplateItem, 'name' | 'subject' | 'html'> & { text?: string }) => {
    const response = await apiClient.getClient().patch(`/platform-admin/apps/${appId}/email/templates/${templateId}`, payload);
    return response.data as PlatformEmailTemplateItem;
  },

  listAppEmailCampaigns: async (appId: string, params?: { page?: number; page_size?: number }) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/email/campaigns`, { params });
    return response.data as { items: PlatformEmailCampaignItem[]; total: number; page: number; page_size: number };
  },

  createAppEmailCampaign: async (
    appId: string,
    payload: { name: string; sender_id?: string; template_id?: string; subject?: string; html?: string; text?: string },
  ) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/email/campaigns`, payload);
    return response.data as PlatformEmailCampaignItem;
  },

  sendAppEmailCampaignTest: async (appId: string, campaignId: string, payload: { to: string }) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/email/campaigns/${campaignId}/send-test`, payload);
    return response.data as { ok: boolean };
  },

  scheduleAppEmailCampaign: async (appId: string, campaignId: string, payload?: { scheduled_at?: string }) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/email/campaigns/${campaignId}/schedule`, payload || {});
    return response.data as { scheduled: boolean; recipients_created: number };
  },

  cancelAppEmailCampaign: async (appId: string, campaignId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/email/campaigns/${campaignId}/cancel`);
    return response.data as { cancelled: boolean };
  },

  getAppSiteSettings: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/site`);
    return response.data as { app_id: string; app_slug: string; settings: PlatformTenantSiteSettings };
  },

  updateAppSiteSettings: async (appId: string, payload: PlatformTenantSiteSettings) => {
    const response = await apiClient.getClient().put(`/platform-admin/apps/${appId}/site`, payload);
    return response.data as { app_id: string; app_slug: string; settings: PlatformTenantSiteSettings };
  },

  createAppSiteDownloadUploadUrl: async (
    appId: string,
    platform: 'macos' | 'windows',
    payload: { filename: string; content_type?: string },
  ) => {
    const response = await apiClient
      .getClient()
      .post(`/platform-admin/apps/${appId}/site/downloads/${platform}/upload-url`, payload);
    return response.data as PlatformTenantSiteDownloadUploadUrl;
  },

  confirmAppSiteDownloadUpload: async (
    appId: string,
    platform: 'macos' | 'windows',
    payload: Partial<PlatformTenantSiteDownloadItem> & { file_url: string; file_key: string },
  ) => {
    const response = await apiClient
      .getClient()
      .post(`/platform-admin/apps/${appId}/site/downloads/${platform}/confirm-upload`, payload);
    return response.data as { app_id: string; app_slug: string; settings: PlatformTenantSiteSettings };
  },

  getAppBusinessAnalytics: async (
    appId: string,
    params?: { days?: number; from?: string; to?: string; recent_limit?: number },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/business-analytics`, {
      params,
    });
    return response.data as PlatformTenantBusinessAnalytics;
  },

  getAppAnalyticsOverview: async (
    appId: string,
    params?: { days?: number; from?: string; to?: string; timezone?: string; granularity?: 'day' | 'week' | 'month' },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/analytics/overview`, { params });
    return response.data as PlatformTenantAnalyticsOverview;
  },

  getAppAnalyticsGrowth: async (
    appId: string,
    params?: { days?: number; from?: string; to?: string; timezone?: string; granularity?: 'day' | 'week' | 'month' },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/analytics/growth`, { params });
    return response.data as PlatformTenantGrowthAnalytics;
  },

  getAppAnalyticsRetention: async (
    appId: string,
    params?: { days?: number; from?: string; to?: string; timezone?: string; granularity?: 'day' | 'week' | 'month' },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/analytics/retention`, { params });
    return response.data as PlatformTenantRetentionAnalytics;
  },

  getAppAnalyticsProfiles: async (
    appId: string,
    params?: { days?: number; from?: string; to?: string; timezone?: string; granularity?: 'day' | 'week' | 'month' },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/analytics/profiles`, { params });
    return response.data as PlatformTenantProfileAnalytics;
  },

  getAppAnalyticsConversion: async (
    appId: string,
    params?: { days?: number; from?: string; to?: string; timezone?: string; granularity?: 'day' | 'week' | 'month' },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/analytics/conversion`, { params });
    return response.data as PlatformTenantConversionAnalytics;
  },

  getAppAnalyticsUsers: async (
    appId: string,
    params?: {
      days?: number;
      from?: string;
      to?: string;
      timezone?: string;
      granularity?: 'day' | 'week' | 'month';
      segment?: string;
      created_scope?: string;
      last_login_scope?: string;
      membership_type?: string;
      login_method?: string;
      source?: string;
      paid_status?: string;
      account_status?: 'active' | 'deactivated' | 'all';
      sort_by?: 'created_at' | 'paid_amount_total' | 'points_balance' | 'ai_requests_total' | 'last_login_at';
      sort_order?: 'asc' | 'desc';
      page?: number;
      page_size?: number;
    },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/analytics/users`, { params });
    return response.data as PlatformTenantUsersAnalytics;
  },

  deactivateTenantUser: async (appId: string, userId: string, payload?: { reason?: string }) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/users/${userId}/deactivate`, payload || {});
    return response.data;
  },

  restoreTenantUser: async (appId: string, userId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/users/${userId}/restore`);
    return response.data;
  },

  unlinkTenantUserPhone: async (appId: string, userId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/users/${userId}/unlink-phone`);
    return response.data;
  },

  unlinkTenantUserEmail: async (appId: string, userId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/users/${userId}/unlink-email`);
    return response.data;
  },

  listAppAdmins: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/admins`);
    return response.data;
  },

  getMyAppAdminPermissions: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/admin-permissions/me`);
    return response.data as PlatformMyAppAdminPermissions;
  },

  createOrUpdateAppAdmin: async (
    appId: string,
    payload: {
      email: string;
      password: string;
      display_name?: string;
      admin_type?: 'SUPER_ADMIN' | 'ADMIN';
      page_permissions?: string[];
      role_keys?: string[];
      permission_overrides?: string[];
    }
  ) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/admins`, payload);
    return response.data;
  },

  resetAppAdminPassword: async (
    appId: string,
    adminUserId: string,
    payload: {
      new_password: string;
      invalidate_sessions?: boolean;
    }
  ) => {
    const response = await apiClient.getClient().put(
      `/platform-admin/apps/${appId}/admins/${adminUserId}/password`,
      payload
    );
    return response.data;
  },

  updateAppAdminPermissions: async (
    appId: string,
    adminUserId: string,
    payload: {
      page_permissions?: string[];
      role_keys?: string[];
      permission_overrides?: string[];
    }
  ) => {
    const response = await apiClient.getClient().patch(
      `/platform-admin/apps/${appId}/admins/${adminUserId}/permissions`,
      payload
    );
    return response.data;
  },

  updateAppAdminStatus: async (
    appId: string,
    adminUserId: string,
    payload: {
      is_active: boolean;
    }
  ) => {
    const response = await apiClient.getClient().patch(
      `/platform-admin/apps/${appId}/admins/${adminUserId}/status`,
      payload
    );
    return response.data;
  },

  deleteAppAdmin: async (appId: string, adminUserId: string) => {
    const response = await apiClient.getClient().delete(
      `/platform-admin/apps/${appId}/admins/${adminUserId}`
    );
    return response.data;
  },

  listGlobalAiSources: async () => {
    const response = await apiClient.getClient().get('/platform-admin/ai/sources');
    return response.data;
  },

  getAiGatewayRuntime: async () => {
    const response = await apiClient.getClient().get('/platform-admin/ai/gateway/runtime');
    return response.data;
  },

  getPlatformObservabilityRuntime: async () => {
    const response = await apiClient.getClient().get('/platform-admin/observability/runtime');
    return response.data;
  },

  listPlatformRequestEvents: async (params?: PlatformObservabilityEventsQuery) => {
    const response = await apiClient.getClient().get('/platform-admin/observability/request-events', { params });
    return response.data;
  },

  listPlatformAuditEvents: async (params?: PlatformObservabilityEventsQuery) => {
    const response = await apiClient.getClient().get('/platform-admin/observability/audit-events', { params });
    return response.data;
  },

  listAppRequestEvents: async (appId: string, params?: Omit<PlatformObservabilityEventsQuery, 'app_id'>) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/observability/request-events`, { params });
    return response.data;
  },

  listAppAuditEvents: async (appId: string, params?: Omit<PlatformObservabilityEventsQuery, 'app_id'>) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/observability/audit-events`, { params });
    return response.data;
  },

  getPlatformRuntimeOverview: async (params?: { limit?: number | string }): Promise<PlatformRuntimeOverview> => {
    const response = await apiClient.getClient().get('/platform-admin/runtime/overview', { params });
    return response.data?.data || response.data;
  },

  refreshPlatformRuntime: async (): Promise<PlatformTaskDetail> => {
    const response = await apiClient.getClient().post('/platform-admin/runtime/refresh');
    return response.data?.data || response.data;
  },

  listRuntimeTemplates: async (): Promise<{ items: PlatformRuntimeTemplate[] }> => {
    const response = await apiClient.getClient().get('/platform-admin/runtime/templates');
    return response.data?.data || response.data;
  },

  getAppRuntimeOverview: async (appId: string, params?: { limit?: number | string }): Promise<PlatformAppRuntimeOverview> => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/runtime/overview`, { params });
    return response.data?.data || response.data;
  },

  refreshAppRuntime: async (appId: string): Promise<PlatformTaskDetail> => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/runtime/refresh`);
    return response.data?.data || response.data;
  },

  applyAppRuntimeTemplate: async (appId: string, templateKey: string): Promise<PlatformTaskDetail> => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/runtime/templates/${templateKey}/apply`);
    return response.data?.data || response.data;
  },

  listAppConnectors: async (appId: string): Promise<{ items: PlatformConnectorItem[] }> => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/connectors`);
    return response.data?.data || response.data;
  },

  createAppConnector: async (appId: string, payload: Record<string, unknown>) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/connectors`, payload);
    return response.data?.data || response.data;
  },

  updateAppConnector: async (appId: string, connector: string, payload: Record<string, unknown>) => {
    const response = await apiClient.getClient().patch(`/platform-admin/apps/${appId}/connectors/${connector}`, payload);
    return response.data?.data || response.data;
  },

  deleteAppConnector: async (appId: string, connector: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/apps/${appId}/connectors/${connector}`);
    return response.data?.data || response.data;
  },

  listConnectorCredentials: async (appId: string, connector: string): Promise<{ items: PlatformConnectorCredentialItem[] }> => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/connectors/${connector}/credentials`);
    return response.data?.data || response.data;
  },

  createConnectorCredential: async (appId: string, connector: string, payload: Record<string, unknown>) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/connectors/${connector}/credentials`, payload);
    return response.data?.data || response.data;
  },

  updateConnectorCredential: async (appId: string, connector: string, credential: string, payload: Record<string, unknown>) => {
    const response = await apiClient.getClient().patch(`/platform-admin/apps/${appId}/connectors/${connector}/credentials/${credential}`, payload);
    return response.data?.data || response.data;
  },

  deleteConnectorCredential: async (appId: string, connector: string, credential: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/apps/${appId}/connectors/${connector}/credentials/${credential}`);
    return response.data?.data || response.data;
  },

  listConnectorActions: async (appId: string, connector: string): Promise<{ items: PlatformConnectorActionItem[] }> => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/connectors/${connector}/actions`);
    return response.data?.data || response.data;
  },

  createConnectorAction: async (appId: string, connector: string, payload: Record<string, unknown>) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/connectors/${connector}/actions`, payload);
    return response.data?.data || response.data;
  },

  updateConnectorAction: async (appId: string, connector: string, action: string, payload: Record<string, unknown>) => {
    const response = await apiClient.getClient().patch(`/platform-admin/apps/${appId}/connectors/${connector}/actions/${action}`, payload);
    return response.data?.data || response.data;
  },

  deleteConnectorAction: async (appId: string, connector: string, action: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/apps/${appId}/connectors/${connector}/actions/${action}`);
    return response.data?.data || response.data;
  },

  invokeConnectorAction: async (appId: string, connector: string, action: string, payload: Record<string, unknown>) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/connectors/${connector}/actions/${action}/invoke`, payload);
    return response.data?.data || response.data;
  },

  listConnectorRuns: async (appId: string, connector: string): Promise<{ items: PlatformConnectorRunItem[] }> => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/connectors/${connector}/runs`);
    return response.data?.data || response.data;
  },

  getPlatformTaskRuntime: async (): Promise<PlatformTaskRuntime> => {
    const response = await apiClient.getClient().get('/platform-admin/tasks/runtime');
    return response.data?.data || response.data;
  },

  listPlatformTasks: async (params?: PlatformTasksQuery): Promise<PlatformTasksResponse> => {
    const response = await apiClient.getClient().get('/platform-admin/tasks', { params });
    return response.data?.data || response.data;
  },

  getPlatformTask: async (taskId: string): Promise<PlatformTaskDetail> => {
    const response = await apiClient.getClient().get(`/platform-admin/tasks/${taskId}`);
    return response.data?.data || response.data;
  },

  listAppTasks: async (appId: string, params?: Omit<PlatformTasksQuery, 'app_id'>): Promise<PlatformTasksResponse> => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/tasks`, { params });
    return response.data?.data || response.data;
  },

  getAppTask: async (appId: string, taskId: string): Promise<PlatformTaskDetail> => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/tasks/${taskId}`);
    return response.data?.data || response.data;
  },

  createPlatformTask: async (payload: {
    app_id?: string | null;
    module: string;
    action: string;
    queue_name?: string | null;
    source_type?: string | null;
    source_id?: string | null;
    idempotency_key?: string | null;
    input_summary?: Record<string, unknown> | null;
  }): Promise<PlatformTaskDetail> => {
    const response = await apiClient.getClient().post('/platform-admin/tasks', payload);
    return response.data?.data || response.data;
  },

  transitionPlatformTask: async (taskId: string, payload: { status: string; progress?: number; error_code?: string; error_message?: string }) => {
    const response = await apiClient.getClient().post(`/platform-admin/tasks/${taskId}/transition`, payload);
    return response.data?.data || response.data;
  },

  cancelPlatformTask: async (taskId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/tasks/${taskId}/cancel`);
    return response.data?.data || response.data;
  },

  createGlobalAiSource: async (
    payload: {
      name: string;
      provider_type?: string;
      base_url: string;
      api_key: string;
      api_keys?: Array<{
        id?: string | null;
        label?: string | null;
        api_key?: string | null;
        sort_order?: number;
        is_active?: boolean;
      }>;
      custom_headers?: Record<string, string>;
      credentials?: Record<string, unknown>;
      outbound_proxy_id?: string | null;
      is_active?: boolean;
    }
  ) => {
    const response = await apiClient.getClient().post('/platform-admin/ai/sources', payload);
    return response.data;
  },

  testGlobalAiSourceConnection: async (
    payload: {
      source_id?: string;
      provider_type?: string;
      base_url?: string;
      api_key?: string;
      custom_headers?: Record<string, string>;
      credentials?: Record<string, unknown>;
      outbound_proxy_id?: string | null;
      test_path?: string;
      timeout_ms?: number;
    }
  ) => {
    const response = await apiClient.getClient().post('/platform-admin/ai/sources/test', payload);
    return response.data;
  },

  updateGlobalAiSource: async (
    sourceId: string,
    payload: {
      name?: string;
      provider_type?: string;
      base_url?: string;
      api_key?: string;
      api_keys?: Array<{
        id?: string | null;
        label?: string | null;
        api_key?: string | null;
        sort_order?: number;
        is_active?: boolean;
      }>;
      custom_headers?: Record<string, string>;
      credentials?: Record<string, unknown>;
      outbound_proxy_id?: string | null;
      is_active?: boolean;
    }
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/ai/sources/${sourceId}`, payload);
    return response.data;
  },

  deleteGlobalAiSource: async (sourceId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/ai/sources/${sourceId}`);
    return response.data;
  },

  listGlobalAiModels: async () => {
    const response = await apiClient.getClient().get('/platform-admin/ai/models');
    return response.data;
  },

  createGlobalAiModel: async (
    payload: {
      model_key: string;
      display_name?: string;
      capability?: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
      execution_mode?: 'sync' | 'async';
      pricing_mode?: 'per_mtoken' | 'per_call' | 'per_minute' | 'per_mchar';
      rmb_per_mtoken?: number;
      input_rmb_per_mtoken?: number;
      cached_input_rmb_per_mtoken?: number;
      cache_write_5m_rmb_per_mtoken?: number;
      cache_write_1h_rmb_per_mtoken?: number;
      output_rmb_per_mtoken?: number;
      rmb_per_call?: number;
      rmb_per_minute?: number;
      points_per_mtoken?: number;
      points_input_per_mtoken?: number;
      points_cached_input_per_mtoken?: number;
      points_cache_write_5m_per_mtoken?: number;
      points_cache_write_1h_per_mtoken?: number;
      points_output_per_mtoken?: number;
      points_per_call?: number;
      points_per_minute?: number;
      default_source_id: string;
      source_routes?: Array<{
        route_key?: string;
        source_id: string;
        sort_order?: number;
        is_active?: boolean;
        upstream_model?: string | null;
        endpoint_path?: string | null;
        api_type?: string | null;
        request_overrides?: Record<string, unknown>;
      }>;
      upstream_model?: string;
      endpoint_path?: string;
      api_type?: string;
      request_overrides?: Record<string, unknown>;
      is_default?: boolean;
      is_active?: boolean;
      is_visible?: boolean;
    }
  ) => {
    const response = await apiClient.getClient().post('/platform-admin/ai/models', payload);
    return response.data;
  },

  testGlobalAiModelConnection: async (
    payload: {
      model_id?: string;
      capability?: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
      source_id?: string;
      upstream_model?: string;
      endpoint_path?: string;
      api_type?: string;
      request_overrides?: Record<string, unknown>;
      test_prompt?: string;
      timeout_ms?: number;
    }
  ) => {
    const response = await apiClient.getClient().post('/platform-admin/ai/models/test', payload);
    return response.data;
  },

  testGlobalAiModelsBatchConnection: async (
    payload: {
      capability?: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
      model_ids?: string[];
      only_active?: boolean;
      test_prompt?: string;
      timeout_ms?: number;
    }
  ) => {
    const response = await apiClient.getClient().post('/platform-admin/ai/models/test-batch', payload);
    return response.data as PlatformAiModelBatchConnectivityTestResult;
  },

  runGlobalAiModelPlayground: async (
    payload: {
      app_id: string;
      model_id?: string;
      capability?: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
      source_id?: string;
      upstream_model?: string;
      endpoint_path?: string;
      api_type?: string;
      request_overrides?: Record<string, unknown>;
      video_mode?: 'sync' | 'async';
      payload?: Record<string, unknown>;
    }
  ) => {
    const response = await apiClient.getClient().post('/platform-admin/ai/models/playground', payload);
    return response.data as PlatformAiPlaygroundResult;
  },

  queryGlobalAiModelPlayground: async (
    payload: {
      app_id: string;
      model_id?: string;
      capability?: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
      source_id?: string;
      upstream_model?: string;
      endpoint_path?: string;
      api_type?: string;
      request_overrides?: Record<string, unknown>;
      payload?: Record<string, unknown>;
    }
  ) => {
    const response = await apiClient.getClient().post('/platform-admin/ai/models/playground/query', payload);
    return response.data as PlatformAiPlaygroundResult;
  },

  updateGlobalAiModel: async (
    modelId: string,
    payload: {
      model_key?: string;
      display_name?: string;
      capability?: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';
      execution_mode?: 'sync' | 'async';
      pricing_mode?: 'per_mtoken' | 'per_call' | 'per_minute' | 'per_mchar';
      rmb_per_mtoken?: number;
      input_rmb_per_mtoken?: number;
      cached_input_rmb_per_mtoken?: number;
      cache_write_5m_rmb_per_mtoken?: number;
      cache_write_1h_rmb_per_mtoken?: number;
      output_rmb_per_mtoken?: number;
      rmb_per_call?: number;
      rmb_per_minute?: number;
      points_per_mtoken?: number;
      points_input_per_mtoken?: number;
      points_cached_input_per_mtoken?: number;
      points_cache_write_5m_per_mtoken?: number;
      points_cache_write_1h_per_mtoken?: number;
      points_output_per_mtoken?: number;
      points_per_call?: number;
      points_per_minute?: number;
      default_source_id?: string;
      source_routes?: Array<{
        route_key?: string;
        source_id: string;
        sort_order?: number;
        is_active?: boolean;
        upstream_model?: string | null;
        endpoint_path?: string | null;
        api_type?: string | null;
        request_overrides?: Record<string, unknown>;
      }>;
      upstream_model?: string;
      endpoint_path?: string;
      api_type?: string;
      request_overrides?: Record<string, unknown>;
      is_default?: boolean;
      is_active?: boolean;
      is_visible?: boolean;
    }
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/ai/models/${modelId}`, payload);
    return response.data;
  },

  listGlobalAiModelSources: async (modelId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/ai/models/${modelId}/sources`);
    return response.data as { items: PlatformAiModelSourceRouteItem[] };
  },

  replaceGlobalAiModelSources: async (
    modelId: string,
    payload: {
      items: Array<{
        source_id: string;
        sort_order?: number;
        is_active?: boolean;
        upstream_model?: string | null;
        endpoint_path?: string | null;
        api_type?: string | null;
        request_overrides?: Record<string, unknown>;
      }>;
    },
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/ai/models/${modelId}/sources`, payload);
    return response.data as { items: PlatformAiModelSourceRouteItem[] };
  },

  deleteGlobalAiModel: async (modelId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/ai/models/${modelId}`);
    return response.data;
  },

  getGlobalAiUsageSummary: async (params?: PlatformAiUsageQueryParams) => {
    const response = await apiClient.getClient().get('/platform-admin/ai/usage/summary', { params });
    return response.data as PlatformAiUsageSummary;
  },

  getGlobalAiUsageBreakdown: async (params?: PlatformAiUsageQueryParams) => {
    const response = await apiClient.getClient().get('/platform-admin/ai/usage/breakdown', { params });
    return response.data as PlatformAiUsageBreakdown;
  },

  listGlobalAiUsageLogs: async (params?: PlatformAiUsageLogsQueryParams) => {
    const response = await apiClient.getClient().get('/platform-admin/ai/usage/logs', { params });
    return response.data as PlatformAiUsageLogsResponse;
  },

  getAppAiUsageSummary: async (appId: string, params?: Omit<PlatformAiUsageQueryParams, 'app_id'>) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/ai/usage/summary`, { params });
    return response.data as PlatformAppAiUsageSummary;
  },

  getAppAiUsageBreakdown: async (appId: string, params?: Omit<PlatformAiUsageQueryParams, 'app_id'>) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/ai/usage/breakdown`, { params });
    return response.data as PlatformAppAiUsageBreakdown;
  },

  listAppAiUsageLogs: async (appId: string, params?: Omit<PlatformAiUsageLogsQueryParams, 'app_id'>) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/ai/usage/logs`, { params });
    return response.data as PlatformAppAiUsageLogsResponse;
  },

  listAppAiModelRoutes: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/ai/model-routes`);
    return response.data;
  },

  upsertAppAiModelRoute: async (
    appId: string,
    modelId: string,
    payload: {
      source_id: string;
      is_active?: boolean;
      request_overrides?: Record<string, unknown>;
    }
  ) => {
    const response = await apiClient.getClient().put(
      `/platform-admin/apps/${appId}/ai/model-routes/${modelId}`,
      payload
    );
    return response.data;
  },

  deleteAppAiModelRoute: async (appId: string, modelId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/apps/${appId}/ai/model-routes/${modelId}`);
    return response.data;
  },

  updateAppAiModelVisibility: async (appId: string, modelId: string, payload: { is_visible: boolean }) => {
    const response = await apiClient.getClient().put(
      `/platform-admin/apps/${appId}/ai/model-visibility/${modelId}`,
      payload
    );
    return response.data;
  },

  listAppAiCapabilityDefaults: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/ai/default-models`);
    return response.data;
  },

  upsertAppAiCapabilityDefault: async (
    appId: string,
    capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video',
    payload: { model_id: string }
  ) => {
    const response = await apiClient.getClient().put(
      `/platform-admin/apps/${appId}/ai/default-models/${capability}`,
      payload
    );
    return response.data;
  },

  deleteAppAiCapabilityDefault: async (
    appId: string,
    capability: 'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video'
  ) => {
    const response = await apiClient.getClient().delete(
      `/platform-admin/apps/${appId}/ai/default-models/${capability}`
    );
    return response.data;
  },

  listAppAiDefaultModelSlots: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/ai/default-model-slots`);
    return response.data;
  },

  upsertAppAiDefaultModelSlot: async (
    appId: string,
    slotKey: PlatformAppAiDefaultModelSlotKey,
    payload: { primary_model_id?: string | null; fallback_model_id?: string | null }
  ) => {
    const response = await apiClient.getClient().put(
      `/platform-admin/apps/${appId}/ai/default-model-slots/${slotKey}`,
      payload
    );
    return response.data;
  },

  deleteAppAiDefaultModelSlot: async (appId: string, slotKey: PlatformAppAiDefaultModelSlotKey) => {
    const response = await apiClient.getClient().delete(
      `/platform-admin/apps/${appId}/ai/default-model-slots/${slotKey}`
    );
    return response.data;
  },

  getAppAiPointsSettings: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/ai/points-settings`);
    return response.data as PlatformAppAiPointsSettings;
  },

  listPlatformAgents: async () => {
    const response = await apiClient.getClient().get('/platform-admin/agents');
    return response.data as { items: PlatformAgentItem[] };
  },

  getPlatformAgent: async (agentId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/agents/${agentId}`);
    return response.data as PlatformAgentItem;
  },

  createPlatformAgent: async (payload: {
    slug: string;
    name: string;
    description?: string;
    scope?: 'global' | 'app';
    owner_app_id?: string;
    visibility?: 'private' | 'internal' | 'public';
    system_prompt_template: string;
    developer_prompt_template?: string;
    default_model?: string;
    max_steps?: number;
    max_tool_calls?: number;
    timeout_ms?: number;
    output_mode?: 'text' | 'json';
    input_schema_json?: Record<string, unknown>;
    output_schema_json?: Record<string, unknown>;
    tool_policy_json?: Record<string, unknown>;
    tools?: PlatformAgentToolBindingItem[];
  }) => {
    const response = await apiClient.getClient().post('/platform-admin/agents', payload);
    return response.data as PlatformAgentItem;
  },

  updatePlatformAgent: async (
    agentId: string,
    payload: {
      slug?: string;
      name?: string;
      description?: string;
      scope?: 'global' | 'app';
      owner_app_id?: string;
      visibility?: 'private' | 'internal' | 'public';
      system_prompt_template?: string;
      developer_prompt_template?: string;
      default_model?: string;
      max_steps?: number;
      max_tool_calls?: number;
      timeout_ms?: number;
      output_mode?: 'text' | 'json';
      input_schema_json?: Record<string, unknown>;
      output_schema_json?: Record<string, unknown>;
      tool_policy_json?: Record<string, unknown>;
      tools?: PlatformAgentToolBindingItem[];
    },
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/agents/${agentId}`, payload);
    return response.data as PlatformAgentItem;
  },

  publishPlatformAgent: async (agentId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/agents/${agentId}/publish`);
    return response.data as PlatformAgentItem;
  },

  archivePlatformAgent: async (agentId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/agents/${agentId}/archive`);
    return response.data as PlatformAgentItem;
  },

  deletePlatformAgent: async (agentId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/agents/${agentId}`);
    return response.data as { deleted: boolean; agent_id: string };
  },

  testPlatformAgent: async (
    agentId: string,
    payload: {
      app_id: string;
      input: string;
      variables?: Record<string, unknown>;
      user_id?: string;
      debug?: boolean;
    },
  ) => {
    const response = await apiClient.getClient().post(`/platform-admin/agents/${agentId}/test`, payload);
    return response.data as PlatformAgentTestResult;
  },

  listPlatformAgentTools: async () => {
    const response = await apiClient.getClient().get('/platform-admin/agent-tools');
    return response.data as { packs: PlatformAgentToolPackItem[]; items: PlatformAgentToolCatalogItem[] };
  },

  listPlatformAgentRuns: async (params?: {
    agent_id?: string;
    app_id?: string;
    status?: string;
    page?: number;
    page_size?: number;
  }) => {
    const response = await apiClient.getClient().get('/platform-admin/agent-runs', { params });
    return response.data as { items: PlatformAgentRunItem[]; page: number; page_size: number };
  },

  listAppAgentBindings: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/agents`);
    return response.data as { items: PlatformAgentBindingItem[] };
  },

  upsertAppAgentBinding: async (
    appId: string,
    agentId: string,
    payload: {
      route_slug?: string;
      is_enabled?: boolean;
      auth_policy?: 'public' | 'user' | 'admin';
      points_cost?: number;
      model_override?: string;
      system_prompt_override?: string;
      tool_override_json?: Record<string, unknown>;
    },
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/apps/${appId}/agents/${agentId}/binding`, payload);
    return response.data as { items: PlatformAgentBindingItem[] };
  },

  deleteAppAgentBinding: async (appId: string, agentId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/apps/${appId}/agents/${agentId}/binding`);
    return response.data as { deleted: boolean; app_id: string; agent_id: string };
  },

  updateAppAiPointsSettings: async (
    appId: string,
    payload: {
      initial_points?: number;
      points_per_yuan?: number;
    },
  ) => {
    const response = await apiClient.getClient().put(`/platform-admin/apps/${appId}/ai/points-settings`, payload);
    return response.data as PlatformAppAiPointsSettings;
  },

  grantAppAiPoints: async (
    appId: string,
    payload: {
      amount: number;
      reason?: string;
      user_id?: string;
      email?: string;
      phone?: string;
    },
  ) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/ai/points/grant`, payload);
    return response.data as PlatformAppAiPointsGrantResult;
  },

  listAppPaymentOrders: async (
    appId: string,
    params?: { page?: number; page_size?: number; status?: string },
  ) => {
    const response = await withNotFoundFallback([
      () => apiClient.getClient().get(`/platform-admin/apps/${appId}/payments/orders`, { params }),
      () => apiClient.getClient().get(`/platform-admin/payments/apps/${appId}/orders`, { params }),
      () =>
        apiClient.getClient().get(`/platform-admin/payments/orders`, {
          params: {
            ...(params || {}),
            app_id: appId,
          },
        }),
    ]);
    return response.data as {
      total: number;
      page: number;
      page_size: number;
      items: PlatformPaymentOrderItem[];
    };
  },

  refundAppPaymentOrder: async (
    appId: string,
    orderId: string,
    payload?: { amount?: string; reason?: string },
  ) => {
    const body = payload || {};
    const response = await withNotFoundFallback([
      () => apiClient.getClient().post(`/platform-admin/apps/${appId}/payments/orders/${orderId}/refund`, body),
      () => apiClient.getClient().post(`/platform-admin/payments/apps/${appId}/orders/${orderId}/refund`, body),
      () =>
        apiClient.getClient().post(`/platform-admin/payments/orders/${orderId}/refund`, body, {
          params: { app_id: appId },
        }),
    ]);
    return response.data as {
      order_id: string;
      out_trade_no: string;
      out_request_no: string;
      refund_amount: string;
      refunded_amount_total: string;
      refund_count: number;
      order_amount: string;
      status: 'REFUNDED' | 'PARTIAL_REFUNDED';
      response: Record<string, unknown>;
    };
  },

  listAppFeedbacks: async (
    appId: string,
    params?: { page?: number; page_size?: number; status?: string; priority?: string; assignee_user_id?: string; q?: string },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/feedbacks`, {
      params,
    });
    return response.data as {
      total: number;
      page: number;
      page_size: number;
      summary?: Record<string, number>;
      items: PlatformAppFeedbackItem[];
    };
  },

  getAppFeedback: async (appId: string, feedbackId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/feedbacks/${feedbackId}`);
    return response.data as { item: PlatformAppFeedbackItem; comments: PlatformAppFeedbackComment[] };
  },

  updateAppFeedback: async (
    appId: string,
    feedbackId: string,
    payload: Partial<Pick<PlatformAppFeedbackItem, 'status' | 'priority' | 'title' | 'category' | 'assignee_user_id'>> & {
      note?: string | null;
    },
  ) => {
    const response = await apiClient.getClient().patch(`/platform-admin/apps/${appId}/feedbacks/${feedbackId}`, payload);
    return response.data as { item: PlatformAppFeedbackItem; comments: PlatformAppFeedbackComment[] };
  },

  addAppFeedbackComment: async (
    appId: string,
    feedbackId: string,
    payload: { body: string; is_internal?: boolean },
  ) => {
    const response = await apiClient
      .getClient()
      .post(`/platform-admin/apps/${appId}/feedbacks/${feedbackId}/comments`, payload);
    return response.data as { comment: PlatformAppFeedbackComment; comments: PlatformAppFeedbackComment[] };
  },

  reviewAppFeedback: async (
    appId: string,
    feedbackId: string,
    payload: { action: 'useless' | 'thanks' | 'useful'; note?: string },
  ) => {
    const response = await apiClient.getClient().post(
      `/platform-admin/apps/${appId}/feedbacks/${feedbackId}/review`,
      payload,
    );
    return response.data as { item: PlatformAppFeedbackItem; reward_points: number };
  },

  listAcquisitionSourceOptions: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/acquisition/source-options`);
    return response.data as { items: PlatformAcquisitionSourceOption[] };
  },

  createAcquisitionSourceOption: async (
    appId: string,
    payload: {
      key: string;
      label: string;
      is_active?: boolean;
      allow_free_text?: boolean;
      sort_order?: number;
    },
  ) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/acquisition/source-options`, payload);
    return response.data as { item: PlatformAcquisitionSourceOption };
  },

  updateAcquisitionSourceOption: async (
    appId: string,
    optionId: string,
    payload: Partial<Pick<PlatformAcquisitionSourceOption, 'key' | 'label' | 'is_active' | 'allow_free_text' | 'sort_order'>>,
  ) => {
    const response = await apiClient.getClient().patch(
      `/platform-admin/apps/${appId}/acquisition/source-options/${optionId}`,
      payload,
    );
    return response.data as { item: PlatformAcquisitionSourceOption };
  },

  deleteAcquisitionSourceOption: async (appId: string, optionId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/apps/${appId}/acquisition/source-options/${optionId}`);
    return response.data as { deleted: boolean };
  },

  getAcquisitionSummary: async (appId: string, params?: { from?: string; to?: string }) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/acquisition/summary`, { params });
    return response.data as PlatformAcquisitionSummary;
  },

  listAcquisitionUserSources: async (
    appId: string,
    params?: { source_key?: string; from?: string; to?: string; page?: number; page_size?: number; q?: string },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/acquisition/users`, { params });
    return response.data as {
      total: number;
      page: number;
      page_size: number;
      items: PlatformAcquisitionUserSource[];
    };
  },

  listAppForms: async (appId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/forms`);
    return response.data as { items: PlatformAppFormItem[] };
  },

  createAppForm: async (
    appId: string,
    payload: {
      name: string;
      form_key?: string;
      title?: string;
      subtitle?: string;
      description?: string;
      submit_label?: string;
      success_title?: string;
      success_message?: string;
      theme?: Record<string, unknown>;
      settings?: Record<string, unknown>;
    },
  ) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/forms`, payload);
    return response.data as { item: PlatformAppFormItem };
  },

  getAppForm: async (appId: string, formId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/forms/${formId}`);
    return response.data as { item: PlatformAppFormItem };
  },

  updateAppForm: async (appId: string, formId: string, payload: Partial<PlatformAppFormItem>) => {
    const response = await apiClient.getClient().patch(`/platform-admin/apps/${appId}/forms/${formId}`, payload);
    return response.data as { item: PlatformAppFormItem };
  },

  deleteAppForm: async (appId: string, formId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/apps/${appId}/forms/${formId}`);
    return response.data as { deleted: boolean };
  },

  publishAppForm: async (appId: string, formId: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/forms/${formId}/publish`);
    return response.data as { item: Record<string, unknown>; manifest: Record<string, unknown> };
  },

  listAppFormResponses: async (
    appId: string,
    formId: string,
    params?: { page?: number; page_size?: number },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/forms/${formId}/responses`, { params });
    return response.data as {
      total: number;
      page: number;
      page_size: number;
      items: PlatformAppFormResponseItem[];
    };
  },

  getAppFormMetrics: async (appId: string, formId: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/forms/${formId}/metrics`);
    return response.data as PlatformAppFormMetrics;
  },

  createAppFormQuestion: async (
    appId: string,
    formId: string,
    payload: {
      question_key?: string;
      type: PlatformAppFormQuestionType;
      title: string;
      description?: string;
      required?: boolean;
      sort_order?: number;
      options?: PlatformAppFormOption[];
      validation?: Record<string, unknown>;
      properties?: Record<string, unknown>;
      visibility?: Record<string, unknown>;
    },
  ) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/forms/${formId}/questions`, payload);
    return response.data as { item: PlatformAppFormQuestion };
  },

  updateAppFormQuestion: async (
    appId: string,
    formId: string,
    questionId: string,
    payload: Partial<PlatformAppFormQuestion>,
  ) => {
    const response = await apiClient.getClient().patch(
      `/platform-admin/apps/${appId}/forms/${formId}/questions/${questionId}`,
      payload,
    );
    return response.data as { item: PlatformAppFormQuestion };
  },

  deleteAppFormQuestion: async (appId: string, formId: string, questionId: string) => {
    const response = await apiClient.getClient().delete(`/platform-admin/apps/${appId}/forms/${formId}/questions/${questionId}`);
    return response.data as { deleted: boolean };
  },

  reorderAppFormQuestions: async (appId: string, formId: string, questionIds: string[]) => {
    const response = await apiClient.getClient().patch(`/platform-admin/apps/${appId}/forms/${formId}/questions/reorder`, {
      question_ids: questionIds,
    });
    return response.data as { items: PlatformAppFormQuestion[] };
  },

  listAppSiteMessages: async (
    appId: string,
    params?: { type?: string; status?: string; category?: string; q?: string; page?: number; page_size?: number },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/site/messages`, {
      params,
    });
    return response.data as {
      total: number;
      page: number;
      page_size: number;
      summary?: PlatformTenantSiteMessageSummary;
      items: PlatformTenantSiteMessageItem[];
    };
  },

  updateAppSiteMessage: async (
    appId: string,
    messageId: string,
    payload: { status: 'new' | 'read' | 'archived'; note?: string },
  ) => {
    const response = await apiClient.getClient().patch(`/platform-admin/apps/${appId}/site/messages/${messageId}`, payload);
    return response.data as { item: PlatformTenantSiteMessageItem };
  },

  listAppSiteCookieConsents: async (
    appId: string,
    params?: { region_mode?: string; page?: number; page_size?: number },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/site/cookie-consents`, {
      params,
    });
    return response.data as {
      total: number;
      page: number;
      page_size: number;
      summary: PlatformTenantSiteCookieConsentSummary;
      items: PlatformTenantSiteCookieConsentItem[];
    };
  },

  listRedeemPackages: async (appId: string) => {
    return withRedeemProductPathFallback(async (segment) => {
      const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/redeem/${segment}`);
      return response.data as { items: PlatformRedeemPackageItem[] };
    });
  },

  createRedeemPackage: async (
    appId: string,
    payload: {
      name: string;
      description?: string;
      cover_url?: string;
      price_cny?: number;
      is_active?: boolean;
      billing?: {
        enabled?: boolean;
        type?: 'ONE_TIME' | 'RECURRING';
        status?: 'ACTIVE' | 'INACTIVE';
        membership_days?: number;
        sign_scene?: string;
        sign_validity_period?: number | null;
        period_type?: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR' | null;
        period?: number | null;
        execute_time?: string | null;
      };
      grants: PlatformRedeemGrantInput[];
    },
  ) => {
    return withRedeemProductPathFallback(async (segment) => {
      const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/redeem/${segment}`, payload);
      return response.data as PlatformRedeemPackageItem;
    });
  },

  updateRedeemPackage: async (
    appId: string,
    packageId: string,
    payload: {
      name?: string;
      description?: string;
      cover_url?: string;
      price_cny?: number;
      is_active?: boolean;
      billing?: {
        enabled?: boolean;
        type?: 'ONE_TIME' | 'RECURRING';
        status?: 'ACTIVE' | 'INACTIVE';
        membership_days?: number;
        sign_scene?: string;
        sign_validity_period?: number | null;
        period_type?: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR' | null;
        period?: number | null;
        execute_time?: string | null;
      };
      grants?: PlatformRedeemGrantInput[];
    },
  ) => {
    return withRedeemProductPathFallback(async (segment) => {
      const response = await apiClient.getClient().put(
        `/platform-admin/apps/${appId}/redeem/${segment}/${packageId}`,
        payload,
      );
      return response.data as PlatformRedeemPackageItem;
    });
  },

  deleteRedeemPackage: async (appId: string, packageId: string) => {
    return withRedeemProductPathFallback(async (segment) => {
      const response = await apiClient.getClient().delete(`/platform-admin/apps/${appId}/redeem/${segment}/${packageId}`);
      return response.data as { deleted: boolean };
    });
  },

  distributeRedeemPackageToUser: async (
    appId: string,
    packageId: string,
    payload: { user_id: string },
  ) => {
    return withRedeemProductPathFallback(async (segment) => {
      const response = await apiClient.getClient().post(
        `/platform-admin/apps/${appId}/redeem/${segment}/${packageId}/distribute`,
        payload,
      );
      return response.data as {
        message: string;
        package: { id: string; name: string; cover_url?: string | null };
        user_id: string;
        granted: Array<Record<string, unknown>>;
      };
    });
  },

  getUploadUrl: async (
    filename: string,
    contentType: string = 'application/octet-stream',
    keyPrefix?: string,
    appSlug?: string,
    appId?: string,
  ) => {
    const response = await apiClient.getClient().post('/upload/presigned-url', {
      filename,
      content_type: contentType,
      key_prefix: keyPrefix,
      app_slug: appSlug,
      app_id: appId,
    });
    return response.data as {
      upload_url: string;
      file_url: string;
      file_key?: string;
      content_type?: string;
      expires_in?: number;
      headers?: Record<string, string>;
    };
  },

  uploadImageBuffer: async (
    file: File,
    appSlug?: string,
    appId?: string,
    keyPrefix: string = 'uploads/images',
  ) => {
    const formData = new FormData();
    formData.append('file', file);
    if (appSlug) {
      formData.append('app_slug', appSlug);
    }
    if (appId) {
      formData.append('app_id', appId);
    }
    if (keyPrefix) {
      formData.append('key_prefix', keyPrefix);
    }
    const response = await apiClient.getClient().post('/upload/image-buffer', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data as {
      file_key: string;
      file_url: string;
    };
  },

  createRedeemCodeBatch: async (
    appId: string,
    payload: {
      name?: string;
      note?: string;
      count: number;
      code_prefix?: string;
      max_uses?: number;
      expires_at?: string;
      package_id?: string;
      grants?: PlatformRedeemGrantInput[];
    },
  ) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/redeem/codes/batches`, payload);
    return response.data as {
      batch_id: string;
      name: string;
      created_count: number;
      max_uses: number;
      expires_at?: string | null;
      codes: string[];
    };
  },

  listRedeemCodes: async (appId: string, page: number = 1, pageSize: number = 20, batchId?: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/redeem/codes`, {
      params: {
        page,
        page_size: pageSize,
        batch_id: batchId,
      },
    });
    return response.data as {
      total: number;
      page: number;
      page_size: number;
      items: PlatformRedeemCodeItem[];
    };
  },

  listRedeemCodeRedemptions: async (appId: string, page: number = 1, pageSize: number = 20, batchId?: string) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/redeem/redemptions`, {
      params: {
        page,
        page_size: pageSize,
        batch_id: batchId,
      },
    });
    return response.data as {
      total: number;
      page: number;
      page_size: number;
      items: PlatformRedeemCodeRedemptionItem[];
    };
  },

  listRedeemCodeBatches: async (appId: string, page: number = 1, pageSize: number = 20) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/redeem/codes/batches`, {
      params: { page, page_size: pageSize },
    });
    return response.data as {
      total: number;
      page: number;
      page_size: number;
      items: PlatformRedeemCodeBatchItem[];
    };
  },

  getRedeemBatchTxt: async (
    appId: string,
    batchId: string,
    options?: {
      format?: 'code' | 'url';
      base_url?: string;
    },
  ) => {
    const response = await apiClient.getClient().get(`/platform-admin/apps/${appId}/redeem/codes/batches/${batchId}/txt`, {
      params: {
        format: options?.format,
        base_url: options?.base_url,
      },
    });
    return response.data as { filename: string; content: string; line_count: number; format?: 'code' | 'url' };
  },

  voidRedeemCode: async (appId: string, code: string, reason?: string) => {
    const response = await apiClient.getClient().post(`/platform-admin/apps/${appId}/redeem/codes/${encodeURIComponent(code)}/void`, {
      reason,
    });
    return response.data as { message: string; affected: number };
  },

  revokeRedeemCodeRedemption: async (appId: string, redemptionId: string, reason?: string) => {
    const response = await apiClient
      .getClient()
      .post(`/platform-admin/apps/${appId}/redeem/redemptions/${encodeURIComponent(redemptionId)}/revoke`, {
        reason,
      });
    return response.data as {
      message: string;
      redemption_id: string;
      code: string;
      user_id: string;
      deactivated_entitlements: number;
      app_membership_expires_at?: string | null;
    };
  },
};
