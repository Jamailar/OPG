/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_PLATFORM_APP_SLUG?: string;
  readonly VITE_PLATFORM_ADMIN_DOMAIN?: string;
  readonly VITE_ADMIN_PORTAL_MODE?: 'auto' | 'platform' | 'business';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;

interface AppAdminRuntimeConfig {
  VITE_API_BASE_URL?: string;
  VITE_PLATFORM_APP_SLUG?: string;
  VITE_PLATFORM_ADMIN_DOMAIN?: string;
  VITE_ADMIN_PORTAL_MODE?: 'auto' | 'platform' | 'business';
}

interface Window {
  __APPADMIN_RUNTIME_CONFIG__?: AppAdminRuntimeConfig;
}
