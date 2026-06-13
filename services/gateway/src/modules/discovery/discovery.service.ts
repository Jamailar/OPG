import { Inject, Injectable } from '@nestjs/common';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AppDomainType, AppStatus, PrismaClient } from '@prisma/client';

@Injectable()
export class DiscoveryService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async resolveAdminContext(host: string, platformAppSlug: string, defaultAppSlug: string, appSlug?: string) {
    const normalizedSlug = this.normalizeSlug(appSlug);
    if (normalizedSlug) {
      return this.resolveAdminContextBySlug(normalizedSlug, defaultAppSlug);
    }

    const normalizedHost = this.normalizeHost(host);
    const { hostname, port } = this.splitHostPort(normalizedHost);

    const domains = await this.prisma.appDomain.findMany({
      where: {
        domain: {
          in: [normalizedHost, hostname].filter(Boolean),
        },
        app: {
          status: AppStatus.ACTIVE,
        },
      },
      include: {
        app: true,
      },
    });

    if (domains.length > 0) {
      const priority: Record<AppDomainType, number> = {
        PLATFORM_ADMIN: 0,
        BUSINESS_ADMIN: 1,
        USER_WEB: 2,
        API: 3,
      };

      domains.sort((a, b) => (priority[a.domainType] ?? 99) - (priority[b.domainType] ?? 99));
      const match = domains[0];

      return {
        resolved: true,
        portal_mode: match.domainType === AppDomainType.PLATFORM_ADMIN ? 'platform' : 'business',
        app_slug: match.app.slug,
        app_name: match.app.name,
        domain_type: match.domainType,
        matched_domain: match.domain,
      };
    }

    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      if (port === '3002') {
        return {
          resolved: true,
          portal_mode: 'platform',
          app_slug: platformAppSlug,
          app_name: null,
          domain_type: AppDomainType.PLATFORM_ADMIN,
          matched_domain: normalizedHost,
        };
      }

      if (port === '3001') {
        return {
          resolved: true,
          portal_mode: 'business',
          app_slug: defaultAppSlug,
          app_name: null,
          domain_type: AppDomainType.BUSINESS_ADMIN,
          matched_domain: normalizedHost,
        };
      }
    }

    return {
      resolved: false,
      portal_mode: 'business',
      app_slug: defaultAppSlug,
      app_name: null,
      domain_type: null,
      matched_domain: null,
    };
  }

  private async resolveAdminContextBySlug(appSlug: string, defaultAppSlug: string) {
    const app = await this.prisma.app.findFirst({
      where: {
        status: AppStatus.ACTIVE,
        OR: [
          { slug: appSlug },
          {
            slugAliases: {
              some: {
                slug: appSlug,
                isActive: true,
              },
            },
          },
        ],
      },
      select: {
        slug: true,
        name: true,
      },
    });

    if (!app) {
      return {
        resolved: false,
        portal_mode: 'business',
        app_slug: appSlug || defaultAppSlug,
        app_name: null,
        domain_type: null,
        matched_domain: null,
        matched_slug: null,
      };
    }

    return {
      resolved: true,
      portal_mode: 'business',
      app_slug: app.slug,
      app_name: app.name,
      domain_type: AppDomainType.BUSINESS_ADMIN,
      matched_domain: null,
      matched_slug: appSlug,
    };
  }

  private normalizeHost(rawHost: string): string {
    const input = (rawHost || '').trim().toLowerCase();
    if (!input) {
      return '';
    }

    if (input.includes('://')) {
      try {
        const parsed = new URL(input);
        return parsed.host.toLowerCase();
      } catch {
        return input.split('/')[0];
      }
    }

    return input.split('/')[0];
  }

  private normalizeSlug(rawSlug: string | undefined): string {
    return String(rawSlug || '')
      .trim()
      .toLowerCase()
      .replace(/^\/+|\/+$/g, '');
  }

  private splitHostPort(host: string): { hostname: string; port: string | null } {
    if (!host.includes(':')) {
      return { hostname: host, port: null };
    }

    const [hostname, port] = host.split(':');
    if (port && /^\d+$/.test(port)) {
      return { hostname, port };
    }
    return { hostname: host, port: null };
  }
}
