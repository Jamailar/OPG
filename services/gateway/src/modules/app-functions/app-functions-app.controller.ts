import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { resolveAppSlug, tenantControllerPaths } from '../../common/utils/controller-paths';
import { DeveloperSdkAuthGuard } from '../developer-sdk/developer-sdk-auth.guard';
import { AppFunctionsService } from './app-functions.service';

@ApiTags('AppFunctions')
@Controller(tenantControllerPaths('functions', true))
@UseGuards(DeveloperSdkAuthGuard)
@ApiBearerAuth()
export class AppFunctionsAppController {
  constructor(private readonly appFunctionsService: AppFunctionsService) {}

  @Post(':slug/invoke')
  @ApiOperation({ summary: 'Invoke an app function' })
  invokeFunction(@Req() req: any, @Param('slug') slug: string, @Body() body: Record<string, unknown>) {
    return this.appFunctionsService.invokeFunction(String(resolveAppSlug(req) || ''), slug, req.user, body || {});
  }
}
