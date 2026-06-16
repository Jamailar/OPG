import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  PlatformAppAiDefaultModelSlotItem,
  PlatformAppAiDefaultModelSlotKey,
  PlatformAcquisitionSourceOption,
  PlatformAcquisitionSummary,
  PlatformAcquisitionUserSource,
  PlatformAppFeedbackComment,
  PlatformAppFeedbackItem,
  PlatformAppAiPointsGrantResult,
  PlatformAppAiPointsSettings,
  PlatformAppleLoginCredentialItem,
  PlatformGitHubOAuthAppItem,
  PlatformGoogleOAuthClientItem,
  PlatformWechatOpenAppItem,
  PlatformRedeemCodeBatchItem,
  PlatformRedeemCodeItem,
  PlatformRedeemCodeRedemptionItem,
  PlatformRedeemGrantInput,
  PlatformRedeemGrantScope,
  PlatformRedeemPackageItem,
  PlatformAiSourceItem,
  PlatformPaymentOrderItem,
  PlatformPaymentMethodItem,
  PlatformAppAiModelRouteItem,
  PlatformAppItem,
  PlatformAppSmsTestResult,
  PlatformAppEmailSettings,
  PlatformEmailCampaignItem,
  PlatformEmailContactItem,
  PlatformEmailSenderItem,
  PlatformEmailTemplateItem,
  PlatformPermissionCatalogItem,
  PlatformMyAppAdminPermissions,
  PlatformSmsTemplateItem,
  PlatformTenantAdminItem,
  PlatformTenantStats,
  PlatformTenantSiteCookieConsentItem,
  PlatformTenantSiteCookieConsentSummary,
  PlatformTenantSiteDownloadItem,
  PlatformTenantSiteMessageItem,
  PlatformTenantSiteMessageSummary,
  PlatformTenantSiteSettings,
  AppApiKeyItem,
  OpgSdkManifest,
  OpgSdkSmokeResult,
  platformApi,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';
import { runtimeContext } from '@/lib/runtime-context';
import AppAiUsagePanel from '@/pages/platform/components/AppAiUsagePanel';
import TenantApiDocsPanel from '@/pages/platform/components/TenantApiDocsPanel';
import TenantAnalyticsPanel from '@/pages/platform/components/TenantAnalyticsPanel';

type Message = { type: 'success' | 'error'; text: string } | null;
type WorkspaceSection = 'overview' | 'analytics' | 'ai-usage' | 'api-docs' | 'developers' | 'admins' | 'ai-routing' | 'site' | 'email' | 'feedback' | 'acquisition' | 'redeem';
type RedeemSubPage = 'products' | 'product-create' | 'orders' | 'code-batches' | 'code-create' | 'codes' | 'redemptions';
type ManualGrantIdentityType = 'email' | 'user_id' | 'phone';

interface AdminCreateForm {
  email: string;
  password: string;
  display_name: string;
  admin_type: 'SUPER_ADMIN' | 'ADMIN';
  page_permissions: string[];
}

interface PasswordForm {
  admin_user_id: string;
  new_password: string;
  invalidate_sessions: boolean;
}

interface AcquisitionOptionForm {
  key: string;
  label: string;
  sort_order: string;
  allow_free_text: boolean;
  is_active: boolean;
}

type DefaultModelSlotDrafts = Record<PlatformAppAiDefaultModelSlotKey, { primary_model_id: string; fallback_model_id: string }>;

interface RedeemPackageForm {
  id?: string;
  name: string;
  description: string;
  cover_url: string;
  price_cny: string;
  is_active: boolean;
  payment_enabled: boolean;
  payment_type: 'ONE_TIME' | 'RECURRING';
  membership_scope: PlatformRedeemGrantScope;
  membership_days: number;
  sign_scene: string;
  sign_validity_period: number;
  period_type: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
  period: number;
  execute_time: string;
}

interface RedeemBatchForm {
  name: string;
  note: string;
  count: number;
  code_prefix: string;
  max_uses: number;
  expires_at: string;
  package_id: string;
  use_package: boolean;
  custom_membership_scope: PlatformRedeemGrantScope;
  custom_membership_days: number;
}

type ProductPaymentTestMode = 'alipay-one-time' | 'wechat-one-time' | 'alipay-recurring';

interface PaymentTestPayload {
  one_time_order?: {
    status?: string;
    payment_form?: string;
  } | null;
  agreement?: {
    status?: string;
    sign_form?: string;
  } | null;
  order?: {
    status?: string;
    payment_url?: string | null;
    code_url?: string | null;
  } | null;
}

const WORKSPACE_NAV: Array<{ key: WorkspaceSection; label: string; desc: string }> = [
  { key: 'overview', label: '应用概览', desc: '统计、域名与关键配置' },
  { key: 'analytics', label: '经营分析', desc: '用户、订单、账单统计' },
  { key: 'ai-usage', label: 'AI 调用统计', desc: '单 app 调用与消耗趋势' },
  { key: 'api-docs', label: 'API 文档', desc: '按模块查看当前 app 可用接口' },
  { key: 'developers', label: '开发者接入', desc: 'SDK、Codex 与 API Key' },
  { key: 'admins', label: '管理员管理', desc: '账号、密码、权限' },
  { key: 'ai-routing', label: 'AI 模型路由', desc: '基于全局源做租户级覆盖' },
  { key: 'site', label: '官网配置', desc: '下载、表单、站点消息' },
  { key: 'email', label: '邮件', desc: '发件、联系人与批次' },
  { key: 'feedback', label: '用户反馈', desc: '反馈处理、积分奖励' },
  { key: 'acquisition', label: '用户来源', desc: '来源选项与提交记录' },
  { key: 'redeem', label: '产品与兑换', desc: '产品、兑换码与分发运营' },
];

const REDEEM_SUB_NAV: Array<{ key: RedeemSubPage; label: string }> = [
  { key: 'products', label: '产品列表' },
  { key: 'product-create', label: '创建产品' },
  { key: 'orders', label: '订单与退款' },
  { key: 'code-batches', label: '兑换码批次' },
  { key: 'code-create', label: '创建兑换码' },
  { key: 'codes', label: '兑换码列表' },
  { key: 'redemptions', label: '兑换记录' },
];

const LIFETIME_MEMBERSHIP_DAYS = 36500;

const EMPTY_ADMIN_FORM: AdminCreateForm = {
  email: '',
  password: '',
  display_name: '',
  admin_type: 'ADMIN',
  page_permissions: [],
};

const DEFAULT_MODEL_SLOT_META: Array<{
  key: PlatformAppAiDefaultModelSlotKey;
  label: string;
  capabilities: Array<'chat' | 'embedding' | 'tts' | 'stt' | 'image' | 'video'>;
}> = [
  { key: 'reasoning', label: '推理模型', capabilities: ['chat'] },
  { key: 'visual_index', label: '视觉索引模型', capabilities: ['embedding', 'chat'] },
  { key: 'visual_analysis', label: '视觉分析模型', capabilities: ['chat'] },
  { key: 'tts', label: 'TTS 模型', capabilities: ['tts'] },
  { key: 'embedding', label: '嵌入模型', capabilities: ['embedding'] },
  { key: 'transcription', label: '转录模型', capabilities: ['stt'] },
  { key: 'image_generation', label: '生图模型', capabilities: ['image'] },
  { key: 'video_text_to_video', label: '生视频：文生视频', capabilities: ['video'] },
  { key: 'video_image_to_video', label: '生视频：图生视频', capabilities: ['video'] },
  { key: 'video_reference_to_video', label: '生视频：参考生视频', capabilities: ['video'] },
];

const createEmptyDefaultModelSlotDrafts = (): DefaultModelSlotDrafts =>
  DEFAULT_MODEL_SLOT_META.reduce((acc, item) => {
    acc[item.key] = { primary_model_id: '', fallback_model_id: '' };
    return acc;
  }, {} as DefaultModelSlotDrafts);

const isVoiceCloneApiType = (apiType?: string | null) => {
  const normalized = String(apiType || '').trim().toLowerCase();
  return normalized.includes('voice-clone') || normalized.includes('voice_clone');
};

const MEMBERSHIP_SCOPE_LABELS: Record<PlatformRedeemGrantScope, string> = {
  app_membership: '应用会员',
  ai_membership: 'AI 会员',
};

const buildMembershipGrant = (
  scope: PlatformRedeemGrantScope,
  days: number,
): PlatformRedeemGrantInput => ({
  scope,
  days: Math.max(Math.round(days), 1),
});

const resolvePrimaryMembershipScope = (grants: PlatformRedeemGrantInput[]): PlatformRedeemGrantScope => {
  if (grants.some((grant) => grant.scope === 'ai_membership') && !grants.some((grant) => grant.scope === 'app_membership')) {
    return 'ai_membership';
  }
  return 'app_membership';
};

const resolveMembershipGrantDays = (grants: PlatformRedeemGrantInput[]) => {
  const days = grants
    .filter((grant) => grant.scope === 'app_membership' || grant.scope === 'ai_membership')
    .map((grant) => Number(grant.days || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return days.length ? Math.max(...days) : 30;
};

const formatMembershipScopeLabel = (grants: PlatformRedeemGrantInput[]) => {
  const scopes = grants
    .map((grant) => grant.scope)
    .filter((scope): scope is PlatformRedeemGrantScope => scope === 'app_membership' || scope === 'ai_membership');
  if (!scopes.length) {
    return '-';
  }
  return Array.from(new Set(scopes)).map((scope) => MEMBERSHIP_SCOPE_LABELS[scope]).join(' / ');
};

const EMPTY_REDEEM_PACKAGE_FORM: RedeemPackageForm = {
  name: '',
  description: '',
  cover_url: '',
  price_cny: '0.00',
  is_active: true,
  payment_enabled: true,
  payment_type: 'ONE_TIME',
  membership_scope: 'app_membership',
  membership_days: 30,
  sign_scene: 'INDUSTRY|DIGITAL_MEDIA',
  sign_validity_period: 365,
  period_type: 'MONTH',
  period: 1,
  execute_time: '',
};

const EMPTY_REDEEM_BATCH_FORM: RedeemBatchForm = {
  name: '',
  note: '',
  count: 50,
  code_prefix: '',
  max_uses: 1,
  expires_at: '',
  package_id: '',
  use_package: true,
  custom_membership_scope: 'app_membership',
  custom_membership_days: 30,
};

const EMPTY_ACQUISITION_OPTION_FORM: AcquisitionOptionForm = {
  key: '',
  label: '',
  sort_order: '100',
  allow_free_text: false,
  is_active: true,
};

type OAuthProvider = 'wechat' | 'google' | 'github';

function extractWechatRedirectHost(value?: string | null): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    if (/^https?:\/\//i.test(raw)) {
      return new URL(raw).host;
    }
  } catch {
    // fallback to plain host extraction below
  }
  return raw.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]?.trim() || '';
}

function resolveApiBaseUrl() {
  const configured = String(runtimeContext.apiBaseUrl || '').replace(/\/+$/, '');
  if (configured) return configured;
  if (typeof window !== 'undefined') return window.location.origin.replace(/\/+$/, '');
  return '';
}

function buildAppAuthCallbackUrl(appSlug?: string | null, provider?: OAuthProvider, hostOverride?: string | null): string {
  const slug = String(appSlug || '').trim();
  if (!slug || !provider) return '';
  const host = extractWechatRedirectHost(hostOverride);
  const base = host ? `https://${host}` : resolveApiBaseUrl();
  if (!base) return '';
  return `${base.replace(/\/+$/, '')}/${slug}/v1/auth/login/${provider}/callback`;
}

function buildWechatRedirectPreview(appSlug?: string | null, value?: string | null): string {
  return buildAppAuthCallbackUrl(appSlug, 'wechat', value);
}

function normalizePublicBaseUrl(value?: string | null): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const full = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(full);
    if (!parsed.hostname) return null;
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function asPlainRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

function boundedNumberInput(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function resolveRedeemCodeBaseUrl(app: PlatformAppItem | null): string | null {
  if (!app) return null;

  const appUrl = normalizePublicBaseUrl(app.settings?.app_url);
  if (appUrl) return appUrl;

  const userWebDomains = (app.domains || [])
    .filter((item) => item.domain_type === 'USER_WEB' && String(item.domain || '').trim())
    .sort((a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)));
  for (const item of userWebDomains) {
    const normalized = normalizePublicBaseUrl(item.domain);
    if (normalized) return normalized;
  }
  return null;
}

function parseSlugAliases(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\n,]/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function formatCurrencyCny(value?: number | null) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

function formatDateTime(value?: string | Date | null) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleString();
}

function formatPackageSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function openGatewayForm(formHtml: string): boolean {
  if (!formHtml || typeof window === 'undefined') return false;
  const raw = String(formHtml || '').trim();
  if (!raw) return false;
  const popup = window.open('about:blank', '_blank');
  if (!popup) return false;
  try {
    popup.document.open();
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"/></head><body>${raw}</body></html>`);
    popup.document.close();
    const popupForm = popup.document.querySelector('form') as HTMLFormElement | null;
    if (popupForm) {
      popupForm.submit();
      return true;
    }
  } catch {
    // fallback to parent document submit
  }

  try {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = raw;
    const form = wrapper.querySelector('form') as HTMLFormElement | null;
    if (form) {
      const targetName = `pay_test_${Date.now()}`;
      if (!popup.closed) popup.name = targetName;
      form.target = targetName;
      form.style.display = 'none';
      document.body.appendChild(form);
      form.submit();
      form.remove();
      return true;
    }
  } catch {
    // ignored
  }

  try {
    popup.document.open();
    popup.document.write('<p style="font-family:sans-serif;padding:16px;">支付页打开失败，请检查支付配置或浏览器策略。</p>');
    popup.document.close();
  } catch {
    // ignored
  }
  return false;
}

function openExternalUrl(url: string): boolean {
  if (!url || typeof window === 'undefined') return false;
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  return Boolean(opened);
}

function openQrBridge(codeUrl: string): boolean {
  if (!codeUrl || typeof window === 'undefined') return false;
  const popup = window.open('', '_blank', 'noopener,noreferrer');
  if (!popup) return false;
  const escaped = encodeURIComponent(codeUrl);
  popup.document.open();
  popup.document.write(`
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <title>微信扫码支付</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#1f2937}
          .wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
          .card{width:min(92vw,460px);background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;text-align:center;box-shadow:0 12px 28px rgba(15,23,42,.08)}
          h1{font-size:20px;line-height:1.2;margin:0 0 10px}
          p{font-size:14px;color:#6b7280;line-height:1.6;margin:0 0 16px}
          img{width:320px;max-width:100%;height:auto;border-radius:12px;border:1px solid #e5e7eb;background:#fff}
          code{display:block;margin-top:16px;font-size:12px;word-break:break-all;color:#4b5563}
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="card">
            <h1>微信支付扫码测试</h1>
            <p>请使用微信扫码完成真实支付测试。</p>
            <img alt="微信支付二维码" src="https://api.qrserver.com/v1/create-qr-code/?size=420x420&data=${escaped}" />
            <code>${codeUrl.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>
          </div>
        </div>
      </body>
    </html>
  `);
  popup.document.close();
  return true;
}

function pickTemplateVariablesExample(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }
  const raw = meta as Record<string, unknown>;
  const candidates = [
    raw.variables_example,
    raw.variables_sample,
    raw.template_params_example,
    raw.template_params_sample,
    raw.template_param_example,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

function resolveBusinessWorkspaceBasePath(): string {
  const slug = String(runtimeContext.appSlug || '').trim();
  return slug ? `/${slug}/admin` : '/admin';
}

function resolveWorkspaceBasePath(pathname: string, appId: string): string {
  const platformBase = `/platform-admin/apps/${appId}`;
  if (pathname === platformBase || pathname.startsWith(`${platformBase}/`)) {
    return platformBase;
  }

  const businessMatch = pathname.match(/^\/[^/]+\/admin(?:\/|$)/);
  if (businessMatch) {
    return businessMatch[0].replace(/\/$/, '');
  }

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return '/admin';
  }

  return runtimeContext.isPlatformPortal ? platformBase : resolveBusinessWorkspaceBasePath();
}

function resolveSection(pathname: string, appId: string): WorkspaceSection {
  const basePath = resolveWorkspaceBasePath(pathname, appId);
  const section = pathname.slice(basePath.length).replace(/^\/+/, '').split('/')[0] as WorkspaceSection;
  if (!section || !WORKSPACE_NAV.some((item) => item.key === section)) {
    return 'overview';
  }
  return section;
}

function resolveRedeemSubPage(pathname: string, appId: string): RedeemSubPage {
  const marker = `${resolveWorkspaceBasePath(pathname, appId)}/redeem`;
  if (pathname !== marker && !pathname.startsWith(`${marker}/`)) return 'products';
  const rest = pathname.slice(marker.length).replace(/^\/+/, '');
  const section = rest.split('/')[0];
  if (!section) return 'products';
  if (section === 'products') return 'products';
  if (section === 'product-create') return 'product-create';
  if (section === 'orders') return 'orders';
  if (section === 'code-batches') return 'code-batches';
  if (section === 'code-create') return 'code-create';
  if (section === 'codes') return 'codes';
  if (section === 'redemptions') return 'redemptions';
  return 'products';
}

interface TenantWorkspaceProps {
  appIdOverride?: string;
}

