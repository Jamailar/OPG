import { Body, Controller, Get, Headers, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { resolveAppSlug, tenantControllerPaths } from '../../common/utils/controller-paths';
import { AppFormsService } from './app-forms.service';

@ApiTags('App Forms')
@Controller(tenantControllerPaths('forms', true))
export class AppFormsPublicController {
  constructor(private readonly appFormsService: AppFormsService) {}

  @Get(':form_key/manifest')
  @Public()
  @ApiOperation({ summary: '获取公开表单 Manifest' })
  async getManifest(
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Param('app') app: string | undefined,
    @Param('form_key') formKey: string,
  ) {
    const result = await this.appFormsService.getPublicManifest(resolveAppSlug(req, app), formKey);
    const etag = `"${result.etag}"`;
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
    res.setHeader('ETag', etag);
    if (ifNoneMatch === etag) {
      res.status(304);
      return undefined;
    }
    return result.manifest;
  }

  @Post(':form_key/responses')
  @Public()
  @ApiOperation({ summary: '提交公开表单' })
  async submitResponse(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Param('form_key') formKey: string,
    @Body() body: unknown,
  ) {
    return this.appFormsService.submitPublicResponse(resolveAppSlug(req, app), formKey, body, req);
  }
}
