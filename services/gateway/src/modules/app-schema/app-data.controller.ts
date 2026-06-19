import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { resolveAppSlug, tenantControllerPaths } from '../../common/utils/controller-paths';
import { DeveloperSdkAuthGuard } from '../developer-sdk/developer-sdk-auth.guard';
import { AppSchemaService } from './app-schema.service';

@ApiTags('AppData')
@Controller(tenantControllerPaths('data', true))
@UseGuards(DeveloperSdkAuthGuard)
@ApiBearerAuth()
export class AppDataController {
  constructor(private readonly appSchemaService: AppSchemaService) {}

  @Get('schema')
  @ApiOperation({ summary: '当前 app 自定义 Data API schema' })
  async getDataSchema(@Req() req: any) {
    return this.appSchemaService.getDataSchema(String(resolveAppSlug(req) || ''), req.user);
  }

  @Get(':table')
  @ApiOperation({ summary: '查询 app 自定义数据表 rows' })
  async listRows(@Req() req: any, @Param('table') table: string, @Query() query: Record<string, unknown>) {
    return this.appSchemaService.listRows(String(resolveAppSlug(req) || ''), table, req.user, query || {});
  }

  @Post(':table')
  @ApiOperation({ summary: '创建 app 自定义数据 row' })
  async createRow(@Req() req: any, @Param('table') table: string, @Body() body: Record<string, unknown>) {
    return this.appSchemaService.createRow(String(resolveAppSlug(req) || ''), table, req.user, body || {});
  }

  @Get(':table/:id')
  @ApiOperation({ summary: '读取 app 自定义数据 row' })
  async getRow(@Req() req: any, @Param('table') table: string, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.appSchemaService.getRow(String(resolveAppSlug(req) || ''), table, id, req.user, query || {});
  }

  @Patch(':table/:id')
  @ApiOperation({ summary: '更新 app 自定义数据 row' })
  async updateRow(@Req() req: any, @Param('table') table: string, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.appSchemaService.updateRow(String(resolveAppSlug(req) || ''), table, id, req.user, body || {});
  }

  @Delete(':table/:id')
  @ApiOperation({ summary: '删除 app 自定义数据 row' })
  async deleteRow(@Req() req: any, @Param('table') table: string, @Param('id') id: string) {
    return this.appSchemaService.deleteRow(String(resolveAppSlug(req) || ''), table, id, req.user);
  }
}
