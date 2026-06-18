import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppBrandMark } from '@/components/AppBrand';
import { authService } from '@/lib/auth-service';
import { runtimeContext } from '@/lib/runtime-context';

const heroFeatures = [
  { className: 'project', icon: 'M4 7.2A2.2 2.2 0 0 1 6.2 5h3.16l1.6 1.6h6.84A2.2 2.2 0 0 1 20 8.8v8A2.2 2.2 0 0 1 17.8 19H6.2A2.2 2.2 0 0 1 4 16.8Z', label: '项目管理' },
  { className: 'data', icon: 'M6 17v-5m6 5V7m6 10v-8', label: '数据分析' },
  { className: 'business', icon: 'M12 4 4 8l8 4 8-4-8-4Zm-8 8 8 4 8-4M4 16l8 4 8-4', label: '多业务单元' },
  { className: 'flow', icon: 'M13 3 5 14h6l-1 7 9-12h-6l0-6Z', label: '自动化流程' },
  { className: 'team', icon: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 19a4 4 0 0 1 8 0m0 0a4 4 0 0 1 8 0', label: '团队协作' },
];

export default function Login() {
  const navigate = useNavigate();
  const isPlatformPortal = runtimeContext.isPlatformPortal;
  const title = isPlatformPortal ? '欢迎回来' : '应用后台登录';
  const subtitle = isPlatformPortal ? '登录你的 opg 账户，继续高效管理' : '使用管理员账号进入应用后台';
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      console.log('[AdminLogin] submit email:', formData.email);
      const resp = await authService.login(formData.email, formData.password);
      console.log('[AdminLogin] success user role:', resp?.user?.role, 'admin_type:', resp?.user?.admin_type);
      if (!resp?.user || resp.user.role !== 'ADMIN') {
        authService.logout();
        setMessage({ type: 'error', text: '该账号不是管理员，无法登录管理后台' });
        return;
      }
      const isSuperAdmin = resp.user.admin_type === 'SUPER_ADMIN';
      if (isPlatformPortal && !isSuperAdmin) {
        authService.logout();
        setMessage({ type: 'error', text: '仅超级管理员可登录平台租户管理后台' });
        return;
      }
      setMessage({ type: 'success', text: '登录成功！' });
      // 登录成功后跳转到管理后台
      setTimeout(() => {
        const sdkLoginReturn = localStorage.getItem('opg_sdk_login_return') || '';
        if (sdkLoginReturn.startsWith('/sdk-login')) {
          localStorage.removeItem('opg_sdk_login_return');
          navigate(sdkLoginReturn);
          return;
        }
        navigate(runtimeContext.homePath);
      }, 500);
    } catch (error: any) {
      console.log('[AdminLogin] failed:', error?.response?.data || error);
      setMessage({
        type: 'error',
        text: error.message || '登录失败，请检查邮箱和密码',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ac-login-page ac-login-screen">
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
              <span>一个人管理</span>
              <strong>一个集团</strong>
            </h1>
            <p>opg 帮助独立开发者和小团队，轻松管理多个项目、团队和业务单元。</p>
          </div>

          <div className="ac-login-hero">
            <div className="ac-login-orbit orbit-one" aria-hidden="true" />
            <div className="ac-login-orbit orbit-two" aria-hidden="true" />
            <div className="ac-login-orbit orbit-three" aria-hidden="true" />
            <div className="ac-login-hero-mark">
              <AppBrandMark size={224} />
            </div>
            {heroFeatures.map((item) => (
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
              <span>J</span>
              <span>A</span>
              <span>M</span>
            </div>
            <p>“自从使用 opg，我一个人就能管理 5 个项目，效率提升了 300%。”<br />— 独立开发者 · Alex</p>
          </div>
        </section>

        <section className="ac-login-card">
          <div className="ac-login-card-brand">
            <AppBrandMark size={52} />
            <strong>opg</strong>
          </div>
          <div className="ac-login-header">
            <div>
              <h2>{title}</h2>
              <p>{subtitle}</p>
            </div>
          </div>

          {!runtimeContext.apiBaseUrl && (
            <div className="alert alert-warning">
              未配置 API 地址。请在部署环境设置 <code>VITE_API_BASE_URL</code> 指向 gateway-api 域名。
            </div>
          )}

          {message && (
            <div className={`alert alert-${message.type}`}>
              {message.text}
            </div>
          )}

          <form className="ac-login-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label>邮箱地址</label>
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
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  required
                  placeholder="请输入邮箱地址"
                />
              </div>
            </div>

            <div className="form-group">
              <label>密码</label>
              <div className="ac-input-wrap">
                <span aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path d="M7 10V8a5 5 0 0 1 10 0v2M6.8 10h10.4A1.8 1.8 0 0 1 19 11.8v6.4a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 18.2v-6.4A1.8 1.8 0 0 1 6.8 10Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  </svg>
                </span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  required
                  placeholder="请输入密码"
                />
              </div>
            </div>

            <button type="submit" className="btn ac-login-btn" disabled={loading}>
              {loading ? '登录中...' : '登录'}
            </button>
          </form>
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
