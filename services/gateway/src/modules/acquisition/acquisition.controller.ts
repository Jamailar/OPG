import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { tenantControllerPaths, resolveAppSlug } from '../../common/utils/controller-paths';
import { AcquisitionService } from './acquisition.service';

@ApiTags('Acquisition')
@Controller(tenantControllerPaths('acquisition', true))
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AcquisitionController {
  constructor(private readonly acquisitionService: AcquisitionService) {}

  @Get('source-options')
  @Public()
  @ApiOperation({ summary: '获取用户来源选项' })
  async listSourceOptions(@Req() req: any, @Param('app') app?: string) {
    return this.acquisitionService.listSourceOptionsByAppSlug(resolveAppSlug(req, app));
  }
}
