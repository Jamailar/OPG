import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { BootstrapService } from './bootstrap.service';

@ApiTags('Bootstrap')
@Controller(tenantControllerPaths('bootstrap', true))
export class BootstrapController {
  constructor(private readonly bootstrapService: BootstrapService) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: '检查首次启动初始化状态' })
  async getStatus() {
    return this.bootstrapService.getStatus();
  }

  @Public()
  @Post('platform-admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '创建首个平台超级管理员' })
  async createPlatformAdmin(@Body() body: { email?: string; password?: string; display_name?: string }) {
    return this.bootstrapService.createPlatformAdmin(body || {});
  }
}
