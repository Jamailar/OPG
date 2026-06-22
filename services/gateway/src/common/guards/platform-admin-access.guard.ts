import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { normalizePlatformAppAdminPermissions } from '../platform-admin-permissions';
import {
  PLATFORM_ADMIN_ACCESS_METADATA,
  PlatformAdminAccessMetadata,
} from '../decorators/platform-admin-permission.decorator';

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
    private readonly reflector: Reflector,
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
    const access = this.resolveRequiredAccess(context, req?.method || 'GET', path, appId);
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

  private resolveRequiredAccess(context: ExecutionContext, methodRaw: string, path: string, appId: string): RequiredAccess {
    const declared = this.reflector.getAllAndOverride<PlatformAdminAccessMetadata | undefined>(
      PLATFORM_ADMIN_ACCESS_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (declared) {
      return declared;
    }

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
      return { kind: 'app-permission', permissions: ['app.analytics.read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/users(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: method === 'GET' ? ['app.users.read'] : ['app.users.write'] };
    }
    if (path.match(/^\/apps\/[^/]+\/ai\/usage(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app.ai.usage.read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/observability(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app.logs.read'] };
    }
    if (method === 'GET' && path.match(/^\/apps\/[^/]+\/tasks(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app.logs.read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/notifications(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: method === 'GET' ? ['app.notifications.read'] : ['app.notifications.manage'] };
    }
    if (method === 'GET' && path.match(/^\/apps\/[^/]+\/ai\/points-settings$/)) {
      return { kind: 'app-permission', permissions: ['app.ai.usage.read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/ai\/points\/grant$/)) {
      return { kind: 'app-permission', permissions: ['app.ai.points.grant'] };
    }
    if (method !== 'GET' && path.match(/^\/apps\/[^/]+\/ai\/points-settings$/)) {
      return { kind: 'app-permission', permissions: ['app.ai.points.grant'] };
    }
    if (path.match(/^\/apps\/[^/]+\/email(?:\/|$)/)) {
      if (method === 'GET') return { kind: 'app-permission', permissions: ['app.email.read'] };
      if (path.match(/\/(?:send-test|schedule|cancel)(?:\/|$)/)) return { kind: 'app-permission', permissions: ['app.email.send'] };
      return { kind: 'app-permission', permissions: ['app.email.write'] };
    }
    if (path.match(/^\/apps\/[^/]+\/site(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: method === 'GET' ? ['app.site.read'] : ['app.site.write'] };
    }
    if (path.match(/^\/apps\/[^/]+\/feedbacks(?:\/|$)/)) {
      if (method === 'GET') return { kind: 'app-permission', permissions: ['app.feedback.read'] };
      if (path.match(/\/review$/)) return { kind: 'app-permission', permissions: ['app.feedback.reward'] };
      return { kind: 'app-permission', permissions: ['app.feedback.review'] };
    }
    if (path.match(/^\/apps\/[^/]+\/acquisition(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: method === 'GET' ? ['app.acquisition.read'] : ['app.acquisition.write'] };
    }
    if (path.match(/^\/apps\/[^/]+\/forms(?:\/|$)/)) {
      return {
        kind: 'app-permission',
        permissions: method === 'GET'
          ? ['app.forms.read', 'app.acquisition.read']
          : ['app.forms.write', 'app.acquisition.write'],
      };
    }
    if (path.match(/^\/apps\/[^/]+\/redeem\/packages\/[^/]+\/distribute$/)) {
      return { kind: 'app-permission', permissions: ['app.redeem.packages.distribute'] };
    }
    if (path.match(/^\/apps\/[^/]+\/redeem\/packages(?:\/[^/]+)?$/) && method !== 'GET') {
      return { kind: 'app-permission', permissions: ['app.products.write'] };
    }
    if (path.match(/^\/apps\/[^/]+\/redeem\/packages(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app.products.read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/redeem\/codes\/batches$/) && method !== 'GET') {
      return { kind: 'app-permission', permissions: ['app.redeem.codes.create'] };
    }
    if (path.match(/^\/apps\/[^/]+\/redeem\/codes\/[^/]+\/void$/)) {
      return { kind: 'app-permission', permissions: ['app.redeem.codes.void'] };
    }
    if (path.match(/^\/apps\/[^/]+\/redeem\/redemptions\/[^/]+\/revoke$/)) {
      return { kind: 'app-permission', permissions: ['app.redeem.redemptions.revoke'] };
    }
    if (path.match(/^\/apps\/[^/]+\/redeem(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app.redeem.codes.read', 'app.products.read', 'app.orders.read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/payments\/orders$/) || path.match(/^\/payments\/apps\/[^/]+\/orders$/) || path === '/payments/orders') {
      return { kind: 'app-permission', permissions: ['app.orders.read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/payments\/orders\/[^/]+\/refund$/) || path.match(/^\/payments\/apps\/[^/]+\/orders\/[^/]+\/refund$/) || path.match(/^\/payments\/orders\/[^/]+\/refund$/)) {
      return { kind: 'app-permission', permissions: ['app.orders.refund'] };
    }
    if (path.match(/^\/apps\/[^/]+\/agents(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app.runtime.manage'] };
    }
    if (path.match(/^\/apps\/[^/]+\/schema(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: method === 'GET' ? ['app.schema.read'] : ['app.schema.write'] };
    }
    if (path.match(/^\/apps\/[^/]+\/functions(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app.runtime.manage'] };
    }
    if (path.match(/^\/apps\/[^/]+\/workflows(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app.runtime.manage'] };
    }
    if (path.match(/^\/apps\/[^/]+\/connectors(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app.runtime.manage'] };
    }
    if (path.match(/^\/apps\/[^/]+\/(?:blocks|storage)(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app.runtime.manage'] };
    }
    if (method === 'GET' && path.match(/^\/apps\/[^/]+\/build(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: ['app.build.read'] };
    }
    if (path.match(/^\/apps\/[^/]+\/ai\/(?:model-routes|default-models|default-model-slots)(?:\/|$)/)) {
      return { kind: 'app-permission', permissions: method === 'GET' ? ['app.ai.usage.read', 'app.ai.routing.write'] : ['app.ai.routing.write'] };
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
    if (method !== 'GET' && path.match(/^\/apps\/[^/]+$/)) return true;
    if (path.match(/^\/apps\/[^/]+\/sms\/test-send$/)) return true;
    return false;
  }

  private async fetchAllowedPermissions(appId: string, adminUserId: string): Promise<string[]> {
    const assignmentRows = await (this.prisma.$queryRawUnsafe(
      `SELECT id FROM admin_user_role_assignments WHERE app_id = $1::uuid AND admin_user_id = $2::uuid LIMIT 1`,
      appId,
      adminUserId,
    ) as Promise<Array<{ id: string }>>);
    const roleRows = await (this.prisma.$queryRawUnsafe(
      `SELECT rp.permission_key
       FROM admin_user_role_assignments a
       JOIN admin_roles r ON r.id = a.role_id
       JOIN admin_role_permissions rp ON rp.role_id = r.id
       WHERE a.app_id = $1::uuid
         AND a.admin_user_id = $2::uuid
         AND r.status = 'ACTIVE'
         AND (r.app_id IS NULL OR r.app_id = a.app_id)
       UNION
       SELECT permission_key
       FROM admin_user_permission_overrides
       WHERE app_id = $1::uuid
         AND admin_user_id = $2::uuid
         AND effect = 'ALLOW'
         AND (expires_at IS NULL OR expires_at > now())`,
      appId,
      adminUserId,
    ) as Promise<Array<{ permission_key: string }>>);

    if (assignmentRows.length > 0 || roleRows.length > 0) {
      return normalizePlatformAppAdminPermissions(roleRows.map((row) => row.permission_key));
    }

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
