import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { AppSchemaService } from './app-schema.service';

@ApiTags('AppSchema')
@Controller(tenantControllerPaths('platform-admin', true))
@UseGuards(JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class AppSchemaPlatformController {
  constructor(private readonly appSchemaService: AppSchemaService) {}

  @Get('apps/:app_id/schema/manifest')
  @ApiOperation({ summary: '当前 app 自定义数据模型 manifest' })
  async getAppSchemaManifest(@Param('app_id') appId: string) {
    return this.appSchemaService.getManifest(appId);
  }
}
