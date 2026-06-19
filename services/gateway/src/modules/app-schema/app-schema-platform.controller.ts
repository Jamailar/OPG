import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
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

  @Post('apps/:app_id/schema/tables')
  @ApiOperation({ summary: '结构化创建 app 数据表，默认 dry-run' })
  async createAppDataTable(@Req() req: any, @Param('app_id') appId: string, @Body() body: Record<string, unknown>) {
    return this.appSchemaService.createTable(appId, req.user, body || {});
  }

  @Post('apps/:app_id/schema/tables/:table/columns')
  @ApiOperation({ summary: '结构化添加 app 数据表字段，默认 dry-run' })
  async addAppDataColumn(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('table') table: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.appSchemaService.addColumn(appId, table, req.user, body || {});
  }
}
