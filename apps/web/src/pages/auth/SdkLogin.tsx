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
  const [loading, setLoading] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadSession() {
      if (!baseUrl || !state) {
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

  const loginAndReturn = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('opg_sdk_login_return', `${window.location.pathname}${window.location.search}`);
    }
    navigate(runtimeContext.loginPath);
  };

  const authorize = async () => {
    const token = authService.getToken();
    if (!token) {
      loginAndReturn();
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
        body: JSON.stringify({ scopes: selectedScopes }),
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
  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) => (prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope]));
  };

  return (
    <div className="ac-login-page ac-login-screen">
      <div className="ac-login-backdrop" aria-hidden="true" />
      <div className="ac-login-shell">
        <section className="ac-login-card">
          <div className="ac-login-card-brand">
            <strong>OPG SDK</strong>
            <span>浏览器授权</span>
          </div>
          <div className="ac-login-header">
            <h1>授权本地开发工具</h1>
            <p>
              {session
                ? session.mode === 'platform' || !session.app
                  ? `${session.client} 将访问平台控制面`
                  : `${session.client} 将访问 ${session.app.name || session.app.slug}`
                : '加载授权会话中'}
            </p>
          </div>

          {loading ? <div className="loading">加载中...</div> : null}

          {!loading && session ? (
            <div className="ac-login-form">
              <label>
                <span>应用</span>
                <input readOnly value={session.app?.slug || 'platform'} />
              </label>
              <label>
                <span>配置</span>
                <input readOnly value={session.profile || 'default'} />
              </label>
              {session.scope_catalog?.length ? <div className="platform-permission-grid">
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
              </div> : null}
              {message ? <div className={`message ${message.type}`}>{message.text}</div> : null}
              <button className="btn ac-login-btn" type="button" onClick={authorize} disabled={authorizing || expired}>
                {authorizing ? '授权中...' : expired ? '授权已过期' : authService.isAuthenticated() ? '授权' : '登录后授权'}
              </button>
            </div>
          ) : null}

          {!loading && !session && message ? <div className={`message ${message.type}`}>{message.text}</div> : null}
        </section>
      </div>
    </div>
  );
}
