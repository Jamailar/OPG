import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { resolveAppSlug, tenantControllerPaths } from '../../common/utils/controller-paths';
import { DeveloperSdkAuthGuard } from '../developer-sdk/developer-sdk-auth.guard';
import { AppWorkflowsService } from './app-workflows.service';

@ApiTags('AppWorkflows')
@Controller(tenantControllerPaths('workflows', true))
@UseGuards(DeveloperSdkAuthGuard)
@ApiBearerAuth()
export class AppWorkflowsAppController {
  constructor(private readonly appWorkflowsService: AppWorkflowsService) {}

  @Post(':slug/run')
  @ApiOperation({ summary: 'Run an app workflow' })
  runWorkflow(@Req() req: any, @Param('slug') slug: string, @Body() body: Record<string, unknown>) {
    return this.appWorkflowsService.runWorkflow(String(resolveAppSlug(req) || ''), slug, req.user, body || {});
  }
}
