import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AdminRoleGuard implements CanActivate {
  private readonly logger = new Logger(AdminRoleGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const role = String(req?.user?.role || '').toUpperCase();
    if (role === 'ADMIN') {
      return true;
    }

    const requestPath = req?.originalUrl || req?.url || '';
    this.logger.warn(`Forbidden non-admin request ${req?.method || ''} ${requestPath}`);
    throw new ForbiddenException('admin role required');
  }
}
