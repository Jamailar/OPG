import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { AppBuildObservabilityService } from './app-build-observability.service';

@ApiTags('AppBuildObservability')
@Controller(tenantControllerPaths('platform-admin', true))
@UseGuards(JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class AppBuildObservabilityController {
  constructor(private readonly service: AppBuildObservabilityService) {}

  @Get('apps/:app_id/build/summary')
  @ApiOperation({ summary: 'Build resource summary for one app' })
  summary(@Param('app_id') appId: string) {
    return this.service.summary(appId);
  }

  @Get('apps/:app_id/build/events')
  @ApiOperation({ summary: 'Recent build/runtime events for one app' })
  events(@Param('app_id') appId: string, @Query() query: Record<string, unknown>) {
    return this.service.events(appId, query || {});
  }
}
