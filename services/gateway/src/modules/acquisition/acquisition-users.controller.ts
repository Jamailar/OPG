import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { resolveAppSlug, tenantControllerPaths } from '../../common/utils/controller-paths';
import { AcquisitionService } from './acquisition.service';

@ApiTags('Acquisition')
@Controller(tenantControllerPaths('users', true))
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AcquisitionUsersController {
  constructor(private readonly acquisitionService: AcquisitionService) {}

  @Get('me/acquisition-source')
  @ApiOperation({ summary: '获取当前用户来源' })
  async getMyAcquisitionSource(@Req() req: any, @Param('app') app?: string) {
    return this.acquisitionService.getMySourceByAppSlug(resolveAppSlug(req, app), req.user.id);
  }

  @Post('me/acquisition-source')
  @ApiOperation({ summary: '提交当前用户来源' })
  async submitMyAcquisitionSource(@Req() req: any, @Param('app') app: string | undefined, @Body() body: Record<string, unknown>) {
    return this.acquisitionService.submitMySourceByAppSlug(resolveAppSlug(req, app), req.user.id, body || {}, req);
  }
}
