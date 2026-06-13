import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppBrandMark } from '@/components/AppBrand';
import { authService } from '@/lib/auth-service';
import { runtimeContext } from '@/lib/runtime-context';

export default function Login() {
  const navigate = useNavigate();
  const isPlatformPortal = runtimeContext.isPlatformPortal;
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
    <div className="ac-login-page">
      <div className="ac-login-backdrop" aria-hidden="true" />
      <div className="ac-login-shell">
        <section className="ac-login-intro">
          <div className="ac-login-intro-main">
            <div className="ac-login-intro-mark">
              <AppBrandMark size={112} />
            </div>
            <div className="ac-brand-pill">OPG</div>
            <h1>{isPlatformPortal ? '欢迎进入平台管理台' : '管理员登录'}</h1>
            <p>{isPlatformPortal ? '统一查看租户应用、AI 服务、支付方式与短信配置。该入口仅面向超级管理员。' : '使用管理员账号进入应用后台。'}</p>
            {isPlatformPortal && (
              <ul>
                <li>租户接入与状态查看</li>
                <li>管理员账号与权限控制</li>
                <li>平台服务配置与运行检查</li>
              </ul>
            )}
          </div>

          <div className="ac-login-intro-footer">
            <strong>OPG</strong>
            <span>{isPlatformPortal ? '超级管理员入口' : runtimeContext.appSlug}</span>
          </div>
        </section>

        <section className="ac-login-card">
          <div className="ac-login-header">
            <div className="ac-login-logo">
              <AppBrandMark size={60} />
            </div>
            <div>
              <h2>{isPlatformPortal ? '管理员登录' : '应用后台登录'}</h2>
              <p>使用管理员账号进入控制台</p>
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
              <label>管理员邮箱 *</label>
              <input
                type="email"
                autoComplete="username email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                required
                placeholder="admin@example.com"
              />
            </div>

            <div className="form-group">
              <label>密码 *</label>
              <input
                type="password"
                autoComplete="current-password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                required
                placeholder="请输入密码"
              />
            </div>

            <button type="submit" className="btn ac-login-btn" disabled={loading}>
              {loading ? '登录中...' : isPlatformPortal ? '进入平台' : '进入后台'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
