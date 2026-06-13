import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { RuntimeSettingsModule } from '../runtime-settings/runtime-settings.module';

@Module({
  imports: [
    MulterModule.register({
      dest: './uploads',
    }),
    RuntimeSettingsModule,
  ],
  controllers: [UploadController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule {}
