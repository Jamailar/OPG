import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { RuntimeSettingsService } from './runtime-settings.service';

@ApiTags('RuntimeSettings')
@Controller('runtime-config')
export class RuntimeSettingsController {
  constructor(private readonly runtimeSettingsService: RuntimeSettingsService) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '公开运行时配置（不含密钥）' })
  async getRuntimeConfig() {
    return this.runtimeSettingsService.getPublicRuntimeConfig();
  }
}

