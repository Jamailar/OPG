import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { normalizePlatformAppAdminPermissions } from '../platform-admin-permissions';

type RequiredAccess =
  | { kind: 'global' }
  | { kind: 'app-any' }
  | { kind: 'app-super' }
  | { kind: 'app-permission'; permissions: string[] };

@Injectable()
export class PlatformAdminAccessGuard implements CanActivate {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId = String(req?.user?.id || req?.user?.userId || '').trim();
    if (!userId) {
      throw new ForbiddenException('admin access required');
    }

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        appId: true,
        role: true,
        adminType: true,
        isActive: true,
        deletedAt: true,
        app: { select: { slug: true } },
      },
    });

    if (!actor || actor.deletedAt || !actor.isActive || String(actor.role || '').toUpperCase() !== 'ADMIN') {
      throw new ForbiddenException('admin access required');
    }

    const path = this.normalizePlatformPath(req);
    const appId = await this.resolveAppId(req, path);
    const access = this.resolveRequiredAccess(req?.method || 'GET', path, appId);
    const isSuperAdmin = String(actor.adminType || '').toUpperCase() === 'SUPER_ADMIN';
    const isPlatformSuperAdmin = isSuperAdmin && actor.app?.slug === this.config.app.platformSlug;

    if (isPlatformSuperAdmin) {
      return true;
    }

    if (access.kind === 'global') {
      throw new ForbiddenException('platform super admin required');
    }

    if (!appId || actor.appId !== appId) {
      throw new ForbiddenException('app admin scope required');
    }

    if (isSuperAdmin) {
      return true;
    }

    if (access.kind === 'app-super') {
      throw new ForbiddenException('app super admin required');
    }

    if (access.kind === 'app-any') {
      return true;
    }

    const allowed = await this.fetchAllowedPermissions(appId, actor.id);
    if (access.permissions.some((permission) => allowed.includes(permission))) {
      return true;
    }

    throw new ForbiddenException('app admin permission required');
  }

  private normalizePlatformPath(req: any): string {
    const rawUrl = String(req?.originalUrl || req?.url || '').split('?')[0] || '';
    const marker = '/platform-admin';
    const markerIndex = rawUrl.indexOf(marker);
    if (markerIndex >= 0) {
      return rawUrl.slice(markerIndex + marker.length) || '/';
    }
    return rawUrl || '/';
  }

  private async resolveAppId(req: any, path: string): Promise<string> {
    const paramAppId = String(req?.params?.app_id || req?.params?.appId || '').trim();
    if (paramAppId) return this.resolveAppIdOrSlug(paramAppId);

    const queryAppId = String(req?.query?.app_id || req?.query?.appId || '').trim();
    if (queryAppId && (path === '/payments/orders' || path.includes('/payments/') || path === '/agent-runs')) {
      return this.resolveAppIdOrSlug(queryAppId);
    }

    const match = path.match(/^\/apps\/([^/]+)/);
    return match?.[1] ? this.resolveAppIdOrSlug(match[1]) : '';
  }

  private async resolveAppIdOrSlug(value: string): Promise<string> {
    const ref = String(value || '').trim();
    if (!ref) return '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref)) {
      return ref;
    }
    const app = await this.prisma.app.findUnique({ where: { slug: ref.toLowerCase() }, select: { id: true } });
    return app?.id || ref;
  }

  private resolveRequiredAccess(methodRaw: string, path: string, appId: string): RequiredAccess {
    const method = String(methodRaw || 'GET').toUpperCase();
    if (!appId) {
      return { kind: 'global' };
    }

    if (this.isAppAdminPermissionSelfPath(path)) {
      return { kind: 'app-any' };
    }

    if (this.isAppSuperOnlyPath(method, path)) {
      return { kind: 'app-super' };
    }

    if (path.match(/^\/apps\/[^/]+\/(?:business-analytics|analytics)(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app_analytics_read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/ai\/usage(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app_ai_usage_read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/observability(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app_logs_read'] };
    }
    if (method === 'GET' && path.match(/^\/apps\/[^/]+\/tasks(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app_logs_read'] };
    }
    if (method === 'GET' && path.match(/^\/apps\/[^/]+\/ai\/points-settings$/)) {
      return { kind: 'app-permission', permissions: ['app_ai_usage_read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/email(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app_email_manage'] };
    }
    if (path.match(/^\/apps\/[^/]+\/site(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app_site_manage'] };
    }
    if (path.match(/^\/apps\/[^/]+\/feedbacks(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app_feedback_manage'] };
    }
    if (path.match(/^\/apps\/[^/]+\/acquisition(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app_acquisition_manage'] };
    }
    if (path.match(/^\/apps\/[^/]+\/redeem\/packages(?:\/[^/]+)?$/) && method !== 'GET') {
      return { kind: 'app-permission', permissions: ['app_redeem_products_manage'] };
    }
    if (path.match(/^\/apps\/[^/]+\/redeem(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app_redeem_read', 'app_redeem_products_manage'] };
    }
    if (path.match(/^\/apps\/[^/]+\/payments\/orders$/) || path.match(/^\/payments\/apps\/[^/]+\/orders$/) || path === '/payments/orders') {
      return { kind: 'app-permission', permissions: ['app_redeem_read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/agents(?:\/|$)/)) {
      return { kind: 'app-super' };
    }
    if (path.match(/^\/apps\/[^/]+\/schema(?:\/|$)/)) {
      return method === 'GET' ? { kind: 'app-any' } : { kind: 'app-super' };
    }
    if (path.match(/^\/apps\/[^/]+\/functions(?:\/|$)/)) {
      return { kind: 'app-super' };
    }
    if (path.match(/^\/apps\/[^/]+\/workflows(?:\/|$)/)) {
      return { kind: 'app-super' };
    }
    if (path.match(/^\/apps\/[^/]+\/connectors(?:\/|$)/)) {
      return { kind: 'app-super' };
    }
    if (path.match(/^\/apps\/[^/]+\/(?:blocks|storage)(?:\/|$)/)) {
      return { kind: 'app-super' };
    }
    if (method === 'GET' && path.match(/^\/apps\/[^/]+\/build(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app_logs_read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/ai\/(?:model-routes|default-models|default-model-slots)(?:\/|$)/)) {
      return { kind: 'app-super' };
    }
    if ((method === 'GET' && path.match(/^\/apps\/[^/]+$/)) || (method === 'GET' && path.match(/^\/apps\/[^/]+\/stats$/))) {
      return { kind: 'app-any' };
    }

    return { kind: 'global' };
  }

  private isAppAdminPermissionSelfPath(path: string): boolean {
    return path.match(/^\/apps\/[^/]+\/admin-permissions\/me$/) !== null;
  }

  private isAppSuperOnlyPath(method: string, path: string): boolean {
    if (path.match(/^\/apps\/[^/]+\/admins(?:\/|$)/)) return true;
    if (path.match(/^\/apps\/[^/]+\/users\/[^/]+\/(?:deactivate|restore|unlink-phone|unlink-email)$/)) return true;
    if (method !== 'GET' && path.match(/^\/apps\/[^/]+$/)) return true;
    if (path.match(/^\/apps\/[^/]+\/sms\/test-send$/)) return true;
    if (path.match(/^\/apps\/[^/]+\/payments\/orders\/[^/]+\/refund$/)) return true;
    if (path.match(/^\/payments\/apps\/[^/]+\/orders\/[^/]+\/refund$/)) return true;
    if (path.match(/^\/payments\/orders\/[^/]+\/refund$/)) return true;
    if (method !== 'GET' && path.match(/^\/apps\/[^/]+\/ai\/points-settings$/)) return true;
    if (path.match(/^\/apps\/[^/]+\/ai\/points\/grant$/)) return true;
    if (path.match(/^\/apps\/[^/]+\/feedbacks\/[^/]+\/review$/)) return true;
    if (path.match(/^\/apps\/[^/]+\/redeem\/packages\/[^/]+\/distribute$/)) return true;
    if (path.match(/^\/apps\/[^/]+\/redeem\/codes\/batches$/) && method !== 'GET') return true;
    if (path.match(/^\/apps\/[^/]+\/redeem\/redemptions\/[^/]+\/revoke$/)) return true;
    if (path.match(/^\/apps\/[^/]+\/redeem\/codes\/[^/]+\/void$/)) return true;
    return false;
  }

  private async fetchAllowedPermissions(appId: string, adminUserId: string): Promise<string[]> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT allowed_pages
       FROM admin_page_permissions
       WHERE app_id = $1::uuid AND admin_user_id = $2::uuid
       LIMIT 1`,
      appId,
      adminUserId,
    ) as Promise<Array<{ allowed_pages: unknown }>>);
    return normalizePlatformAppAdminPermissions(rows[0]?.allowed_pages);
  }
}
