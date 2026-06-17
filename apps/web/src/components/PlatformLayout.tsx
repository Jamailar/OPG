import { ReactNode, useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { AppBrandMark, MenuIcon } from '@/components/AppBrand';
import { authApi } from '@/lib/api';
import { authService } from '@/lib/auth-service';
import { useCurrentUser } from '@/lib/hooks/use-api';
import { runtimeContext } from '@/lib/runtime-context';

interface PlatformLayoutProps {
  children: ReactNode;
}

type PlatformNavIconKey =
  | 'dashboard'
  | 'apps'
  | 'login'
  | 'proxy'
  | 'payment'
  | 'sms'
  | 'email'
  | 'storage'
  | 'settings'
  | 'api'
  | 'ai'
  | 'playground'
  | 'sources'
  | 'models'
  | 'usage';

const navItems = [
  {
    key: 'dashboard',
    icon: 'dashboard',
    label: '平台概览',
    desc: '租户规模与运行状态',
    path: '/platform-admin/dashboard',
  },
  {
    key: 'apps',
    icon: 'apps',
    label: '租户应用',
    desc: '画廊视图与租户工作区',
    path: '/platform-admin/apps',
  },
  {
    key: 'login-credentials',
    icon: 'login',
    label: '登录凭证',
    desc: '微信、GitHub、Google',
    path: '/platform-admin/login-credentials',
  },
  {
    key: 'proxies',
    icon: 'proxy',
    label: '代理 IP',
    desc: '出站代理与检测',
    path: '/platform-admin/proxies',
  },
  {
    key: 'payments',
    icon: 'payment',
    label: '支付方式',
    desc: '支付宝/微信密钥与链路测试',
    path: '/platform-admin/payments',
  },
  {
    key: 'sms',
    icon: 'sms',
    label: '短信服务',
    desc: '短信通道与签名配置',
    path: '/platform-admin/sms',
  },
  {
    key: 'email',
    icon: 'email',
    label: '邮件服务',
    desc: 'Cloudflare 发件与批次',
    path: '/platform-admin/email',
  },
  {
    key: 'storage',
    icon: 'storage',
    label: '对象存储',
    desc: 'OSS、S3 与 R2',
    path: '/platform-admin/storage',
  },
  {
    key: 'settings',
    icon: 'settings',
    label: '平台设置',
    desc: '域名、CORS 与运行参数',
    path: '/platform-admin/settings',
  },
  {
    key: 'apis',
    icon: 'api',
    label: '共享 API 列表',
    desc: '端点与中文说明',
    path: '/platform-admin/apis',
  },
] satisfies Array<{
  key: string;
  icon: PlatformNavIconKey;
  label: string;
  desc: string;
  path: string;
}>;

const platformNavIconPaths: Record<PlatformNavIconKey, string[]> = {
  dashboard: ['M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v4A1.5 1.5 0 0 1 9.5 11h-4A1.5 1.5 0 0 1 4 9.5v-4ZM13 5.5A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13 9.5v-4ZM4 14.5A1.5 1.5 0 0 1 5.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-4ZM13 14.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4Z'],
  apps: ['M12 4 4 8l8 4 8-4-8-4Z', 'M4 12l8 4 8-4', 'M4 16l8 4 8-4'],
  login: ['M15 7.5V6a3 3 0 0 0-6 0v1.5', 'M7 10h10a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 17 19H7a1.5 1.5 0 0 1-1.5-1.5v-6A1.5 1.5 0 0 1 7 10Z', 'M12 14v2'],
  proxy: ['M8 8h8a4 4 0 0 1 0 8h-2', 'M16 16H8a4 4 0 0 1 0-8h2', 'M9 12h6'],
  payment: ['M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v9A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5v-9Z', 'M4 10h16', 'M7 15h4'],
  sms: ['M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H11l-4.5 4v-4A2.5 2.5 0 0 1 4 12.5v-6Z', 'M8 8h8M8 11h5'],
  email: ['M4 7.5 12 13l8-5.5', 'M6 18h12A2 2 0 0 0 20 16V8A2 2 0 0 0 18 6H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2Z'],
  storage: ['M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Z', 'M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7', 'M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5'],
  settings: ['M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.04.05a2 2 0 0 1-2.83 2.83l-.05-.04A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 0 1-4 0v-.05A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.88.34l-.05.04a2 2 0 0 1-2.83-2.83l.04-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 0 1 0-4h.05A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.04-.05a2 2 0 0 1 2.83-2.83l.05.04A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 0 1 4 0v.05A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.05-.04a2 2 0 0 1 2.83 2.83l-.04.05A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 0 1 0 4h-.05A1.7 1.7 0 0 0 19.4 15Z'],
  api: ['M8 7 4 12l4 5', 'M16 7l4 5-4 5', 'M14 4l-4 16'],
  ai: ['M13 3 5 14h6l-1 7 9-12h-6l0-6Z'],
  playground: ['M12 3l1.9 5.9H20l-5 3.6 1.9 5.9-5-3.6-5 3.6L8.8 12.5l-5-3.6h6.2L12 3Z'],
  sources: ['M5 7a4 4 0 0 1 7-2.65A4 4 0 1 1 12 11H8', 'M19 17a4 4 0 0 1-7 2.65A4 4 0 1 1 12 13h4'],
  models: ['M12 4 4 8l8 4 8-4-8-4Z', 'M4 12l8 4 8-4', 'M4 16l8 4 8-4'],
  usage: ['M6 17v-5', 'M12 17V7', 'M18 17v-8'],
};

function PlatformNavIcon({ icon }: { icon: PlatformNavIconKey }) {
  return (
    <span className="platform-nav-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        {platformNavIconPaths[icon].map((path) => (
          <path key={path} d={path} />
        ))}
      </svg>
    </span>
  );
}

