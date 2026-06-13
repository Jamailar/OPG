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

const navItems = [
  {
    key: 'dashboard',
    label: '平台概览',
    desc: '租户规模与运行状态',
    path: '/platform-admin/dashboard',
  },
  {
    key: 'apps',
    label: '租户应用',
    desc: '画廊视图与租户工作区',
    path: '/platform-admin/apps',
  },
  {
    key: 'agents',
    label: 'Agent',
    desc: '平台级 Agent 与租户发布',
    path: '/platform-admin/agents',
  },
  {
    key: 'login-credentials',
    label: '登录凭证',
    desc: '微信、GitHub、Google',
    path: '/platform-admin/login-credentials',
  },
  {
    key: 'proxies',
    label: '代理 IP',
    desc: '出站代理与检测',
    path: '/platform-admin/proxies',
  },
  {
    key: 'payments',
    label: '支付方式',
    desc: '支付宝/微信密钥与链路测试',
    path: '/platform-admin/payments',
  },
  {
    key: 'sms',
    label: '短信服务',
    desc: '短信通道与签名配置',
    path: '/platform-admin/sms',
  },
  {
    key: 'email',
    label: '邮件服务',
    desc: 'Cloudflare 发件与批次',
    path: '/platform-admin/email',
  },
  {
    key: 'settings',
    label: '平台设置',
    desc: '域名、CORS 与运行参数',
    path: '/platform-admin/settings',
  },
  {
    key: 'apis',
    label: '共享 API 列表',
    desc: '端点与中文说明',
    path: '/platform-admin/apis',
  },
];

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
      label: 'Playground',
      desc: '直接调试文本、图片、语音和视频模型',
      path: '/platform-admin/ai/playground',
    },
    {
      key: 'ai-sources',
      label: '供应商',
      desc: '管理 AI 源与连通性测试',
      path: '/platform-admin/ai/sources',
    },
    {
      key: 'ai-models',
      label: '模型',
      desc: '模型目录、供应商切换与测试',
      path: '/platform-admin/ai/models',
    },
    {
      key: 'ai-usage',
      label: '调用统计',
      desc: '调用量、成本与日志明细',
      path: '/platform-admin/ai/usage',
    },
  ];

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
              <p>{`v${__APP_VERSION__}`}</p>
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
                      <div className="platform-nav-subitem-title">{item.label}</div>
                      <div className="platform-nav-subitem-desc">{item.desc}</div>
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
