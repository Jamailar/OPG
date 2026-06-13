import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AcquisitionService } from './acquisition.service';

@ApiTags('Acquisition')
@Controller('/api/v1/platform-admin/apps/:app_id/acquisition')
@UseGuards(JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class AcquisitionAdminController {
  constructor(private readonly acquisitionService: AcquisitionService) {}

  @Get('source-options')
  @ApiOperation({ summary: '管理来源选项列表' })
  async listSourceOptions(@Param('app_id') appId: string) {
    return this.acquisitionService.listSourceOptionsByAppId(appId);
  }

  @Post('source-options')
  @ApiOperation({ summary: '新增来源选项' })
  async createSourceOption(@Param('app_id') appId: string, @Body() body: Record<string, unknown>) {
    return this.acquisitionService.createSourceOption(appId, body || {});
  }

  @Patch('source-options/:option_id')
  @ApiOperation({ summary: '更新来源选项' })
  async updateSourceOption(
    @Param('app_id') appId: string,
    @Param('option_id') optionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.acquisitionService.updateSourceOption(appId, optionId, body || {});
  }

  @Delete('source-options/:option_id')
  @ApiOperation({ summary: '删除来源选项' })
  async deleteSourceOption(@Param('app_id') appId: string, @Param('option_id') optionId: string) {
    return this.acquisitionService.deleteSourceOption(appId, optionId);
  }

  @Get('summary')
  @ApiOperation({ summary: '用户来源统计' })
  async getSummary(@Param('app_id') appId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.acquisitionService.getSummaryByAppId(appId, { from, to });
  }

  @Get('users')
  @ApiOperation({ summary: '用户来源明细' })
  async listUserSources(
    @Param('app_id') appId: string,
    @Query('source_key') sourceKey?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('q') q?: string,
  ) {
    return this.acquisitionService.listUserSourcesByAppId(appId, {
      source_key: sourceKey,
      from,
      to,
      page,
      page_size: pageSize,
      q,
    });
  }
}
