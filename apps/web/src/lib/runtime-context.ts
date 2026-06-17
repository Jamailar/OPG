type AdminPortalMode = 'business' | 'platform';

interface DiscoveryData {
  resolved: boolean;
  portal_mode: AdminPortalMode;
  app_slug: string;
  app_name?: string | null;
}

interface RemoteRuntimeConfig {
  api_base_url?: string | null;
  platform_app_slug?: string | null;
  admin_portal_mode?: 'auto' | 'platform' | 'business' | string | null;
}

function readRuntimeConfig(key: keyof AppAdminRuntimeConfig): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return String(window.__APPADMIN_RUNTIME_CONFIG__?.[key] || '').trim();
}

function isLocalHost(host: string): boolean {
  const value = host.toLowerCase();
  return (
    value === 'localhost' ||
    value === '127.0.0.1' ||
    value === '0.0.0.0' ||
    value.endsWith('.local')
  );
}

function resolveApiBaseUrl(): string {
  const envBase = readConfiguredApiBaseUrl();
  if (envBase) {
    const normalized = envBase.replace(/\/+$/, '');
    if (typeof window !== 'undefined') {
      const currentHost = window.location.hostname.toLowerCase();
      const isCurrentLocal = isLocalHost(currentHost);

      try {
        const envHost = new URL(normalized).hostname.toLowerCase();
        const isEnvLocal = isLocalHost(envHost);

        if (!isCurrentLocal && isEnvLocal) {
          console.error(
            '[RuntimeContext] VITE_API_BASE_URL 配置为 localhost，但当前为线上域名访问。请改为网关真实域名。',
          );
          return '';
        }
      } catch {
        // Ignore parse errors and use normalized value.
      }
    }
    return normalized;
  }

  if (typeof window !== 'undefined' && isLocalHost(window.location.hostname)) {
    return 'http://localhost:8000';
  }

  return '';
}

function readConfiguredApiBaseUrl(): string {
  return readRuntimeConfig('VITE_API_BASE_URL') || (import.meta.env.VITE_API_BASE_URL || '').trim();
}

function hasConfiguredApiBaseUrl(): boolean {
  return Boolean(readConfiguredApiBaseUrl());
}

let API_BASE_URL = resolveApiBaseUrl();
let PLATFORM_APP_SLUG = (
  readRuntimeConfig('VITE_PLATFORM_APP_SLUG') ||
  import.meta.env.VITE_PLATFORM_APP_SLUG ||
  'platform'
).trim();
const PLATFORM_ADMIN_DOMAIN = (
  readRuntimeConfig('VITE_PLATFORM_ADMIN_DOMAIN') ||
  import.meta.env.VITE_PLATFORM_ADMIN_DOMAIN ||
  ''
).trim();
let ADMIN_PORTAL_MODE = (
  readRuntimeConfig('VITE_ADMIN_PORTAL_MODE') ||
  import.meta.env.VITE_ADMIN_PORTAL_MODE ||
  'platform'
).trim().toLowerCase();

interface DiscoveryResponse {
  code: number;
  message: string;
  data?: DiscoveryData;
}

function normalizeHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const withProtocol = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).host.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function resolvePortalModeByEnv(): AdminPortalMode {
  if (ADMIN_PORTAL_MODE === 'business') return 'business';
  if (ADMIN_PORTAL_MODE !== 'auto') return 'platform';

  if (typeof window === 'undefined') return 'platform';
  const currentHost = window.location.host.toLowerCase();
  const platformHost = normalizeHost(PLATFORM_ADMIN_DOMAIN);
  if (platformHost && currentHost === platformHost) {
    return 'platform';
  }
  return 'business';
}

