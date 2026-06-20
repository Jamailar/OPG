import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { AppRuntimeService } from './app-runtime.service';

type AuthRequest = {
  user?: {
    id?: string;
    user_id?: string;
    sub?: string;
  };
};

@ApiTags('AppRuntime')
@Controller(tenantControllerPaths('platform-admin', true))
@UseGuards(JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class AppRuntimeController {
  constructor(private readonly service: AppRuntimeService) {}

  @Get('runtime/overview')
  @ApiOperation({ summary: 'Global app runtime module overview' })
  overview(@Query() query: Record<string, unknown>) {
    return this.service.getGlobalOverview(query || {});
  }

  @Post('runtime/refresh')
  @ApiOperation({ summary: 'Queue runtime module refresh for all apps' })
  refreshAll(@Req() req: AuthRequest) {
    return this.service.queueRefreshAll(this.actorId(req));
  }

  @Get('runtime/templates')
  @ApiOperation({ summary: 'List app runtime templates' })
  templates() {
    return this.service.listTemplates();
  }

  @Get('apps/:app_id/runtime/overview')
  @ApiOperation({ summary: 'App runtime module overview' })
  appOverview(@Param('app_id') appId: string, @Query() query: Record<string, unknown>) {
    return this.service.getAppOverview(appId, query || {});
  }

  @Post('apps/:app_id/runtime/refresh')
  @ApiOperation({ summary: 'Queue runtime module refresh for one app' })
  refreshApp(@Param('app_id') appId: string, @Req() req: AuthRequest) {
    return this.service.queueRefreshApp(appId, this.actorId(req));
  }

  @Post('apps/:app_id/runtime/templates/:template_key/apply')
  @ApiOperation({ summary: 'Queue runtime template application for one app' })
  applyTemplate(
    @Param('app_id') appId: string,
    @Param('template_key') templateKey: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.queueApplyTemplate(appId, templateKey, this.actorId(req));
  }

  private actorId(req: AuthRequest) {
    return req.user?.id || req.user?.user_id || req.user?.sub || null;
  }
}
