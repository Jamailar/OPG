export function tenantControllerPaths(basePath: string, includeBarePath = false): string[] {
  return tenantVersionedControllerPaths(basePath, 'v1', includeBarePath);
}

export function tenantVersionedControllerPaths(basePath: string, version = 'v1', includeBarePath = false): string[] {
  const normalized = basePath.replace(/^\/+|\/+$/g, '');
  const safeVersion = version.replace(/^\/+|\/+$/g, '');
  const paths = [`/api/${safeVersion}/${normalized}`, `/:app/${safeVersion}/${normalized}`];

  if (includeBarePath) {
    paths.push(`/${normalized}`);
  }

  return paths;
}

export function tenantRootControllerPaths(version = 'v1', includeBarePath = false): string[] {
  const safeVersion = version.replace(/^\/+|\/+$/g, '');
  const paths = [`/api/${safeVersion}`, `/:app/${safeVersion}`];

  if (includeBarePath) {
    paths.push(`/${safeVersion}`);
  }

  return paths;
}

function normalizeRouteAppParam(value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.toLowerCase() === 'api') {
    return undefined;
  }
  return normalized;
}

export function resolveAppSlug(request: any, fallback?: string): string | undefined {
  return normalizeRouteAppParam(request?.params?.app) || normalizeRouteAppParam(request?.query?.app) || request?.user?.appSlug || fallback;
}
