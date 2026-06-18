import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authService } from '@/lib/auth-service';
import { runtimeContext } from '@/lib/runtime-context';

type SdkLoginSession = {
  mode?: 'platform' | 'app';
  app?: {
    slug: string;
    name: string;
  } | null;
  client: string;
  profile: string;
  scopes: string[];
  scope_catalog: Array<{ key: string; label: string; group: string; risk: string }>;
  status: string;
  expires_at: string;
};

type SdkAuthApp = {
  id?: string;
  slug: string;
  name?: string;
};

export default function SdkLogin() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const baseUrl = useMemo(
    () => String(searchParams.get('baseUrl') || runtimeContext.apiBaseUrl || '').replace(/\/+$/, ''),
    [searchParams],
  );
  const app = String(searchParams.get('app') || '').trim();
  const isPlatformMode = String(searchParams.get('mode') || '').trim() === 'platform' || !app;
  const state = String(searchParams.get('state') || '').trim();
  const [session, setSession] = useState<SdkLoginSession | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [authTarget, setAuthTarget] = useState<'platform' | 'app'>('platform');
  const [apps, setApps] = useState<SdkAuthApp[]>([]);
  const [selectedAppSlug, setSelectedAppSlug] = useState('');
  const [appsLoading, setAppsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'info'; text: string } | null>(null);

  const fixedAppSession = session?.mode === 'app' && session.app ? session.app : null;
  const authorizationLabel = authTarget === 'platform' ? '全平台授权' : '单个应用授权';

  useEffect(() => {
    let cancelled = false;
    async function loadSession() {
      if (!baseUrl || !state) {
        const savedReturn = typeof window !== 'undefined'
          ? localStorage.getItem('opg_sdk_login_return') || sessionStorage.getItem('opg_sdk_login_return') || ''
          : '';
        if (savedReturn.includes('/sdk-login') && savedReturn.includes('state=')) {
          window.location.assign(savedReturn);
          return;
        }
        setMessage({ type: 'error', text: '授权链接缺少必要参数' });
        setLoading(false);
        return;
      }
      try {
        const sessionBase = isPlatformMode
          ? `${baseUrl}/api/v1/sdk`
          : `${baseUrl}/${encodeURIComponent(app)}/v1/sdk`;
        const response = await fetch(`${sessionBase}/auth/sessions/${encodeURIComponent(state)}`, {
          headers: { Accept: 'application/json' },
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.message || '授权会话不可用');
        }
        if (!cancelled) {
          const payload = data?.data || data;
          setSession(payload);
          setSelectedScopes(payload.scopes || []);
          if (payload.mode === 'app' && payload.app?.slug) {
            setAuthTarget('app');
            setSelectedAppSlug(payload.app.slug);
          } else {
            let savedTarget = '';
            let savedApp = '';
            if (typeof window !== 'undefined') {
              savedTarget = sessionStorage.getItem('opg_sdk_auth_target') || '';
              savedApp = sessionStorage.getItem('opg_sdk_auth_app') || '';
              sessionStorage.removeItem('opg_sdk_auth_target');
              sessionStorage.removeItem('opg_sdk_auth_app');
            }
            setAuthTarget(savedTarget === 'app' ? 'app' : 'platform');
            setSelectedAppSlug(savedApp);
          }
        }
      } catch (error: any) {
        if (!cancelled) {
          setMessage({ type: 'error', text: error?.message || '授权会话加载失败' });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadSession();
    return () => {
      cancelled = true;
    };
  }, [app, baseUrl, isPlatformMode, state]);

  useEffect(() => {
    let cancelled = false;
    async function loadApps() {
      const token = authService.getToken();
      if (!session || fixedAppSession || !token || !baseUrl) {
        return;
      }
      setAppsLoading(true);
      try {
        const response = await fetch(`${baseUrl}/api/v1/platform-admin/apps?include_inactive=true`, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.message || '应用列表加载失败');
        }
        const payload = data?.data || data;
        const items = Array.isArray(payload?.items) ? payload.items : [];
        if (!cancelled) {
          const nextApps = items
            .map((item: any) => ({
              id: String(item?.id || ''),
              slug: String(item?.slug || '').trim(),
              name: String(item?.name || '').trim(),
            }))
            .filter((item: SdkAuthApp) => item.slug);
          setApps(nextApps);
          setSelectedAppSlug((current) => {
            if (current && nextApps.some((item: SdkAuthApp) => item.slug === current)) {
              return current;
            }
            return nextApps[0]?.slug || '';
          });
        }
      } catch (error: any) {
        if (!cancelled && authTarget === 'app') {
          setMessage({ type: 'error', text: error?.message || '应用列表加载失败' });
        }
      } finally {
        if (!cancelled) {
          setAppsLoading(false);
        }
      }
    }

    void loadApps();
    return () => {
      cancelled = true;
    };
  }, [authTarget, baseUrl, fixedAppSession, session]);

  const loginAndReturn = () => {
    if (typeof window !== 'undefined') {
      const returnUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      localStorage.setItem('opg_sdk_login_return', returnUrl);
      sessionStorage.setItem('opg_sdk_login_return', returnUrl);
      sessionStorage.setItem('opg_sdk_auth_target', authTarget);
      if (selectedAppSlug) {
        sessionStorage.setItem('opg_sdk_auth_app', selectedAppSlug);
      }
    }
    navigate(runtimeContext.loginPath);
  };

  const authorize = async () => {
    const token = authService.getToken();
    if (!token) {
      loginAndReturn();
      return;
    }

    if (authTarget === 'app' && !selectedAppSlug) {
      setMessage({ type: 'error', text: '请选择要授权的 app' });
      return;
    }

    setAuthorizing(true);
    setMessage(null);
    try {
      const sessionBase = isPlatformMode
        ? `${baseUrl}/api/v1/sdk`
        : `${baseUrl}/${encodeURIComponent(app)}/v1/sdk`;
      const response = await fetch(`${sessionBase}/auth/sessions/${encodeURIComponent(state)}/authorize`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scopes: authTarget === 'app' ? selectedScopes : [],
          target: authTarget,
          app_slug: authTarget === 'app' ? selectedAppSlug : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.message || '授权失败');
      }
      const payload = data?.data || data;
      window.location.href = payload.redirect_url;
    } catch (error: any) {
      setMessage({ type: 'error', text: error?.message || '授权失败' });
      setAuthorizing(false);
    }
  };

  const expired = session?.status === 'EXPIRED';
  const selectedApp = fixedAppSession || apps.find((item) => item.slug === selectedAppSlug) || null;
  const appSelectionDisabled = Boolean(fixedAppSession) || authorizing || expired;
  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) => (prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope]));
  };

  return (
    <div className="sdk-auth-page">
      <section className="sdk-auth-card">
        <div className="sdk-auth-brand">
          <strong>OPG</strong>
          <span>CLI 授权</span>
        </div>
        <div className="sdk-auth-header">
          <h1>授权本地开发工具</h1>
          <p>
            {session
              ? authTarget === 'platform'
                ? `${session.client} 将获得平台控制面权限`
                : `${session.client} 将访问 ${selectedApp?.name || selectedApp?.slug || '所选 app'}`
              : '加载授权会话中'}
          </p>
        </div>

        {loading ? <div className="loading">加载中...</div> : null}

        {!loading && session ? (
          <div className="sdk-auth-form">
            <div className="sdk-auth-mode" aria-label="授权范围">
              <button
                className={`sdk-auth-mode-option ${authTarget === 'platform' ? 'active' : ''}`}
                type="button"
                onClick={() => setAuthTarget('platform')}
                disabled={Boolean(fixedAppSession) || authorizing || expired}
              >
                <strong>全平台授权</strong>
                <span>默认</span>
              </button>
              <button
                className={`sdk-auth-mode-option ${authTarget === 'app' ? 'active' : ''}`}
                type="button"
                onClick={() => setAuthTarget('app')}
                disabled={appSelectionDisabled}
              >
                <strong>单个 app 授权</strong>
                <span>{selectedApp?.name || selectedApp?.slug || '可选'}</span>
              </button>
            </div>

            {authTarget === 'app' && !fixedAppSession ? (
              <label className="sdk-auth-select">
                <span>App</span>
                <select
                  value={selectedAppSlug}
                  onChange={(event) => setSelectedAppSlug(event.target.value)}
                  disabled={appsLoading || authorizing || expired}
                >
                  {!apps.length ? <option value="">{appsLoading ? '加载中...' : '暂无 app'}</option> : null}
                  {apps.map((item) => (
                    <option key={item.slug} value={item.slug}>
                      {item.name ? `${item.name} (${item.slug})` : item.slug}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="sdk-auth-meta">
              <div>
                <span>授权范围</span>
                <strong>{authorizationLabel}</strong>
              </div>
              <div>
                <span>{authTarget === 'app' ? 'App' : '配置'}</span>
                <strong>{authTarget === 'app' ? selectedApp?.slug || '-' : session.profile || 'default'}</strong>
              </div>
            </div>

            {session.scope_catalog?.length ? (
              <div className="platform-permission-grid sdk-auth-scopes">
                {(session.scope_catalog || []).map((scope) => (
                  <label key={scope.key} className="platform-permission-item">
                    <input
                      type="checkbox"
                      checked={selectedScopes.includes(scope.key)}
                      onChange={() => toggleScope(scope.key)}
                      disabled={authorizing || expired}
                    />
                    <span>{scope.label}</span>
                  </label>
                ))}
              </div>
            ) : null}

            {message ? <div className={`message ${message.type}`}>{message.text}</div> : null}

            <button
              className="btn sdk-auth-btn"
              type="button"
              onClick={authorize}
              disabled={authorizing || expired || (authTarget === 'app' && !selectedAppSlug && authService.isAuthenticated())}
            >
              {authorizing ? '授权中...' : expired ? '授权已过期' : authService.isAuthenticated() ? '授权' : '登录后授权'}
            </button>
          </div>
        ) : null}

        {!loading && !session && message ? <div className={`message ${message.type}`}>{message.text}</div> : null}
      </section>
    </div>
  );
}
