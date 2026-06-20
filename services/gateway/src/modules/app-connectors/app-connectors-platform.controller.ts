import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { AppConnectorsService } from './app-connectors.service';

@ApiTags('AppConnectors')
@Controller(tenantControllerPaths('platform-admin', true))
@UseGuards(JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class AppConnectorsPlatformController {
  constructor(private readonly service: AppConnectorsService) {}

  @Get('apps/:app_id/connectors')
  @ApiOperation({ summary: 'List app connectors' })
  listConnectors(@Param('app_id') appId: string) {
    return this.service.listConnectors(appId);
  }

  @Post('apps/:app_id/connectors')
  @ApiOperation({ summary: 'Create an app connector' })
  createConnector(@Req() req: any, @Param('app_id') appId: string, @Body() body: Record<string, unknown>) {
    return this.service.createConnector(appId, req.user, body || {});
  }

  @Patch('apps/:app_id/connectors/:connector')
  @ApiOperation({ summary: 'Update an app connector' })
  updateConnector(@Req() req: any, @Param('app_id') appId: string, @Param('connector') connector: string, @Body() body: Record<string, unknown>) {
    return this.service.updateConnector(appId, connector, req.user, body || {});
  }

  @Delete('apps/:app_id/connectors/:connector')
  @ApiOperation({ summary: 'Delete an app connector' })
  deleteConnector(@Req() req: any, @Param('app_id') appId: string, @Param('connector') connector: string) {
    return this.service.deleteConnector(appId, connector, req.user);
  }

  @Get('apps/:app_id/connectors/:connector/credentials')
  @ApiOperation({ summary: 'List connector credentials' })
  listCredentials(@Param('app_id') appId: string, @Param('connector') connector: string) {
    return this.service.listCredentials(appId, connector);
  }

  @Post('apps/:app_id/connectors/:connector/credentials')
  @ApiOperation({ summary: 'Create connector credential' })
  createCredential(@Req() req: any, @Param('app_id') appId: string, @Param('connector') connector: string, @Body() body: Record<string, unknown>) {
    return this.service.createCredential(appId, connector, req.user, body || {});
  }

  @Patch('apps/:app_id/connectors/:connector/credentials/:credential')
  @ApiOperation({ summary: 'Update connector credential' })
  updateCredential(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('connector') connector: string,
    @Param('credential') credential: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.updateCredential(appId, connector, credential, req.user, body || {});
  }

  @Delete('apps/:app_id/connectors/:connector/credentials/:credential')
  @ApiOperation({ summary: 'Delete connector credential' })
  deleteCredential(@Req() req: any, @Param('app_id') appId: string, @Param('connector') connector: string, @Param('credential') credential: string) {
    return this.service.deleteCredential(appId, connector, credential, req.user);
  }

  @Get('apps/:app_id/connectors/:connector/actions')
  @ApiOperation({ summary: 'List connector actions' })
  listActions(@Param('app_id') appId: string, @Param('connector') connector: string) {
    return this.service.listActions(appId, connector);
  }

  @Post('apps/:app_id/connectors/:connector/actions')
  @ApiOperation({ summary: 'Create connector action' })
  createAction(@Req() req: any, @Param('app_id') appId: string, @Param('connector') connector: string, @Body() body: Record<string, unknown>) {
    return this.service.createAction(appId, connector, req.user, body || {});
  }

  @Patch('apps/:app_id/connectors/:connector/actions/:action')
  @ApiOperation({ summary: 'Update connector action' })
  updateAction(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('connector') connector: string,
    @Param('action') action: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.updateAction(appId, connector, action, req.user, body || {});
  }

  @Delete('apps/:app_id/connectors/:connector/actions/:action')
  @ApiOperation({ summary: 'Delete connector action' })
  deleteAction(@Req() req: any, @Param('app_id') appId: string, @Param('connector') connector: string, @Param('action') action: string) {
    return this.service.deleteAction(appId, connector, action, req.user);
  }

  @Post('apps/:app_id/connectors/:connector/actions/:action/invoke')
  @ApiOperation({ summary: 'Invoke connector action from platform admin' })
  invokeAction(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('connector') connector: string,
    @Param('action') action: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.invokeAction(appId, connector, action, req.user, body || {});
  }

  @Get('apps/:app_id/connectors/:connector/runs')
  @ApiOperation({ summary: 'List connector runs' })
  listRuns(@Param('app_id') appId: string, @Param('connector') connector: string) {
    return this.service.listRuns(appId, connector);
  }

  @Get('apps/:app_id/connectors/:connector/actions/:action/runs')
  @ApiOperation({ summary: 'List connector action runs' })
  listActionRuns(@Param('app_id') appId: string, @Param('connector') connector: string, @Param('action') action: string) {
    return this.service.listRuns(appId, connector, action);
  }
}
