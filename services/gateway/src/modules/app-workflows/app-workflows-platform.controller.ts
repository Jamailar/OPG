import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { AppWorkflowsService } from './app-workflows.service';

@ApiTags('AppWorkflows')
@Controller(tenantControllerPaths('platform-admin', true))
@UseGuards(JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class AppWorkflowsPlatformController {
  constructor(private readonly appWorkflowsService: AppWorkflowsService) {}

  @Get('apps/:app_id/workflows')
  @ApiOperation({ summary: 'List app workflows' })
  listWorkflows(@Param('app_id') appId: string) {
    return this.appWorkflowsService.listWorkflows(appId);
  }

  @Post('apps/:app_id/workflows')
  @ApiOperation({ summary: 'Create an app workflow' })
  createWorkflow(@Req() req: any, @Param('app_id') appId: string, @Body() body: Record<string, unknown>) {
    return this.appWorkflowsService.createWorkflow(appId, req.user, body || {});
  }

  @Post('apps/:app_id/workflows/:workflow_id/run')
  @ApiOperation({ summary: 'Run an app workflow from platform admin' })
  runWorkflow(@Req() req: any, @Param('app_id') appId: string, @Param('workflow_id') workflowId: string, @Body() body: Record<string, unknown>) {
    return this.appWorkflowsService.runWorkflow(appId, workflowId, req.user, body || {});
  }

  @Get('apps/:app_id/workflows/:workflow_id/runs')
  @ApiOperation({ summary: 'List app workflow runs' })
  listRuns(@Param('app_id') appId: string, @Param('workflow_id') workflowId: string) {
    return this.appWorkflowsService.listRuns(appId, workflowId);
  }

  @Get('workflows/runtime/status')
  @ApiOperation({ summary: 'Workflow runtime queue status' })
  runtimeStatus() {
    return this.appWorkflowsService.runtimeStatus();
  }
}
