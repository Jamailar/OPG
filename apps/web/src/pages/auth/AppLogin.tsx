import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppBrandMark } from '@/components/AppBrand';
import { authService } from '@/lib/auth-service';
import {
  applyRuntimeContext,
  resolveAdminContextByAppSlug,
  runtimeContext,
} from '@/lib/runtime-context';

export default function AppLogin() {
  const navigate = useNavigate();
  const { appSlug: routeAppSlug = '' } = useParams();
  const appSlug = useMemo(() => String(routeAppSlug || '').trim().toLowerCase(), [routeAppSlug]);
  const [appName, setAppName] = useState(runtimeContext.appName || appSlug);
  const [loadingApp, setLoadingApp] = useState(false);
  const [appResolved, setAppResolved] = useState(true);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (!appSlug) return;
    applyRuntimeContext('business', appSlug, appSlug);
    setAppName(appSlug);
    setAppResolved(true);
    if (!runtimeContext.apiBaseUrl) {
      setLoadingApp(false);
      return;
    }

    let cancelled = false;
    setLoadingApp(true);
    resolveAdminContextByAppSlug(appSlug)
      .then((context) => {
        if (cancelled) return;
        if (context?.resolved && context.portal_mode === 'business' && context.app_slug) {
          applyRuntimeContext('business', context.app_slug, context.app_name);
          setAppName(context.app_name || context.app_slug);
          setAppResolved(true);
          return;
        }
        setAppResolved(false);
        setAppName(appSlug);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingApp(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [appSlug]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      if (!appResolved) {
        setMessage({ type: 'error', text: '未找到该应用' });
        return;
      }

      const resp = await authService.login(formData.email, formData.password);
      if (!resp?.user || resp.user.role !== 'ADMIN') {
        authService.logout();
        setMessage({ type: 'error', text: '该账号不是管理员，无法登录应用后台' });
        return;
      }
      if (resp.user.app_slug !== runtimeContext.appSlug) {
        authService.logout();
        setMessage({ type: 'error', text: '该账号不属于当前应用' });
        return;
      }
      setMessage({ type: 'success', text: '登录成功' });
      setTimeout(() => {
        navigate(runtimeContext.homePath);
      }, 300);
    } catch (error: any) {
      setMessage({
        type: 'error',
        text: error.message || '登录失败，请检查邮箱和密码',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-login-page">
      <section className="app-login-panel">
        <div className="app-login-brand">
          <AppBrandMark size={56} />
          <span>{loadingApp ? '加载中' : appName || appSlug}</span>
        </div>

        <div className="app-login-heading">
          <h1>{appName || appSlug}</h1>
          <p>管理员登录</p>
        </div>

        {!runtimeContext.apiBaseUrl && (
          <div className="alert alert-warning">
            未配置 API 地址。请设置 <code>VITE_API_BASE_URL</code>。
          </div>
        )}

        {!appResolved && (
          <div className="alert alert-error">
            未找到该应用
          </div>
        )}

        {message && (
          <div className={`alert alert-${message.type}`}>
            {message.text}
          </div>
        )}

        <form className="app-login-form" onSubmit={handleSubmit}>
          <label>
            管理员邮箱
            <input
              type="email"
              autoComplete="username email"
              value={formData.email}
              onChange={(event) => setFormData({ ...formData, email: event.target.value })}
              required
              placeholder="admin@example.com"
            />
          </label>

          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              value={formData.password}
              onChange={(event) => setFormData({ ...formData, password: event.target.value })}
              required
              placeholder="请输入密码"
            />
          </label>

          <button type="submit" className="btn app-login-submit" disabled={loading || loadingApp || !appResolved}>
            {loading ? '登录中...' : '进入后台'}
          </button>
        </form>
      </section>
    </div>
  );
}
