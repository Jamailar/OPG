import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { resolveAppSlug, tenantControllerPaths } from '../../common/utils/controller-paths';
import { DeveloperDatabaseService } from './developer-database.service';
import { DeveloperSdkAuthGuard } from './developer-sdk-auth.guard';
import { DeveloperSdkLoginService } from './developer-sdk-login.service';
import { DeveloperSdkService } from './developer-sdk.service';

@ApiTags('DeveloperSDK')
@Controller(tenantControllerPaths('sdk', true))
export class DeveloperSdkController {
  constructor(
    private readonly developerSdkService: DeveloperSdkService,
    private readonly developerDatabaseService: DeveloperDatabaseService,
    private readonly developerSdkLoginService: DeveloperSdkLoginService,
  ) {}

  @Get('manifest')
  @ApiOperation({ summary: 'OPG SDK manifest for the current app' })
  async getManifest(@Req() req: any) {
    return this.developerSdkService.getManifest(resolveAppSlug(req), this.getRequestOptions(req));
  }

  @Get('openapi.json')
  @ApiOperation({ summary: 'OPG SDK OpenAPI contract for the current app' })
  async getOpenApi(@Req() req: any) {
    return this.developerSdkService.getOpenApi(resolveAppSlug(req), this.getRequestOptions(req));
  }

  @Get('examples')
  @ApiOperation({ summary: 'OPG SDK usage examples' })
  async getExamples(@Req() req: any, @Query('target') target?: string) {
    return this.developerSdkService.getExamples(resolveAppSlug(req), target, this.getRequestOptions(req));
  }

  @Post('smoke-test')
  @UseGuards(DeveloperSdkAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Validate SDK authentication and route contract' })
  async smokeTest(@Req() req: any, @Body() _body: Record<string, unknown>) {
    return this.developerSdkService.runSmokeTest(resolveAppSlug(req), req.user, this.getRequestOptions(req));
  }

  @Post('install-profile')
  @UseGuards(DeveloperSdkAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return a local SDK install profile for Codex or CLI clients' })
  async installProfile(@Req() req: any, @Body() body: { profile?: string; client?: string }) {
    const manifest = await this.developerSdkService.getManifest(resolveAppSlug(req), this.getRequestOptions(req));
    return {
      profile: String(body?.profile || 'default').trim() || 'default',
      client: String(body?.client || '@jamba/opg-cli').trim() || '@jamba/opg-cli',
      app: manifest.app,
      env: {
        OPG_BASE_URL: this.getRequestOptions(req).baseUrl,
        OPG_APP_SLUG: manifest.app.slug,
      },
      codex: manifest.codex,
    };
  }

  @Post('auth/sessions')
  @ApiOperation({ summary: 'Create a browser-based SDK login session for local CLI clients' })
  async createLoginSession(
    @Req() req: any,
    @Body() body: { callback_url?: string; callbackUrl?: string; client?: string; profile?: string; web_url?: string; webUrl?: string },
  ) {
    return this.developerSdkLoginService.createSession(resolveAppSlug(req), body || {}, this.getRequestOptions(req));
  }

  @Get('auth/sessions/:state')
  @ApiOperation({ summary: 'Read a browser-based SDK login session' })
  async getLoginSession(@Req() req: any, @Param('state') state: string) {
    return this.developerSdkLoginService.getSession(resolveAppSlug(req), state);
  }

  @Post('auth/sessions/:state/authorize')
  @UseGuards(DeveloperSdkAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Authorize an SDK login session with the current app admin' })
  async authorizeLoginSession(@Req() req: any, @Param('state') state: string, @Body() body: { scopes?: unknown }) {
    return this.developerSdkLoginService.authorizeSession(resolveAppSlug(req), state, req.user, body || {});
  }

  @Post('auth/token')
  @ApiOperation({ summary: 'Exchange a browser authorization code for a local SDK API key' })
  async exchangeLoginToken(@Req() req: any, @Body() body: { state?: string; code?: string }) {
    return this.developerSdkLoginService.exchangeToken(resolveAppSlug(req), body || {});
  }

  @Get('database/manifest')
  @UseGuards(DeveloperSdkAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return app-scoped database namespace and safety contract' })
  async databaseManifest(@Req() req: any) {
    return this.developerDatabaseService.getManifest({ appSlug: resolveAppSlug(req), actor: req.user });
  }

  @Get('database/tables')
  @UseGuards(DeveloperSdkAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List app-owned database tables visible to the SDK' })
  async databaseTables(@Req() req: any) {
    return this.developerDatabaseService.listTables({ appSlug: resolveAppSlug(req), actor: req.user });
  }

  @Get('database/tables/:table')
  @UseGuards(DeveloperSdkAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Describe an app-owned database table' })
  async databaseTable(@Req() req: any, @Param('table') table: string) {
    return this.developerDatabaseService.describeTable({ appSlug: resolveAppSlug(req), actor: req.user }, table);
  }

  @Post('database/query')
  @UseGuards(DeveloperSdkAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Run a read-only SQL query against app-owned database tables' })
  async databaseQuery(@Req() req: any, @Body() body: Record<string, unknown>) {
    return this.developerDatabaseService.query({ appSlug: resolveAppSlug(req), actor: req.user }, body);
  }

  @Post('database/execute')
  @UseGuards(DeveloperSdkAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dry-run or apply SQL changes inside the app-owned database namespace' })
  async databaseExecute(@Req() req: any, @Body() body: Record<string, unknown>) {
    return this.developerDatabaseService.execute({ appSlug: resolveAppSlug(req), actor: req.user }, body);
  }

  private getRequestOptions(req: any) {
    const protocol = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
    const baseUrl = host ? `${protocol}://${host}` : '';
    return {
      baseUrl,
      routePrefix: String(req.baseUrl || ''),
    };
  }
}