export default function PlatformLayout({ children }: PlatformLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: userInfo } = useCurrentUser();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [aiMenuExpanded, setAiMenuExpanded] = useState(location.pathname.startsWith('/platform-admin/ai'));
  const isTenantWorkspace = /^\/platform-admin\/apps\/[^/]+(?:\/|$)/.test(location.pathname);

  const aiSecondaryItems = [
    {
      key: 'ai-playground',
      icon: 'playground',
      label: 'Playground',
      desc: '直接调试文本、图片、语音和视频模型',
      path: '/platform-admin/ai/playground',
    },
    {
      key: 'ai-sources',
      icon: 'sources',
      label: '供应商',
      desc: '管理 AI 源与连通性测试',
      path: '/platform-admin/ai/sources',
    },
    {
      key: 'ai-models',
      icon: 'models',
      label: '模型',
      desc: '模型目录、供应商切换与测试',
      path: '/platform-admin/ai/models',
    },
    {
      key: 'ai-usage',
      icon: 'usage',
      label: '调用统计',
      desc: '调用量、成本与日志明细',
      path: '/platform-admin/ai/usage',
    },
  ] satisfies Array<{
    key: string;
    icon: PlatformNavIconKey;
    label: string;
    desc: string;
    path: string;
  }>;

  const isAiSection = location.pathname.startsWith('/platform-admin/ai');

  useEffect(() => {
    if (isAiSection) {
      setAiMenuExpanded(true);
    }
  }, [isAiSection]);

  const handleLogout = () => {
    authApi.logout();
    authService.logout();
    navigate(runtimeContext.loginPath);
  };

  return (
    <div className={`platform-shell ${isTenantWorkspace ? 'tenant-workspace-mode' : ''}`}>
      {!isTenantWorkspace && (
        <aside className={`platform-sidebar ${mobileOpen ? 'open' : ''}`}>
          <div className="platform-brand">
            <div className="platform-brand-logo">
              <AppBrandMark size={40} />
            </div>
            <div className="platform-brand-text">
              <h2>OPG</h2>
              <p>one person group</p>
            </div>
          </div>

          <nav className="platform-nav">
            {navItems.map((item) => (
              <NavLink
                key={item.key}
                to={item.path}
                className={({ isActive }) => `platform-nav-item ${isActive ? 'active' : ''}`}
                onClick={() => setMobileOpen(false)}
              >
                <PlatformNavIcon icon={item.icon} />
                <div className="platform-nav-item-title">{item.label}</div>
                <div className="platform-nav-item-desc">{item.desc}</div>
              </NavLink>
            ))}

            <div className={`platform-nav-group ${aiMenuExpanded ? 'expanded' : ''}`}>
              <button
                type="button"
                className={`platform-nav-group-trigger ${isAiSection ? 'active' : ''}`}
                onClick={() => setAiMenuExpanded((prev) => !prev)}
                aria-expanded={aiMenuExpanded}
              >
                <PlatformNavIcon icon="ai" />
                <div>
                  <div className="platform-nav-item-title">AI</div>
                  <div className="platform-nav-item-desc">配置供应商、模型与调试入口</div>
                </div>
                <span className="platform-nav-group-caret">{aiMenuExpanded ? '−' : '+'}</span>
              </button>

              {aiMenuExpanded && (
                <div className="platform-nav-children">
                  {aiSecondaryItems.map((item) => (
                    <NavLink
                      key={item.key}
                      to={item.path}
                      className={({ isActive }) => `platform-nav-subitem ${isActive ? 'active' : ''}`}
                      onClick={() => setMobileOpen(false)}
                    >
                      <PlatformNavIcon icon={item.icon} />
                      <div>
                        <div className="platform-nav-subitem-title">{item.label}</div>
                        <div className="platform-nav-subitem-desc">{item.desc}</div>
                      </div>
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          </nav>
        </aside>
      )}

      {!isTenantWorkspace && mobileOpen && <div className="platform-mask" onClick={() => setMobileOpen(false)} />}

      <div className={`platform-main ${isTenantWorkspace ? 'tenant-workspace-mode' : ''}`}>
        <header className="platform-header">
          {!isTenantWorkspace && (
            <button
              aria-label="打开导航菜单"
              className="platform-menu-btn"
              onClick={() => setMobileOpen((prev) => !prev)}
              title="打开导航菜单"
              type="button"
            >
              <MenuIcon />
            </button>
          )}
          <div className="platform-header-context">
            {isTenantWorkspace ? (
              <span>租户应用工作区</span>
            ) : (
              <>
                <span>平台管理台</span>
                <span>当前应用：{runtimeContext.appSlug}</span>
              </>
            )}
          </div>
          <div className="platform-header-user">
            <div className="platform-header-user-info">
              <strong>{userInfo?.display_name || userInfo?.email || '超级管理员'}</strong>
              <span>{userInfo?.email || 'platform-admin'}</span>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={handleLogout}>
              退出登录
            </button>
          </div>
        </header>

        <main className="platform-content">{children}</main>
      </div>
    </div>
  );
}
