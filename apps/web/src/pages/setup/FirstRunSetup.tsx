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
      await authService.login(email, password);
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
    <div className="ac-login-page">
      <div className="ac-login-backdrop" aria-hidden="true" />
      <div className="ac-login-shell">
        <section className="ac-login-intro">
          <div className="ac-login-intro-main">
            <div className="ac-login-intro-mark">
              <AppBrandMark size={112} />
            </div>
            <div className="ac-brand-pill">OPG</div>
            <h1>初始化平台</h1>
            <p>创建首个超级管理员后，初始化入口会自动关闭。</p>
            <ul>
              <li>创建 platform 应用</li>
              <li>绑定超级管理员账号</li>
              <li>进入平台管理台</li>
            </ul>
          </div>

          <div className="ac-login-intro-footer">
            <strong>OPG</strong>
            <span>首次启动</span>
          </div>
        </section>

        <section className="ac-login-card">
          <div className="ac-login-header">
            <div className="ac-login-logo">
              <AppBrandMark size={60} />
            </div>
            <div>
              <h2>设置管理员</h2>
              <p>用于登录平台管理台</p>
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
                  <input
                    type="text"
                    autoComplete="name"
                    value={formData.displayName}
                    onChange={(event) => updateForm({ displayName: event.target.value })}
                    placeholder="管理员"
                  />
                </div>

                <div className="form-group">
                  <label>管理员邮箱 *</label>
                  <input
                    type="email"
                    autoComplete="username email"
                    value={formData.email}
                    onChange={(event) => updateForm({ email: event.target.value })}
                    required
                    placeholder="admin@example.com"
                  />
                </div>

                <div className="form-group">
                  <label>密码 *</label>
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

                <div className="form-group">
                  <label>确认密码 *</label>
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

                <button type="submit" className="btn ac-login-btn" disabled={submitting}>
                  {submitting ? '初始化中...' : '完成初始化'}
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
