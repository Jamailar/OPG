import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { AppFunctionsService } from './app-functions.service';

@ApiTags('AppFunctions')
@Controller(tenantControllerPaths('platform-admin', true))
@UseGuards(JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class AppFunctionsPlatformController {
  constructor(private readonly appFunctionsService: AppFunctionsService) {}

  @Get('apps/:app_id/functions')
  @ApiOperation({ summary: 'List app functions' })
  listFunctions(@Param('app_id') appId: string) {
    return this.appFunctionsService.listFunctions(appId);
  }

  @Post('apps/:app_id/functions')
  @ApiOperation({ summary: 'Create an app function draft' })
  createFunction(@Req() req: any, @Param('app_id') appId: string, @Body() body: Record<string, unknown>) {
    return this.appFunctionsService.createFunction(appId, req.user, body || {});
  }

  @Post('apps/:app_id/functions/:function_id/deploy')
  @ApiOperation({ summary: 'Deploy an app function version' })
  deployFunction(@Req() req: any, @Param('app_id') appId: string, @Param('function_id') functionId: string) {
    return this.appFunctionsService.deployFunction(appId, functionId, req.user);
  }

  @Get('apps/:app_id/functions/:function_id/runs')
  @ApiOperation({ summary: 'List app function runs' })
  listRuns(@Param('app_id') appId: string, @Param('function_id') functionId: string) {
    return this.appFunctionsService.listRuns(appId, functionId);
  }

  @Post('apps/:app_id/functions/:function_id/invoke')
  @ApiOperation({ summary: 'Invoke an app function from platform admin' })
  invokeFromPlatform(@Req() req: any, @Param('app_id') appId: string, @Param('function_id') functionId: string, @Body() body: Record<string, unknown>) {
    return this.appFunctionsService.invokeFunction(appId, functionId, req.user, body || {});
  }

  @Get('functions/runtime/status')
  @ApiOperation({ summary: 'Function runtime queue status' })
  runtimeStatus() {
    return this.appFunctionsService.runtimeStatus();
  }
}
