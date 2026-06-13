import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';

type AliasCacheEntry = {
  expiresAt: number;
  canonicalSlug: string | null;
};

const SLUG_ALIAS_CACHE_TTL_MS = 60_000;
const slugAliasCache = new Map<string, AliasCacheEntry>();

export function clearAppSlugAliasCache() {
  slugAliasCache.clear();
}

function normalizeSlug(value: unknown): string {
  const slug = String(value || '').trim().toLowerCase();
  if (!slug || slug === 'api') {
    return '';
  }
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ? slug : '';
}

function isMissingAliasTableError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === '42P01' || String((error as Error)?.message || '').includes('app_slug_aliases');
}

async function resolveCanonicalSlug(prisma: PrismaClient, inputSlug: string): Promise<string | null> {
  const slug = normalizeSlug(inputSlug);
  if (!slug) {
    return null;
  }

  const cached = slugAliasCache.get(slug);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.canonicalSlug;
  }

  try {
    const rows = await (prisma.$queryRawUnsafe(
      `SELECT apps.slug AS canonical_slug
       FROM app_slug_aliases
       JOIN apps ON apps.id = app_slug_aliases.app_id
       WHERE LOWER(app_slug_aliases.slug) = LOWER($1)
         AND app_slug_aliases.is_active = true
         AND apps.status = 'ACTIVE'
       LIMIT 1`,
      slug,
    ) as Promise<Array<{ canonical_slug: string }>>);
    const canonicalSlug = rows[0]?.canonical_slug || null;
    slugAliasCache.set(slug, { expiresAt: now + SLUG_ALIAS_CACHE_TTL_MS, canonicalSlug });
    return canonicalSlug;
  } catch (error) {
    if (isMissingAliasTableError(error)) {
      slugAliasCache.set(slug, { expiresAt: now + SLUG_ALIAS_CACHE_TTL_MS, canonicalSlug: null });
      return null;
    }
    throw error;
  }
}

function rewriteFirstPathSegment(req: Request, canonicalSlug: string) {
  const url = req.url || '';
  const match = url.match(/^\/([^/?#]+)(\/v[0-9][^?#]*)([?#].*)?$/);
  if (!match) {
    return;
  }
  req.url = `/${canonicalSlug}${match[2]}${match[3] || ''}`;
}

function rewriteQueryApp(req: Request, canonicalSlug: string) {
  const query = req.query as Record<string, unknown> | undefined;
  if (query && typeof query.app === 'string') {
    query.app = canonicalSlug;
  }
}

export function createAppSlugAliasMiddleware(prisma: PrismaClient) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const pathSlug = normalizeSlug(req.path.split('/').filter(Boolean)[0]);
      const querySlug = normalizeSlug((req.query as Record<string, unknown> | undefined)?.app);

      if (pathSlug) {
        const canonicalSlug = await resolveCanonicalSlug(prisma, pathSlug);
        if (canonicalSlug && canonicalSlug !== pathSlug) {
          rewriteFirstPathSegment(req, canonicalSlug);
        }
      }

      if (querySlug) {
        const canonicalSlug = await resolveCanonicalSlug(prisma, querySlug);
        if (canonicalSlug && canonicalSlug !== querySlug) {
          rewriteQueryApp(req, canonicalSlug);
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