function normalizeSlug(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function businessLoginPath(appSlug: string): string {
  const slug = normalizeSlug(appSlug);
  return slug ? `/${slug}` : '/auth/login';
}

function businessHomePath(appSlug: string): string {
  const slug = normalizeSlug(appSlug);
  return slug ? `/${slug}/admin` : '/admin';
}

function computeContext(mode: AdminPortalMode, appSlug: string, appName?: string | null) {
  const normalizedAppSlug = normalizeSlug(appSlug);
  const apiV1Prefix = mode === 'platform' ? '/api/v1' : `/${normalizedAppSlug}/v1`;
  return {
    portalMode: mode,
    isPlatformPortal: mode === 'platform',
    appSlug: normalizedAppSlug,
    appName: appName || '',
    apiBaseUrl: API_BASE_URL,
    apiV1Prefix,
    apiV1BaseUrl: API_BASE_URL ? `${API_BASE_URL}${apiV1Prefix}` : '',
    homePath: mode === 'platform' ? '/platform-admin/apps' : businessHomePath(normalizedAppSlug),
    loginPath: mode === 'platform' ? '/auth/login' : businessLoginPath(normalizedAppSlug),
  };
}

const initialMode = resolvePortalModeByEnv();
const initialAppSlug = PLATFORM_APP_SLUG;

export const runtimeContext = computeContext(initialMode, initialAppSlug);

export function applyRuntimeContext(mode: AdminPortalMode, appSlug: string, appName?: string | null) {
  const next = computeContext(mode, appSlug, appName);
  Object.assign(runtimeContext, next);
}

async function loadRemoteRuntimeConfig(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  const hasExplicitApiBaseUrl = hasConfiguredApiBaseUrl();
  const sameOriginRuntimeConfigUrl = `${window.location.origin}/runtime-config`;
  const configuredRuntimeConfigUrl = API_BASE_URL ? `${API_BASE_URL}/runtime-config` : '';
  const candidates = Array.from(
    new Set(
      (hasExplicitApiBaseUrl
        ? [configuredRuntimeConfigUrl, sameOriginRuntimeConfigUrl]
        : [sameOriginRuntimeConfigUrl, configuredRuntimeConfigUrl]
      ).filter(Boolean),
    ),
  );

  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        continue;
      }
      const payload = await response.json();
      const data = (payload?.data || payload) as RemoteRuntimeConfig;
      const apiBaseUrl = String(data.api_base_url || '').trim().replace(/\/+$/, '');
      if (apiBaseUrl) {
        API_BASE_URL = apiBaseUrl;
      } else {
        const responseOrigin = new URL(response.url || url, window.location.href).origin;
        if (responseOrigin === window.location.origin) {
          API_BASE_URL = window.location.origin;
        }
      }
      const platformSlug = String(data.platform_app_slug || '').trim();
      if (platformSlug) {
        PLATFORM_APP_SLUG = platformSlug;
      }
      const portalMode = String(data.admin_portal_mode || '').trim().toLowerCase();
      if (portalMode === 'auto' || portalMode === 'platform' || portalMode === 'business') {
        ADMIN_PORTAL_MODE = portalMode;
      }
      const mode = resolvePortalModeByEnv();
      applyRuntimeContext(mode, mode === 'platform' ? PLATFORM_APP_SLUG : runtimeContext.appSlug || PLATFORM_APP_SLUG, runtimeContext.appName);
      return;
    } catch {
      // Keep local runtime fallback and try the next candidate.
    }
  }
}

const RESERVED_APP_SLUG_PATHS = new Set([
  'admin',
  'api',
  'assets',
  'auth',
  'discovery',
  'env.js',
  'favicon.ico',
  'platform-admin',
  'setup',
]);

function resolvePathAppSlug(): string {
  if (typeof window === 'undefined') return '';
  const segments = window.location.pathname
    .split('/')
    .map((item) => item.trim())
    .filter(Boolean);
  let decoded = segments[0] || '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    decoded = segments[0] || '';
  }
  const first = normalizeSlug(decoded);
  if (!first || RESERVED_APP_SLUG_PATHS.has(first)) return '';
  if (segments.length === 1 || normalizeSlug(segments[1]) === 'admin') return first;
  return '';
}

export async function resolveAdminContextByAppSlug(appSlug: string): Promise<DiscoveryData | null> {
  const slug = normalizeSlug(appSlug);
  if (!API_BASE_URL || !slug) {
    return null;
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/discovery/admin-context?app_slug=${encodeURIComponent(slug)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
    );

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as DiscoveryResponse;
    if (payload.code !== 200 || !payload.data) {
      return null;
    }

    return payload.data;
  } catch {
    return null;
  }
}

export async function bootstrapRuntimeContext(): Promise<void> {
  await loadRemoteRuntimeConfig();

  const pathAppSlug = resolvePathAppSlug();
  if (pathAppSlug) {
    const discovered = await resolveAdminContextByAppSlug(pathAppSlug);
    if (discovered?.resolved && discovered.portal_mode === 'business' && discovered.app_slug) {
      applyRuntimeContext('business', discovered.app_slug, discovered.app_name);
      return;
    }
    applyRuntimeContext('business', pathAppSlug);
    return;
  }

  if (!API_BASE_URL) {
    return;
  }

  if (ADMIN_PORTAL_MODE !== 'auto') {
    return;
  }

  if (typeof window === 'undefined') {
    return;
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/discovery/admin-context?host=${encodeURIComponent(window.location.host)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
    );

    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as DiscoveryResponse;
    if (payload.code !== 200 || !payload.data) {
      return;
    }

    const mode = payload.data.portal_mode;
    const appSlug = payload.data.app_slug;
    if (!mode || !appSlug) {
      return;
    }

    applyRuntimeContext(mode, appSlug, payload.data.app_name);
  } catch {
    // Ignore discovery errors and keep env fallback context.
  }
}
