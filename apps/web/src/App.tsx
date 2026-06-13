import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { authService } from '@/lib/auth-service';
import { useCurrentUser } from '@/lib/hooks/use-api';
import Login from '@/pages/auth/Login';
import AppLogin from '@/pages/auth/AppLogin';
import PlatformDashboard from '@/pages/platform/PlatformDashboard';
import AppTenants from '@/pages/platform/AppTenants';
import SharedApiCatalog from '@/pages/platform/SharedApiCatalog';
import TenantWorkspace from '@/pages/platform/TenantWorkspace';
import AiWorkspace from '@/pages/platform/AiWorkspace';
import GlobalAiSourcesPage from '@/pages/platform/GlobalAiSourcesPage';
import GlobalAiModelsPage from '@/pages/platform/GlobalAiModelsPage';
import GlobalAiPlaygroundPage from '@/pages/platform/GlobalAiPlaygroundPage';
import GlobalAiUsagePage from '@/pages/platform/GlobalAiUsagePage';
import LoginCredentialsPage from '@/pages/platform/LoginCredentialsPage';
import OutboundProxiesPage from '@/pages/platform/OutboundProxiesPage';
import PlatformPaymentMethodsPage from '@/pages/platform/PlatformPaymentMethodsPage';
import PlatformSmsServicesPage from '@/pages/platform/PlatformSmsServicesPage';
import PlatformEmailServicePage from '@/pages/platform/PlatformEmailServicePage';
import PlatformAgentsPage from '@/pages/platform/PlatformAgentsPage';
import PlatformRuntimeSettingsPage from '@/pages/platform/PlatformRuntimeSettingsPage';
import PlatformLayout from '@/components/PlatformLayout';
import { applyRuntimeContext, runtimeContext } from '@/lib/runtime-context';
import '@/styles/globals.css';

function PlatformProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { data: userInfo, isLoading } = useCurrentUser();
  const authed = authService.isAuthenticated();
  console.log('[PlatformGuard] path:', location.pathname, 'authed:', authed, 'loading:', isLoading);

  if (!authed) {
    return <Navigate to={runtimeContext.loginPath} replace />;
  }

  if (isLoading) {
    return <div className="container"><div className="loading">加载中...</div></div>;
  }

  if (
    !userInfo ||
    userInfo.role !== 'ADMIN' ||
    userInfo.admin_type !== 'SUPER_ADMIN' ||
    userInfo.app_slug !== runtimeContext.appSlug
  ) {
    authService.logout();
    return <Navigate to={runtimeContext.loginPath} replace />;
  }

  return <PlatformLayout>{children}</PlatformLayout>;
}

function BusinessProtectedRoute() {
  const { appSlug: routeAppSlug = '' } = useParams();
  if (routeAppSlug && runtimeContext.portalMode !== 'business') {
    applyRuntimeContext('business', routeAppSlug, routeAppSlug);
  }
  const { data: userInfo, isLoading } = useCurrentUser();
  const authed = authService.isAuthenticated();

  if (!authed) {
    return <Navigate to={runtimeContext.loginPath} replace />;
  }

  if (isLoading) {
    return <div className="container"><div className="loading">加载中...</div></div>;
  }

  if (!userInfo || userInfo.role !== 'ADMIN' || userInfo.app_slug !== runtimeContext.appSlug || !userInfo.app_id) {
    authService.logout();
    return <Navigate to={runtimeContext.loginPath} replace />;
  }

  return <TenantWorkspace appIdOverride={String(userInfo.app_id)} />;
}

function App() {
  return (
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <Routes>
        <Route path="/auth/login" element={<Login />} />
        <Route path="/:appSlug" element={<AppLogin />} />
        <Route path="/:appSlug/admin/*" element={<BusinessProtectedRoute />} />
        <Route path="/admin/*" element={<BusinessProtectedRoute />} />

        <Route
          path="/platform-admin/dashboard"
          element={
            <PlatformProtectedRoute>
              <PlatformDashboard />
            </PlatformProtectedRoute>
          }
        />

        <Route
          path="/platform-admin/apps"
          element={
            <PlatformProtectedRoute>
              <AppTenants />
            </PlatformProtectedRoute>
          }
        />

        <Route
          path="/platform-admin/apps/:appId/*"
          element={
            <PlatformProtectedRoute>
              <TenantWorkspace />
            </PlatformProtectedRoute>
          }
        />

        <Route
          path="/platform-admin/ai/*"
          element={
            <PlatformProtectedRoute>
              <AiWorkspace />
            </PlatformProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/platform-admin/ai/playground" replace />} />
          <Route path="playground" element={<GlobalAiPlaygroundPage />} />
          <Route path="sources" element={<GlobalAiSourcesPage />} />
          <Route path="models" element={<GlobalAiModelsPage />} />
          <Route path="usage" element={<GlobalAiUsagePage />} />
        </Route>

        <Route
          path="/platform-admin/agents"
          element={
            <PlatformProtectedRoute>
              <PlatformAgentsPage />
            </PlatformProtectedRoute>
          }
        />

        <Route
          path="/platform-admin/proxies"
          element={
            <PlatformProtectedRoute>
              <OutboundProxiesPage />
            </PlatformProtectedRoute>
          }
        />

        <Route
          path="/platform-admin/login-credentials"
          element={
            <PlatformProtectedRoute>
              <LoginCredentialsPage />
            </PlatformProtectedRoute>
          }
        />

        <Route path="/platform-admin/wechat/open-apps" element={<Navigate to="/platform-admin/login-credentials?provider=wechat" replace />} />
        <Route path="/platform-admin/google/oauth-clients" element={<Navigate to="/platform-admin/login-credentials?provider=google" replace />} />
        <Route path="/platform-admin/github/oauth-apps" element={<Navigate to="/platform-admin/login-credentials?provider=github" replace />} />

        <Route
          path="/platform-admin/payments"
          element={
            <PlatformProtectedRoute>
              <PlatformPaymentMethodsPage />
            </PlatformProtectedRoute>
          }
        />

        <Route
          path="/platform-admin/sms"
          element={
            <PlatformProtectedRoute>
              <PlatformSmsServicesPage />
            </PlatformProtectedRoute>
          }
        />

        <Route
          path="/platform-admin/email"
          element={
            <PlatformProtectedRoute>
              <PlatformEmailServicePage />
            </PlatformProtectedRoute>
          }
        />

        <Route
          path="/platform-admin/settings"
          element={
            <PlatformProtectedRoute>
              <PlatformRuntimeSettingsPage />
            </PlatformProtectedRoute>
          }
        />

        <Route
          path="/platform-admin/apis"
          element={
            <PlatformProtectedRoute>
              <SharedApiCatalog />
            </PlatformProtectedRoute>
          }
        />

        <Route path="/platform-admin" element={<Navigate to="/platform-admin/dashboard" replace />} />
        <Route path="/" element={<Navigate to={runtimeContext.homePath} replace />} />
        <Route path="*" element={<Navigate to={runtimeContext.homePath} replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