export default function TenantWorkspace({ appIdOverride }: TenantWorkspaceProps) {
  const { appId: routeAppId = '' } = useParams();
  const appId = appIdOverride || routeAppId;
  const location = useLocation();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [appDetail, setAppDetail] = useState<PlatformAppItem | null>(null);
  const [sdkManifest, setSdkManifest] = useState<OpgSdkManifest | null>(null);
  const [sdkManifestLoading, setSdkManifestLoading] = useState(false);
  const [sdkSmokeResult, setSdkSmokeResult] = useState<OpgSdkSmokeResult | null>(null);
  const [sdkSmokeLoading, setSdkSmokeLoading] = useState(false);
  const [developerApiKeys, setDeveloperApiKeys] = useState<AppApiKeyItem[]>([]);
  const [developerApiKeysLoading, setDeveloperApiKeysLoading] = useState(false);
  const [newDeveloperApiKey, setNewDeveloperApiKey] = useState('');
  const [newDeveloperApiKeyName, setNewDeveloperApiKeyName] = useState('Codex SDK Key');
  const [developerApiKeySaving, setDeveloperApiKeySaving] = useState(false);
  const [wechatOpenApps, setWechatOpenApps] = useState<PlatformWechatOpenAppItem[]>([]);
  const [wechatOpenAppsError, setWechatOpenAppsError] = useState('');
  const [wechatOpenAppRefIdInput, setWechatOpenAppRefIdInput] = useState('');
  const [wechatRedirectUriInput, setWechatRedirectUriInput] = useState('');
  const [googleOAuthClients, setGoogleOAuthClients] = useState<PlatformGoogleOAuthClientItem[]>([]);
  const [googleOAuthClientsError, setGoogleOAuthClientsError] = useState('');
  const [googleOAuthClientRefIdInput, setGoogleOAuthClientRefIdInput] = useState('');
  const [githubOAuthApps, setGithubOAuthApps] = useState<PlatformGitHubOAuthAppItem[]>([]);
  const [githubOAuthAppsError, setGithubOAuthAppsError] = useState('');
  const [githubOAuthAppRefIdInput, setGithubOAuthAppRefIdInput] = useState('');
  const [appleLoginCredentials, setAppleLoginCredentials] = useState<PlatformAppleLoginCredentialItem[]>([]);
  const [appleLoginCredentialsError, setAppleLoginCredentialsError] = useState('');
  const [appleLoginCredentialRefIdInput, setAppleLoginCredentialRefIdInput] = useState('');
  const [iosAppAttestModeInput, setIosAppAttestModeInput] = useState('ENFORCE_SENSITIVE');
  const [appleAppAppleIdInput, setAppleAppAppleIdInput] = useState('');
  const [oauthRedirectHostsInput, setOauthRedirectHostsInput] = useState('');
  const [slugAliasesInput, setSlugAliasesInput] = useState('');
  const [slugAliasesSaving, setSlugAliasesSaving] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PlatformPaymentMethodItem[]>([]);
  const [paymentMethodsError, setPaymentMethodsError] = useState('');
  const [paymentMethodRefIdsInput, setPaymentMethodRefIdsInput] = useState<string[]>([]);
  const [smsTemplates, setSmsTemplates] = useState<PlatformSmsTemplateItem[]>([]);
  const [smsTemplatesError, setSmsTemplatesError] = useState('');
  const [smsTemplateRefIdInput, setSmsTemplateRefIdInput] = useState('');
  const [wechatSettingsSaving, setWechatSettingsSaving] = useState(false);
  const [smsTestPhoneInput, setSmsTestPhoneInput] = useState('');
  const [smsTestCodeInput, setSmsTestCodeInput] = useState('');
  const [smsTestSending, setSmsTestSending] = useState(false);
  const [smsTestResult, setSmsTestResult] = useState<PlatformAppSmsTestResult | null>(null);
  const [stats, setStats] = useState<PlatformTenantStats | null>(null);
  const [admins, setAdmins] = useState<PlatformTenantAdminItem[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<PlatformPermissionCatalogItem[]>([]);
  const [adminAccess, setAdminAccess] = useState<PlatformMyAppAdminPermissions | null>(null);
  const [createForm, setCreateForm] = useState<AdminCreateForm>(EMPTY_ADMIN_FORM);
  const [createSaving, setCreateSaving] = useState(false);
  const [passwordForm, setPasswordForm] = useState<PasswordForm>({
    admin_user_id: '',
    new_password: '',
    invalidate_sessions: true,
  });
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [permissionEditorAdminId, setPermissionEditorAdminId] = useState('');
  const [permissionKeys, setPermissionKeys] = useState<string[]>([]);
  const [permissionSaving, setPermissionSaving] = useState(false);

  const [aiSources, setAiSources] = useState<PlatformAiSourceItem[]>([]);
  const [modelRoutes, setModelRoutes] = useState<PlatformAppAiModelRouteItem[]>([]);
  const [defaultModelSlots, setDefaultModelSlots] = useState<PlatformAppAiDefaultModelSlotItem[]>([]);
  const [defaultModelSlotDrafts, setDefaultModelSlotDrafts] = useState<DefaultModelSlotDrafts>(() =>
    createEmptyDefaultModelSlotDrafts(),
  );
  const [defaultModelSlotSaving, setDefaultModelSlotSaving] = useState('');
  const [aiPointsSettings, setAiPointsSettings] = useState<PlatformAppAiPointsSettings | null>(null);
  const [initialPointsInput, setInitialPointsInput] = useState('200');
  const [pointsPerYuanInput, setPointsPerYuanInput] = useState('100');
  const [pointsSettingsSaving, setPointsSettingsSaving] = useState(false);
  const [videoProxyEnabled, setVideoProxyEnabled] = useState(false);
  const [videoProxyRetentionDaysInput, setVideoProxyRetentionDaysInput] = useState('7');
  const [videoProxyMaxFileMbInput, setVideoProxyMaxFileMbInput] = useState('1024');
  const [videoProxySaving, setVideoProxySaving] = useState(false);
  const [manualGrantIdentityType, setManualGrantIdentityType] = useState<ManualGrantIdentityType>('email');
  const [manualGrantIdentityInput, setManualGrantIdentityInput] = useState('');
  const [manualGrantAmountInput, setManualGrantAmountInput] = useState('100');
  const [manualGrantReasonInput, setManualGrantReasonInput] = useState('');
  const [manualGrantSubmitting, setManualGrantSubmitting] = useState(false);
  const [siteSettings, setSiteSettings] = useState<PlatformTenantSiteSettings>({});
  const [siteMessages, setSiteMessages] = useState<PlatformTenantSiteMessageItem[]>([]);
  const [siteMessagesTotal, setSiteMessagesTotal] = useState(0);
  const [siteMessagesSummary, setSiteMessagesSummary] = useState<PlatformTenantSiteMessageSummary | null>(null);
  const [siteMessagesPage, setSiteMessagesPage] = useState(1);
  const [siteMessageTypeFilter, setSiteMessageTypeFilter] = useState('');
  const [siteMessageStatusFilter, setSiteMessageStatusFilter] = useState('new');
  const [siteMessageCategoryFilter, setSiteMessageCategoryFilter] = useState('');
  const [siteMessageSearchInput, setSiteMessageSearchInput] = useState('');
  const [siteCookieConsents, setSiteCookieConsents] = useState<PlatformTenantSiteCookieConsentItem[]>([]);
  const [siteCookieConsentSummary, setSiteCookieConsentSummary] = useState<PlatformTenantSiteCookieConsentSummary | null>(null);
  const [siteCookieConsentPage, setSiteCookieConsentPage] = useState(1);
  const [siteCookieConsentRegionFilter, setSiteCookieConsentRegionFilter] = useState('');
  const [siteCookieConsentsLoading, setSiteCookieConsentsLoading] = useState(false);
  const [siteSettingsSaving, setSiteSettingsSaving] = useState(false);
  const [sitePackageUploading, setSitePackageUploading] = useState<'macos' | 'windows' | ''>('');
  const [siteMessagesLoading, setSiteMessagesLoading] = useState(false);
  const [siteMessageActingId, setSiteMessageActingId] = useState('');
  const [emailSettings, setEmailSettings] = useState<PlatformAppEmailSettings>({});
  const [emailSenders, setEmailSenders] = useState<PlatformEmailSenderItem[]>([]);
  const [emailContacts, setEmailContacts] = useState<PlatformEmailContactItem[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<PlatformEmailTemplateItem[]>([]);
  const [emailCampaigns, setEmailCampaigns] = useState<PlatformEmailCampaignItem[]>([]);
  const [emailContactsText, setEmailContactsText] = useState('');
  const [emailTemplateForm, setEmailTemplateForm] = useState({ name: '', subject: '', html: '', text: '' });
  const [emailCampaignForm, setEmailCampaignForm] = useState({ name: '', sender_id: '', template_id: '', subject: '', html: '', text: '' });
  const [emailTestTo, setEmailTestTo] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailSaving, setEmailSaving] = useState(false);
  const [feedbackItems, setFeedbackItems] = useState<PlatformAppFeedbackItem[]>([]);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const [feedbackSummary, setFeedbackSummary] = useState<Record<string, number>>({});
  const [feedbackPage, setFeedbackPage] = useState(1);
  const [feedbackStatusFilter, setFeedbackStatusFilter] = useState('pending');
  const [feedbackPriorityFilter, setFeedbackPriorityFilter] = useState('');
  const [feedbackQuery, setFeedbackQuery] = useState('');
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackActingId, setFeedbackActingId] = useState('');
  const [selectedFeedbackId, setSelectedFeedbackId] = useState('');
  const [selectedFeedback, setSelectedFeedback] = useState<PlatformAppFeedbackItem | null>(null);
  const [feedbackComments, setFeedbackComments] = useState<PlatformAppFeedbackComment[]>([]);
  const [feedbackDetailLoading, setFeedbackDetailLoading] = useState(false);
  const [feedbackNote, setFeedbackNote] = useState('');
  const [feedbackCommentBody, setFeedbackCommentBody] = useState('');
  const [feedbackCommentInternal, setFeedbackCommentInternal] = useState(false);
  const [acquisitionOptions, setAcquisitionOptions] = useState<PlatformAcquisitionSourceOption[]>([]);
  const [acquisitionSummary, setAcquisitionSummary] = useState<PlatformAcquisitionSummary | null>(null);
  const [acquisitionUsers, setAcquisitionUsers] = useState<PlatformAcquisitionUserSource[]>([]);
  const [acquisitionUsersTotal, setAcquisitionUsersTotal] = useState(0);
  const [acquisitionLoading, setAcquisitionLoading] = useState(false);
  const [acquisitionSaving, setAcquisitionSaving] = useState(false);
  const [acquisitionEditingId, setAcquisitionEditingId] = useState('');
  const [acquisitionOptionForm, setAcquisitionOptionForm] = useState<AcquisitionOptionForm>(EMPTY_ACQUISITION_OPTION_FORM);
  const [acquisitionSourceFilter, setAcquisitionSourceFilter] = useState('');
  const [acquisitionQuery, setAcquisitionQuery] = useState('');
  const [acquisitionPage, setAcquisitionPage] = useState(1);

  const [redeemPackages, setRedeemPackages] = useState<PlatformRedeemPackageItem[]>([]);
  const [paymentOrders, setPaymentOrders] = useState<PlatformPaymentOrderItem[]>([]);
  const [paymentOrdersTotal, setPaymentOrdersTotal] = useState(0);
  const [paymentOrdersPage, setPaymentOrdersPage] = useState(1);
  const [paymentOrdersStatusFilter, setPaymentOrdersStatusFilter] = useState('');
  const [paymentOrdersLoading, setPaymentOrdersLoading] = useState(false);
  const [paymentOrderRefundingId, setPaymentOrderRefundingId] = useState('');
  const [redeemCodes, setRedeemCodes] = useState<PlatformRedeemCodeItem[]>([]);
  const [redeemRedemptions, setRedeemRedemptions] = useState<PlatformRedeemCodeRedemptionItem[]>([]);
  const [redeemBatches, setRedeemBatches] = useState<PlatformRedeemCodeBatchItem[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [redeemPage, setRedeemPage] = useState(1);
  const [redeemTotal, setRedeemTotal] = useState(0);
  const [redeemRedemptionPage, setRedeemRedemptionPage] = useState(1);
  const [redeemRedemptionTotal, setRedeemRedemptionTotal] = useState(0);
  const [redeemRedemptionRevokingId, setRedeemRedemptionRevokingId] = useState('');
  const [redeemVoidCodeInput, setRedeemVoidCodeInput] = useState('');
  const [redeemVoidSaving, setRedeemVoidSaving] = useState(false);
  const [packageForm, setPackageForm] = useState<RedeemPackageForm>(EMPTY_REDEEM_PACKAGE_FORM);
  const [packageSaving, setPackageSaving] = useState(false);
  const [packageCoverUploading, setPackageCoverUploading] = useState(false);
  const [batchForm, setBatchForm] = useState<RedeemBatchForm>(EMPTY_REDEEM_BATCH_FORM);
  const [batchSaving, setBatchSaving] = useState(false);
  const [lastGeneratedCodes, setLastGeneratedCodes] = useState<string[]>([]);
  const [paymentTestingKey, setPaymentTestingKey] = useState('');

  const workspaceBasePath = useMemo(
    () => (runtimeContext.isPlatformPortal ? `/platform-admin/apps/${appId}` : resolveBusinessWorkspaceBasePath()),
    [appId],
  );
  const activeSection = useMemo(() => resolveSection(location.pathname, appId), [location.pathname, appId]);
  const redeemSubPage = useMemo(() => resolveRedeemSubPage(location.pathname, appId), [location.pathname, appId]);
  const redeemCodeBaseUrl = useMemo(() => resolveRedeemCodeBaseUrl(appDetail), [appDetail]);

  const selectedAdmin = useMemo(
    () => admins.find((item) => item.id === permissionEditorAdminId) || null,
    [admins, permissionEditorAdminId],
  );
  const isAppSuperAdmin = Boolean(adminAccess?.is_super_admin);
  const canManagePlatformAppSettings = runtimeContext.isPlatformPortal && isAppSuperAdmin;
  const hasAppPermission = (key: string) => isAppSuperAdmin || Boolean(adminAccess?.page_permissions?.includes(key));
  const canUseRedeemRead = hasAppPermission('app_redeem_read') || hasAppPermission('app_redeem_products_manage');
  const visibleWorkspaceNav = useMemo(() => {
    if (!adminAccess) return WORKSPACE_NAV.filter((item) => item.key === 'overview');
    return WORKSPACE_NAV.filter((item) => {
      if (item.key === 'overview') return true;
      if (item.key === 'analytics') return hasAppPermission('app_analytics_read');
      if (item.key === 'ai-usage') return hasAppPermission('app_ai_usage_read');
      if (item.key === 'api-docs') return hasAppPermission('app_api_docs_read');
      if (item.key === 'developers') return hasAppPermission('app_api_docs_read');
      if (item.key === 'admins') return isAppSuperAdmin;
      if (item.key === 'ai-routing') return canManagePlatformAppSettings;
      if (item.key === 'site') return hasAppPermission('app_site_manage');
      if (item.key === 'email') return hasAppPermission('app_email_manage');
      if (item.key === 'feedback') return hasAppPermission('app_feedback_manage');
      if (item.key === 'acquisition') return hasAppPermission('app_acquisition_manage');
      if (item.key === 'redeem') return hasAppPermission('app_redeem_read') || hasAppPermission('app_redeem_products_manage');
      return false;
    });
  }, [adminAccess, isAppSuperAdmin, canManagePlatformAppSettings]);

  const defaultModelSlotByKey = useMemo(() => {
    const map = new Map<PlatformAppAiDefaultModelSlotKey, PlatformAppAiDefaultModelSlotItem>();
    defaultModelSlots.forEach((item) => map.set(item.slot_key, item));
    return map;
  }, [defaultModelSlots]);

  const savedWechatOpenAppRefId = useMemo(
    () => String(appDetail?.settings?.wechat_open_app_ref_id || '').trim(),
    [appDetail?.settings?.wechat_open_app_ref_id],
  );

  const savedWechatOpenApp = useMemo(
    () => wechatOpenApps.find((item) => item.id === savedWechatOpenAppRefId) || null,
    [wechatOpenApps, savedWechatOpenAppRefId],
  );

  const savedWechatRedirectHost = useMemo(
    () => extractWechatRedirectHost(appDetail?.settings?.wechat_redirect_uri),
    [appDetail?.settings?.wechat_redirect_uri],
  );

  const selectedWechatOpenApp = useMemo(
    () => wechatOpenApps.find((item) => item.id === wechatOpenAppRefIdInput) || null,
    [wechatOpenApps, wechatOpenAppRefIdInput],
  );

  const savedGoogleOAuthClientRefId = useMemo(
    () => String(appDetail?.settings?.google_oauth_client_ref_id || '').trim(),
    [appDetail?.settings?.google_oauth_client_ref_id],
  );

  const savedGoogleOAuthClient = useMemo(
    () => googleOAuthClients.find((item) => item.id === savedGoogleOAuthClientRefId) || null,
    [googleOAuthClients, savedGoogleOAuthClientRefId],
  );

  const selectedGoogleOAuthClient = useMemo(
    () => googleOAuthClients.find((item) => item.id === googleOAuthClientRefIdInput) || null,
    [googleOAuthClients, googleOAuthClientRefIdInput],
  );

  const savedGitHubOAuthAppRefId = useMemo(
    () => String(appDetail?.settings?.github_oauth_app_ref_id || '').trim(),
    [appDetail?.settings?.github_oauth_app_ref_id],
  );

  const savedGitHubOAuthApp = useMemo(
    () => githubOAuthApps.find((item) => item.id === savedGitHubOAuthAppRefId) || null,
    [githubOAuthApps, savedGitHubOAuthAppRefId],
  );

  const selectedGitHubOAuthApp = useMemo(
    () => githubOAuthApps.find((item) => item.id === githubOAuthAppRefIdInput) || null,
    [githubOAuthApps, githubOAuthAppRefIdInput],
  );

  const savedAppleLoginCredentialRefId = useMemo(
    () => String(appDetail?.settings?.apple_login_credential_ref_id || '').trim(),
    [appDetail?.settings?.apple_login_credential_ref_id],
  );

  const selectedAppleLoginCredential = useMemo(
    () => appleLoginCredentials.find((item) => item.id === appleLoginCredentialRefIdInput) || null,
    [appleLoginCredentials, appleLoginCredentialRefIdInput],
  );

  const savedAppleLoginCredential = useMemo(
    () => appleLoginCredentials.find((item) => item.id === savedAppleLoginCredentialRefId) || null,
    [appleLoginCredentials, savedAppleLoginCredentialRefId],
  );

  const savedPaymentMethodRefIds = useMemo(
    () => (Array.isArray(appDetail?.settings?.payment_method_ref_ids) ? appDetail.settings.payment_method_ref_ids : []),
    [appDetail?.settings?.payment_method_ref_ids],
  );

  const savedPaymentMethods = useMemo(
    () => paymentMethods.filter((item) => savedPaymentMethodRefIds.includes(item.id)),
    [paymentMethods, savedPaymentMethodRefIds],
  );

  const selectedPaymentMethods = useMemo(
    () => paymentMethods.filter((item) => paymentMethodRefIdsInput.includes(item.id)),
    [paymentMethods, paymentMethodRefIdsInput],
  );

  const savedSmsTemplateRefId = useMemo(
    () => String(appDetail?.settings?.sms_template_ref_id || '').trim(),
    [appDetail?.settings?.sms_template_ref_id],
  );

  const savedSmsTemplate = useMemo(
    () => smsTemplates.find((item) => item.id === savedSmsTemplateRefId) || null,
    [smsTemplates, savedSmsTemplateRefId],
  );

  const selectedSmsTemplate = useMemo(
    () => smsTemplates.find((item) => item.id === smsTemplateRefIdInput) || null,
    [smsTemplates, smsTemplateRefIdInput],
  );

  const selectedSmsTemplateVariables = useMemo(
    () => pickTemplateVariablesExample(selectedSmsTemplate?.meta),
    [selectedSmsTemplate],
  );

  const savedSmsTemplateVariables = useMemo(
    () => pickTemplateVariablesExample(savedSmsTemplate?.meta),
    [savedSmsTemplate],
  );

  const goSection = (section: WorkspaceSection) => {
    if (!appId) return;
    if (section === 'redeem') {
      navigate(`${workspaceBasePath}/redeem/products`);
      return;
    }
    navigate(`${workspaceBasePath}/${section}`);
  };

  const goRedeemSubPage = (section: RedeemSubPage) => {
    if (!appId) return;
    navigate(`${workspaceBasePath}/redeem/${section}`);
  };

  const resolveDeveloperAppSlug = () => String(appDetail?.slug || runtimeContext.appSlug || '').trim();

  const loadDeveloperData = async () => {
    const appSlug = resolveDeveloperAppSlug();
    if (!appSlug) return;
    setSdkManifestLoading(true);
    setDeveloperApiKeysLoading(true);
    try {
      const manifest = await platformApi.getDeveloperSdkManifest(appSlug);
      setSdkManifest(manifest);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 SDK manifest 失败') });
    } finally {
      setSdkManifestLoading(false);
    }

    try {
      const keys = await platformApi.listMyAppApiKeys(appSlug);
      setDeveloperApiKeys(keys.items || []);
    } catch {
      setDeveloperApiKeys([]);
    } finally {
      setDeveloperApiKeysLoading(false);
    }
  };

  const runDeveloperSmokeTest = async () => {
    const appSlug = resolveDeveloperAppSlug();
    if (!appSlug) return;
    setSdkSmokeLoading(true);
    setMessage(null);
    try {
      const result = await platformApi.runDeveloperSdkSmokeTest(appSlug);
      setSdkSmokeResult(result);
      setMessage({ type: result.ok ? 'success' : 'error', text: result.ok ? 'SDK 接入检查通过' : 'SDK 接入检查未通过' });
    } catch (error: any) {
      setSdkSmokeResult(null);
      setMessage({ type: 'error', text: pickApiErrorMessage(error, 'SDK 接入检查失败') });
    } finally {
      setSdkSmokeLoading(false);
    }
  };

  const createDeveloperApiKey = async () => {
    const appSlug = resolveDeveloperAppSlug();
    if (!appSlug) return;
    setDeveloperApiKeySaving(true);
    setMessage(null);
    try {
      const result = await platformApi.createMyAppApiKey(appSlug, newDeveloperApiKeyName.trim() || 'Codex SDK Key');
      setNewDeveloperApiKey(result.key || '');
      setMessage({ type: 'success', text: result.key ? 'API Key 已创建' : 'API Key 已存在' });
      const keys = await platformApi.listMyAppApiKeys(appSlug);
      setDeveloperApiKeys(keys.items || []);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '创建 API Key 失败') });
    } finally {
      setDeveloperApiKeySaving(false);
    }
  };

  const revokeDeveloperApiKey = async (keyId: string) => {
    const appSlug = resolveDeveloperAppSlug();
    if (!appSlug || !keyId) return;
    if (!window.confirm('确认撤销这个 API Key 吗？')) return;
    setDeveloperApiKeySaving(true);
    setMessage(null);
    try {
      await platformApi.revokeMyAppApiKey(appSlug, keyId);
      const keys = await platformApi.listMyAppApiKeys(appSlug);
      setDeveloperApiKeys(keys.items || []);
      setMessage({ type: 'success', text: 'API Key 已撤销' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '撤销 API Key 失败') });
    } finally {
      setDeveloperApiKeySaving(false);
    }
  };

  const copyDeveloperText = async (value: string, label: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setMessage({ type: 'success', text: `${label}已复制` });
    } catch {
      setMessage({ type: 'error', text: '复制失败' });
    }
  };

  const loadRedeemData = async () => {
    if (!appId) return;
    setPaymentOrdersLoading(true);
    try {
      const [packagesResp, batchesResp, codesResp, redemptionsResp] = await Promise.all([
        platformApi.listRedeemPackages(appId),
        platformApi.listRedeemCodeBatches(appId, 1, 50),
        platformApi.listRedeemCodes(appId, redeemPage, 20, selectedBatchId || undefined),
        platformApi.listRedeemCodeRedemptions(appId, redeemRedemptionPage, 20, selectedBatchId || undefined),
      ]);

      const packagesPayload = pickApiData<{ items: PlatformRedeemPackageItem[] }>(packagesResp);
      setRedeemPackages(packagesPayload?.items || []);

      const batchesPayload = pickApiData<{ items: PlatformRedeemCodeBatchItem[] }>(batchesResp);
      setRedeemBatches(batchesPayload?.items || []);

      const codesPayload = pickApiData<{ total: number; items: PlatformRedeemCodeItem[] }>(codesResp);
      setRedeemCodes(codesPayload?.items || []);
      setRedeemTotal(codesPayload?.total || 0);

      const redemptionsPayload = pickApiData<{ total: number; items: PlatformRedeemCodeRedemptionItem[] }>(redemptionsResp);
      setRedeemRedemptions(redemptionsPayload?.items || []);
      setRedeemRedemptionTotal(redemptionsPayload?.total || 0);

      try {
        const ordersResp = await platformApi.listAppPaymentOrders(appId, {
          page: paymentOrdersPage,
          page_size: 20,
          status: paymentOrdersStatusFilter || undefined,
        });
        const ordersPayload = pickApiData<{ total: number; items: PlatformPaymentOrderItem[] }>(ordersResp);
        setPaymentOrders(ordersPayload?.items || []);
        setPaymentOrdersTotal(Number(ordersPayload?.total || 0));
      } catch (ordersError: any) {
        setPaymentOrders([]);
        setPaymentOrdersTotal(0);
        setMessage({ type: 'error', text: pickApiErrorMessage(ordersError, '订单列表暂时不可用，请稍后重试') });
      }
    } finally {
      setPaymentOrdersLoading(false);
    }
  };

  const loadFeedbackData = async () => {
    if (!appId) return;
    setFeedbackLoading(true);
    try {
      const feedbackResp = await platformApi.listAppFeedbacks(appId, {
        page: feedbackPage,
        page_size: 20,
        status: feedbackStatusFilter || undefined,
        priority: feedbackPriorityFilter || undefined,
        q: feedbackQuery.trim() || undefined,
      });
      const payload = pickApiData<{
        total: number;
        page: number;
        page_size: number;
        summary?: Record<string, number>;
        items: PlatformAppFeedbackItem[];
      }>(feedbackResp);
      setFeedbackItems(payload?.items || []);
      setFeedbackTotal(Number(payload?.total || 0));
      setFeedbackSummary(payload?.summary || {});
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载用户反馈失败') });
    } finally {
      setFeedbackLoading(false);
    }
  };

  const loadAcquisitionData = async () => {
    if (!appId) return;
    setAcquisitionLoading(true);
    try {
      const [optionsResp, summaryResp, usersResp] = await Promise.all([
        platformApi.listAcquisitionSourceOptions(appId),
        platformApi.getAcquisitionSummary(appId),
        platformApi.listAcquisitionUserSources(appId, {
          page: acquisitionPage,
          page_size: 20,
          source_key: acquisitionSourceFilter || undefined,
          q: acquisitionQuery.trim() || undefined,
        }),
      ]);
      const optionsPayload = pickApiData<{ items: PlatformAcquisitionSourceOption[] }>(optionsResp) || optionsResp;
      setAcquisitionOptions(optionsPayload?.items || []);
      setAcquisitionSummary((pickApiData<PlatformAcquisitionSummary>(summaryResp) || summaryResp) as PlatformAcquisitionSummary);
      const usersPayload = pickApiData<{
        total: number;
        page: number;
        page_size: number;
        items: PlatformAcquisitionUserSource[];
      }>(usersResp) || usersResp;
      setAcquisitionUsers(usersPayload?.items || []);
      setAcquisitionUsersTotal(Number(usersPayload?.total || 0));
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载用户来源失败') });
    } finally {
      setAcquisitionLoading(false);
    }
  };

  const loadSiteMessages = async () => {
    if (!appId) return;
    setSiteMessagesLoading(true);
    try {
      const response = await platformApi.listAppSiteMessages(appId, {
        page: siteMessagesPage,
        page_size: 20,
        type: siteMessageTypeFilter || undefined,
        status: siteMessageStatusFilter || undefined,
        category: siteMessageCategoryFilter || undefined,
        q: siteMessageSearchInput.trim() || undefined,
      });
      const payload = pickApiData<{
        total: number;
        summary?: PlatformTenantSiteMessageSummary;
        items: PlatformTenantSiteMessageItem[];
      }>(response) || response;
      setSiteMessages(payload?.items || []);
      setSiteMessagesTotal(Number(payload?.total || 0));
      setSiteMessagesSummary(payload?.summary || null);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载官网消息失败') });
    } finally {
      setSiteMessagesLoading(false);
    }
  };

  const loadSiteCookieConsents = async () => {
    if (!appId) return;
    setSiteCookieConsentsLoading(true);
    try {
      const response = await platformApi.listAppSiteCookieConsents(appId, {
        page: siteCookieConsentPage,
        page_size: 20,
        region_mode: siteCookieConsentRegionFilter || undefined,
      });
      const payload = pickApiData<{
        total: number;
        summary: PlatformTenantSiteCookieConsentSummary;
        items: PlatformTenantSiteCookieConsentItem[];
      }>(response) || response;
      setSiteCookieConsents(payload?.items || []);
      setSiteCookieConsentSummary(payload?.summary || null);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 Cookie 偏好失败') });
    } finally {
      setSiteCookieConsentsLoading(false);
    }
  };

  const loadEmailData = async () => {
    if (!appId) return;
    setEmailLoading(true);
    try {
      const [settingsResp, contactsResp, templatesResp, campaignsResp] = await Promise.all([
        platformApi.getAppEmailSettings(appId),
        platformApi.listAppEmailContacts(appId, { page: 1, page_size: 20 }),
        platformApi.listAppEmailTemplates(appId),
        platformApi.listAppEmailCampaigns(appId, { page: 1, page_size: 20 }),
      ]);
      setEmailSettings(settingsResp.settings || {});
      setEmailSenders(settingsResp.senders || []);
      setEmailContacts(contactsResp.items || []);
      setEmailTemplates(templatesResp.items || []);
      setEmailCampaigns(campaignsResp.items || []);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载邮件数据失败') });
    } finally {
      setEmailLoading(false);
    }
  };

  const loadData = async () => {
    if (!appId) return;
    setLoading(true);
    setMessage(null);
    try {
      const [accessResp, detailResp, statsResp] = await Promise.all([
        platformApi.getMyAppAdminPermissions(appId),
        platformApi.getAppDetail(appId),
        platformApi.getAppStats(appId),
      ]);
      const access = pickApiData<PlatformMyAppAdminPermissions>(accessResp) || accessResp;
      const accessPermissions = access?.page_permissions || [];
      const accessIsSuper = Boolean(access?.is_super_admin);
      const canUseGlobalPlatformSettings = runtimeContext.isPlatformPortal && accessIsSuper;
      const accessHasPermission = (key: string) => accessIsSuper || accessPermissions.includes(key);
      setAdminAccess(access);
      setPermissionCatalog(access?.permission_catalog || []);

      const detail = pickApiData<PlatformAppItem>(detailResp) || null;
      setAppDetail(detail);
      setWechatOpenAppRefIdInput(String(detail?.settings?.wechat_open_app_ref_id || '').trim());
      setWechatRedirectUriInput(extractWechatRedirectHost(detail?.settings?.wechat_redirect_uri));
      setGoogleOAuthClientRefIdInput(String(detail?.settings?.google_oauth_client_ref_id || '').trim());
      setGithubOAuthAppRefIdInput(String(detail?.settings?.github_oauth_app_ref_id || '').trim());
      setAppleLoginCredentialRefIdInput(String(detail?.settings?.apple_login_credential_ref_id || '').trim());
      setIosAppAttestModeInput(String(detail?.settings?.ios_app_attest_mode || 'ENFORCE_SENSITIVE').trim() || 'ENFORCE_SENSITIVE');
      setAppleAppAppleIdInput(String(detail?.settings?.apple_app_apple_id || '').trim());
      setSlugAliasesInput((detail?.slug_aliases || []).join('\n'));
      const oauthHosts = (detail?.settings?.extra_json as any)?.oauth_redirect_hosts;
      setOauthRedirectHostsInput(Array.isArray(oauthHosts) ? oauthHosts.join('\n') : String(oauthHosts || ''));
      const videoProxy = asPlainRecord(asPlainRecord(asPlainRecord(detail?.settings?.extra_json).ai).video_download_proxy);
      setVideoProxyEnabled(videoProxy.enabled === true);
      setVideoProxyRetentionDaysInput(String(videoProxy.retention_days || 7));
      setVideoProxyMaxFileMbInput(String(videoProxy.max_file_mb || 1024));
      setPaymentMethodRefIdsInput(Array.isArray(detail?.settings?.payment_method_ref_ids) ? detail.settings.payment_method_ref_ids : []);
      setSmsTemplateRefIdInput(String(detail?.settings?.sms_template_ref_id || '').trim());
      setStats(pickApiData<PlatformTenantStats>(statsResp));

      if (accessHasPermission('app_site_manage')) {
        const siteSettingsResp = await platformApi.getAppSiteSettings(appId);
        const sitePayload = pickApiData<{ settings: PlatformTenantSiteSettings }>(siteSettingsResp) || siteSettingsResp;
        setSiteSettings(sitePayload?.settings || {});
      } else {
        setSiteSettings({});
      }

      let adminItems: PlatformTenantAdminItem[] = [];
      if (accessIsSuper) {
        const adminsResp = await platformApi.listAppAdmins(appId);
        const adminsPayload = pickApiData<{
          items: PlatformTenantAdminItem[];
          permission_catalog?: PlatformPermissionCatalogItem[];
        }>(adminsResp);
        adminItems = adminsPayload?.items || [];
        setAdmins(adminItems);
        setPermissionCatalog(adminsPayload?.permission_catalog || access?.permission_catalog || []);
      } else {
        setAdmins([]);
      }

      if (canUseGlobalPlatformSettings) {
        const [aiSourcesResp, modelRoutesResp, defaultModelSlotsResp] = await Promise.all([
          platformApi.listGlobalAiSources(),
          platformApi.listAppAiModelRoutes(appId),
          platformApi.listAppAiDefaultModelSlots(appId),
        ]);

        const sourcePayload = pickApiData<{ items: PlatformAiSourceItem[] }>(aiSourcesResp);
        setAiSources(sourcePayload?.items || []);

        const routePayload = pickApiData<{ items: PlatformAppAiModelRouteItem[] }>(modelRoutesResp);
        setModelRoutes(routePayload?.items || []);

        const defaultModelSlotsPayload = pickApiData<{ items: PlatformAppAiDefaultModelSlotItem[] }>(defaultModelSlotsResp);
        const slotItems = defaultModelSlotsPayload?.items || [];
        setDefaultModelSlots(slotItems);
        setDefaultModelSlotDrafts(
          DEFAULT_MODEL_SLOT_META.reduce((acc, item) => {
            const slot = slotItems.find((slotItem) => slotItem.slot_key === item.key);
            acc[item.key] = {
              primary_model_id: slot?.primary_model?.model_id || '',
              fallback_model_id: slot?.fallback_model?.model_id || '',
            };
            return acc;
          }, {} as DefaultModelSlotDrafts),
        );
      } else {
        setAiSources([]);
        setModelRoutes([]);
        setDefaultModelSlots([]);
      }

      if (accessIsSuper) {
        const pointsSettingsResp = await platformApi.getAppAiPointsSettings(appId);
        const pointsSettings = pickApiData<PlatformAppAiPointsSettings>(pointsSettingsResp) || null;
        setAiPointsSettings(pointsSettings);
        setInitialPointsInput(String(pointsSettings?.initial_points ?? 200));
        setPointsPerYuanInput(String(pointsSettings?.points_per_yuan ?? 100));
      } else {
        setAiPointsSettings(null);
      }

      if (canUseGlobalPlatformSettings) {
        try {
          const wechatAppsResp = await platformApi.listGlobalWechatOpenApps();
          const wechatAppsPayload = pickApiData<{ items: PlatformWechatOpenAppItem[] }>(wechatAppsResp);
          setWechatOpenApps(wechatAppsPayload?.items || []);
          setWechatOpenAppsError('');
        } catch (wechatError: any) {
          setWechatOpenApps([]);
          setWechatOpenAppsError(pickApiErrorMessage(wechatError, '当前账号无权限读取微信登录应用池'));
        }

        try {
          const googleClientsResp = await platformApi.listGlobalGoogleOAuthClients();
          const googleClientsPayload = pickApiData<{ items: PlatformGoogleOAuthClientItem[] }>(googleClientsResp);
          setGoogleOAuthClients(googleClientsPayload?.items || []);
          setGoogleOAuthClientsError('');
        } catch (googleError: any) {
          setGoogleOAuthClients([]);
          setGoogleOAuthClientsError(pickApiErrorMessage(googleError, '当前账号无权限读取 Google 登录应用池'));
        }

        try {
          const githubAppsResp = await platformApi.listGlobalGitHubOAuthApps();
          const githubAppsPayload = pickApiData<{ items: PlatformGitHubOAuthAppItem[] }>(githubAppsResp);
          setGithubOAuthApps(githubAppsPayload?.items || []);
          setGithubOAuthAppsError('');
        } catch (githubError: any) {
          setGithubOAuthApps([]);
          setGithubOAuthAppsError(pickApiErrorMessage(githubError, '当前账号无权限读取 GitHub 登录应用池'));
        }

        try {
          const appleResp = await platformApi.listGlobalAppleLoginCredentials();
          const applePayload = pickApiData<{ items: PlatformAppleLoginCredentialItem[] }>(appleResp);
          setAppleLoginCredentials(applePayload?.items || []);
          setAppleLoginCredentialsError('');
        } catch (appleError: any) {
          setAppleLoginCredentials([]);
          setAppleLoginCredentialsError(pickApiErrorMessage(appleError, '当前账号无权限读取 Apple 登录凭证'));
        }

        try {
          const paymentMethodsResp = await platformApi.listGlobalPaymentMethods();
          const paymentMethodsPayload = pickApiData<{ items: PlatformPaymentMethodItem[] }>(paymentMethodsResp);
          setPaymentMethods(paymentMethodsPayload?.items || []);
          setPaymentMethodsError('');
        } catch (paymentError: any) {
          setPaymentMethods([]);
          setPaymentMethodsError(pickApiErrorMessage(paymentError, '当前账号无权限读取支付方式'));
        }

        try {
          const smsTemplatesResp = await platformApi.listGlobalSmsTemplates();
          const smsTemplatesPayload = pickApiData<{ items: PlatformSmsTemplateItem[] }>(smsTemplatesResp);
          setSmsTemplates(smsTemplatesPayload?.items || []);
          setSmsTemplatesError('');
        } catch (smsError: any) {
          setSmsTemplates([]);
          setSmsTemplatesError(pickApiErrorMessage(smsError, '当前账号无权限读取短信模板池'));
        }
      } else {
        setWechatOpenApps([]);
        setGoogleOAuthClients([]);
        setGithubOAuthApps([]);
        setAppleLoginCredentials([]);
        setPaymentMethods([]);
        setSmsTemplates([]);
        setWechatOpenAppsError('');
        setGoogleOAuthClientsError('');
        setGithubOAuthAppsError('');
        setAppleLoginCredentialsError('');
        setPaymentMethodsError('');
        setSmsTemplatesError('');
      }

      if (adminItems.length) {
        setPasswordForm((prev) => ({
          ...prev,
          admin_user_id: prev.admin_user_id || adminItems[0].id,
        }));
        const editable = adminItems.find((item) => item.admin_type === 'ADMIN');
        if (editable) {
          setPermissionEditorAdminId((prev) => prev || editable.id);
          setPermissionKeys(editable.page_permissions || []);
        }
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载租户工作区失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [appId]);

  useEffect(() => {
    if (!appId || activeSection !== 'feedback' || !hasAppPermission('app_feedback_manage')) return;
    loadFeedbackData().catch((error: any) => {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载用户反馈失败') });
    });
  }, [appId, activeSection, feedbackPage, feedbackStatusFilter, feedbackPriorityFilter, feedbackQuery, adminAccess]);

  useEffect(() => {
    if (!appId || activeSection !== 'acquisition' || !hasAppPermission('app_acquisition_manage')) return;
    loadAcquisitionData().catch((error: any) => {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载用户来源失败') });
    });
  }, [appId, activeSection, acquisitionPage, acquisitionSourceFilter, acquisitionQuery, adminAccess]);

  useEffect(() => {
    if (!appId || activeSection !== 'site' || !hasAppPermission('app_site_manage')) return;
    loadSiteMessages().catch((error: any) => {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载官网消息失败') });
    });
  }, [
    appId,
    activeSection,
    siteMessagesPage,
    siteMessageTypeFilter,
    siteMessageStatusFilter,
    siteMessageCategoryFilter,
    siteMessageSearchInput,
    adminAccess,
  ]);

  useEffect(() => {
    if (!appId || activeSection !== 'site' || !hasAppPermission('app_site_manage')) return;
    loadSiteCookieConsents().catch((error: any) => {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载 Cookie 偏好失败') });
    });
  }, [appId, activeSection, siteCookieConsentPage, siteCookieConsentRegionFilter, adminAccess]);

  useEffect(() => {
    if (!appId || activeSection !== 'email' || !hasAppPermission('app_email_manage')) return;
    loadEmailData().catch((error: any) => {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载邮件数据失败') });
    });
  }, [appId, activeSection, adminAccess]);

  useEffect(() => {
    if (!adminAccess) return;
    if (!visibleWorkspaceNav.some((item) => item.key === activeSection)) {
      navigate(`${workspaceBasePath}/overview`, { replace: true });
    }
  }, [adminAccess, activeSection, navigate, visibleWorkspaceNav, workspaceBasePath]);

  useEffect(() => {
    if (!appId || activeSection !== 'redeem' || !canUseRedeemRead) return;
    loadRedeemData().catch((error: any) => {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载产品与兑换数据失败') });
    });
  }, [appId, redeemPage, redeemRedemptionPage, selectedBatchId, paymentOrdersPage, paymentOrdersStatusFilter, activeSection, adminAccess]);

  useEffect(() => {
    if (!appId) return;
    const currentPath = location.pathname.replace(/\/+$/, '') || '/';
    const currentBasePath = workspaceBasePath.replace(/\/+$/, '') || '/';
    if (currentPath === `/platform-admin/apps/${appId}` || currentPath === currentBasePath || currentPath === '/admin') {
      navigate(`${workspaceBasePath}/overview`, { replace: true });
      return;
    }
    if (currentPath === `/platform-admin/apps/${appId}/redeem` || currentPath === `${currentBasePath}/redeem` || currentPath === '/admin/redeem') {
      navigate(`${workspaceBasePath}/redeem/products`, { replace: true });
      return;
    }
    if (currentPath === `/platform-admin/apps/${appId}/payments` || currentPath === `${currentBasePath}/payments`) {
      navigate(`${workspaceBasePath}/redeem/orders`, { replace: true });
      return;
    }
    if (currentPath === `/platform-admin/apps/${appId}/payments/orders` || currentPath === `${currentBasePath}/payments/orders`) {
      navigate(`${workspaceBasePath}/redeem/orders`, { replace: true });
    }
  }, [appId, location.pathname, navigate, workspaceBasePath]);

  useEffect(() => {
    if (!permissionEditorAdminId) return;
    const matched = admins.find((item) => item.id === permissionEditorAdminId);
    if (matched) {
      setPermissionKeys(matched.page_permissions || []);
    }
  }, [permissionEditorAdminId, admins]);

  useEffect(() => {
    if (activeSection !== 'developers' || !appDetail?.slug) return;
    void loadDeveloperData();
  }, [activeSection, appDetail?.slug]);

  const toggleCreatePermission = (key: string) => {
    setCreateForm((prev) => {
      const exists = prev.page_permissions.includes(key);
      return {
        ...prev,
        page_permissions: exists ? prev.page_permissions.filter((item) => item !== key) : [...prev.page_permissions, key],
      };
    });
  };

  const togglePermissionEditorKey = (key: string) => {
    setPermissionKeys((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
  };

  const togglePaymentMethodRef = (methodId: string) => {
    setPaymentMethodRefIdsInput((prev) =>
      prev.includes(methodId) ? prev.filter((item) => item !== methodId) : [...prev, methodId],
    );
  };

  const resetAcquisitionOptionForm = () => {
    setAcquisitionEditingId('');
    setAcquisitionOptionForm(EMPTY_ACQUISITION_OPTION_FORM);
  };

  const editAcquisitionOption = (item: PlatformAcquisitionSourceOption) => {
    setAcquisitionEditingId(item.id);
    setAcquisitionOptionForm({
      key: item.key,
      label: item.label,
      sort_order: String(item.sort_order || 0),
      allow_free_text: Boolean(item.allow_free_text),
      is_active: Boolean(item.is_active),
    });
  };

  const saveAcquisitionOption = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!appId) return;
    setAcquisitionSaving(true);
    setMessage(null);
    try {
      const payload = {
        key: acquisitionOptionForm.key.trim(),
        label: acquisitionOptionForm.label.trim(),
        sort_order: Number(acquisitionOptionForm.sort_order || 0),
        allow_free_text: acquisitionOptionForm.allow_free_text,
        is_active: acquisitionOptionForm.is_active,
      };
      if (acquisitionEditingId) {
        await platformApi.updateAcquisitionSourceOption(appId, acquisitionEditingId, payload);
        setMessage({ type: 'success', text: '来源选项已更新' });
      } else {
        await platformApi.createAcquisitionSourceOption(appId, payload);
        setMessage({ type: 'success', text: '来源选项已新增' });
      }
      resetAcquisitionOptionForm();
      await loadAcquisitionData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存来源选项失败') });
    } finally {
      setAcquisitionSaving(false);
    }
  };

  const removeAcquisitionOption = async (item: PlatformAcquisitionSourceOption) => {
    if (!appId) return;
    setAcquisitionSaving(true);
    setMessage(null);
    try {
      await platformApi.deleteAcquisitionSourceOption(appId, item.id);
      if (acquisitionEditingId === item.id) resetAcquisitionOptionForm();
      setMessage({ type: 'success', text: '来源选项已删除' });
      await loadAcquisitionData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除来源选项失败') });
    } finally {
      setAcquisitionSaving(false);
    }
  };

  const handleCreateAdmin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!appId) return;
    setCreateSaving(true);
    setMessage(null);
    try {
      await platformApi.createOrUpdateAppAdmin(appId, {
        email: createForm.email,
        password: createForm.password,
        display_name: createForm.display_name || undefined,
        admin_type: createForm.admin_type,
        page_permissions: createForm.admin_type === 'SUPER_ADMIN' ? [] : createForm.page_permissions,
      });
      setCreateForm(EMPTY_ADMIN_FORM);
      setMessage({ type: 'success', text: '管理员账号保存成功' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存管理员失败') });
    } finally {
      setCreateSaving(false);
    }
  };

  const saveWechatLoginSettings = async () => {
    if (!appId) return;
    setWechatSettingsSaving(true);
    setMessage(null);
    try {
      await platformApi.updateApp(appId, {
        settings: {
          wechat_open_app_ref_id: wechatOpenAppRefIdInput || '',
          wechat_redirect_uri: extractWechatRedirectHost(wechatRedirectUriInput).toLowerCase(),
          google_oauth_client_ref_id: googleOAuthClientRefIdInput || '',
          github_oauth_app_ref_id: githubOAuthAppRefIdInput || '',
          apple_login_credential_ref_id: appleLoginCredentialRefIdInput || '',
          ios_app_attest_mode: iosAppAttestModeInput || 'ENFORCE_SENSITIVE',
          apple_app_apple_id: appleAppAppleIdInput || '',
          payment_method_ref_ids: paymentMethodRefIdsInput,
          extra_json: {
            oauth_redirect_hosts: oauthRedirectHostsInput
              .split(/[\n,]/)
              .map((item) => item.trim())
              .filter(Boolean),
          },
          sms_template_ref_id: smsTemplateRefIdInput || '',
        },
      });
      setMessage({ type: 'success', text: '登录配置已保存到应用工作区' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存登录配置失败') });
    } finally {
      setWechatSettingsSaving(false);
    }
  };

  const saveVideoProxySettings = async () => {
    if (!appId) return;
    setVideoProxySaving(true);
    setMessage(null);
    try {
      const extraJson = asPlainRecord(appDetail?.settings?.extra_json);
      const ai = asPlainRecord(extraJson.ai);
      const existingProxy = asPlainRecord(ai.video_download_proxy);
      const nextExtraJson = {
        ...extraJson,
        ai: {
          ...ai,
          video_download_proxy: {
            ...existingProxy,
            enabled: videoProxyEnabled,
            providers: ['runninghub'],
            retention_days: boundedNumberInput(videoProxyRetentionDaysInput, 7, 1, 365),
            max_file_mb: boundedNumberInput(videoProxyMaxFileMbInput, 1024, 1, 10 * 1024),
            signed_url_ttl_seconds: boundedNumberInput(String(existingProxy.signed_url_ttl_seconds || 600), 600, 30, 24 * 60 * 60),
          },
        },
      };
      await platformApi.updateApp(appId, {
        settings: {
          extra_json: nextExtraJson,
        },
      });
      setMessage({ type: 'success', text: '视频下载加速已保存' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存视频下载加速失败') });
    } finally {
      setVideoProxySaving(false);
    }
  };

  const saveSlugAliases = async () => {
    if (!appId) return;
    setSlugAliasesSaving(true);
    setMessage(null);
    try {
      await platformApi.updateApp(appId, {
        slug_aliases: parseSlugAliases(slugAliasesInput),
      });
      setMessage({ type: 'success', text: '路由标识已保存' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存路由标识失败') });
    } finally {
      setSlugAliasesSaving(false);
    }
  };

  const sendSmsTest = async () => {
    if (!appId) return;
    const phone = smsTestPhoneInput.trim();
    if (!phone) {
      setMessage({ type: 'error', text: '请输入测试手机号' });
      return;
    }
    setSmsTestSending(true);
    setMessage(null);
    try {
      const response = await platformApi.sendAppSmsTest(appId, {
        phone,
        code: smsTestCodeInput.trim() || undefined,
      });
      const result = pickApiData<PlatformAppSmsTestResult>(response) || (response as PlatformAppSmsTestResult);
      setSmsTestResult(result);
      setMessage({ type: 'success', text: '测试短信已发送，请检查手机短信' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '发送测试短信失败') });
    } finally {
      setSmsTestSending(false);
    }
  };

  const handleResetPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!appId || !passwordForm.admin_user_id) return;
    setPasswordSaving(true);
    setMessage(null);
    try {
      await platformApi.resetAppAdminPassword(appId, passwordForm.admin_user_id, {
        new_password: passwordForm.new_password,
        invalidate_sessions: passwordForm.invalidate_sessions,
      });
      setPasswordForm((prev) => ({ ...prev, new_password: '' }));
      setMessage({ type: 'success', text: '管理员密码已更新' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '重置密码失败') });
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleUpdatePermissions = async () => {
    if (!appId || !permissionEditorAdminId) return;
    setPermissionSaving(true);
    setMessage(null);
    try {
      await platformApi.updateAppAdminPermissions(appId, permissionEditorAdminId, {
        page_permissions: permissionKeys,
      });
      setMessage({ type: 'success', text: '管理员权限已更新' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '更新权限失败') });
    } finally {
      setPermissionSaving(false);
    }
  };

  const toggleAdminStatus = async (admin: PlatformTenantAdminItem) => {
    if (!appId) return;
    setMessage(null);
    try {
      await platformApi.updateAppAdminStatus(appId, admin.id, { is_active: !admin.is_active });
      setMessage({ type: 'success', text: '管理员状态已更新' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '更新状态失败') });
    }
  };

  const deleteAdmin = async (admin: PlatformTenantAdminItem) => {
    if (!appId) return;
    if (!window.confirm(`确认删除管理员账号 ${admin.email} 吗？删除后会移除管理员身份。`)) {
      return;
    }

    setMessage(null);
    try {
      await platformApi.deleteAppAdmin(appId, admin.id);
      setMessage({ type: 'success', text: '管理员账号已删除' });
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除管理员失败') });
    }
  };

  const updateDefaultModelSlotDraft = (
    slotKey: PlatformAppAiDefaultModelSlotKey,
    field: 'primary_model_id' | 'fallback_model_id',
    value: string,
  ) => {
    setDefaultModelSlotDrafts((prev) => ({
      ...prev,
      [slotKey]: {
        ...prev[slotKey],
        [field]: value,
      },
    }));
  };

  const saveDefaultModelSlot = async (slotKey: PlatformAppAiDefaultModelSlotKey) => {
    if (!appId) return;
    const draft = defaultModelSlotDrafts[slotKey] || { primary_model_id: '', fallback_model_id: '' };
    setDefaultModelSlotSaving(slotKey);
    setMessage(null);
    try {
      if (draft.primary_model_id || draft.fallback_model_id) {
        await platformApi.upsertAppAiDefaultModelSlot(appId, slotKey, {
          primary_model_id: draft.primary_model_id || null,
          fallback_model_id: draft.fallback_model_id || null,
        });
        setMessage({ type: 'success', text: '默认模型已更新' });
      } else {
        await platformApi.deleteAppAiDefaultModelSlot(appId, slotKey);
        setMessage({ type: 'success', text: '默认模型已清除' });
      }
      await loadData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存默认模型失败') });
    } finally {
      setDefaultModelSlotSaving('');
    }
  };

  const saveAiPointsSettings = async () => {
    if (!appId) return;
    setPointsSettingsSaving(true);
    setMessage(null);
    try {
      const parsedInitial = Number(initialPointsInput);
      const parsedPointsPerYuan = Number(pointsPerYuanInput);
      if (!Number.isFinite(parsedInitial) || parsedInitial < 0) {
        throw new Error('新用户初始积分必须是 >= 0 的数字');
      }
      if (!Number.isFinite(parsedPointsPerYuan) || parsedPointsPerYuan <= 0) {
        throw new Error('充值汇率必须是 > 0 的数字');
      }

      const response = await platformApi.updateAppAiPointsSettings(appId, {
        initial_points: Math.floor(parsedInitial),
        points_per_yuan: Math.floor(parsedPointsPerYuan),
      });
      const payload = pickApiData<PlatformAppAiPointsSettings>(response);
      setAiPointsSettings(payload || null);
      setInitialPointsInput(String(payload?.initial_points ?? Math.floor(parsedInitial)));
      setPointsPerYuanInput(String(payload?.points_per_yuan ?? Math.floor(parsedPointsPerYuan)));
      setMessage({ type: 'success', text: '积分设置已保存' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存 AI 积分规则失败') });
    } finally {
      setPointsSettingsSaving(false);
    }
  };

  const grantAiPointsToUser = async () => {
    if (!appId || manualGrantSubmitting) return;
    const identity = manualGrantIdentityInput.trim();
    const amountRaw = Number(manualGrantAmountInput);
    setMessage(null);
    if (!identity) {
      setMessage({ type: 'error', text: '请填写用户标识' });
      return;
    }
    if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
      setMessage({ type: 'error', text: '赠送积分必须是大于 0 的数字' });
      return;
    }

    const payload: {
      amount: number;
      reason?: string;
      user_id?: string;
      email?: string;
      phone?: string;
    } = {
      amount: Math.round(amountRaw * 100) / 100,
      reason: manualGrantReasonInput.trim() || undefined,
    };
    if (manualGrantIdentityType === 'user_id') payload.user_id = identity;
    if (manualGrantIdentityType === 'email') payload.email = identity;
    if (manualGrantIdentityType === 'phone') payload.phone = identity;

    setManualGrantSubmitting(true);
    try {
      const response = await platformApi.grantAppAiPoints(appId, payload);
      const granted = pickApiData<PlatformAppAiPointsGrantResult>(response) || (response as PlatformAppAiPointsGrantResult);
      setMessage({
        type: 'success',
        text: `已向 ${granted.user_display_name || granted.user_email || granted.user_id} 赠送 ${granted.amount.toFixed(2)} 积分，余额 ${granted.balance_before.toFixed(2)} -> ${granted.balance_after.toFixed(2)}`,
      });
      setManualGrantReasonInput('');
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '赠送积分失败') });
    } finally {
      setManualGrantSubmitting(false);
    }
  };

  const reviewFeedback = async (feedbackId: string, action: 'useless' | 'thanks' | 'useful') => {
    if (!appId || !feedbackId || feedbackActingId) return;
    setFeedbackActingId(feedbackId);
    setMessage(null);
    try {
      const response = await platformApi.reviewAppFeedback(appId, feedbackId, {
        action,
      });
      const payload = pickApiData<{ item: PlatformAppFeedbackItem; reward_points: number }>(response);
      const reward = Number(payload?.reward_points || 0);
      if (reward > 0) {
        setMessage({ type: 'success', text: `反馈已处理，用户奖励 ${reward} 积分` });
      } else {
        setMessage({ type: 'success', text: '反馈已处理' });
      }
      if (selectedFeedbackId === feedbackId) {
        await loadFeedbackDetail(feedbackId);
      }
      await loadFeedbackData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '处理反馈失败') });
    } finally {
      setFeedbackActingId('');
    }
  };

  const loadFeedbackDetail = async (feedbackId: string) => {
    if (!appId || !feedbackId) return;
    setFeedbackDetailLoading(true);
    try {
      const response = await platformApi.getAppFeedback(appId, feedbackId);
      const payload = pickApiData<{ item: PlatformAppFeedbackItem; comments: PlatformAppFeedbackComment[] }>(response) || response;
      setSelectedFeedback(payload.item);
      setFeedbackComments(payload.comments || []);
      setFeedbackNote(payload.item?.admin_note || '');
      setSelectedFeedbackId(feedbackId);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载反馈详情失败') });
    } finally {
      setFeedbackDetailLoading(false);
    }
  };

  const updateFeedback = async (payload: Parameters<typeof platformApi.updateAppFeedback>[2]) => {
    if (!appId || !selectedFeedbackId || feedbackActingId) return;
    setFeedbackActingId(selectedFeedbackId);
    try {
      const response = await platformApi.updateAppFeedback(appId, selectedFeedbackId, payload);
      const result = pickApiData<{ item: PlatformAppFeedbackItem; comments: PlatformAppFeedbackComment[] }>(response) || response;
      setSelectedFeedback(result.item);
      setFeedbackComments(result.comments || []);
      setFeedbackItems((prev) => prev.map((item) => (item.id === result.item.id ? result.item : item)));
      setMessage({ type: 'success', text: '反馈已更新' });
      await loadFeedbackData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '更新反馈失败') });
    } finally {
      setFeedbackActingId('');
    }
  };

  const addFeedbackComment = async () => {
    if (!appId || !selectedFeedbackId || feedbackActingId) return;
    const body = feedbackCommentBody.trim();
    if (!body) {
      setMessage({ type: 'error', text: '请输入回复内容' });
      return;
    }
    setFeedbackActingId(selectedFeedbackId);
    try {
      const response = await platformApi.addAppFeedbackComment(appId, selectedFeedbackId, {
        body,
        is_internal: feedbackCommentInternal,
      });
      const result = pickApiData<{ comment: PlatformAppFeedbackComment; comments: PlatformAppFeedbackComment[] }>(response) || response;
      setFeedbackComments(result.comments || []);
      setFeedbackCommentBody('');
      setFeedbackCommentInternal(false);
      setMessage({ type: 'success', text: feedbackCommentInternal ? '备注已保存' : '回复已发送' });
      await loadFeedbackData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存回复失败') });
    } finally {
      setFeedbackActingId('');
    }
  };

  const patchSiteDownload = (
    platform: 'macos' | 'windows',
    field: keyof PlatformTenantSiteDownloadItem,
    value: string,
  ) => {
    setSiteSettings((prev) => ({
      ...prev,
      downloads: {
        ...(prev.downloads || {}),
        [platform]: {
          ...((prev.downloads || {})[platform] || {}),
          [field]: value,
        },
      },
    }));
  };

  const patchSiteLegal = (field: 'updated_at' | 'privacy_contact' | 'terms_contact', value: string) => {
    setSiteSettings((prev) => ({
      ...prev,
      legal: {
        ...(prev.legal || {}),
        [field]: value,
      },
    }));
  };

  const saveSiteSettings = async () => {
    if (!appId || siteSettingsSaving) return;
    setSiteSettingsSaving(true);
    setMessage(null);
    try {
      const response = await platformApi.updateAppSiteSettings(appId, siteSettings);
      const payload = pickApiData<{ settings: PlatformTenantSiteSettings }>(response) || response;
      setSiteSettings(payload?.settings || {});
      setMessage({ type: 'success', text: '官网配置已保存' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存官网配置失败') });
    } finally {
      setSiteSettingsSaving(false);
    }
  };

  const saveEmailSettings = async () => {
    if (!appId || emailSaving) return;
    setEmailSaving(true);
    setMessage(null);
    try {
      const response = await platformApi.updateAppEmailSettings(appId, emailSettings);
      setEmailSettings(response.settings || {});
      setMessage({ type: 'success', text: '邮件设置已保存' });
      await loadEmailData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存邮件设置失败') });
    } finally {
      setEmailSaving(false);
    }
  };

  const importEmailContacts = async () => {
    if (!appId || !emailContactsText.trim()) return;
    setEmailSaving(true);
    setMessage(null);
    try {
      const result = await platformApi.importAppEmailContacts(appId, { text: emailContactsText });
      setEmailContactsText('');
      setMessage({ type: 'success', text: `已导入 ${result.imported} 个联系人` });
      await loadEmailData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '导入联系人失败') });
    } finally {
      setEmailSaving(false);
    }
  };

  const saveEmailTemplate = async () => {
    if (!appId || emailSaving) return;
    setEmailSaving(true);
    setMessage(null);
    try {
      await platformApi.createAppEmailTemplate(appId, emailTemplateForm);
      setEmailTemplateForm({ name: '', subject: '', html: '', text: '' });
      setMessage({ type: 'success', text: '邮件模板已保存' });
      await loadEmailData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存邮件模板失败') });
    } finally {
      setEmailSaving(false);
    }
  };

  const createEmailCampaign = async () => {
    if (!appId || emailSaving) return;
    setEmailSaving(true);
    setMessage(null);
    try {
      const template = emailTemplates.find((item) => item.id === emailCampaignForm.template_id);
      const campaign = await platformApi.createAppEmailCampaign(appId, {
        name: emailCampaignForm.name,
        sender_id: emailCampaignForm.sender_id || emailSettings.marketing_sender_id || undefined,
        template_id: emailCampaignForm.template_id || undefined,
        subject: emailCampaignForm.subject || template?.subject,
        html: emailCampaignForm.html || template?.html,
        text: emailCampaignForm.text || template?.text || undefined,
      });
      if (emailTestTo.trim()) {
        await platformApi.sendAppEmailCampaignTest(appId, campaign.id, { to: emailTestTo.trim() });
      }
      setEmailCampaignForm({ name: '', sender_id: '', template_id: '', subject: '', html: '', text: '' });
      setMessage({ type: 'success', text: emailTestTo.trim() ? '批次已创建，测试邮件已发送' : '批次已创建' });
      await loadEmailData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '创建邮件批次失败') });
    } finally {
      setEmailSaving(false);
    }
  };

  const selectEmailCampaignTemplate = (templateId: string) => {
    const template = emailTemplates.find((item) => item.id === templateId);
    setEmailCampaignForm((prev) => ({
      ...prev,
      template_id: templateId,
      subject: template?.subject || prev.subject,
      html: template?.html || prev.html,
      text: template?.text || prev.text,
      name: prev.name || template?.name || '',
    }));
  };

  const updateEmailContactStatus = async (contact: PlatformEmailContactItem, status: PlatformEmailContactItem['status']) => {
    if (!appId || emailSaving) return;
    setEmailSaving(true);
    setMessage(null);
    try {
      await platformApi.updateAppEmailContact(appId, contact.id, { status });
      setMessage({ type: 'success', text: status === 'subscribed' ? '联系人已恢复' : '联系人已退订' });
      await loadEmailData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '更新联系人失败') });
    } finally {
      setEmailSaving(false);
    }
  };

  const scheduleEmailCampaign = async (campaignId: string) => {
    if (!appId || emailSaving) return;
    if (!window.confirm('确认开始发送这个邮件批次吗？')) return;
    setEmailSaving(true);
    setMessage(null);
    try {
      const result = await platformApi.scheduleAppEmailCampaign(appId, campaignId);
      setMessage({ type: 'success', text: `已加入发送队列：${result.recipients_created} 个收件人` });
      await loadEmailData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '启动邮件批次失败') });
    } finally {
      setEmailSaving(false);
    }
  };

  const cancelEmailCampaign = async (campaignId: string) => {
    if (!appId || emailSaving) return;
    setEmailSaving(true);
    setMessage(null);
    try {
      await platformApi.cancelAppEmailCampaign(appId, campaignId);
      setMessage({ type: 'success', text: '邮件批次已取消' });
      await loadEmailData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '取消邮件批次失败') });
    } finally {
      setEmailSaving(false);
    }
  };

  const uploadSitePackage = async (platform: 'macos' | 'windows', file?: File | null) => {
    if (!appId || !file || sitePackageUploading) return;
    setSitePackageUploading(platform);
    setMessage(null);
    try {
      const upload = await platformApi.createAppSiteDownloadUploadUrl(appId, platform, {
        filename: file.name,
        content_type: file.type || 'application/octet-stream',
      });
      const uploadResponse = await fetch(upload.upload_url, {
        method: 'PUT',
        headers: upload.headers || { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!uploadResponse.ok) {
        throw new Error(`上传失败：${uploadResponse.status}`);
      }
      const response = await platformApi.confirmAppSiteDownloadUpload(appId, platform, {
        file_url: upload.file_url,
        file_key: upload.file_key,
        file_name: file.name,
        file_size: formatPackageSize(file.size),
        content_type: file.type || 'application/octet-stream',
        updated_at: new Date().toISOString().slice(0, 10),
      });
      const payload = pickApiData<{ settings: PlatformTenantSiteSettings }>(response) || response;
      setSiteSettings(payload?.settings || {});
      setMessage({ type: 'success', text: `${platform === 'macos' ? 'macOS' : 'Windows'} 安装包已发布` });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, error?.message || '安装包上传失败') });
    } finally {
      setSitePackageUploading('');
    }
  };

  const updateSiteMessageStatus = async (messageId: string, status: 'read' | 'archived') => {
    if (!appId || !messageId || siteMessageActingId) return;
    setSiteMessageActingId(messageId);
    setMessage(null);
    try {
      await platformApi.updateAppSiteMessage(appId, messageId, { status });
      setMessage({ type: 'success', text: status === 'archived' ? '消息已归档' : '消息已标记已读' });
      await loadSiteMessages();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '更新官网消息失败') });
    } finally {
      setSiteMessageActingId('');
    }
  };

  const applyLifetimeMembershipToPackageForm = () => {
    setPackageForm((prev) => ({
      ...prev,
      membership_days: LIFETIME_MEMBERSHIP_DAYS,
    }));
  };

  const editPackage = (item: PlatformRedeemPackageItem) => {
    const payment = item.payment_product || null;
    const grants = item.grants?.length ? item.grants : [buildMembershipGrant('app_membership', 30)];
    const membershipGrantDays = resolveMembershipGrantDays(grants);
    setPackageForm({
      id: item.id,
      name: item.name,
      description: item.description || '',
      cover_url: item.cover_url || '',
      price_cny: Number(item.price_cny || 0).toFixed(2),
      is_active: item.is_active,
      payment_enabled: payment ? String(payment.status || '').toUpperCase() !== 'INACTIVE' : Number(item.price_cny || 0) > 0,
      payment_type: String(payment?.type || 'ONE_TIME').toUpperCase() === 'RECURRING' ? 'RECURRING' : 'ONE_TIME',
      membership_scope: resolvePrimaryMembershipScope(grants),
      membership_days: Math.max(Number(payment?.membership_days || 0), 0) || membershipGrantDays || 30,
      sign_scene: String(payment?.sign_scene || 'INDUSTRY|DIGITAL_MEDIA'),
      sign_validity_period: Math.max(Number(payment?.sign_validity_period || 365), 1),
      period_type: (['DAY', 'WEEK', 'MONTH', 'YEAR'].includes(String(payment?.period_type || '').toUpperCase())
        ? String(payment?.period_type || '').toUpperCase()
        : 'MONTH') as 'DAY' | 'WEEK' | 'MONTH' | 'YEAR',
      period: Math.max(Number(payment?.period || 1), 1),
      execute_time: String(payment?.execute_time || ''),
    });
    goRedeemSubPage('product-create');
  };

  const resetPackageForm = () => {
    setPackageForm(EMPTY_REDEEM_PACKAGE_FORM);
  };

  const openCreatePackagePage = () => {
    resetPackageForm();
    goRedeemSubPage('product-create');
  };

  const closePackagePage = () => {
    resetPackageForm();
    goRedeemSubPage('products');
  };

  const savePackage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!appId) return;
    setPackageSaving(true);
    setMessage(null);
    try {
      const parsedPriceCny = Number(packageForm.price_cny);
      if (!Number.isFinite(parsedPriceCny) || parsedPriceCny < 0) {
        throw new Error('产品售价必须是大于等于 0 的数字');
      }
      const payload = {
        name: packageForm.name.trim(),
        description: packageForm.description.trim() || undefined,
        cover_url: packageForm.cover_url.trim() || undefined,
        price_cny: Number(parsedPriceCny.toFixed(2)),
        is_active: packageForm.is_active,
        billing: {
          enabled: packageForm.payment_enabled,
          type: packageForm.payment_type,
          membership_days: Math.max(Math.floor(Number(packageForm.membership_days || 0)), 0),
          sign_scene: packageForm.sign_scene.trim() || undefined,
          sign_validity_period: packageForm.payment_type === 'RECURRING'
            ? Math.max(Math.floor(Number(packageForm.sign_validity_period || 0)), 1)
            : null,
          period_type: packageForm.payment_type === 'RECURRING' ? packageForm.period_type : null,
          period: packageForm.payment_type === 'RECURRING'
            ? Math.max(Math.floor(Number(packageForm.period || 0)), 1)
            : null,
          execute_time: packageForm.payment_type === 'RECURRING'
            ? (packageForm.execute_time.trim() || null)
            : null,
        },
        grants: [buildMembershipGrant(packageForm.membership_scope, packageForm.membership_days)],
      };

      if (!payload.name) {
        throw new Error('产品名称不能为空');
      }
      if (payload.billing.type === 'RECURRING' && payload.billing.enabled && payload.billing.membership_days <= 0) {
        throw new Error('周期扣款产品需要设置大于 0 的会员有效天数');
      }

      if (packageForm.id) {
        await platformApi.updateRedeemPackage(appId, packageForm.id, payload);
        setMessage({ type: 'success', text: '产品已更新' });
      } else {
        await platformApi.createRedeemPackage(appId, payload);
        setMessage({ type: 'success', text: '产品已创建' });
      }
      resetPackageForm();
      await loadRedeemData();
      goRedeemSubPage('products');
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存产品失败') });
    } finally {
      setPackageSaving(false);
    }
  };

  const deletePackage = async (item: PlatformRedeemPackageItem) => {
    if (!appId) return;
    if (!window.confirm(`确认删除产品“${item.name}”吗？`)) {
      return;
    }
    setMessage(null);
    try {
      await platformApi.deleteRedeemPackage(appId, item.id);
      setMessage({ type: 'success', text: '产品已删除' });
      if (packageForm.id === item.id) {
        resetPackageForm();
        goRedeemSubPage('products');
      }
      await loadRedeemData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除产品失败') });
    }
  };

  const togglePackageActive = async (item: PlatformRedeemPackageItem) => {
    if (!appId) return;
    const nextActive = !item.is_active;
    const actionLabel = nextActive ? '上架' : '下架';
    if (!window.confirm(`确认${actionLabel}产品「${item.name}」吗？`)) {
      return;
    }
    setMessage(null);
    try {
      await platformApi.updateRedeemPackage(appId, item.id, { is_active: nextActive });
      setMessage({ type: 'success', text: `产品「${item.name}」已${actionLabel}` });
      await loadRedeemData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, `${actionLabel}产品失败`) });
    }
  };

  const distributePackageToUser = async (item: PlatformRedeemPackageItem) => {
    if (!appId) return;
    const input = window.prompt(`请输入要分发产品「${item.name}」的用户ID（uuid）`);
    const userId = String(input || '').trim();
    if (!userId) {
      return;
    }
    setMessage(null);
    try {
      await platformApi.distributeRedeemPackageToUser(appId, item.id, { user_id: userId });
      setMessage({ type: 'success', text: `产品「${item.name}」已分发，系统已向用户推送产品到账通知` });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '分发产品失败') });
    }
  };

  const runPackagePaymentTest = async (item: PlatformRedeemPackageItem, mode: ProductPaymentTestMode) => {
    if (!appId) return;
    const payment = item.payment_product;
    if (!payment?.id) {
      setMessage({ type: 'error', text: `产品「${item.name}」未配置支付商品` });
      return;
    }
    if (String(payment.status || '').toUpperCase() !== 'ACTIVE') {
      setMessage({ type: 'error', text: `产品「${item.name}」支付状态非 ACTIVE，无法测试` });
      return;
    }
    const paymentType = String(payment.type || '').toUpperCase();
    if (mode === 'alipay-recurring' && paymentType !== 'RECURRING') {
      setMessage({ type: 'error', text: `产品「${item.name}」不是周期扣款产品，无法发起签约测试` });
      return;
    }
    if ((mode === 'alipay-one-time' || mode === 'wechat-one-time') && paymentType !== 'ONE_TIME') {
      setMessage({ type: 'error', text: `产品「${item.name}」不是单次支付产品，无法发起单次支付测试` });
      return;
    }

    const testingKey = `${item.id}:${mode}`;
    setPaymentTestingKey(testingKey);
    setMessage(null);
    try {
      let response: unknown;
      if (mode === 'alipay-one-time') {
        response = await platformApi.runPlatformPaymentOneTimeTest({
          app_id: appId,
          one_time_product_id: payment.id,
        });
      } else if (mode === 'wechat-one-time') {
        response = await platformApi.runPlatformPaymentWechatOneTimeTest({
          app_id: appId,
          one_time_product_id: payment.id,
        });
      } else {
        response = await platformApi.runPlatformPaymentRecurringTest({
          app_id: appId,
          recurring_product_id: payment.id,
        });
      }

      const payload = pickApiData<PaymentTestPayload>(response) || {};
      if (mode === 'alipay-one-time') {
        const formHtml = payload?.one_time_order?.payment_form || '';
        const opened = openGatewayForm(formHtml);
        if (!opened) {
          throw new Error('未拿到可打开的支付宝支付页面，请检查支付网关返回');
        }
        setMessage({ type: 'success', text: `已发起「${item.name}」支付宝真实支付测试，请在新窗口完成支付` });
        return;
      }
      if (mode === 'alipay-recurring') {
        const signForm = payload?.agreement?.sign_form || '';
        const opened = openGatewayForm(signForm);
        if (!opened) {
          throw new Error('未拿到可打开的支付宝签约页面，请检查支付网关返回');
        }
        setMessage({ type: 'success', text: `已发起「${item.name}」支付宝真实签约测试，请在新窗口完成签约` });
        return;
      }
      const paymentUrl = String(payload?.order?.payment_url || '').trim();
      const codeUrl = String(payload?.order?.code_url || '').trim();
      const directUrl = paymentUrl || codeUrl;
      if (!directUrl) {
        throw new Error('微信支付测试未返回可扫码地址');
      }
      const isHttpLike = /^https?:\/\//i.test(directUrl);
      const opened = isHttpLike ? openExternalUrl(directUrl) : openQrBridge(directUrl);
      if (!opened) {
        throw new Error('浏览器拦截了新窗口，请允许弹窗后重试');
      }
      setMessage({ type: 'success', text: `已发起「${item.name}」微信真实支付测试，请在新窗口扫码` });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '发起支付测试失败') });
    } finally {
      setPaymentTestingKey('');
    }
  };

  const refundPaymentOrder = async (item: PlatformPaymentOrderItem) => {
    if (!appId) return;
    const status = String(item.status || '').toUpperCase();
    if (status !== 'PAID') {
      setMessage({ type: 'error', text: '仅已支付订单支持退款' });
      return;
    }

    const paidAmount = Number(item.amount || 0);
    const refundedAmount = Number(item.refunded_amount || 0);
    const refundable = Number(Math.max(paidAmount - refundedAmount, 0).toFixed(2));
    if (refundable <= 0) {
      setMessage({ type: 'error', text: '该订单已无可退金额' });
      return;
    }

    const amountInput = window.prompt(
      `请输入退款金额（可退 ${refundable.toFixed(2)}，留空默认全退）`,
      refundable.toFixed(2),
    );
    if (amountInput === null) {
      return;
    }
    const amountRaw = String(amountInput || '').trim();
    const refundAmount = amountRaw ? Number(amountRaw) : refundable;
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      setMessage({ type: 'error', text: '退款金额必须大于 0' });
      return;
    }
    if (refundAmount - refundable > 0.0001) {
      setMessage({ type: 'error', text: `退款金额不能超过可退金额 ${refundable.toFixed(2)}` });
      return;
    }

    const reasonInput = window.prompt('请输入退款原因（可选）', '管理员发起退款');
    if (reasonInput === null) {
      return;
    }

    setPaymentOrderRefundingId(item.id);
    setMessage(null);
    try {
      const response = await platformApi.refundAppPaymentOrder(appId, item.id, {
        amount: refundAmount.toFixed(2),
        reason: String(reasonInput || '').trim() || undefined,
      });
      const payload = pickApiData<{
        refund_amount: string;
        refunded_amount_total: string;
        status: 'REFUNDED' | 'PARTIAL_REFUNDED';
      }>(response);
      const refundDone = payload?.refund_amount || refundAmount.toFixed(2);
      const refundedTotal = payload?.refunded_amount_total || '-';
      const resultStatus = payload?.status || '-';
      setMessage({
        type: 'success',
        text: `退款成功：本次 ${refundDone}，累计已退 ${refundedTotal}，订单状态 ${resultStatus}`,
      });
      await loadRedeemData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '订单退款失败') });
    } finally {
      setPaymentOrderRefundingId('');
    }
  };

  const uploadPackageCover = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setMessage({ type: 'error', text: '请上传图片格式文件作为产品封面' });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setMessage({ type: 'error', text: '封面图片不能超过 8MB' });
      return;
    }
    setPackageCoverUploading(true);
    setMessage(null);
    try {
      const uploaded = await platformApi.uploadImageBuffer(file, appDetail?.slug, appId, 'uploads/images');
      setPackageForm((prev) => ({ ...prev, cover_url: uploaded.file_url || '' }));
      setMessage({ type: 'success', text: '产品封面上传成功' });
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '产品封面上传失败') });
    } finally {
      setPackageCoverUploading(false);
    }
  };

  const createBatch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!appId) return;
    setBatchSaving(true);
    setMessage(null);
    try {
      const payload = {
        name: batchForm.name.trim() || undefined,
        note: batchForm.note.trim() || undefined,
        count: Number(batchForm.count || 0),
        code_prefix: batchForm.code_prefix.trim() || undefined,
        max_uses: Number(batchForm.max_uses || 1),
        expires_at: batchForm.expires_at ? new Date(batchForm.expires_at).toISOString() : undefined,
        package_id: batchForm.use_package ? batchForm.package_id || undefined : undefined,
        grants: batchForm.use_package
          ? undefined
          : [buildMembershipGrant(batchForm.custom_membership_scope, batchForm.custom_membership_days)],
      };
      const result = await platformApi.createRedeemCodeBatch(appId, payload);
      setLastGeneratedCodes(result.codes || []);
      setMessage({ type: 'success', text: `批量生成完成，共 ${result.created_count} 个兑换码` });
      setBatchForm(EMPTY_REDEEM_BATCH_FORM);
      setRedeemPage(1);
      setRedeemRedemptionPage(1);
      await loadRedeemData();
      goRedeemSubPage('code-batches');
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '创建兑换码批次失败') });
    } finally {
      setBatchSaving(false);
    }
  };

  const downloadBatchTxt = async (batchId: string) => {
    if (!appId) return;
    try {
      const result = await platformApi.getRedeemBatchTxt(appId, batchId);
      const content = result.content || '';
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename || `redeem-codes-${batchId}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '下载 TXT 失败') });
    }
  };

  const downloadBatchUrlTxt = async (batchId: string) => {
    if (!appId) return;
    if (!redeemCodeBaseUrl) {
      setMessage({ type: 'error', text: '缺少用户端地址配置：请先设置应用地址或 USER_WEB 域名' });
      return;
    }
    try {
      const result = await platformApi.getRedeemBatchTxt(appId, batchId, {
        format: 'url',
        base_url: redeemCodeBaseUrl,
      });
      const content = String(result.content || '').replace(/\uFEFF/g, '').trim();
      if (!content) {
        setMessage({ type: 'error', text: '批次中没有可导出的兑换码' });
        return;
      }
      const fileName = result.filename || `redeem-code-urls-${batchId}.txt`;
      const blob = new Blob([`${content}\n`], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '下载 URL TXT 失败') });
    }
  };

  const voidCode = async (code: string) => {
    if (!appId) return;
    if (!window.confirm(`确认作废兑换码 ${code} 吗？`)) {
      return;
    }
    try {
      await platformApi.voidRedeemCode(appId, code);
      setMessage({ type: 'success', text: '兑换码已作废' });
      await loadRedeemData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '作废兑换码失败') });
    }
  };

  const voidCodeFromInput = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!appId) return;
    const code = redeemVoidCodeInput.trim();
    if (!code) {
      setMessage({ type: 'error', text: '请输入兑换码' });
      return;
    }
    if (!window.confirm(`确认作废兑换码 ${code} 吗？`)) {
      return;
    }

    setRedeemVoidSaving(true);
    setMessage(null);
    try {
      await platformApi.voidRedeemCode(appId, code);
      setRedeemVoidCodeInput('');
      setMessage({ type: 'success', text: '兑换码已作废' });
      await loadRedeemData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '作废兑换码失败') });
    } finally {
      setRedeemVoidSaving(false);
    }
  };

  const revokeCodeRedemption = async (item: PlatformRedeemCodeRedemptionItem) => {
    if (!appId) return;
    if (item.revoked_at) {
      setMessage({ type: 'error', text: '该兑换记录已经撤销' });
      return;
    }
    const reasonInput = window.prompt('请输入撤销原因（可选）', '管理员撤销兑换记录');
    if (reasonInput === null) {
      return;
    }
    const confirmed = window.confirm(
      `确认撤销兑换记录吗？\n兑换码：${item.code}\n用户：${item.user_email || item.user_id}\n此操作会回收该次兑换产生的权益。`,
    );
    if (!confirmed) {
      return;
    }
    setRedeemRedemptionRevokingId(item.id);
    setMessage(null);
    try {
      const response = await platformApi.revokeRedeemCodeRedemption(
        appId,
        item.id,
        String(reasonInput || '').trim() || undefined,
      );
      const payload = pickApiData<{
        deactivated_entitlements?: number;
      }>(response);
      setMessage({
        type: 'success',
        text: `撤销完成：回收权益 ${Number(payload?.deactivated_entitlements || 0)} 条。`,
      });
      await loadRedeemData();
    } catch (error: any) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '撤销兑换记录失败') });
    } finally {
      setRedeemRedemptionRevokingId('');
    }
  };

  const renderOverview = () => (
    <div className="platform-page">
      <div className="platform-stats-grid">
        <div className="platform-stat-card"><span>用户总数</span><strong>{stats?.users_total ?? '-'}</strong></div>
        <div className="platform-stat-card"><span>活跃用户</span><strong>{stats?.users_active ?? '-'}</strong></div>
        <div className="platform-stat-card"><span>管理员数</span><strong>{stats?.admins_total ?? '-'}</strong></div>
        <div className="platform-stat-card"><span>近7天新增</span><strong>{stats?.new_users_7d ?? '-'}</strong></div>
      </div>

      <div className="platform-grid-two tenants-layout">
        <section className="card">
          <div className="platform-section-head"><h3>域名配置</h3></div>
          <div className="platform-detail">
            {(appDetail?.domains || []).map((item) => (
              <div key={`${item.domain_type}-${item.domain}`} className="platform-detail-row">
                <span>{item.domain_type}</span>
                <strong>{item.domain}</strong>
              </div>
            ))}
            {!appDetail?.domains?.length && <div className="loading">暂无域名配置</div>}
          </div>
        </section>

        <section className="card">
          <div className="platform-section-head"><h3>品牌与邮件设置</h3></div>
          <div className="platform-detail">
            <div className="platform-detail-row"><span>品牌名称</span><strong>{appDetail?.settings?.brand_name || '-'}</strong></div>
            <div className="platform-detail-row"><span>应用地址</span><strong>{appDetail?.settings?.app_url || '-'}</strong></div>
            <div className="platform-detail-row">
              <span>主色</span>
              <strong className="platform-color-inline">
                {appDetail?.settings?.email_primary_color ? (
                  <span className="platform-color-inline__swatch" style={{ backgroundColor: appDetail.settings.email_primary_color }} aria-hidden="true" />
                ) : null}
                <span>{appDetail?.settings?.email_primary_color || '-'}</span>
              </strong>
            </div>
            <div className="platform-detail-row">
              <span>辅色</span>
              <strong className="platform-color-inline">
                {appDetail?.settings?.email_secondary_color ? (
                  <span className="platform-color-inline__swatch" style={{ backgroundColor: appDetail.settings.email_secondary_color }} aria-hidden="true" />
                ) : null}
                <span>{appDetail?.settings?.email_secondary_color || '-'}</span>
              </strong>
            </div>
          </div>
        </section>
      </div>

      {canManagePlatformAppSettings && (
        <>
      <section className="card">
        <div className="platform-section-head"><h3>路由标识</h3></div>
        <div className="platform-form-grid">
          <div className="form-group">
            <label>主标识</label>
            <input value={appDetail?.slug || ''} disabled />
          </div>
          <div className="form-group platform-form-span-2">
            <label>附加标识</label>
            <textarea
              value={slugAliasesInput}
              onChange={(event) => setSlugAliasesInput(event.target.value)}
              rows={3}
              placeholder="每行一个，例如 auth.example.com"
            />
          </div>
          <div className="platform-form-actions platform-form-span-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={saveSlugAliases} disabled={slugAliasesSaving}>
              {slugAliasesSaving ? '保存中...' : '保存路由标识'}
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="platform-section-head">
          <h3>登录配置（应用内设置）</h3>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={loadData}
            disabled={loading || wechatSettingsSaving}
          >
            刷新应用池
          </button>
        </div>
        <div className="platform-form-grid">
          <div className="form-group">
            <label>登录微信 AppID</label>
            <select
              value={wechatOpenAppRefIdInput}
              onChange={(event) => setWechatOpenAppRefIdInput(event.target.value)}
              disabled={!wechatOpenApps.length}
            >
              <option value="">未绑定（清空）</option>
              {wechatOpenApps.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.app_id}){item.is_active ? '' : ' [INACTIVE]'}
                </option>
              ))}
            </select>
            {selectedWechatOpenApp ? (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>
                待保存配置：{selectedWechatOpenApp.name} / {selectedWechatOpenApp.app_id}
              </p>
            ) : (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>待保存配置：未绑定</p>
            )}
          </div>
          <div className="form-group">
            <label>微信登录回调域名</label>
            <input
              value={wechatRedirectUriInput}
              onChange={(event) => setWechatRedirectUriInput(event.target.value)}
              placeholder="例如 api.example.com"
            />
            <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>
              当前回调地址：<code>{buildWechatRedirectPreview(appDetail?.slug, wechatRedirectUriInput) || '保存后生成'}</code>
            </p>
          </div>
          <div className="form-group">
            <label>Google Client ID</label>
            <select
              value={googleOAuthClientRefIdInput}
              onChange={(event) => setGoogleOAuthClientRefIdInput(event.target.value)}
              disabled={!googleOAuthClients.length}
            >
              <option value="">未绑定（清空）</option>
              {googleOAuthClients.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.client_id}){item.is_active ? '' : ' [INACTIVE]'}
                </option>
              ))}
            </select>
            {selectedGoogleOAuthClient ? (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>
                待保存配置：{selectedGoogleOAuthClient.name} / {selectedGoogleOAuthClient.client_id}
              </p>
            ) : (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>待保存配置：未绑定</p>
            )}
          </div>
          <div className="form-group">
            <label>GitHub Client ID</label>
            <select
              value={githubOAuthAppRefIdInput}
              onChange={(event) => setGithubOAuthAppRefIdInput(event.target.value)}
              disabled={!githubOAuthApps.length}
            >
              <option value="">未绑定（清空）</option>
              {githubOAuthApps.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.client_id}){item.is_active ? '' : ' [INACTIVE]'}
                </option>
              ))}
            </select>
            {selectedGitHubOAuthApp ? (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>
                待保存配置：{selectedGitHubOAuthApp.name} / {selectedGitHubOAuthApp.client_id}
              </p>
            ) : (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>待保存配置：未绑定</p>
            )}
          </div>
          <div className="form-group">
            <label>Apple 登录凭证</label>
            <select
              value={appleLoginCredentialRefIdInput}
              onChange={(event) => setAppleLoginCredentialRefIdInput(event.target.value)}
              disabled={!appleLoginCredentials.length}
            >
              <option value="">未绑定（清空）</option>
              {appleLoginCredentials.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.bundle_id}){item.is_active ? '' : ' [INACTIVE]'}
                </option>
              ))}
            </select>
            {selectedAppleLoginCredential ? (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>
                待保存配置：{selectedAppleLoginCredential.name} / {selectedAppleLoginCredential.bundle_id}
              </p>
            ) : (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>待保存配置：未绑定</p>
            )}
          </div>
          <div className="form-group">
            <label>App Attest</label>
            <select
              value={iosAppAttestModeInput}
              onChange={(event) => setIosAppAttestModeInput(event.target.value)}
            >
              <option value="OFF">关闭</option>
              <option value="MONITOR">仅记录</option>
              <option value="ENFORCE_SENSITIVE">保护敏感操作</option>
              <option value="ENFORCE_ALL">保护全部接口</option>
            </select>
          </div>
          <div className="form-group">
            <label>Apple App ID</label>
            <input
              value={appleAppAppleIdInput}
              onChange={(event) => setAppleAppAppleIdInput(event.target.value)}
              placeholder="例如 1234567890"
            />
          </div>
          <div className="form-group platform-form-span-2">
            <label>OAuth 回调域名</label>
            <textarea
              value={oauthRedirectHostsInput}
              onChange={(event) => setOauthRedirectHostsInput(event.target.value)}
              placeholder="app.example.com"
              rows={3}
            />
          </div>
          <div className="form-group platform-form-span-2">
            <label>支付方式</label>
            <div className="permission-grid">
              {paymentMethods.map((item) => (
                <label key={item.id} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={paymentMethodRefIdsInput.includes(item.id)}
                    onChange={() => togglePaymentMethodRef(item.id)}
                  />
                  {item.name} ({item.provider_type}){item.is_active ? '' : ' [INACTIVE]'}
                </label>
              ))}
              {!paymentMethods.length && <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>暂无可选支付方式</span>}
            </div>
            {selectedPaymentMethods.length ? (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>
                待保存配置：{selectedPaymentMethods.map((item) => `${item.name} / ${item.provider_type}`).join('，')}
              </p>
            ) : (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>待保存配置：使用平台默认</p>
            )}
          </div>
          <div className="form-group">
            <label>验证码模板</label>
            <select
              value={smsTemplateRefIdInput}
              onChange={(event) => setSmsTemplateRefIdInput(event.target.value)}
              disabled={!smsTemplates.length}
            >
              <option value="">使用全局默认（自动匹配）</option>
              {smsTemplates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.template_name || item.template_code} ({item.template_code}){item.is_active ? '' : ' [INACTIVE]'}
                </option>
              ))}
            </select>
            {selectedSmsTemplate ? (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>
                待保存配置：{selectedSmsTemplate.template_name || selectedSmsTemplate.template_code} / {selectedSmsTemplate.template_code}
              </p>
            ) : (
              <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 12 }}>待保存配置：使用全局默认</p>
            )}
          </div>
          <div className="platform-form-actions platform-form-span-2">
            <button className="btn" type="button" disabled={wechatSettingsSaving} onClick={saveWechatLoginSettings}>
              {wechatSettingsSaving ? '保存中...' : '保存登录配置'}
            </button>
          </div>
        </div>
        <div className="oauth-callback-panel">
          <div className="oauth-callback-row">
            <span>微信开放平台</span>
            <code>{buildAppAuthCallbackUrl(appDetail?.slug, 'wechat', wechatRedirectUriInput) || '未生成'}</code>
          </div>
          <div className="oauth-callback-row">
            <span>Google OAuth</span>
            <code>{buildAppAuthCallbackUrl(appDetail?.slug, 'google') || '未生成'}</code>
          </div>
          <div className="oauth-callback-row">
            <span>GitHub OAuth</span>
            <code>{buildAppAuthCallbackUrl(appDetail?.slug, 'github') || '未生成'}</code>
          </div>
        </div>
        {wechatOpenAppsError && <div className="alert alert-error" style={{ marginTop: 12 }}>{wechatOpenAppsError}</div>}
        {googleOAuthClientsError && <div className="alert alert-error" style={{ marginTop: 12 }}>{googleOAuthClientsError}</div>}
        {githubOAuthAppsError && <div className="alert alert-error" style={{ marginTop: 12 }}>{githubOAuthAppsError}</div>}
        {appleLoginCredentialsError && <div className="alert alert-error" style={{ marginTop: 12 }}>{appleLoginCredentialsError}</div>}
        {paymentMethodsError && <div className="alert alert-error" style={{ marginTop: 12 }}>{paymentMethodsError}</div>}
        {smsTemplatesError && <div className="alert alert-error" style={{ marginTop: 12 }}>{smsTemplatesError}</div>}
        <div className="platform-detail" style={{ marginTop: 12 }}>
          <div className="platform-detail-row">
            <span>当前已生效</span>
            <strong>{savedWechatOpenApp ? `${savedWechatOpenApp.name} (${savedWechatOpenApp.app_id})` : '未绑定'}</strong>
          </div>
          <div className="platform-detail-row">
            <span>当前回调域名</span>
            <strong>{savedWechatRedirectHost || '未设置'}</strong>
          </div>
          <div className="platform-detail-row">
            <span>当前生效回调 URL</span>
            <strong>{buildWechatRedirectPreview(appDetail?.slug, savedWechatRedirectHost) || '未设置'}</strong>
          </div>
          <div className="platform-detail-row">
            <span>当前 Google 登录</span>
            <strong>{savedGoogleOAuthClient ? `${savedGoogleOAuthClient.name} (${savedGoogleOAuthClient.client_id})` : '未绑定'}</strong>
          </div>
          <div className="platform-detail-row">
            <span>当前 GitHub 登录</span>
            <strong>{savedGitHubOAuthApp ? `${savedGitHubOAuthApp.name} (${savedGitHubOAuthApp.client_id})` : '未绑定'}</strong>
          </div>
          <div className="platform-detail-row">
            <span>当前 Apple 登录</span>
            <strong>{savedAppleLoginCredential ? `${savedAppleLoginCredential.name} (${savedAppleLoginCredential.bundle_id})` : '未绑定'}</strong>
          </div>
          <div className="platform-detail-row">
            <span>当前 App Attest</span>
            <strong>{String(appDetail?.settings?.ios_app_attest_mode || 'ENFORCE_SENSITIVE')}</strong>
          </div>
          <div className="platform-detail-row">
            <span>当前 Apple App ID</span>
            <strong>{String(appDetail?.settings?.apple_app_apple_id || '').trim() || '未设置'}</strong>
          </div>
          <div className="platform-detail-row">
            <span>Apple 通知地址</span>
            <strong>{appDetail?.slug ? `${resolveApiBaseUrl()}/${appDetail.slug}/v1/payments/callbacks/apple` : '未生成'}</strong>
          </div>
          <div className="platform-detail-row">
            <span>当前支付方式</span>
            <strong>
              {savedPaymentMethods.length
                ? savedPaymentMethods.map((item) => `${item.name} (${item.provider_type})`).join('，')
                : '平台默认'}
            </strong>
          </div>
          <div className="platform-detail-row">
            <span>当前验证码模板</span>
            <strong>
              {savedSmsTemplate
                ? `${savedSmsTemplate.template_name || savedSmsTemplate.template_code} (${savedSmsTemplate.template_code})`
                : '全局默认'}
            </strong>
          </div>
          {selectedSmsTemplateVariables ? (
            <div className="platform-detail-row">
              <span>待保存模板变量示例</span>
              <strong>
                <code>{JSON.stringify(selectedSmsTemplateVariables)}</code>
              </strong>
            </div>
          ) : null}
          {savedSmsTemplateVariables ? (
            <div className="platform-detail-row">
              <span>当前模板变量示例</span>
              <strong>
                <code>{JSON.stringify(savedSmsTemplateVariables)}</code>
              </strong>
            </div>
          ) : null}
          {wechatOpenAppsError ? (
            <div className="platform-detail-row">
              <span>应用池状态</span>
              <strong>{wechatOpenAppsError}</strong>
            </div>
          ) : (
            <div className="platform-detail-row">
              <span>应用池可选数量</span>
              <strong>{wechatOpenApps.length}</strong>
            </div>
          )}
          {smsTemplatesError ? (
            <div className="platform-detail-row">
              <span>模板池状态</span>
              <strong>{smsTemplatesError}</strong>
            </div>
          ) : (
            <div className="platform-detail-row">
              <span>模板池可选数量</span>
              <strong>{smsTemplates.length}</strong>
            </div>
          )}
        </div>

        <div className="platform-detail-block" style={{ marginTop: 14 }}>
          <h4>发送测试验证码</h4>
          <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 10 }}>
            该测试与用户登录发码走同一条短信服务链路，默认不写入验证码校验记录。
          </p>
          <div className="platform-form-grid">
            <div className="form-group">
              <label>测试手机号</label>
              <input
                value={smsTestPhoneInput}
                onChange={(event) => setSmsTestPhoneInput(event.target.value)}
                placeholder="例如 13800000000"
              />
            </div>
            <div className="form-group">
              <label>验证码（可选）</label>
              <input
                value={smsTestCodeInput}
                onChange={(event) => setSmsTestCodeInput(event.target.value)}
                placeholder="不填则自动生成 6 位验证码"
              />
            </div>
            <div className="platform-form-actions platform-form-span-2">
              <button className="btn btn-secondary" type="button" onClick={sendSmsTest} disabled={smsTestSending}>
                {smsTestSending ? '发送中...' : '发送测试短信'}
              </button>
            </div>
          </div>
          {smsTestResult ? (
            <div className="platform-detail" style={{ marginTop: 12 }}>
              <div className="platform-detail-row">
                <span>发送手机号</span>
                <strong>{smsTestResult.phone || '-'}</strong>
              </div>
              <div className="platform-detail-row">
                <span>本次验证码</span>
                <strong>{smsTestResult.code || '-'}</strong>
              </div>
              <div className="platform-detail-row">
                <span>短信服务</span>
                <strong>{smsTestResult.route?.provider_name || '-'}</strong>
              </div>
              <div className="platform-detail-row">
                <span>短信签名</span>
                <strong>{smsTestResult.route?.signature_name || '-'}</strong>
              </div>
              <div className="platform-detail-row">
                <span>短信模板</span>
                <strong>{smsTestResult.route?.template_code || '未配置模板（服务端回退）'}</strong>
              </div>
            </div>
          ) : null}
        </div>
      </section>
        </>
      )}

      {isAppSuperAdmin && renderAiPointsSettingsCard()}
      {isAppSuperAdmin && renderManualGrantAiPointsCard()}
    </div>
  );

  const renderAnalytics = () => <TenantAnalyticsPanel appId={appId} />;

  const renderAiUsage = () => <AppAiUsagePanel appId={appId} aiSources={aiSources} modelRoutes={modelRoutes} />;

  const renderApiDocs = () => <TenantApiDocsPanel app={appDetail} />;

  const renderDevelopers = () => {
    const appSlug = resolveDeveloperAppSlug();
    const apiBaseUrl = sdkManifest?.app?.api_base_url || (runtimeContext.apiBaseUrl ? `${runtimeContext.apiBaseUrl.replace(/\/+$/, '')}/${appSlug}/v1` : '');
    const installCommand = sdkManifest?.codex?.install_command || `npx -y @opg/cli codex install --base-url ${runtimeContext.apiBaseUrl} --app ${appSlug}`;
    const envText = [
      `OPG_BASE_URL=${runtimeContext.apiBaseUrl || ''}`,
      `OPG_APP_SLUG=${appSlug}`,
      'OPG_API_KEY=rbx_replace_me',
    ].join('\n');

    return (
      <div className="platform-page tenant-developer-page">
        <section className="card">
          <div className="platform-section-head">
            <h3>SDK</h3>
            <div className="btn-group">
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadDeveloperData()} disabled={sdkManifestLoading}>
                {sdkManifestLoading ? '刷新中...' : '刷新'}
              </button>
              <button className="btn btn-sm" type="button" onClick={() => void runDeveloperSmokeTest()} disabled={sdkSmokeLoading}>
                {sdkSmokeLoading ? '检查中...' : '检查'}
              </button>
            </div>
          </div>
          <div className="platform-form-grid compact">
            <label>
              Base URL
              <input readOnly value={runtimeContext.apiBaseUrl || ''} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <label>
              App slug
              <input readOnly value={appSlug} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <label className="platform-form-span-2">
              API Base
              <input readOnly value={apiBaseUrl} onFocus={(event) => event.currentTarget.select()} />
            </label>
          </div>
          <div className="platform-form-actions">
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void copyDeveloperText(envText, '环境变量')}>
              复制 env
            </button>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void copyDeveloperText('npm install @opg/sdk', '安装命令')}>
              复制 SDK 安装
            </button>
          </div>
          <pre className="platform-code-block">{`import { createOpgClient } from '@opg/sdk';

const opg = createOpgClient({
  baseUrl: process.env.OPG_BASE_URL!,
  app: process.env.OPG_APP_SLUG!,
  apiKey: process.env.OPG_API_KEY!,
});

const agents = await opg.agents.list();`}</pre>
        </section>

        <section className="card">
          <div className="platform-section-head">
            <h3>Codex</h3>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void copyDeveloperText(installCommand, 'Codex 命令')}>
              复制
            </button>
          </div>
          <pre className="platform-code-block">{installCommand}</pre>
          <div className="platform-api-table-wrap">
            <table className="table">
              <tbody>
                <tr><td>MCP command</td><td>{sdkManifest?.codex?.mcp_server_command || 'npx'}</td></tr>
                <tr><td>MCP args</td><td>{(sdkManifest?.codex?.mcp_server_args || ['-y', '@opg/cli', 'mcp']).join(' ')}</td></tr>
                <tr><td>环境变量</td><td>{(sdkManifest?.codex?.environment || ['OPG_BASE_URL', 'OPG_APP_SLUG', 'OPG_API_KEY']).join(', ')}</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="platform-section-head">
            <h3>API Keys</h3>
            <button className="btn btn-sm" type="button" onClick={() => void createDeveloperApiKey()} disabled={developerApiKeySaving}>
              {developerApiKeySaving ? '创建中...' : '创建'}
            </button>
          </div>
          <div className="platform-form-grid compact">
            <label>
              名称
              <input value={newDeveloperApiKeyName} onChange={(event) => setNewDeveloperApiKeyName(event.target.value)} />
            </label>
            {newDeveloperApiKey ? (
              <label className="platform-form-span-2">
                新 Key
                <input readOnly value={newDeveloperApiKey} onFocus={(event) => event.currentTarget.select()} />
              </label>
            ) : null}
          </div>
          {newDeveloperApiKey ? (
            <div className="platform-form-actions">
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => void copyDeveloperText(newDeveloperApiKey, 'API Key')}>
                复制新 Key
              </button>
            </div>
          ) : null}
          <div className="platform-api-table-wrap">
            <table className="table">
              <thead><tr><th>名称</th><th>Key</th><th>状态</th><th>最近使用</th><th>操作</th></tr></thead>
              <tbody>
                {developerApiKeys.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.key_prefix}...{item.key_last4}</td>
                    <td><span className={`status-tag ${item.is_active ? 'success' : 'muted'}`}>{item.is_active ? '启用' : '停用'}</span></td>
                    <td>{formatDateTime(item.last_used_at)}</td>
                    <td>
                      {item.is_active ? (
                        <button className="btn btn-danger btn-sm" type="button" onClick={() => void revokeDeveloperApiKey(item.id)} disabled={developerApiKeySaving}>
                          撤销
                        </button>
                      ) : '-'}
                    </td>
                  </tr>
                ))}
                {!developerApiKeys.length && (
                  <tr><td colSpan={5}>{developerApiKeysLoading ? '加载中...' : '暂无 API Key'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {sdkSmokeResult ? (
          <section className="card">
            <div className="platform-section-head"><h3>检查结果</h3></div>
            <div className="platform-api-table-wrap">
              <table className="table">
                <thead><tr><th>检查项</th><th>状态</th><th>结果</th></tr></thead>
                <tbody>
                  {sdkSmokeResult.checks.map((item) => (
                    <tr key={item.key}>
                      <td>{item.key}</td>
                      <td><span className={`status-tag ${item.ok ? 'success' : 'error'}`}>{item.ok ? '通过' : '失败'}</span></td>
                      <td>{item.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    );
  };

  const renderAdmins = () => (
    <div className="platform-page">
      <div className="platform-grid-two tenants-layout">
        <section className="card">
          <div className="platform-section-head"><h3>创建/更新管理员账号</h3></div>
          <form onSubmit={handleCreateAdmin} className="platform-form-grid">
            <div className="form-group">
              <label>管理员邮箱</label>
              <input
                value={createForm.email}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, email: event.target.value }))}
                placeholder="admin@example.com"
                required
              />
            </div>
            <div className="form-group">
              <label>登录密码</label>
              <input
                type="password"
                autoComplete="new-password"
                value={createForm.password}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, password: event.target.value }))}
                placeholder="至少8位"
                required
              />
            </div>
            <div className="form-group">
              <label>显示名称</label>
              <input
                value={createForm.display_name}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, display_name: event.target.value }))}
                placeholder="可选"
              />
            </div>
            <div className="form-group">
              <label>管理员类型</label>
              <select
                value={createForm.admin_type}
                onChange={(event) =>
                  setCreateForm((prev) => ({ ...prev, admin_type: event.target.value as 'SUPER_ADMIN' | 'ADMIN' }))
                }
              >
                <option value="ADMIN">ADMIN</option>
                <option value="SUPER_ADMIN">SUPER_ADMIN</option>
              </select>
            </div>

            {createForm.admin_type === 'ADMIN' && (
              <div className="form-group platform-form-span-2">
                <label>页面权限</label>
                <div className="platform-permission-grid">
                  {permissionCatalog.map((item) => (
                    <label key={item.key} className="platform-permission-item">
                      <input
                        type="checkbox"
                        checked={createForm.page_permissions.includes(item.key)}
                        onChange={() => toggleCreatePermission(item.key)}
                      />
                      <span>{item.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="platform-form-actions platform-form-span-2">
              <button className="btn" type="submit" disabled={createSaving}>
                {createSaving ? '保存中...' : '保存管理员账号'}
              </button>
            </div>
          </form>
        </section>

        <section className="card">
          <div className="platform-section-head"><h3>重置管理员密码</h3></div>
          <form onSubmit={handleResetPassword}>
            <div className="form-group">
              <label>管理员账号</label>
              <select
                value={passwordForm.admin_user_id}
                onChange={(event) => setPasswordForm((prev) => ({ ...prev, admin_user_id: event.target.value }))}
                required
              >
                <option value="">请选择管理员</option>
                {admins.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.email} ({item.admin_type})
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>新密码</label>
              <input
                type="password"
                autoComplete="new-password"
                value={passwordForm.new_password}
                onChange={(event) => setPasswordForm((prev) => ({ ...prev, new_password: event.target.value }))}
                placeholder="至少8位"
                required
              />
            </div>
            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={passwordForm.invalidate_sessions}
                  onChange={(event) =>
                    setPasswordForm((prev) => ({ ...prev, invalidate_sessions: event.target.checked }))
                  }
                />
                重置后使原会话失效
              </label>
            </div>
            <button className="btn" type="submit" disabled={passwordSaving}>
              {passwordSaving ? '提交中...' : '重置密码'}
            </button>
          </form>

          <div className="platform-section-head" style={{ marginTop: 20 }}>
            <h3>编辑管理员权限</h3>
          </div>
          <div className="form-group">
            <label>选择管理员（仅 ADMIN 可编辑）</label>
            <select value={permissionEditorAdminId} onChange={(event) => setPermissionEditorAdminId(event.target.value)}>
              <option value="">请选择管理员</option>
              {admins
                .filter((item) => item.admin_type === 'ADMIN')
                .map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.email}
                  </option>
                ))}
            </select>
          </div>
          {selectedAdmin?.admin_type === 'ADMIN' && (
            <>
              <div className="platform-permission-grid">
                {permissionCatalog.map((item) => (
                  <label key={item.key} className="platform-permission-item">
                    <input
                      type="checkbox"
                      checked={permissionKeys.includes(item.key)}
                      onChange={() => togglePermissionEditorKey(item.key)}
                    />
                    <span>{item.name}</span>
                  </label>
                ))}
              </div>
              <div className="platform-form-actions" style={{ marginTop: 12 }}>
                <button className="btn" disabled={permissionSaving} onClick={handleUpdatePermissions}>
                  {permissionSaving ? '保存中...' : '保存权限'}
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      <section className="card">
        <div className="platform-section-head"><h3>管理员列表</h3></div>
        <div className="platform-api-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>显示名</th>
                <th>类型</th>
                <th>状态</th>
                <th>最近登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((item) => (
                <tr key={item.id}>
                  <td>{item.email}</td>
                  <td>{item.display_name || '-'}</td>
                  <td>{item.admin_type}</td>
                  <td>
                    <span className={`status-tag ${item.is_active ? 'success' : 'warning'}`}>
                      {item.is_active ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </td>
                  <td>{item.last_login_at ? new Date(item.last_login_at).toLocaleString() : '-'}</td>
                  <td>
                    <div className="btn-group">
                      <button className="btn btn-secondary btn-sm" onClick={() => toggleAdminStatus(item)}>
                        {item.is_active ? '禁用' : '启用'}
                      </button>
                      {item.admin_type !== 'SUPER_ADMIN' && (
                        <button className="btn btn-danger btn-sm" onClick={() => deleteAdmin(item)}>
                          删除
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!admins.length && (
                <tr>
                  <td colSpan={6}>当前租户暂无管理员</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );

  const renderAiPointsSettingsCard = () => (
    <section className="card">
      <div className="platform-section-head"><h3>积分钱包</h3></div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
        设置新用户可用积分和充值兑换比例。
      </p>
      <div className="platform-form-grid">
        <div className="form-group">
          <label>新用户初始积分</label>
          <input
            type="number"
            min={0}
            step={1}
            value={initialPointsInput}
            onChange={(event) => setInitialPointsInput(event.target.value)}
          />
        </div>
        <div className="form-group">
          <label>充值汇率（1元=多少积分）</label>
          <input
            type="number"
            min={1}
            step={1}
            value={pointsPerYuanInput}
            onChange={(event) => setPointsPerYuanInput(event.target.value)}
          />
        </div>
        <div className="platform-form-actions platform-form-span-2">
          <button className="btn" type="button" disabled={pointsSettingsSaving} onClick={saveAiPointsSettings}>
            {pointsSettingsSaving ? '保存中...' : '保存积分设置'}
          </button>
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
            最近更新：{aiPointsSettings?.updated_at ? new Date(aiPointsSettings.updated_at).toLocaleString() : '未配置'}
          </span>
        </div>
      </div>
    </section>
  );

  const renderManualGrantAiPointsCard = () => (
    <section className="card">
      <div className="platform-section-head"><h3>手动赠送积分</h3></div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
        仅对当前应用生效。用于运营补偿、活动发放等场景，积分会写入统一账本。
      </p>
      <div className="platform-form-grid">
        <div className="form-group">
          <label>用户标识类型</label>
          <select
            value={manualGrantIdentityType}
            onChange={(event) => setManualGrantIdentityType(event.target.value as ManualGrantIdentityType)}
          >
            <option value="email">邮箱</option>
            <option value="user_id">用户ID</option>
            <option value="phone">手机号</option>
          </select>
        </div>
        <div className="form-group">
          <label>用户标识</label>
          <input
            value={manualGrantIdentityInput}
            onChange={(event) => setManualGrantIdentityInput(event.target.value)}
            placeholder={manualGrantIdentityType === 'email' ? 'user@example.com' : manualGrantIdentityType === 'user_id' ? '用户 UUID' : '13800000000'}
          />
        </div>
        <div className="form-group">
          <label>赠送积分</label>
          <input
            type="number"
            min={0.01}
            step={0.01}
            value={manualGrantAmountInput}
            onChange={(event) => setManualGrantAmountInput(event.target.value)}
          />
        </div>
        <div className="form-group">
          <label>备注（可选）</label>
          <input
            value={manualGrantReasonInput}
            onChange={(event) => setManualGrantReasonInput(event.target.value)}
            placeholder="例如：活动补偿"
          />
        </div>
        <div className="platform-form-actions platform-form-span-2">
          <button className="btn" type="button" disabled={manualGrantSubmitting} onClick={grantAiPointsToUser}>
            {manualGrantSubmitting ? '赠送中...' : '确认赠送'}
          </button>
        </div>
      </div>
    </section>
  );

  const renderAiRouting = () => (
    <div className="platform-page">
      <section className="card">
        <div className="platform-section-head">
          <h3>AI 模型</h3>
        </div>
      </section>

      <section className="card">
        <div className="platform-section-head"><h3>视频下载加速</h3></div>
        <div className="platform-form-grid">
          <label className="form-group">
            <span>启用</span>
            <input
              type="checkbox"
              checked={videoProxyEnabled}
              onChange={(event) => setVideoProxyEnabled(event.target.checked)}
            />
          </label>
          <div className="form-group">
            <label>保存天数</label>
            <input
              type="number"
              min={1}
              max={365}
              value={videoProxyRetentionDaysInput}
              onChange={(event) => setVideoProxyRetentionDaysInput(event.target.value)}
            />
          </div>
          <div className="form-group">
            <label>最大文件 MB</label>
            <input
              type="number"
              min={1}
              max={10240}
              value={videoProxyMaxFileMbInput}
              onChange={(event) => setVideoProxyMaxFileMbInput(event.target.value)}
            />
          </div>
          <div className="platform-form-actions platform-form-span-2">
            <button className="btn btn-primary btn-sm" type="button" onClick={saveVideoProxySettings} disabled={videoProxySaving}>
              {videoProxySaving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="platform-section-head"><h3>默认模型列表</h3></div>
        <div className="table-wrap">
          <table className="platform-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>主模型</th>
                <th>备用模型</th>
                <th>生效</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {DEFAULT_MODEL_SLOT_META.map((slot) => {
                const item = defaultModelSlotByKey.get(slot.key);
                const draft = defaultModelSlotDrafts[slot.key] || { primary_model_id: '', fallback_model_id: '' };
                const options = modelRoutes.filter(
                  (route) =>
                    route.model.is_active
                    && slot.capabilities.includes(route.model.capability)
                    && !(slot.key === 'tts' && isVoiceCloneApiType(route.model.api_type)),
                );
                const saving = defaultModelSlotSaving === slot.key;
                return (
                  <tr key={slot.key}>
                    <td>{slot.label}</td>
                    <td>
                      <select
                        value={draft.primary_model_id}
                        onChange={(event) => updateDefaultModelSlotDraft(slot.key, 'primary_model_id', event.target.value)}
                      >
                        <option value="">未设置</option>
                        {options.map((route) => (
                          <option key={route.model_id} value={route.model_id}>
                            {route.model.model_key}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={draft.fallback_model_id}
                        onChange={(event) => updateDefaultModelSlotDraft(slot.key, 'fallback_model_id', event.target.value)}
                      >
                        <option value="">未设置</option>
                        {options.map((route) => (
                          <option key={route.model_id} value={route.model_id}>
                            {route.model.model_key}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{item?.effective_model?.model_key || '未设置'}</td>
                    <td>
                      <button className="btn btn-sm" type="button" disabled={saving} onClick={() => saveDefaultModelSlot(slot.key)}>
                        {saving ? '保存中...' : '保存'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

    </div>
  );

  const feedbackStatusLabel = (status?: string | null) =>
    ({
      pending: '待处理',
      triaged: '已确认',
      in_progress: '处理中',
      resolved: '已解决',
      closed: '已关闭',
      useless: '无效',
      thanks: '已感谢',
      useful: '有用',
    })[String(status || '')] || status || '-';

  const feedbackPriorityLabel = (priority?: string | null) =>
    ({
      low: '低',
      normal: '普通',
      high: '高',
      urgent: '紧急',
    })[String(priority || '')] || priority || '-';

  const feedbackStatusClass = (status?: string | null) => {
    if (status === 'pending' || status === 'triaged') return 'warning';
    if (status === 'in_progress') return 'info';
    if (status === 'resolved' || status === 'thanks' || status === 'useful') return 'success';
    if (status === 'useless') return 'error';
    return '';
  };

  const siteMessageStatusLabel = (status?: string | null) =>
    ({
      new: '新消息',
      read: '已读',
      archived: '已归档',
    })[String(status || '')] || status || '-';

  const siteMessageStatusClass = (status?: string | null) => {
    if (status === 'new') return 'warning';
    if (status === 'read') return 'success';
    if (status === 'archived') return 'info';
    return '';
  };

  const consentRegionLabel = (region?: string | null) =>
    ({
      eu: '欧洲/英国',
      us: '美国/加州',
      other: '其他地区',
    })[String(region || '')] || region || '-';

  const renderEmail = () => (
    <div className="platform-page tenant-email-page">
      <section className="email-service-summary">
        <div><span>发件邮箱</span><strong>{emailSenders.length}</strong></div>
        <div><span>联系人</span><strong>{emailContacts.length}</strong></div>
        <div><span>模板</span><strong>{emailTemplates.length}</strong></div>
        <div><span>批次</span><strong>{emailCampaigns.length}</strong></div>
      </section>

      <section className="card">
        <div className="platform-section-head">
          <h3>发件设置</h3>
          <button className="btn btn-sm" type="button" onClick={() => void saveEmailSettings()} disabled={emailSaving}>
            {emailSaving ? '保存中...' : '保存'}
          </button>
        </div>
        <div className="platform-form-grid">
          <label>营销发件邮箱<select value={emailSettings.marketing_sender_id || ''} onChange={(event) => setEmailSettings((prev) => ({ ...prev, marketing_sender_id: event.target.value || null }))}><option value="">请选择</option>{emailSenders.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label>
          <label>通知发件邮箱<select value={emailSettings.notification_sender_id || ''} onChange={(event) => setEmailSettings((prev) => ({ ...prev, notification_sender_id: event.target.value || null }))}><option value="">请选择</option>{emailSenders.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label>
          <label>品牌名<input value={emailSettings.brand_name || ''} onChange={(event) => setEmailSettings((prev) => ({ ...prev, brand_name: event.target.value }))} /></label>
          <label>Reply-To<input value={emailSettings.reply_to_email || ''} onChange={(event) => setEmailSettings((prev) => ({ ...prev, reply_to_email: event.target.value }))} /></label>
          <label className="platform-form-span-2">退订地址<input value={emailSettings.unsubscribe_base_url || ''} onChange={(event) => setEmailSettings((prev) => ({ ...prev, unsubscribe_base_url: event.target.value }))} /></label>
          <label className="platform-form-span-2">页脚<textarea rows={2} value={emailSettings.footer_text || ''} onChange={(event) => setEmailSettings((prev) => ({ ...prev, footer_text: event.target.value }))} /></label>
        </div>
      </section>

      <div className="tenant-email-grid">
        <section className="card">
          <div className="platform-section-head">
            <h3>联系人</h3>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadEmailData()} disabled={emailLoading}>{emailLoading ? '刷新中...' : '刷新'}</button>
          </div>
          <textarea rows={5} value={emailContactsText} onChange={(event) => setEmailContactsText(event.target.value)} placeholder="user@example.com, 用户名" />
          <div className="platform-form-actions">
            <button className="btn btn-sm" type="button" onClick={() => void importEmailContacts()} disabled={emailSaving || !emailContactsText.trim()}>导入联系人</button>
          </div>
          <div className="tenant-email-list">
            {emailContacts.map((item) => (
              <div key={item.id} className="tenant-email-row">
                <div className="tenant-email-row-main"><strong>{item.display_name || item.email}</strong><span>{item.email}</span></div>
                <div className="btn-group">
                  <span className={`status-tag ${item.status === 'subscribed' ? 'success' : 'muted'}`}>{item.status}</span>
                  {item.status === 'subscribed' ? (
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => void updateEmailContactStatus(item, 'unsubscribed')} disabled={emailSaving}>退订</button>
                  ) : (
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => void updateEmailContactStatus(item, 'subscribed')} disabled={emailSaving}>恢复</button>
                  )}
                </div>
              </div>
            ))}
            {!emailContacts.length && <div className="loading">暂无联系人</div>}
          </div>
        </section>

        <section className="card">
          <div className="platform-section-head"><h3>模板</h3></div>
          <div className="platform-form-grid single-column">
            <label>名称<input value={emailTemplateForm.name} onChange={(event) => setEmailTemplateForm({ ...emailTemplateForm, name: event.target.value })} /></label>
            <label>标题<input value={emailTemplateForm.subject} onChange={(event) => setEmailTemplateForm({ ...emailTemplateForm, subject: event.target.value })} /></label>
            <label>HTML<textarea rows={6} value={emailTemplateForm.html} onChange={(event) => setEmailTemplateForm({ ...emailTemplateForm, html: event.target.value })} /></label>
            <button className="btn btn-sm" type="button" onClick={() => void saveEmailTemplate()} disabled={emailSaving}>保存模板</button>
          </div>
          <div className="tenant-email-list">
            {emailTemplates.map((item) => (
              <div key={item.id} className="tenant-email-row">
                <div className="tenant-email-row-main"><strong>{item.name}</strong><span>{item.subject}</span></div>
                <span className="status-tag success">{item.status}</span>
              </div>
            ))}
            {!emailTemplates.length && <div className="loading">暂无模板</div>}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="platform-section-head"><h3>邮件批次</h3></div>
        <div className="platform-form-grid">
          <label>批次名称<input value={emailCampaignForm.name} onChange={(event) => setEmailCampaignForm({ ...emailCampaignForm, name: event.target.value })} /></label>
          <label>模板<select value={emailCampaignForm.template_id} onChange={(event) => selectEmailCampaignTemplate(event.target.value)}><option value="">不使用模板</option>{emailTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>发件邮箱<select value={emailCampaignForm.sender_id} onChange={(event) => setEmailCampaignForm({ ...emailCampaignForm, sender_id: event.target.value })}><option value="">使用默认</option>{emailSenders.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label>
          <label>测试邮箱<input value={emailTestTo} onChange={(event) => setEmailTestTo(event.target.value)} /></label>
          <label>标题<input value={emailCampaignForm.subject} onChange={(event) => setEmailCampaignForm({ ...emailCampaignForm, subject: event.target.value })} /></label>
          <label className="platform-form-span-2">HTML<textarea rows={5} value={emailCampaignForm.html} onChange={(event) => setEmailCampaignForm({ ...emailCampaignForm, html: event.target.value })} /></label>
          <div className="platform-form-actions platform-form-span-2">
            <button className="btn btn-sm" type="button" onClick={() => void createEmailCampaign()} disabled={emailSaving}>创建批次</button>
          </div>
        </div>
        <div className="platform-api-table-wrap">
          <table className="table">
            <thead><tr><th>批次</th><th>发件邮箱</th><th>状态</th><th>结果</th><th>操作</th></tr></thead>
            <tbody>
              {emailCampaigns.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>{item.sender_email || '-'}</td>
                  <td><span className="status-tag">{item.status}</span></td>
                  <td>{item.delivered_count}/{item.recipient_total}，失败 {item.failed_count}，重试 {item.retry_count || 0}</td>
                  <td>
                    <div className="btn-group">
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => void scheduleEmailCampaign(item.id)} disabled={emailSaving || item.status !== 'draft'}>发送</button>
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => void cancelEmailCampaign(item.id)} disabled={emailSaving || !['draft', 'scheduled', 'paused'].includes(item.status)}>取消</button>
                    </div>
                  </td>
                </tr>
              ))}
              {!emailCampaigns.length && <tr><td colSpan={5}>暂无批次</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );

  const renderFeedback = () => (
    <div className="platform-page tenant-feedback-page">
      <section className="card tenant-feedback-toolbar">
        <div className="platform-section-head">
          <h3>用户反馈</h3>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadFeedbackData()} disabled={feedbackLoading}>
            {feedbackLoading ? '刷新中...' : '刷新'}
          </button>
        </div>
        <div className="tenant-feedback-summary">
          <button
            type="button"
            className={`tenant-feedback-summary-card ${feedbackStatusFilter === 'pending' ? 'active' : ''}`}
            onClick={() => {
              setFeedbackStatusFilter('pending');
              setFeedbackPage(1);
            }}
          >
            <span>待处理</span>
            <strong>{feedbackSummary.pending || 0}</strong>
          </button>
          <button
            type="button"
            className={`tenant-feedback-summary-card ${feedbackStatusFilter === 'in_progress' ? 'active' : ''}`}
            onClick={() => {
              setFeedbackStatusFilter('in_progress');
              setFeedbackPage(1);
            }}
          >
            <span>处理中</span>
            <strong>{feedbackSummary.in_progress || 0}</strong>
          </button>
          <button
            type="button"
            className={`tenant-feedback-summary-card ${feedbackStatusFilter === '' ? 'active' : ''}`}
            onClick={() => {
              setFeedbackStatusFilter('');
              setFeedbackPage(1);
            }}
          >
            <span>全部</span>
            <strong>{feedbackTotal}</strong>
          </button>
        </div>
        <div className="tenant-feedback-filter-row">
          <input
            value={feedbackQuery}
            onChange={(event) => {
              setFeedbackQuery(event.target.value);
              setFeedbackPage(1);
            }}
            placeholder="搜索标题、内容、用户"
          />
          <select
            value={feedbackStatusFilter}
            onChange={(event) => {
              setFeedbackStatusFilter(event.target.value);
              setFeedbackPage(1);
            }}
          >
            <option value="pending">待处理</option>
            <option value="triaged">已确认</option>
            <option value="in_progress">处理中</option>
            <option value="resolved">已解决</option>
            <option value="closed">已关闭</option>
            <option value="thanks">已感谢</option>
            <option value="useful">有用</option>
            <option value="useless">无效</option>
            <option value="">全部</option>
          </select>
          <select
            value={feedbackPriorityFilter}
            onChange={(event) => {
              setFeedbackPriorityFilter(event.target.value);
              setFeedbackPage(1);
            }}
          >
            <option value="">全部优先级</option>
            <option value="urgent">紧急</option>
            <option value="high">高</option>
            <option value="normal">普通</option>
            <option value="low">低</option>
          </select>
        </div>
      </section>

      <div className="tenant-feedback-workbench">
        <section className="card tenant-feedback-list-panel">
          <div className="platform-section-head"><h3>反馈队列</h3></div>
          {feedbackLoading ? <div className="loading">加载中...</div> : null}
          {!feedbackLoading && !feedbackItems.length ? <div className="loading">暂无反馈</div> : null}
          {!feedbackLoading && feedbackItems.length ? (
            <div className="tenant-feedback-list">
              {feedbackItems.map((item) => (
                <button
                  key={item.id}
                  className={`tenant-feedback-item ${selectedFeedbackId === item.id ? 'active' : ''}`}
                  type="button"
                  onClick={() => void loadFeedbackDetail(item.id)}
                >
                  <div className="tenant-feedback-item-head">
                    <strong>{item.title || item.content}</strong>
                    <span className={`status-tag ${feedbackStatusClass(item.status)}`}>{feedbackStatusLabel(item.status)}</span>
                  </div>
                  <p>{item.content}</p>
                  <div className="tenant-feedback-item-meta">
                    <span>{item.user_display_name || item.user_email || '-'}</span>
                    <span>{feedbackPriorityLabel(item.priority)}</span>
                    <span>{item.comment_count || 0} 条回复</span>
                    <span>{formatDateTime(item.updated_at)}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
          <div className="pagination">
            <button className="btn btn-secondary btn-sm" disabled={feedbackPage <= 1} onClick={() => setFeedbackPage((p) => Math.max(1, p - 1))}>
              上一页
            </button>
            <span>第 {feedbackPage} 页 / 共 {Math.max(Math.ceil(feedbackTotal / 20), 1)} 页</span>
            <button
              className="btn btn-secondary btn-sm"
              disabled={feedbackPage >= Math.max(Math.ceil(feedbackTotal / 20), 1)}
              onClick={() => setFeedbackPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
        </section>

        <section className="card tenant-feedback-detail-panel">
          <div className="platform-section-head"><h3>反馈详情</h3></div>
          {feedbackDetailLoading ? <div className="loading">加载中...</div> : null}
          {!feedbackDetailLoading && !selectedFeedback ? <div className="loading">选择一条反馈</div> : null}
          {selectedFeedback ? (
            <div className="tenant-feedback-detail">
              <div>
                <h4>{selectedFeedback.title || '未命名反馈'}</h4>
                <div className="btn-group">
                  <span className={`status-tag ${feedbackStatusClass(selectedFeedback.status)}`}>
                    {feedbackStatusLabel(selectedFeedback.status)}
                  </span>
                  <span className="status-tag">{feedbackPriorityLabel(selectedFeedback.priority)}</span>
                  {selectedFeedback.reward_points ? <span className="status-tag success">+{selectedFeedback.reward_points}</span> : null}
                </div>
              </div>
              <div className="tenant-feedback-content">{selectedFeedback.content}</div>
              <div className="tenant-feedback-user">
                <span>{selectedFeedback.user_display_name || '-'}</span>
                <strong>{selectedFeedback.user_email || selectedFeedback.user_id}</strong>
              </div>
              <div className="platform-form-grid compact">
                <div className="form-group">
                  <label>状态</label>
                  <select
                    value={selectedFeedback.status}
                    onChange={(event) => void updateFeedback({ status: event.target.value as PlatformAppFeedbackItem['status'] })}
                    disabled={feedbackActingId === selectedFeedback.id}
                  >
                    <option value="pending">待处理</option>
                    <option value="triaged">已确认</option>
                    <option value="in_progress">处理中</option>
                    <option value="resolved">已解决</option>
                    <option value="closed">已关闭</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>优先级</label>
                  <select
                    value={selectedFeedback.priority}
                    onChange={(event) => void updateFeedback({ priority: event.target.value as PlatformAppFeedbackItem['priority'] })}
                    disabled={feedbackActingId === selectedFeedback.id}
                  >
                    <option value="urgent">紧急</option>
                    <option value="high">高</option>
                    <option value="normal">普通</option>
                    <option value="low">低</option>
                  </select>
                </div>
              </div>
              {isAppSuperAdmin && ['pending', 'triaged', 'in_progress'].includes(selectedFeedback.status) ? (
                <div className="tenant-feedback-review-actions">
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => void reviewFeedback(selectedFeedback.id, 'useless')}>
                    无效
                  </button>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => void reviewFeedback(selectedFeedback.id, 'thanks')}>
                    感谢
                  </button>
                  <button className="btn btn-sm" type="button" onClick={() => void reviewFeedback(selectedFeedback.id, 'useful')}>
                    有用
                  </button>
                </div>
              ) : null}
              <div className="form-group">
                <label>处理备注</label>
                <textarea value={feedbackNote} onChange={(event) => setFeedbackNote(event.target.value)} rows={3} />
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  onClick={() => void updateFeedback({ note: feedbackNote })}
                  disabled={feedbackActingId === selectedFeedback.id}
                >
                  保存备注
                </button>
              </div>
              <div className="tenant-feedback-comments">
                {feedbackComments.map((comment) => (
                  <div key={comment.id} className="tenant-feedback-comment">
                    <div>
                      {comment.author_display_name || comment.author_email || '-'} · {formatDateTime(comment.created_at)}
                      {comment.is_internal ? ' · 内部备注' : ''}
                    </div>
                    <p>{comment.body}</p>
                  </div>
                ))}
              </div>
              <div className="form-group">
                <label>{feedbackCommentInternal ? '内部备注' : '回复'}</label>
                <textarea value={feedbackCommentBody} onChange={(event) => setFeedbackCommentBody(event.target.value)} rows={3} />
                <div className="tenant-feedback-reply-actions">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={feedbackCommentInternal}
                      onChange={(event) => setFeedbackCommentInternal(event.target.checked)}
                    />
                    内部备注
                  </label>
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => void addFeedbackComment()}
                    disabled={feedbackActingId === selectedFeedback.id}
                  >
                    发送
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );

  const renderSite = () => {
    const macos = siteSettings.downloads?.macos || {};
    const windows = siteSettings.downloads?.windows || {};
    return (
      <div className="platform-page tenant-site-page">
        <section className="tenant-site-top-grid">
          <div className="card tenant-site-settings-card">
            <div className="platform-section-head">
              <h3>官网配置</h3>
              <button className="btn btn-sm" type="button" onClick={() => void saveSiteSettings()} disabled={siteSettingsSaving}>
                {siteSettingsSaving ? '保存中...' : '保存'}
              </button>
            </div>
            <div className="platform-form-grid compact">
              <div className="form-group">
                <label>支持邮箱</label>
                <input
                  value={siteSettings.support_email || ''}
                  onChange={(event) => setSiteSettings((prev) => ({ ...prev, support_email: event.target.value }))}
                  placeholder="support@example.com"
                />
              </div>
              <div className="form-group">
                <label>登录地址</label>
                <input
                  value={siteSettings.login_url || ''}
                  onChange={(event) => setSiteSettings((prev) => ({ ...prev, login_url: event.target.value }))}
                  placeholder="https://app.example.com/login"
                />
              </div>
              <div className="form-group">
                <label>应用 Deep Link</label>
                <input
                  value={siteSettings.app_deep_link || ''}
                  onChange={(event) => setSiteSettings((prev) => ({ ...prev, app_deep_link: event.target.value }))}
                  placeholder="myapp://open"
                />
              </div>
              <div className="form-group">
                <label>协议更新时间</label>
                <input
                  value={siteSettings.legal?.updated_at || ''}
                  onChange={(event) => patchSiteLegal('updated_at', event.target.value)}
                  placeholder="2026-05-03"
                />
              </div>
              <div className="form-group">
                <label>隐私联系邮箱</label>
                <input
                  value={siteSettings.legal?.privacy_contact || ''}
                  onChange={(event) => patchSiteLegal('privacy_contact', event.target.value)}
                  placeholder="privacy@example.com"
                />
              </div>
              <div className="form-group">
                <label>条款联系邮箱</label>
                <input
                  value={siteSettings.legal?.terms_contact || ''}
                  onChange={(event) => patchSiteLegal('terms_contact', event.target.value)}
                  placeholder="legal@example.com"
                />
              </div>
            </div>
          </div>

          <div className="card tenant-site-summary-card">
            <div className="platform-section-head"><h3>站点状态</h3></div>
            <div className="tenant-site-summary-grid">
              <div><span>官网消息</span><strong>{siteMessagesSummary?.total || 0}</strong></div>
              <div><span>新消息</span><strong>{siteMessagesSummary?.new || 0}</strong></div>
              <div><span>Cookie 偏好</span><strong>{siteCookieConsentSummary?.total || 0}</strong></div>
              <div><span>拒绝出售/共享</span><strong>{siteCookieConsentSummary?.do_not_sell_share || 0}</strong></div>
            </div>
          </div>
        </section>

        <section className="card tenant-site-doc-card">
          <div className="platform-section-head"><h3>操作说明</h3></div>
          <div className="tenant-site-doc-grid">
            <div>
              <h4>基础配置</h4>
              <p>支持邮箱会显示在官网联系入口和协议联系信息里。登录地址用于官网跳转到产品登录页，Deep Link 用于桌面端或移动端打开应用。</p>
            </div>
            <div>
              <h4>安装包发布</h4>
              <p>macOS 和 Windows 安装包必须通过上传发布。上传完成后系统会写入 OSS 链接、文件名、文件大小和更新时间，下载地址不能手动填写。</p>
            </div>
            <div>
              <h4>API 发布</h4>
              <p>API 调用也需要先申请临时上传地址，再把文件 PUT 到返回的地址，最后用返回的 file_url 和 file_key 确认发布。请求使用平台管理员的 Bearer Token，macos 可替换为 windows。</p>
              <code>POST /api/v1/platform-admin/apps/{`{app_id}`}/site/downloads/macos/upload-url</code>
              <code>POST /api/v1/platform-admin/apps/{`{app_id}`}/site/downloads/macos/confirm-upload</code>
            </div>
            <div>
              <h4>站点消息</h4>
              <p>官网订阅和联系表单会进入官网消息。处理后可标记已读或归档，Cookie 偏好用于查看访客同意记录。</p>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="platform-section-head"><h3>下载链接</h3></div>
          <div className="tenant-download-grid">
            {([
              ['macos', 'macOS', macos],
              ['windows', 'Windows', windows],
            ] as const).map(([platform, label, item]) => (
              <div key={platform} className="tenant-download-card">
                <div className="tenant-download-card-head">
                  <strong>{label}</strong>
                  <span>{item.version || '未设置版本'}</span>
                </div>
                <div className="platform-form-grid compact">
                  <div className="form-group">
                    <label>按钮文案</label>
                    <input value={item.label || ''} onChange={(event) => patchSiteDownload(platform, 'label', event.target.value)} placeholder={`Download for ${label}`} />
                  </div>
                  <div className="form-group">
                    <label>版本</label>
                    <input value={item.version || ''} onChange={(event) => patchSiteDownload(platform, 'version', event.target.value)} placeholder="v1.0.0" />
                  </div>
                  <div className="form-group platform-form-span-2">
                    <label>安装包</label>
                    <div className="tenant-package-upload-row">
                      <input value={item.url || ''} readOnly placeholder="上传后自动生成 OSS 链接" />
                      <label className={`btn btn-secondary btn-sm tenant-package-upload-button ${sitePackageUploading === platform ? 'disabled' : ''}`}>
                        {sitePackageUploading === platform ? '上传中...' : '上传'}
                        <input
                          type="file"
                          disabled={Boolean(sitePackageUploading)}
                          onChange={(event) => {
                            const file = event.target.files?.[0] || null;
                            event.currentTarget.value = '';
                            void uploadSitePackage(platform, file);
                          }}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="form-group">
                    <label>文件名</label>
                    <input value={item.file_name || ''} onChange={(event) => patchSiteDownload(platform, 'file_name', event.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>文件大小</label>
                    <input value={item.file_size || ''} onChange={(event) => patchSiteDownload(platform, 'file_size', event.target.value)} placeholder="120 MB" />
                  </div>
                  <div className="form-group">
                    <label>最低系统</label>
                    <input value={item.minimum_os || ''} onChange={(event) => patchSiteDownload(platform, 'minimum_os', event.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>架构</label>
                    <input value={item.architecture || ''} onChange={(event) => patchSiteDownload(platform, 'architecture', event.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>更新时间</label>
                    <input value={item.updated_at || ''} onChange={(event) => patchSiteDownload(platform, 'updated_at', event.target.value)} placeholder="2026-05-03" />
                  </div>
                  <div className="form-group platform-form-span-2">
                    <label>校验值</label>
                    <input value={item.checksum || ''} onChange={(event) => patchSiteDownload(platform, 'checksum', event.target.value)} placeholder="SHA-256" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="tenant-site-workbench">
          <section className="card tenant-site-message-panel">
            <div className="platform-section-head">
              <h3>官网消息</h3>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadSiteMessages()} disabled={siteMessagesLoading}>
                {siteMessagesLoading ? '刷新中...' : '刷新'}
              </button>
            </div>
            <div className="tenant-site-filter-row">
              <input
                value={siteMessageSearchInput}
                onChange={(event) => { setSiteMessageSearchInput(event.target.value); setSiteMessagesPage(1); }}
                placeholder="搜索邮箱、姓名、主题或内容"
              />
              <select value={siteMessageTypeFilter} onChange={(event) => { setSiteMessageTypeFilter(event.target.value); setSiteMessagesPage(1); }}>
                <option value="">全部类型</option>
                <option value="newsletter">订阅</option>
                <option value="contact">联系</option>
              </select>
              <select value={siteMessageStatusFilter} onChange={(event) => { setSiteMessageStatusFilter(event.target.value); setSiteMessagesPage(1); }}>
                <option value="new">新消息</option>
                <option value="read">已读</option>
                <option value="archived">已归档</option>
                <option value="">全部状态</option>
              </select>
              <select value={siteMessageCategoryFilter} onChange={(event) => { setSiteMessageCategoryFilter(event.target.value); setSiteMessagesPage(1); }}>
                <option value="">全部分类</option>
                <option value="support">Support</option>
                <option value="partnership">Partnership</option>
                <option value="press">Press</option>
                <option value="security">Security</option>
              </select>
            </div>
            {siteMessagesLoading ? <div className="loading">加载中...</div> : null}
            {!siteMessagesLoading && !siteMessages.length ? <div className="loading">暂无官网消息</div> : null}
            {!siteMessagesLoading && siteMessages.length ? (
              <div className="tenant-site-message-list">
                {siteMessages.map((item) => (
                  <article key={item.id} className="tenant-site-message-card">
                    <div className="tenant-site-message-main">
                      <div className="tenant-site-message-head">
                        <span>{item.type === 'newsletter' ? '订阅' : '联系'}</span>
                        <strong>{item.subject || item.email || '-'}</strong>
                      </div>
                      <p>{item.message || item.source || '-'}</p>
                      <div className="tenant-site-message-meta">
                        <span>{item.name || '-'}</span>
                        <span>{item.email || '-'}</span>
                        <span>{formatDateTime(item.created_at)}</span>
                      </div>
                    </div>
                    <div className="tenant-site-message-actions">
                      <span className={`status-tag ${siteMessageStatusClass(item.status)}`}>{siteMessageStatusLabel(item.status)}</span>
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => void updateSiteMessageStatus(item.id, 'read')} disabled={siteMessageActingId === item.id || item.status === 'read'}>
                        已读
                      </button>
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => void updateSiteMessageStatus(item.id, 'archived')} disabled={siteMessageActingId === item.id || item.status === 'archived'}>
                        归档
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
            <div className="pagination">
              <button className="btn btn-secondary btn-sm" disabled={siteMessagesPage <= 1} onClick={() => setSiteMessagesPage((p) => Math.max(1, p - 1))}>
                上一页
              </button>
              <span>第 {siteMessagesPage} 页 / 共 {Math.max(Math.ceil(siteMessagesTotal / 20), 1)} 页</span>
              <button
                className="btn btn-secondary btn-sm"
                disabled={siteMessagesPage >= Math.max(Math.ceil(siteMessagesTotal / 20), 1)}
                onClick={() => setSiteMessagesPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          </section>

          <section className="card tenant-site-cookie-panel">
            <div className="platform-section-head">
              <h3>Cookie 偏好</h3>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadSiteCookieConsents()} disabled={siteCookieConsentsLoading}>
                {siteCookieConsentsLoading ? '刷新中...' : '刷新'}
              </button>
            </div>
            <div className="tenant-site-filter-row compact">
              <select value={siteCookieConsentRegionFilter} onChange={(event) => { setSiteCookieConsentRegionFilter(event.target.value); setSiteCookieConsentPage(1); }}>
                <option value="">全部地区</option>
                <option value="eu">欧洲/英国</option>
                <option value="us">美国/加州</option>
                <option value="other">其他地区</option>
              </select>
            </div>
            {siteCookieConsentSummary ? (
              <div className="tenant-cookie-summary">
                <div><span>分析同意</span><strong>{siteCookieConsentSummary.analytics_enabled}</strong></div>
                <div><span>营销同意</span><strong>{siteCookieConsentSummary.marketing_enabled}</strong></div>
                <div><span>拒绝出售/共享</span><strong>{siteCookieConsentSummary.do_not_sell_share}</strong></div>
              </div>
            ) : null}
            {siteCookieConsentsLoading ? <div className="loading">加载中...</div> : null}
            {!siteCookieConsentsLoading && !siteCookieConsents.length ? <div className="loading">暂无 Cookie 偏好</div> : null}
            {!siteCookieConsentsLoading && siteCookieConsents.length ? (
              <div className="tenant-cookie-list">
                {siteCookieConsents.map((item) => (
                  <article key={item.id} className="tenant-cookie-card">
                    <div>
                      <strong>{consentRegionLabel(item.region_mode)}</strong>
                      <span>{item.source || '-'}</span>
                    </div>
                    <div className="tenant-cookie-prefs">
                      <span>Essential {item.essential ? 'on' : 'off'}</span>
                      <span>Analytics {item.analytics ? 'on' : 'off'}</span>
                      <span>Marketing {item.marketing ? 'on' : 'off'}</span>
                      {item.do_not_sell_share ? <span>拒绝出售/共享</span> : null}
                    </div>
                    <time>{formatDateTime(item.updated_at)}</time>
                  </article>
                ))}
              </div>
            ) : null}
            <div className="pagination">
              <button className="btn btn-secondary btn-sm" disabled={siteCookieConsentPage <= 1} onClick={() => setSiteCookieConsentPage((p) => Math.max(1, p - 1))}>
                上一页
              </button>
              <span>第 {siteCookieConsentPage} 页</span>
              <button
                className="btn btn-secondary btn-sm"
                disabled={siteCookieConsents.length < 20}
                onClick={() => setSiteCookieConsentPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  };

  const renderPackageEditor = () => (
    <section className="card">
      <div className="platform-section-head">
        <h3>{packageForm.id ? '编辑产品' : '创建产品'}</h3>
        <div className="btn-group">
          <button className="btn btn-secondary btn-sm" type="button" onClick={closePackagePage}>
            返回产品列表
          </button>
        </div>
      </div>
      <form onSubmit={savePackage} className="platform-form-grid">
        <div className="form-group platform-form-span-2">
          <label>产品名称</label>
          <input
            value={packageForm.name}
            onChange={(event) => setPackageForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="例如：年度会员"
            required
          />
        </div>
        <div className="form-group platform-form-span-2">
          <label>产品说明</label>
          <textarea
            rows={2}
            value={packageForm.description}
            onChange={(event) => setPackageForm((prev) => ({ ...prev, description: event.target.value }))}
            placeholder="可选描述"
          />
        </div>
        <div className="form-group platform-form-span-2">
          <label>产品封面</label>
          <input
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void uploadPackageCover(file);
              }
              event.currentTarget.value = '';
            }}
          />
          {packageCoverUploading ? <p className="form-note" style={{ marginTop: 8 }}>封面上传中...</p> : null}
          <input
            value={packageForm.cover_url}
            onChange={(event) => setPackageForm((prev) => ({ ...prev, cover_url: event.target.value }))}
            placeholder="封面 URL（可手动填写）"
          />
          {packageForm.cover_url ? (
            <div style={{ marginTop: 10 }}>
              <img
                src={packageForm.cover_url}
                alt="产品封面预览"
                style={{ width: 160, height: 96, objectFit: 'cover', borderRadius: 10, border: '1px solid #e3dcc7' }}
              />
            </div>
          ) : (
            <p className="form-note" style={{ marginTop: 8 }}>建议上传 16:9 比例封面，用于产品展示。</p>
          )}
        </div>
        <div className="form-group">
          <label>会员类型</label>
          <select
            value={packageForm.membership_scope}
            onChange={(event) =>
              setPackageForm((prev) => ({
                ...prev,
                membership_scope: event.target.value as PlatformRedeemGrantScope,
              }))
            }
          >
            <option value="app_membership">{MEMBERSHIP_SCOPE_LABELS.app_membership}</option>
            <option value="ai_membership">{MEMBERSHIP_SCOPE_LABELS.ai_membership}</option>
          </select>
        </div>
        <div className="form-group">
          <label>售价（元）</label>
          <input
            type="number"
            min={0}
            step={0.01}
            value={packageForm.price_cny}
            onChange={(event) => setPackageForm((prev) => ({ ...prev, price_cny: event.target.value }))}
            placeholder="例如：99.00"
            required
          />
        </div>
        <div className="form-group">
          <label>支付模式</label>
          <select
            value={packageForm.payment_type}
            onChange={(event) =>
              setPackageForm((prev) => ({ ...prev, payment_type: event.target.value as 'ONE_TIME' | 'RECURRING' }))
            }
          >
            <option value="ONE_TIME">单次支付</option>
            <option value="RECURRING">周期扣款（会员）</option>
          </select>
        </div>
        <div className="form-group">
          <label>会员有效天数（支付发放）</label>
          <input
            type="number"
            min={0}
            value={packageForm.membership_days}
            onChange={(event) =>
              setPackageForm((prev) => ({ ...prev, membership_days: Math.max(Number(event.target.value || 0), 0) }))
            }
          />
          <div className="platform-form-actions" style={{ marginTop: 8 }}>
            <button className="btn btn-secondary btn-sm" type="button" onClick={applyLifetimeMembershipToPackageForm}>
              永久会员
            </button>
          </div>
        </div>
        {packageForm.payment_type === 'RECURRING' && (
          <>
            <div className="form-group">
              <label>扣款周期单位</label>
              <select
                value={packageForm.period_type}
                onChange={(event) =>
                  setPackageForm((prev) => ({
                    ...prev,
                    period_type: event.target.value as 'DAY' | 'WEEK' | 'MONTH' | 'YEAR',
                  }))
                }
              >
                <option value="DAY">天</option>
                <option value="WEEK">周</option>
                <option value="MONTH">月</option>
                <option value="YEAR">年</option>
              </select>
            </div>
            <div className="form-group">
              <label>每周期长度</label>
              <input
                type="number"
                min={1}
                value={packageForm.period}
                onChange={(event) =>
                  setPackageForm((prev) => ({ ...prev, period: Math.max(Number(event.target.value || 1), 1) }))
                }
              />
            </div>
            <div className="form-group">
              <label>签约场景</label>
              <input
                value={packageForm.sign_scene}
                onChange={(event) => setPackageForm((prev) => ({ ...prev, sign_scene: event.target.value }))}
                placeholder="INDUSTRY|DIGITAL_MEDIA"
              />
            </div>
            <div className="form-group">
              <label>签约有效期（天）</label>
              <input
                type="number"
                min={1}
                value={packageForm.sign_validity_period}
                onChange={(event) =>
                  setPackageForm((prev) => ({
                    ...prev,
                    sign_validity_period: Math.max(Number(event.target.value || 1), 1),
                  }))
                }
              />
            </div>
            <div className="form-group">
              <label>首次执行时间（可选）</label>
              <input
                value={packageForm.execute_time}
                onChange={(event) => setPackageForm((prev) => ({ ...prev, execute_time: event.target.value }))}
                placeholder="HH:mm 或 HH:mm:ss"
              />
            </div>
          </>
        )}
        <div className="form-group platform-form-span-2">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={packageForm.is_active}
              onChange={(event) => setPackageForm((prev) => ({ ...prev, is_active: event.target.checked }))}
            />
            产品启用
          </label>
          <label className="checkbox-label" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={packageForm.payment_enabled}
              onChange={(event) => setPackageForm((prev) => ({ ...prev, payment_enabled: event.target.checked }))}
            />
            启用支付（关闭后将不会被支付端上架）
          </label>
        </div>

        <div className="platform-form-actions platform-form-span-2">
          <button className="btn" type="submit" disabled={packageSaving}>
            {packageSaving ? '保存中...' : packageForm.id ? '更新产品' : '创建产品'}
          </button>
          <button className="btn btn-secondary" type="button" onClick={closePackagePage}>
            取消
          </button>
        </div>
      </form>
    </section>
  );

  const renderCodeBatchCreate = () => (
    <section className="card">
      <div className="platform-section-head">
        <h3>创建兑换码批次</h3>
        <div className="btn-group">
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => goRedeemSubPage('code-batches')}>
            返回批次列表
          </button>
        </div>
      </div>
      <form onSubmit={createBatch} className="platform-form-grid">
        <div className="form-group">
          <label>批次名称</label>
          <input
            value={batchForm.name}
            onChange={(event) => setBatchForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="可选"
          />
        </div>
        <div className="form-group">
          <label>数量</label>
          <input
            type="number"
            min={1}
            max={5000}
            value={batchForm.count}
            onChange={(event) => setBatchForm((prev) => ({ ...prev, count: Number(event.target.value || 0) }))}
          />
        </div>
        <div className="form-group">
          <label>最大使用次数</label>
          <input
            type="number"
            min={1}
            max={1000}
            value={batchForm.max_uses}
            onChange={(event) => setBatchForm((prev) => ({ ...prev, max_uses: Number(event.target.value || 1) }))}
          />
        </div>
        <div className="form-group">
          <label>前缀</label>
          <input
            value={batchForm.code_prefix}
            onChange={(event) => setBatchForm((prev) => ({ ...prev, code_prefix: event.target.value }))}
            placeholder="可选"
          />
        </div>
        <div className="form-group platform-form-span-2">
          <label>有效期（可选）</label>
          <input
            type="datetime-local"
            value={batchForm.expires_at}
            onChange={(event) => setBatchForm((prev) => ({ ...prev, expires_at: event.target.value }))}
          />
        </div>
        <div className="form-group platform-form-span-2">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={batchForm.use_package}
              onChange={(event) => setBatchForm((prev) => ({ ...prev, use_package: event.target.checked }))}
            />
            使用产品生成
          </label>
        </div>
        {batchForm.use_package ? (
          <div className="form-group platform-form-span-2">
            <label>选择产品</label>
            <select
              value={batchForm.package_id}
              onChange={(event) => setBatchForm((prev) => ({ ...prev, package_id: event.target.value }))}
            >
              <option value="">请选择产品</option>
              {redeemPackages
                .filter((item) => item.is_active)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}（{formatCurrencyCny(item.price_cny)}）
                  </option>
                ))}
            </select>
          </div>
        ) : (
          <>
            <div className="form-group">
              <label>会员类型</label>
              <select
                value={batchForm.custom_membership_scope}
                onChange={(event) =>
                  setBatchForm((prev) => ({
                    ...prev,
                    custom_membership_scope: event.target.value as PlatformRedeemGrantScope,
                  }))
                }
              >
                <option value="app_membership">{MEMBERSHIP_SCOPE_LABELS.app_membership}</option>
                <option value="ai_membership">{MEMBERSHIP_SCOPE_LABELS.ai_membership}</option>
              </select>
            </div>
            <div className="form-group">
              <label>有效天数</label>
              <input
                type="number"
                min={1}
                value={batchForm.custom_membership_days}
                onChange={(event) =>
                  setBatchForm((prev) => ({
                    ...prev,
                    custom_membership_days: Math.max(Number(event.target.value || 1), 1),
                  }))
                }
              />
            </div>
          </>
        )}

        <div className="form-group platform-form-span-2">
          <label>备注（可选）</label>
          <textarea
            rows={2}
            value={batchForm.note}
            onChange={(event) => setBatchForm((prev) => ({ ...prev, note: event.target.value }))}
          />
        </div>
        <div className="platform-form-actions platform-form-span-2">
          <button className="btn" type="submit" disabled={batchSaving}>
            {batchSaving ? '生成中...' : '生成兑换码'}
          </button>
        </div>
      </form>

      {!!lastGeneratedCodes.length && (
        <div style={{ marginTop: 16 }}>
          <div className="platform-section-head"><h3>最近生成（前 30 条）</h3></div>
          <div className="platform-detail">
            {lastGeneratedCodes.slice(0, 30).map((code) => (
              <div key={code} className="platform-detail-row">
                <strong>{code}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );


  const renderAcquisition = () => (
    <div className="platform-page">
      <section className="card">
        <div className="platform-section-head">
          <h3>用户来源</h3>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadAcquisitionData()} disabled={acquisitionLoading}>
            {acquisitionLoading ? '刷新中...' : '刷新'}
          </button>
        </div>
        <div className="tenant-feedback-summary">
          <button type="button" className="tenant-feedback-summary-card active">
            <span>已提交</span>
            <strong>{acquisitionSummary?.total || 0}</strong>
          </button>
          <button type="button" className="tenant-feedback-summary-card active">
            <span>用户数</span>
            <strong>{acquisitionSummary?.users || 0}</strong>
          </button>
          <button type="button" className="tenant-feedback-summary-card active">
            <span>来源选项</span>
            <strong>{acquisitionOptions.length}</strong>
          </button>
        </div>
      </section>

      <div className="platform-grid-two tenants-layout">
        <section className="card">
          <div className="platform-section-head">
            <h3>{acquisitionEditingId ? '编辑来源' : '新增来源'}</h3>
            {acquisitionEditingId ? (
              <button className="btn btn-secondary btn-sm" type="button" onClick={resetAcquisitionOptionForm}>
                取消
              </button>
            ) : null}
          </div>
          <form className="platform-form-grid compact" onSubmit={saveAcquisitionOption}>
            <div className="form-group">
              <label>来源标识</label>
              <input
                value={acquisitionOptionForm.key}
                onChange={(event) => setAcquisitionOptionForm((prev) => ({ ...prev, key: event.target.value }))}
                placeholder="xiaohongshu"
                required
              />
            </div>
            <div className="form-group">
              <label>显示名称</label>
              <input
                value={acquisitionOptionForm.label}
                onChange={(event) => setAcquisitionOptionForm((prev) => ({ ...prev, label: event.target.value }))}
                placeholder="小红书"
                required
              />
            </div>
            <div className="form-group">
              <label>排序</label>
              <input
                type="number"
                min={0}
                value={acquisitionOptionForm.sort_order}
                onChange={(event) => setAcquisitionOptionForm((prev) => ({ ...prev, sort_order: event.target.value }))}
              />
            </div>
            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={acquisitionOptionForm.is_active}
                  onChange={(event) => setAcquisitionOptionForm((prev) => ({ ...prev, is_active: event.target.checked }))}
                />
                启用
              </label>
              <label className="checkbox-label" style={{ marginTop: 10 }}>
                <input
                  type="checkbox"
                  checked={acquisitionOptionForm.allow_free_text}
                  onChange={(event) => setAcquisitionOptionForm((prev) => ({ ...prev, allow_free_text: event.target.checked }))}
                />
                允许补充说明
              </label>
            </div>
            <div className="platform-form-actions platform-form-span-2">
              <button className="btn btn-sm" type="submit" disabled={acquisitionSaving}>
                {acquisitionSaving ? '保存中...' : '保存来源'}
              </button>
            </div>
          </form>

          <div className="tenant-route-grid" style={{ marginTop: 12 }}>
            {acquisitionOptions.map((item) => (
              <article className="tenant-route-card" key={item.id}>
                <div className="tenant-route-card-head">
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.key}</span>
                  </div>
                  <span className={`status-tag ${item.is_active ? 'success' : ''}`}>{item.is_active ? '启用' : '停用'}</span>
                </div>
                <div className="tenant-route-card-meta">
                  <span>排序 {item.sort_order}</span>
                  <span>{item.allow_free_text ? '可填写说明' : '固定选项'}</span>
                </div>
                <div className="platform-form-actions">
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => editAcquisitionOption(item)}>
                    编辑
                  </button>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => void removeAcquisitionOption(item)}>
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="platform-section-head"><h3>来源统计</h3></div>
          {acquisitionLoading ? <div className="loading">加载中...</div> : null}
          {!acquisitionLoading && !(acquisitionSummary?.by_source || []).length ? <div className="loading">暂无提交记录</div> : null}
          {!!acquisitionSummary?.by_source?.length && (
            <div className="platform-detail">
              {acquisitionSummary.by_source.map((item) => (
                <button
                  type="button"
                  key={item.source_key}
                  className="platform-detail-row"
                  onClick={() => {
                    setAcquisitionSourceFilter(item.source_key);
                    setAcquisitionPage(1);
                  }}
                >
                  <span>{item.source_label}</span>
                  <strong>{item.users} 人</strong>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <div className="platform-section-head"><h3>提交记录</h3></div>
        <div className="tenant-feedback-filter-row">
          <input
            value={acquisitionQuery}
            onChange={(event) => {
              setAcquisitionQuery(event.target.value);
              setAcquisitionPage(1);
            }}
            placeholder="搜索用户或补充说明"
          />
          <select
            value={acquisitionSourceFilter}
            onChange={(event) => {
              setAcquisitionSourceFilter(event.target.value);
              setAcquisitionPage(1);
            }}
          >
            <option value="">全部来源</option>
            {acquisitionOptions.map((item) => (
              <option key={item.id} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>用户</th>
                <th>来源</th>
                <th>UTM</th>
                <th>入口</th>
                <th>提交时间</th>
              </tr>
            </thead>
            <tbody>
              {acquisitionUsers.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.user_display_name || item.user_email || item.user_id}</strong>
                    <div>{item.user_email || item.user_id}</div>
                  </td>
                  <td>
                    <strong>{item.source_label}</strong>
                    <div>{item.free_text || item.source_key}</div>
                  </td>
                  <td>
                    <div>{item.utm_source || '-'}</div>
                    <div>{item.utm_campaign || item.utm_medium || '-'}</div>
                  </td>
                  <td>
                    <div>{item.landing_path || '-'}</div>
                    <div>{item.referrer || '-'}</div>
                  </td>
                  <td>{formatDateTime(item.submitted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!acquisitionLoading && !acquisitionUsers.length ? <div className="loading">暂无提交记录</div> : null}
        </div>
        <div className="pagination">
          <button className="btn btn-secondary btn-sm" disabled={acquisitionPage <= 1} onClick={() => setAcquisitionPage((p) => Math.max(1, p - 1))}>
            上一页
          </button>
          <span>第 {acquisitionPage} 页 / 共 {Math.max(Math.ceil(acquisitionUsersTotal / 20), 1)} 页</span>
          <button
            className="btn btn-secondary btn-sm"
            disabled={acquisitionPage >= Math.max(Math.ceil(acquisitionUsersTotal / 20), 1)}
            onClick={() => setAcquisitionPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      </section>
    </div>
  );

  const renderRedeemProducts = () => (
    <section className="card">
      <div className="platform-section-head"><h3>产品列表</h3></div>
      <div className="platform-api-table-wrap">
        <table className="table redeem-products-table">
          <thead>
            <tr>
              <th className="rp-col-cover">封面</th>
              <th className="rp-col-name">名称</th>
              <th className="rp-col-language">会员类型</th>
              <th className="rp-col-price">售价</th>
              <th className="rp-col-payment">支付</th>
              <th className="rp-col-status">状态</th>
              <th className="rp-col-grants">有效天数</th>
              <th className="rp-col-updated">更新时间</th>
              <th className="rp-col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {redeemPackages.map((item) => {
              const payment = item.payment_product || null;
              const paymentType = String(payment?.type || '').toUpperCase();
              const paymentStatus = String(payment?.status || '').toUpperCase();
              const paymentActive = paymentStatus === 'ACTIVE';
              const oneTimeTestingKeyAlipay = `${item.id}:alipay-one-time`;
              const oneTimeTestingKeyWechat = `${item.id}:wechat-one-time`;
              const recurringTestingKey = `${item.id}:alipay-recurring`;
              return (
                <tr key={item.id}>
                  <td className="rp-cell-cover">
                    {item.cover_url ? (
                      <img
                        src={item.cover_url}
                        alt={`${item.name} 封面`}
                        className="rp-cover-image"
                      />
                    ) : (
                      <span className="rp-empty">-</span>
                    )}
                  </td>
                  <td>
                    <div className="rp-name-block">
                      <strong>{item.name}</strong>
                      <small>{item.description || item.id}</small>
                    </div>
                  </td>
                  <td>
                    <span className="rp-language">{formatMembershipScopeLabel(item.grants || [])}</span>
                  </td>
                  <td>
                    <strong className="rp-price">{formatCurrencyCny(item.price_cny)}</strong>
                  </td>
                  <td>
                    {payment ? (
                      <div className="rp-payment-cell">
                        <span className={`status-tag ${paymentActive ? 'success' : 'warning'}`}>
                          {paymentType === 'RECURRING' ? '周期扣款' : '单次支付'}
                        </span>
                        <small>{paymentStatus || '-'}</small>
                      </div>
                    ) : (
                      <span className="rp-empty">未配置</span>
                    )}
                  </td>
                  <td>
                    <span className={`status-tag ${item.is_active ? 'success' : 'warning'}`}>
                      {item.is_active ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </td>
                  <td>{resolveMembershipGrantDays(item.grants || [])}</td>
                  <td>{item.updated_at ? new Date(item.updated_at).toLocaleString() : '-'}</td>
                  <td>
                    <div className="btn-group rp-actions">
                      {isAppSuperAdmin && (
                        <button className="btn btn-secondary btn-sm" onClick={() => distributePackageToUser(item)}>
                          分发
                        </button>
                      )}
                      {hasAppPermission('app_redeem_products_manage') && (
                        <>
                          <button className="btn btn-secondary btn-sm" onClick={() => editPackage(item)}>
                            编辑
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => togglePackageActive(item)}>
                            {item.is_active ? '下架' : '上架'}
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => deletePackage(item)}>
                            删除
                          </button>
                        </>
                      )}
                    </div>
                    {payment && isAppSuperAdmin && (
                      <div className="btn-group rp-test-actions">
                        {paymentType === 'ONE_TIME' && (
                          <>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => runPackagePaymentTest(item, 'alipay-one-time')}
                              disabled={!paymentActive || Boolean(paymentTestingKey)}
                            >
                              {paymentTestingKey === oneTimeTestingKeyAlipay ? '跳转中...' : '支付测试(支付宝)'}
                            </button>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => runPackagePaymentTest(item, 'wechat-one-time')}
                              disabled={!paymentActive || Boolean(paymentTestingKey)}
                            >
                              {paymentTestingKey === oneTimeTestingKeyWechat ? '跳转中...' : '支付测试(微信)'}
                            </button>
                          </>
                        )}
                        {paymentType === 'RECURRING' && (
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => runPackagePaymentTest(item, 'alipay-recurring')}
                            disabled={!paymentActive || Boolean(paymentTestingKey)}
                          >
                            {paymentTestingKey === recurringTestingKey ? '跳转中...' : '支付测试(签约)'}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!redeemPackages.length && (
              <tr>
                <td colSpan={9}>暂无产品</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );

  const renderRedeemOrders = () => {
    const totalPages = Math.max(Math.ceil(paymentOrdersTotal / 20), 1);
    return (
      <section className="card">
        <div className="platform-section-head">
          <h3>订单与退款</h3>
          <div className="btn-group">
            <select
              value={paymentOrdersStatusFilter}
              onChange={(event) => {
                setPaymentOrdersStatusFilter(event.target.value);
                setPaymentOrdersPage(1);
              }}
            >
              <option value="">全部状态</option>
              <option value="PENDING">PENDING</option>
              <option value="PAID">PAID</option>
              <option value="REFUNDED">REFUNDED</option>
              <option value="FAILED">FAILED</option>
              <option value="CLOSED">CLOSED</option>
            </select>
          </div>
        </div>
        <div className="platform-api-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>创建时间</th>
                <th>订单号</th>
                <th>金额</th>
                <th>已退</th>
                <th>状态</th>
                <th>支付类型</th>
                <th>商品标题</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {paymentOrders.map((item) => {
                const status = String(item.status || '').toUpperCase();
                const refundable =
                  status === 'PAID' &&
                  Number(item.amount || 0) - Number(item.refunded_amount || 0) > 0.0001;
                return (
                  <tr key={item.id}>
                    <td>{item.created_at ? new Date(item.created_at).toLocaleString() : '-'}</td>
                    <td><code>{item.out_trade_no}</code></td>
                    <td>{item.amount}</td>
                    <td>{item.refunded_amount || '0.00'}</td>
                    <td>
                      <span
                        className={`status-tag ${
                          status === 'PAID' || status === 'REFUNDED'
                            ? 'success'
                            : status === 'FAILED' || status === 'CLOSED'
                              ? 'error'
                              : 'warning'
                        }`}
                      >
                        {status || '-'}
                      </span>
                    </td>
                    <td>{item.payment_type || '-'}</td>
                    <td>{item.subject || '-'}</td>
                    <td>
                      {isAppSuperAdmin && (
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={!refundable || paymentOrderRefundingId === item.id}
                          onClick={() => refundPaymentOrder(item)}
                        >
                          {paymentOrderRefundingId === item.id ? '退款中...' : '退款'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!paymentOrders.length && (
                <tr>
                  <td colSpan={8}>
                    {paymentOrdersLoading ? '加载中...' : '暂无订单'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="pagination">
          <button
            className="btn btn-secondary btn-sm"
            disabled={paymentOrdersPage <= 1}
            onClick={() => setPaymentOrdersPage((p) => Math.max(1, p - 1))}
          >
            上一页
          </button>
          <span>第 {paymentOrdersPage} 页 / 共 {totalPages} 页</span>
          <button
            className="btn btn-secondary btn-sm"
            disabled={paymentOrdersPage >= totalPages}
            onClick={() => setPaymentOrdersPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      </section>
    );
  };

  const renderRedeemBatches = () => (
    <section className="card">
      <div className="platform-section-head"><h3>兑换码批次</h3></div>
      <div className="platform-api-table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>批次名称</th>
              <th>数量</th>
              <th>最大次数</th>
              <th>产品</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {redeemBatches.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>{item.total_count}</td>
                <td>{item.max_uses}</td>
                <td>{item.package_name || '-'}</td>
                <td>{item.created_at ? new Date(item.created_at).toLocaleString() : '-'}</td>
                <td>
                  <div className="btn-group">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setSelectedBatchId(item.id);
                        setRedeemPage(1);
                        setRedeemRedemptionPage(1);
                        goRedeemSubPage('codes');
                      }}
                    >
                      查看兑换码
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => downloadBatchTxt(item.id)}>
                      下载 TXT
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => downloadBatchUrlTxt(item.id)}
                      title={redeemCodeBaseUrl ? '下载完整兑换链接 TXT' : '请先配置应用地址或 USER_WEB 域名'}
                    >
                      下载 URL TXT
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!redeemBatches.length && (
              <tr>
                <td colSpan={6}>暂无批次</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );

  const renderRedeemCodes = () => (
    <section className="card">
      <div className="platform-section-head">
        <h3>兑换码列表</h3>
        <div className="btn-group">
          {isAppSuperAdmin && (
            <form className="redeem-code-void-form" onSubmit={voidCodeFromInput}>
              <input
                type="text"
                value={redeemVoidCodeInput}
                onChange={(event) => setRedeemVoidCodeInput(event.target.value)}
                placeholder="输入兑换码"
                disabled={redeemVoidSaving}
              />
              <button
                className="btn btn-danger btn-sm"
                type="submit"
                disabled={redeemVoidSaving || !redeemVoidCodeInput.trim()}
              >
                {redeemVoidSaving ? '作废中...' : '作废'}
              </button>
            </form>
          )}
          {selectedBatchId && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setSelectedBatchId('');
                setRedeemPage(1);
                setRedeemRedemptionPage(1);
              }}
            >
              清除批次筛选
            </button>
          )}
        </div>
      </div>
      <div className="platform-api-table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>兑换码</th>
              <th>状态</th>
              <th>次数</th>
              <th>批次</th>
              <th>首个使用者</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {redeemCodes.map((item) => (
              <tr key={item.id}>
                <td><code>{item.code}</code></td>
                <td>
                  <span className={`status-tag ${item.status === 'active' ? 'success' : 'warning'}`}>
                    {item.status}
                  </span>
                </td>
                <td>{item.used_count}/{item.max_uses}</td>
                <td>{item.batch_name || '-'}</td>
                <td>{item.first_used_by_email || '-'}</td>
                <td>{item.created_at ? new Date(item.created_at).toLocaleString() : '-'}</td>
                <td>
                  <div className="btn-group">
                    {isAppSuperAdmin && (
                      <button className="btn btn-danger btn-sm" onClick={() => voidCode(item.code)} disabled={item.status !== 'active'}>
                        作废
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!redeemCodes.length && (
              <tr>
                <td colSpan={7}>暂无兑换码</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <button className="btn btn-secondary btn-sm" disabled={redeemPage <= 1} onClick={() => setRedeemPage((p) => Math.max(1, p - 1))}>
          上一页
        </button>
        <span>第 {redeemPage} 页 / 共 {Math.max(Math.ceil(redeemTotal / 20), 1)} 页</span>
        <button
          className="btn btn-secondary btn-sm"
          disabled={redeemPage >= Math.max(Math.ceil(redeemTotal / 20), 1)}
          onClick={() => setRedeemPage((p) => p + 1)}
        >
          下一页
        </button>
      </div>
    </section>
  );

  const renderRedeemRedemptions = () => (
    <section className="card">
      <div className="platform-section-head">
        <h3>兑换记录</h3>
        <div className="btn-group">
          {selectedBatchId && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setSelectedBatchId('');
                setRedeemPage(1);
                setRedeemRedemptionPage(1);
              }}
            >
              清除批次筛选
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => goRedeemSubPage('code-batches')}>
            查看批次
          </button>
        </div>
      </div>
      <div className="platform-api-table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>兑换时间</th>
              <th>兑换码</th>
              <th>用户</th>
              <th>产品</th>
              <th>批次</th>
              <th>权益状态</th>
              <th>撤销状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {redeemRedemptions.map((item) => {
              const revoked = Boolean(item.revoked_at);
              return (
                <tr key={item.id}>
                  <td>{formatDateTime(item.redeemed_at)}</td>
                  <td><code>{item.code}</code></td>
                  <td>
                    <div style={{ display: 'grid', gap: 2 }}>
                      <strong>{item.user_display_name || '-'}</strong>
                      <span>{item.user_email || item.user_id}</span>
                    </div>
                  </td>
                  <td>{item.package_name || '-'}</td>
                  <td>{item.batch_name || '-'}</td>
                  <td>{item.active_entitlements}/{item.total_entitlements}</td>
                  <td>
                    {revoked ? (
                      <div style={{ display: 'grid', gap: 2 }}>
                        <span className="status-tag warning">已撤销</span>
                        <small>{formatDateTime(item.revoked_at)}</small>
                      </div>
                    ) : (
                      <span className="status-tag success">有效</span>
                    )}
                  </td>
                  <td>
                    {isAppSuperAdmin && (
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={revoked || redeemRedemptionRevokingId === item.id}
                        onClick={() => revokeCodeRedemption(item)}
                      >
                        {redeemRedemptionRevokingId === item.id ? '撤销中...' : '撤销兑换'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!redeemRedemptions.length && (
              <tr>
                <td colSpan={8}>暂无兑换记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <button
          className="btn btn-secondary btn-sm"
          disabled={redeemRedemptionPage <= 1}
          onClick={() => setRedeemRedemptionPage((p) => Math.max(1, p - 1))}
        >
          上一页
        </button>
        <span>第 {redeemRedemptionPage} 页 / 共 {Math.max(Math.ceil(redeemRedemptionTotal / 20), 1)} 页</span>
        <button
          className="btn btn-secondary btn-sm"
          disabled={redeemRedemptionPage >= Math.max(Math.ceil(redeemRedemptionTotal / 20), 1)}
          onClick={() => setRedeemRedemptionPage((p) => p + 1)}
        >
          下一页
        </button>
      </div>
    </section>
  );

  const renderRedeem = () => (
    <div className="platform-page">
      <section className="card">
        <div className="platform-section-head">
          <h3>产品与兑换中心</h3>
          <div className="btn-group">
            {redeemSubPage === 'products' && (
              <>
                {hasAppPermission('app_redeem_products_manage') && (
                  <button className="btn btn-sm" type="button" onClick={openCreatePackagePage}>
                    新建产品
                  </button>
                )}
                {isAppSuperAdmin && (
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => goRedeemSubPage('code-create')}>
                    创建兑换码
                  </button>
                )}
              </>
            )}
            {redeemSubPage === 'code-batches' && isAppSuperAdmin && (
              <button className="btn btn-sm" type="button" onClick={() => goRedeemSubPage('code-create')}>
                创建兑换码
              </button>
            )}
            {redeemSubPage === 'codes' && (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => goRedeemSubPage('code-batches')}>
                查看批次
              </button>
            )}
            {redeemSubPage === 'redemptions' && (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => goRedeemSubPage('code-batches')}>
                查看批次
              </button>
            )}
          </div>
        </div>
        <div className="btn-group">
          {REDEEM_SUB_NAV.filter((item) => {
            if (item.key === 'product-create') return hasAppPermission('app_redeem_products_manage');
            if (item.key === 'code-create') return isAppSuperAdmin;
            return true;
          }).map((item) => (
            <button
              key={item.key}
              type="button"
              className={`btn btn-sm ${redeemSubPage === item.key ? '' : 'btn-secondary'}`}
              onClick={() => goRedeemSubPage(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>

      {redeemSubPage === 'products' && renderRedeemProducts()}
      {redeemSubPage === 'product-create' && hasAppPermission('app_redeem_products_manage') && renderPackageEditor()}
      {redeemSubPage === 'orders' && renderRedeemOrders()}
      {redeemSubPage === 'code-batches' && renderRedeemBatches()}
      {redeemSubPage === 'code-create' && isAppSuperAdmin && renderCodeBatchCreate()}
      {redeemSubPage === 'codes' && renderRedeemCodes()}
      {redeemSubPage === 'redemptions' && renderRedeemRedemptions()}
    </div>
  );

  return (
    <div className="platform-page">
      <div className="tenant-workspace-shell">
        <aside className="tenant-workspace-sidebar">
          <div className="tenant-workspace-sidebar-body">
            <div className="tenant-workspace-appcard">
              <strong>{appDetail?.name || '应用工作区'}</strong>
              <span>{appDetail ? `应用标识：${appDetail.slug}` : '正在加载应用信息'}</span>
            </div>

            <nav className="tenant-workspace-nav">
              {visibleWorkspaceNav.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`tenant-workspace-nav-item ${activeSection === item.key ? 'active' : ''}`}
                  onClick={() => goSection(item.key)}
                >
                  <strong>{item.label}</strong>
                  <span>{item.desc}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="tenant-workspace-sidebar-footer">
            {runtimeContext.isPlatformPortal && (
              <Link to="/platform-admin/apps" className="tenant-workspace-backlink">
                返回控制面板
              </Link>
            )}
          </div>
        </aside>

        <section className="tenant-workspace-main">
          {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

          {activeSection === 'overview' && renderOverview()}
          {activeSection === 'analytics' && renderAnalytics()}
          {activeSection === 'ai-usage' && renderAiUsage()}
          {activeSection === 'api-docs' && renderApiDocs()}
          {activeSection === 'developers' && renderDevelopers()}
          {activeSection === 'admins' && renderAdmins()}
          {activeSection === 'ai-routing' && renderAiRouting()}
          {activeSection === 'site' && renderSite()}
          {activeSection === 'email' && renderEmail()}
          {activeSection === 'feedback' && renderFeedback()}
          {activeSection === 'acquisition' && renderAcquisition()}
          {activeSection === 'redeem' && renderRedeem()}
        </section>
      </div>
    </div>
  );
}
