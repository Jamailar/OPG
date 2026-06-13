import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigType } from '@nestjs/config';
import configuration from '../../config/configuration';
import { DiscoveryService } from './discovery.service';
import { Inject } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Discovery')
@Controller('discovery')
export class DiscoveryController {
  constructor(
    private readonly discoveryService: DiscoveryService,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
  ) {}

  @Public()
  @Get('admin-context')
  @ApiOperation({ summary: '按域名解析后台门户上下文' })
  async resolveAdminContext(@Query('host') host: string, @Query('app_slug') appSlug?: string) {
    return this.discoveryService.resolveAdminContext(
      host,
      this.config.app.platformSlug,
      this.config.app.defaultSlug,
      appSlug,
    );
  }
}
