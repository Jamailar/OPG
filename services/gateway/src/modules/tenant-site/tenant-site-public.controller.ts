import { Body, Controller, Get, Header, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { TenantSiteService } from './tenant-site.service';

@ApiTags('TenantSite')
@Controller(tenantControllerPaths('site', true))
export class TenantSitePublicController {
  constructor(private readonly tenantSiteService: TenantSiteService) {}

  @Get('config')
  @Public()
  @Header('Cache-Control', 'public, max-age=120, stale-while-revalidate=300')
  @ApiOperation({ summary: '公开站点配置' })
  async getConfig(@Param('app') app?: string) {
    return this.tenantSiteService.getPublicSiteConfig(app);
  }

  @Get('downloads')
  @Public()
  @Header('Cache-Control', 'public, max-age=120, stale-while-revalidate=300')
  @ApiOperation({ summary: '公开下载配置' })
  async getDownloads(@Param('app') app?: string) {
    const config = await this.tenantSiteService.getPublicSiteConfig(app);
    return {
      downloads: config.downloads,
    };
  }

  @Get('cookies')
  @Public()
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=600')
  @ApiOperation({ summary: '公开 Cookie 政策配置' })
  async getCookiePolicy(@Param('app') app?: string) {
    return this.tenantSiteService.getCookiePolicy(app);
  }

  @Post('newsletter')
  @Public()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '提交 newsletter 订阅' })
  async submitNewsletter(@Param('app') app: string | undefined, @Body() body: any, @Req() req: any) {
    return this.tenantSiteService.submitNewsletter(app, body || {}, req);
  }

  @Post('contact')
  @Public()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '提交联系表单' })
  async submitContact(@Param('app') app: string | undefined, @Body() body: any, @Req() req: any) {
    return this.tenantSiteService.submitContact(app, body || {}, req);
  }

  @Post('cookie-consent')
  @Public()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '保存 Cookie 偏好' })
  async saveCookieConsent(@Param('app') app: string | undefined, @Body() body: any, @Req() req: any) {
    return this.tenantSiteService.saveCookieConsent(app, body || {}, req);
  }
}
