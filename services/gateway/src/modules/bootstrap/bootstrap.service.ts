import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { AdminType, AppStatus, PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';

type BootstrapStatus = {
  needs_setup: boolean;
  platform_app_slug: string;
  platform_app_exists: boolean;
  platform_super_admin_exists: boolean;
};

@Injectable()
export class BootstrapService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
  ) {}

  async getStatus(): Promise<BootstrapStatus> {
    const platformSlug = this.platformSlug();
    const platformApp = await this.prisma.app.findUnique({
      where: { slug: platformSlug },
      select: { id: true },
    });
    const platformSuperAdminExists = platformApp
      ? await this.platformSuperAdminExists(platformApp.id)
      : false;

    return {
      needs_setup: !platformSuperAdminExists,
      platform_app_slug: platformSlug,
      platform_app_exists: !!platformApp,
      platform_super_admin_exists: platformSuperAdminExists,
    };
  }

  async createPlatformAdmin(payload: { email?: string; password?: string; display_name?: string }) {
    const email = this.normalizeEmail(payload.email);
    const password = String(payload.password || '');
    const displayName = String(payload.display_name || '').trim() || email.split('@')[0];

    if (!email) {
      throw new BadRequestException('email is required');
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('email is invalid');
    }
    if (password.length < 8) {
      throw new BadRequestException('password must be at least 8 characters');
    }

    const platformSlug = this.platformSlug();
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('opg_bootstrap_platform_admin'))`);

      const platformApp = await tx.app.upsert({
        where: { slug: platformSlug },
        create: {
          slug: platformSlug,
          name: 'OPG Platform',
          status: AppStatus.ACTIVE,
        },
        update: {
          status: AppStatus.ACTIVE,
        },
      });

      await tx.appSetting.upsert({
        where: { appId: platformApp.id },
        create: {
          appId: platformApp.id,
          brandName: 'OPG',
        },
        update: {},
      });

      const existing = await tx.user.findFirst({
        where: {
          appId: platformApp.id,
          role: UserRole.ADMIN,
          adminType: AdminType.SUPER_ADMIN,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (existing) {
        throw new ConflictException('platform super admin already exists');
      }

      const user = await tx.user.create({
        data: {
          appId: platformApp.id,
          email,
          hashedPassword: await bcrypt.hash(password, 10),
          fullName: displayName,
          displayName,
          role: UserRole.ADMIN,
          adminType: AdminType.SUPER_ADMIN,
          isActive: true,
          isSuperuser: true,
          sessionToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        },
      });

      return {
        app: platformApp,
        user,
      };
    });

    return {
      created: true,
      platform_app_slug: result.app.slug,
      user: {
        id: result.user.id,
        email: result.user.email,
        display_name: result.user.displayName || result.user.fullName || result.user.email,
        role: result.user.role,
        admin_type: result.user.adminType,
      },
    };
  }

  private platformSlug(): string {
    return String(this.config.app.platformSlug || 'platform').trim().toLowerCase() || 'platform';
  }

  private async platformSuperAdminExists(appId: string): Promise<boolean> {
    const existing = await this.prisma.user.findFirst({
      where: {
        appId,
        role: UserRole.ADMIN,
        adminType: AdminType.SUPER_ADMIN,
        deletedAt: null,
      },
      select: { id: true },
    });
    return !!existing;
  }

  private normalizeEmail(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }
}
