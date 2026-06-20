import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { resolveAppSlug, tenantControllerPaths } from '../../common/utils/controller-paths';
import { DeveloperSdkAuthGuard } from '../developer-sdk/developer-sdk-auth.guard';
import { AppConnectorsService } from './app-connectors.service';

@ApiTags('AppConnectors')
@Controller(tenantControllerPaths('connectors', true))
@UseGuards(DeveloperSdkAuthGuard)
@ApiBearerAuth()
export class AppConnectorsAppController {
  constructor(private readonly service: AppConnectorsService) {}

  @Post(':connector/actions/:action/invoke')
  @ApiOperation({ summary: 'Invoke an app connector action' })
  invokeAction(
    @Req() req: any,
    @Param('connector') connector: string,
    @Param('action') action: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.invokeAction(String(resolveAppSlug(req) || ''), connector, action, req.user, body || {});
  }
}
