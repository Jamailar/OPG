import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  platformApi,
  PlatformAppleLoginCredentialItem,
  PlatformGitHubOAuthAppItem,
  PlatformGoogleOAuthClientItem,
  PlatformOAuthCredentialTestResult,
  PlatformOutboundProxyItem,
  PlatformWechatOpenAppItem,
} from '@/lib/api';
import { pickApiData, pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;
type CredentialProvider = 'wechat' | 'github' | 'google' | 'apple';

type CredentialItem = {
  id: string;
  provider: CredentialProvider;
  name: string;
  publicId: string;
  secretMasked: string;
  isActive: boolean;
  updatedAt?: string;
  serviceId?: string | null;
  teamId?: string | null;
  keyId?: string | null;
  issuerId?: string | null;
  environment?: string | null;
  outboundProxyId?: string | null;
  outboundProxyName?: string | null;
  outboundProxyStatus?: string | null;
  outboundProxyLatencyMs?: number | null;
};

type CredentialForm = {
  id?: string;
  provider: CredentialProvider;
  name: string;
  publicId: string;
  secret: string;
  serviceId: string;
  teamId: string;
  keyId: string;
  issuerId: string;
  environment: string;
  outboundProxyId: string;
  isActive: boolean;
};

const PROVIDERS: Array<{
  key: CredentialProvider;
  label: string;
  idLabel: string;
  secretLabel: string;
  createLabel: string;
  secretRequired: boolean;
  externalCreateUrl?: string;
  externalCreateLabel?: string;
}> = [
  {
    key: 'wechat',
    label: '微信',
    idLabel: 'AppID',
    secretLabel: 'AppSecret',
    createLabel: '新建微信凭证',
    secretRequired: true,
    externalCreateUrl: 'https://open.weixin.qq.com/',
    externalCreateLabel: '去微信开放平台',
  },
  {
    key: 'github',
    label: 'GitHub',
    idLabel: 'Client ID',
    secretLabel: 'Client Secret',
    createLabel: '新建 GitHub 凭证',
    secretRequired: true,
    externalCreateUrl: 'https://github.com/settings/applications/new',
    externalCreateLabel: '去 GitHub 创建',
  },
  {
    key: 'google',
    label: 'Google',
    idLabel: 'Client ID',
    secretLabel: 'Client Secret',
    createLabel: '新建 Google 凭证',
    secretRequired: false,
    externalCreateUrl: 'https://console.cloud.google.com/apis/credentials',
    externalCreateLabel: '去 Google Cloud 创建',
  },
  {
    key: 'apple',
    label: 'Apple',
    idLabel: 'Bundle ID',
    secretLabel: 'Private Key',
    createLabel: '新建 Apple 凭证',
    secretRequired: true,
    externalCreateUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
    externalCreateLabel: '去 App Store Connect',
  },
];

const providerByKey = Object.fromEntries(PROVIDERS.map((item) => [item.key, item])) as Record<
  CredentialProvider,
  (typeof PROVIDERS)[number]
>;

const EMPTY_FORM: CredentialForm = {
  provider: 'wechat',
  name: '',
  publicId: '',
  secret: '',
  serviceId: '',
  teamId: '',
  keyId: '',
  issuerId: '',
  environment: 'PRODUCTION',
  outboundProxyId: '',
  isActive: true,
};

function normalizeWechat(item: PlatformWechatOpenAppItem): CredentialItem {
  return {
    id: item.id,
    provider: 'wechat',
    name: item.name,
    publicId: item.app_id,
    secretMasked: item.app_secret_masked,
    isActive: item.is_active,
    updatedAt: item.updated_at,
  };
}

function normalizeGoogle(item: PlatformGoogleOAuthClientItem): CredentialItem {
  return {
    id: item.id,
    provider: 'google',
    name: item.name,
    publicId: item.client_id,
    secretMasked: item.client_secret_masked,
    isActive: item.is_active,
    updatedAt: item.updated_at,
    outboundProxyId: item.outbound_proxy_id || '',
    outboundProxyName: item.outbound_proxy?.name || null,
    outboundProxyStatus: item.outbound_proxy?.status || null,
    outboundProxyLatencyMs: item.outbound_proxy?.latency_ms ?? null,
  };
}

function normalizeGithub(item: PlatformGitHubOAuthAppItem): CredentialItem {
  return {
    id: item.id,
    provider: 'github',
    name: item.name,
    publicId: item.client_id,
    secretMasked: item.client_secret_masked,
    isActive: item.is_active,
    updatedAt: item.updated_at,
  };
}

function normalizeApple(item: PlatformAppleLoginCredentialItem): CredentialItem {
  return {
    id: item.id,
    provider: 'apple',
    name: item.name,
    publicId: item.bundle_id,
    secretMasked: item.private_key_masked || '',
    isActive: item.is_active,
    updatedAt: item.updated_at,
    serviceId: item.service_id,
    teamId: item.team_id,
    keyId: item.key_id,
    issuerId: item.issuer_id,
    environment: item.environment,
  };
}

function formatTime(value?: string) {
  return value ? new Date(value).toLocaleString() : '-';
}

export default function LoginCredentialsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialProvider = PROVIDERS.some((item) => item.key === searchParams.get('provider'))
    ? (searchParams.get('provider') as CredentialProvider)
    : 'wechat';
  const [activeProvider, setActiveProvider] = useState<CredentialProvider>(initialProvider);
  const [items, setItems] = useState<CredentialItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState('');
  const [message, setMessage] = useState<Message>(null);
  const [formVisible, setFormVisible] = useState(false);
  const [form, setForm] = useState<CredentialForm>({ ...EMPTY_FORM, provider: initialProvider });
  const [proxies, setProxies] = useState<PlatformOutboundProxyItem[]>([]);

  const visibleItems = useMemo(() => items.filter((item) => item.provider === activeProvider), [activeProvider, items]);
  const activeProviderConfig = providerByKey[activeProvider];

  const providerStats = useMemo(
    () =>
      PROVIDERS.map((provider) => {
        const providerItems = items.filter((item) => item.provider === provider.key);
        return {
          ...provider,
          total: providerItems.length,
          active: providerItems.filter((item) => item.isActive).length,
        };
      }),
    [items],
  );

  const loadData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [wechatResp, googleResp, githubResp, appleResp] = await Promise.all([
        platformApi.listGlobalWechatOpenApps(),
        platformApi.listGlobalGoogleOAuthClients(),
        platformApi.listGlobalGitHubOAuthApps(),
        platformApi.listGlobalAppleLoginCredentials(),
      ]);
      const proxyResp = await platformApi.listOutboundProxies({ status: 'all', protocol: 'all' });
      const wechatPayload = pickApiData<{ items: PlatformWechatOpenAppItem[] }>(wechatResp);
      const googlePayload = pickApiData<{ items: PlatformGoogleOAuthClientItem[] }>(googleResp);
      const githubPayload = pickApiData<{ items: PlatformGitHubOAuthAppItem[] }>(githubResp);
      const applePayload = pickApiData<{ items: PlatformAppleLoginCredentialItem[] }>(appleResp);
      const proxyPayload = pickApiData<{ items: PlatformOutboundProxyItem[] }>(proxyResp);
      setItems([
        ...(wechatPayload?.items || []).map(normalizeWechat),
        ...(githubPayload?.items || []).map(normalizeGithub),
        ...(googlePayload?.items || []).map(normalizeGoogle),
        ...(applePayload?.items || []).map(normalizeApple),
      ]);
      setProxies(proxyPayload?.items || []);
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '加载登录凭证失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    setSearchParams({ provider: activeProvider }, { replace: true });
  }, [activeProvider, setSearchParams]);

  const openCreate = (provider: CredentialProvider = activeProvider) => {
    setActiveProvider(provider);
    setForm({ ...EMPTY_FORM, provider });
    setFormVisible(true);
  };

  const openEdit = (item: CredentialItem) => {
    setActiveProvider(item.provider);
    setForm({
      id: item.id,
      provider: item.provider,
      name: item.name,
      publicId: item.publicId,
      secret: '',
      isActive: item.isActive,
      serviceId: item.serviceId || '',
      teamId: item.teamId || '',
      keyId: item.keyId || '',
      issuerId: item.issuerId || '',
      environment: item.environment || 'PRODUCTION',
      outboundProxyId: item.outboundProxyId || '',
    });
    setFormVisible(true);
  };

  const closeForm = () => {
    setForm({ ...EMPTY_FORM, provider: activeProvider });
    setFormVisible(false);
  };

  const saveCredential = async (event: React.FormEvent) => {
    event.preventDefault();
    const provider = providerByKey[form.provider];
    const name = form.name.trim();
    const publicId = form.publicId.trim();
    const secret = form.secret.trim();

    if (!name) {
      setMessage({ type: 'error', text: '请输入名称' });
      return;
    }
    if (!publicId) {
      setMessage({ type: 'error', text: `请输入 ${provider.idLabel}` });
      return;
    }
    if (!form.id && provider.secretRequired && !secret) {
      setMessage({ type: 'error', text: `请输入 ${provider.secretLabel}` });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      if (form.provider === 'wechat') {
        const payload = { name, app_id: publicId, app_secret: secret || undefined, is_active: form.isActive };
        if (form.id) {
          await platformApi.updateGlobalWechatOpenApp(form.id, payload);
        } else {
          await platformApi.createGlobalWechatOpenApp({ ...payload, app_secret: secret });
        }
      }
      if (form.provider === 'google') {
        const payload = {
          name,
          client_id: publicId,
          client_secret: secret || undefined,
          outbound_proxy_id: form.outboundProxyId || null,
          is_active: form.isActive,
        };
        if (form.id) {
          await platformApi.updateGlobalGoogleOAuthClient(form.id, payload);
        } else {
          await platformApi.createGlobalGoogleOAuthClient(payload);
        }
      }
      if (form.provider === 'github') {
        const payload = { name, client_id: publicId, client_secret: secret || undefined, is_active: form.isActive };
        if (form.id) {
          await platformApi.updateGlobalGitHubOAuthApp(form.id, payload);
        } else {
          await platformApi.createGlobalGitHubOAuthApp({ ...payload, client_secret: secret });
        }
      }
      if (form.provider === 'apple') {
        const payload = {
          name,
          bundle_id: publicId,
          service_id: form.serviceId.trim() || undefined,
          team_id: form.teamId.trim(),
          key_id: form.keyId.trim() || undefined,
          issuer_id: form.issuerId.trim() || undefined,
          private_key: secret || undefined,
          environment: form.environment,
          is_active: form.isActive,
        };
        if (!payload.team_id) {
          setMessage({ type: 'error', text: '请输入 Team ID' });
          setSaving(false);
          return;
        }
        if (form.id) {
          await platformApi.updateGlobalAppleLoginCredential(form.id, payload);
        } else {
          await platformApi.createGlobalAppleLoginCredential({ ...payload, private_key: secret });
        }
      }
      setMessage({ type: 'success', text: form.id ? '登录凭证已更新' : '登录凭证已创建' });
      closeForm();
      await loadData();
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存登录凭证失败') });
    } finally {
      setSaving(false);
    }
  };

  const deleteCredential = async (item: CredentialItem) => {
    if (!window.confirm(`确认删除登录凭证「${item.name}」？`)) {
      return;
    }
    setMessage(null);
    try {
      if (item.provider === 'wechat') await platformApi.deleteGlobalWechatOpenApp(item.id);
      if (item.provider === 'google') await platformApi.deleteGlobalGoogleOAuthClient(item.id);
      if (item.provider === 'github') await platformApi.deleteGlobalGitHubOAuthApp(item.id);
      if (item.provider === 'apple') await platformApi.deleteGlobalAppleLoginCredential(item.id);
      setMessage({ type: 'success', text: '登录凭证已删除' });
      await loadData();
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除登录凭证失败') });
    }
  };

  const testCredential = async (item: CredentialItem) => {
    setTestingId(item.id);
    setMessage(null);
    try {
      let result: PlatformOAuthCredentialTestResult | undefined;
      if (item.provider === 'wechat') {
        result = pickApiData<PlatformOAuthCredentialTestResult>(await platformApi.testGlobalWechatOpenApp(item.id));
      }
      if (item.provider === 'google') {
        result = pickApiData<PlatformOAuthCredentialTestResult>(await platformApi.testGlobalGoogleOAuthClient(item.id));
      }
      if (item.provider === 'github') {
        result = pickApiData<PlatformOAuthCredentialTestResult>(await platformApi.testGlobalGitHubOAuthApp(item.id));
      }
      if (item.provider === 'apple') {
        result = pickApiData<PlatformOAuthCredentialTestResult>(await platformApi.testGlobalAppleLoginCredential(item.id));
      }
      setMessage({ type: result?.success ? 'success' : 'error', text: result?.message || '测试完成' });
    } catch (error: unknown) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '测试登录凭证失败') });
    } finally {
      setTestingId('');
    }
  };

  return (
    <div className="platform-page login-credentials-page">
      <div className="platform-page-head">
        <div>
          <h1>登录凭证</h1>
          <p>维护租户可选择的第三方登录凭证。</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary btn-sm" onClick={loadData} disabled={loading}>
            {loading ? '刷新中...' : '刷新'}
          </button>
          <button className="btn btn-sm" onClick={() => openCreate(activeProvider)}>
            新建凭证
          </button>
        </div>
      </div>

      {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

      <section className="credential-provider-strip">
        {providerStats.map((provider) => (
          <button
            key={provider.key}
            className={`credential-provider-card ${activeProvider === provider.key ? 'active' : ''}`}
            onClick={() => setActiveProvider(provider.key)}
            type="button"
          >
            <span>{provider.label}</span>
            <strong>{provider.active}/{provider.total}</strong>
          </button>
        ))}
      </section>

      {formVisible && (
        <div className="modal-overlay" onClick={saving ? undefined : closeForm}>
          <section className="modal modal-lg credential-form-modal" onClick={(event) => event.stopPropagation()}>
            <div className="platform-section-head">
            <h3>{form.id ? `编辑${providerByKey[form.provider].label}凭证` : providerByKey[form.provider].createLabel}</h3>
            <div className="btn-group">
              {!form.id && providerByKey[form.provider].externalCreateUrl ? (
                <a
                  className="btn btn-secondary btn-sm"
                  href={providerByKey[form.provider].externalCreateUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {providerByKey[form.provider].externalCreateLabel}
                </a>
              ) : null}
              <button className="btn btn-secondary btn-sm" type="button" onClick={closeForm} disabled={saving}>
                关闭
              </button>
            </div>
            </div>
            <form onSubmit={saveCredential} className="platform-form-grid">
              <div className="form-group">
                <label>提供商</label>
                <select
                  value={form.provider}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, provider: event.target.value as CredentialProvider, secret: '', outboundProxyId: '' }))
                  }
                  disabled={!!form.id}
                >
                  {PROVIDERS.map((provider) => (
                    <option key={provider.key} value={provider.key}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>名称</label>
                <input
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder={`例如：主站${providerByKey[form.provider].label}登录`}
                />
              </div>
              <div className="form-group">
                <label>{providerByKey[form.provider].idLabel}</label>
                <input
                  value={form.publicId}
                  onChange={(event) => setForm((prev) => ({ ...prev, publicId: event.target.value }))}
                  placeholder={form.provider === 'wechat' ? 'wx1234567890abcdef' : form.provider === 'apple' ? 'com.example.app' : 'OAuth Client ID'}
                />
              </div>
              {form.provider === 'apple' && (
                <>
                  <div className="form-group">
                    <label>Services ID</label>
                    <input value={form.serviceId} onChange={(event) => setForm((prev) => ({ ...prev, serviceId: event.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Team ID</label>
                    <input value={form.teamId} onChange={(event) => setForm((prev) => ({ ...prev, teamId: event.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Key ID</label>
                    <input value={form.keyId} onChange={(event) => setForm((prev) => ({ ...prev, keyId: event.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Issuer ID</label>
                    <input value={form.issuerId} onChange={(event) => setForm((prev) => ({ ...prev, issuerId: event.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>环境</label>
                    <select value={form.environment} onChange={(event) => setForm((prev) => ({ ...prev, environment: event.target.value }))}>
                      <option value="PRODUCTION">PRODUCTION</option>
                      <option value="SANDBOX">SANDBOX</option>
                    </select>
                  </div>
                </>
              )}
              <div className="form-group">
                <label>{form.id ? `${providerByKey[form.provider].secretLabel}（留空则保持不变）` : providerByKey[form.provider].secretLabel}</label>
                <input
                  value={form.secret}
                  onChange={(event) => setForm((prev) => ({ ...prev, secret: event.target.value }))}
                  placeholder={form.id ? '不修改可留空' : providerByKey[form.provider].secretRequired ? '请输入密钥' : '可选'}
                />
              </div>
              {form.provider === 'google' && (
                <div className="form-group">
                  <label>代理</label>
                  <select
                    value={form.outboundProxyId}
                    onChange={(event) => setForm((prev) => ({ ...prev, outboundProxyId: event.target.value }))}
                  >
                    <option value="">不使用代理</option>
                    {proxies.map((proxy) => (
                      <option key={proxy.id} value={proxy.id}>
                        {proxy.name} · {proxy.status}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="form-group">
                <label>状态</label>
                <select
                  value={form.isActive ? 'ACTIVE' : 'INACTIVE'}
                  onChange={(event) => setForm((prev) => ({ ...prev, isActive: event.target.value === 'ACTIVE' }))}
                >
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="INACTIVE">INACTIVE</option>
                </select>
              </div>
              <div className="platform-form-actions platform-form-span-2">
                <button className="btn" type="submit" disabled={saving}>
                  {saving ? '保存中...' : form.id ? '保存更新' : '创建凭证'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={closeForm} disabled={saving}>
                  取消
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      <section className="credential-list">
        {visibleItems.map((item) => (
          <article key={item.id} className="credential-row-card">
            <div className="credential-row-main">
              <span className="credential-provider-pill">{providerByKey[item.provider].label}</span>
              <div>
                <h3>{item.name}</h3>
                <code>{item.publicId}</code>
              </div>
            </div>
            <div className="credential-row-meta">
              <div>
                <span>Secret</span>
                <strong>{item.secretMasked || '-'}</strong>
              </div>
              <div>
                <span>最近更新</span>
                <strong>{formatTime(item.updatedAt)}</strong>
              </div>
              {item.provider === 'google' && (
                <div>
                  <span>代理</span>
                  <strong>
                    {item.outboundProxyName || '不使用代理'}
                    {item.outboundProxyLatencyMs ? ` · ${item.outboundProxyLatencyMs} ms` : ''}
                  </strong>
                </div>
              )}
              <span className={`status-tag ${item.isActive ? 'success' : 'warning'}`}>
                {item.isActive ? 'ACTIVE' : 'INACTIVE'}
              </span>
            </div>
            <div className="credential-row-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => testCredential(item)} disabled={testingId === item.id}>
                {testingId === item.id ? '测试中...' : '测试'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => openEdit(item)}>
                编辑
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => deleteCredential(item)}>
                删除
              </button>
            </div>
          </article>
        ))}

        {!visibleItems.length && (
          <section className="card credential-empty">
            <div className="loading">还没有{activeProviderConfig.label}凭证</div>
            <button className="btn btn-sm" onClick={() => openCreate(activeProvider)}>
              {activeProviderConfig.createLabel}
            </button>
          </section>
        )}
      </section>
    </div>
  );
}
