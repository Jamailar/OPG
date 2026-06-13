import { Module } from '@nestjs/common';
import { RuntimeSettingsController } from './runtime-settings.controller';
import { RuntimeSettingsService } from './runtime-settings.service';

@Module({
  controllers: [RuntimeSettingsController],
  providers: [RuntimeSettingsService],
  exports: [RuntimeSettingsService],
})
export class RuntimeSettingsModule {}

