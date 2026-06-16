import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { resolveAppSlug, tenantControllerPaths } from '../../common/utils/controller-paths';
import { DeveloperSdkAuthGuard } from './developer-sdk-auth.guard';
import { DeveloperSdkService } from './developer-sdk.service';

@ApiTags('DeveloperSDK')
@Controller(tenantControllerPaths('sdk', true))
export class DeveloperSdkController {
  constructor(private readonly developerSdkService: DeveloperSdkService) {}

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
      client: String(body?.client || 'opg-cli').trim() || 'opg-cli',
      app: manifest.app,
      env: {
        OPG_BASE_URL: this.getRequestOptions(req).baseUrl,
        OPG_APP_SLUG: manifest.app.slug,
      },
      codex: manifest.codex,
    };
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
