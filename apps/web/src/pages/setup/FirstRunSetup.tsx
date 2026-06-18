import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppBrandMark } from '@/components/AppBrand';
import { bootstrapApi } from '@/lib/api';
import { authService } from '@/lib/auth-service';
import { runtimeContext } from '@/lib/runtime-context';

type Message = {
  type: 'success' | 'error' | 'info';
  text: string;
};

const setupFeatures = [
  { className: 'project', icon: 'M4 7.2A2.2 2.2 0 0 1 6.2 5h3.16l1.6 1.6h6.84A2.2 2.2 0 0 1 20 8.8v8A2.2 2.2 0 0 1 17.8 19H6.2A2.2 2.2 0 0 1 4 16.8Z', label: '空库启动' },
  { className: 'data', icon: 'M6 17v-5m6 5V7m6 10v-8', label: '自动建表' },
  { className: 'business', icon: 'M12 4 4 8l8 4 8-4-8-4Zm-8 8 8 4 8-4M4 16l8 4 8-4', label: '平台应用' },
  { className: 'flow', icon: 'M13 3 5 14h6l-1 7 9-12h-6l0-6Z', label: '进入控制台' },
  { className: 'team', icon: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 19a4 4 0 0 1 8 0m0 0a4 4 0 0 1 8 0', label: '超级管理员' },
];

export default function FirstRunSetup() {
  const navigate = useNavigate();
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [formData, setFormData] = useState({
    displayName: '',
    email: '',
    password: '',
    confirmPassword: '',
  });

  useEffect(() => {
    let cancelled = false;

    bootstrapApi.getStatus()
      .then((status) => {
        if (cancelled) return;
        if (!status.needs_setup) {
          navigate(runtimeContext.loginPath, { replace: true });
          return;
        }
        setLoadingStatus(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMessage({ type: 'error', text: '无法读取初始化状态，请稍后重试' });
        setLoadingStatus(false);
      });

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const updateForm = (patch: Partial<typeof formData>) => {
    setFormData((prev) => ({ ...prev, ...patch }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const email = formData.email.trim();
    const password = formData.password;
    const displayName = formData.displayName.trim();

    if (password.length < 8) {
      setMessage({ type: 'error', text: '密码至少需要 8 个字符' });
      return;
    }
    if (password !== formData.confirmPassword) {
      setMessage({ type: 'error', text: '两次输入的密码不一致' });
      return;
    }

    setSubmitting(true);
    setMessage(null);

    try {
      await bootstrapApi.createPlatformAdmin({
        email,
        password,
        display_name: displayName || undefined,
      });
      await authService.loginPlatform(email, password);
      setMessage({ type: 'success', text: '初始化完成' });
      navigate('/platform-admin/apps', { replace: true });
    } catch (error: any) {
      const status = error?.response?.status;
      const serverMessage = error?.response?.data?.message || error?.message;
      if (status === 409) {
        setMessage({ type: 'info', text: '平台管理员已存在，请直接登录' });
        navigate(runtimeContext.loginPath, { replace: true });
        return;
      }
      setMessage({ type: 'error', text: serverMessage || '初始化失败，请检查输入后重试' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ac-login-page ac-login-screen ac-setup-screen">
      <div className="ac-login-backdrop" aria-hidden="true" />
      <div className="ac-login-language" aria-label="当前语言">
        <span className="ac-login-language-icon" aria-hidden="true">◎</span>
        简体中文
        <span aria-hidden="true">⌄</span>
      </div>
      <div className="ac-login-shell">
        <section className="ac-login-intro">
          <div className="ac-login-brand-row">
            <AppBrandMark size={44} />
            <strong>opg</strong>
            <span />
            <small>one person group</small>
          </div>

          <div className="ac-login-intro-main">
            <h1>
              <span>首次启动</span>
              <strong>初始化平台</strong>
            </h1>
            <p>从空数据库启动，创建平台应用并绑定首个超级管理员。</p>
          </div>

          <div className="ac-login-hero">
            <div className="ac-login-orbit orbit-one" aria-hidden="true" />
            <div className="ac-login-orbit orbit-two" aria-hidden="true" />
            <div className="ac-login-orbit orbit-three" aria-hidden="true" />
            <div className="ac-login-hero-mark">
              <AppBrandMark size={224} />
            </div>
            {setupFeatures.map((item) => (
              <div key={item.className} className={`ac-feature-chip ${item.className}`}>
                <span className="ac-feature-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path d={item.icon} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
                  </svg>
                </span>
                {item.label}
              </div>
            ))}
            <span className="ac-orbit-dot dot-one" aria-hidden="true" />
            <span className="ac-orbit-dot dot-two" aria-hidden="true" />
            <span className="ac-orbit-dot dot-three" aria-hidden="true" />
            <span className="ac-orbit-dot dot-four" aria-hidden="true" />
          </div>

          <div className="ac-login-proof">
            <div className="ac-proof-avatars" aria-hidden="true">
              <span>DB</span>
              <span>OP</span>
              <span>AI</span>
            </div>
            <p>初始化完成后，系统会自动关闭首次启动入口，并进入平台管理台。</p>
          </div>
        </section>

        <section className="ac-login-card">
          <div className="ac-login-card-brand">
            <AppBrandMark size={52} />
            <strong>opg</strong>
          </div>
          <div className="ac-login-header">
            <div>
              <h2>设置管理员</h2>
              <p>创建首个超级管理员账号</p>
            </div>
          </div>

          {loadingStatus ? (
            <div className="loading">加载中...</div>
          ) : (
            <>
              {message && (
                <div className={`alert alert-${message.type}`}>
                  {message.text}
                </div>
              )}

              <form className="ac-login-form" onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>显示名称</label>
                  <div className="ac-input-wrap">
                    <span aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none">
                        <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7 8a7 7 0 0 0-14 0" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                      </svg>
                    </span>
                    <input
                      type="text"
                      autoComplete="name"
                      value={formData.displayName}
                      onChange={(event) => updateForm({ displayName: event.target.value })}
                      placeholder="管理员"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>管理员邮箱 *</label>
                  <div className="ac-input-wrap">
                    <span aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none">
                        <path d="M4 7.5 12 13l8-5.5M6.2 19h11.6A2.2 2.2 0 0 0 20 16.8V7.2A2.2 2.2 0 0 0 17.8 5H6.2A2.2 2.2 0 0 0 4 7.2v9.6A2.2 2.2 0 0 0 6.2 19Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                      </svg>
                    </span>
                    <input
                      type="email"
                      autoComplete="username email"
                      value={formData.email}
                      onChange={(event) => updateForm({ email: event.target.value })}
                      required
                      placeholder="admin@example.com"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>密码 *</label>
                  <div className="ac-input-wrap">
                    <span aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none">
                        <path d="M7 10V8a5 5 0 0 1 10 0v2M6.8 10h10.4A1.8 1.8 0 0 1 19 11.8v6.4a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 18.2v-6.4A1.8 1.8 0 0 1 6.8 10Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                      </svg>
                    </span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={formData.password}
                      onChange={(event) => updateForm({ password: event.target.value })}
                      required
                      minLength={8}
                      placeholder="至少 8 个字符"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>确认密码 *</label>
                  <div className="ac-input-wrap">
                    <span aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none">
                        <path d="M9 12.5 11.2 15 16 9M12 22c5-2.2 7-5.7 7-11V6l-7-3-7 3v5c0 5.3 2 8.8 7 11Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                      </svg>
                    </span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={formData.confirmPassword}
                      onChange={(event) => updateForm({ confirmPassword: event.target.value })}
                      required
                      minLength={8}
                      placeholder="再次输入密码"
                    />
                  </div>
                </div>

                <button type="submit" className="btn ac-login-btn" disabled={submitting}>
                  {submitting ? '初始化中...' : '完成初始化'}
                </button>
              </form>
            </>
          )}
        </section>
      </div>
      <footer className="ac-login-footer">
        <span>© 2024 opg (one person group)，保留所有权利。</span>
        <a>隐私政策</a>
        <a>服务条款</a>
        <a>联系我们</a>
      </footer>
    </div>
  );
}
