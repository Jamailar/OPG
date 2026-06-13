const pickCookieValue = (cookieHeader: string | undefined, key: string): string | null => {
  if (!cookieHeader || !key) {
    return null;
  }

  const entries = cookieHeader.split(';');
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const cookieKey = trimmed.slice(0, eqIndex).trim();
    if (cookieKey !== key) {
      continue;
    }

    const rawValue = trimmed.slice(eqIndex + 1).trim();
    if (!rawValue) {
      return null;
    }

    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return null;
};

const normalizeToken = (value: string | null | undefined): string | null => {
  const token = String(value || '').trim();
  if (!token) {
    return null;
  }

  if (token.toLowerCase().startsWith('bearer ')) {
    return token.slice(7).trim() || null;
  }

  return token;
};

const normalizeAppHint = (value: unknown): string | null => {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.toLowerCase() === 'api') {
    return null;
  }

  return normalized;
};

export const hasExplicitAppHint = (req: any): boolean => {
  return Boolean(normalizeAppHint(req?.params?.app) || normalizeAppHint(req?.query?.app));
};

export const hasJwtCredential = (req: any): boolean => {
  const cookieHeader = String(req?.headers?.cookie || '');
  return Boolean(
    normalizeToken(req?.headers?.authorization) ||
    normalizeToken(pickCookieValue(cookieHeader, 'access_token')) ||
    normalizeToken(pickCookieValue(cookieHeader, 'token')) ||
    normalizeToken(req?.query?.access_token),
  );
};
