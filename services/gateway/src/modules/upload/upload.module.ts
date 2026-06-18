import { forwardRef, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { RuntimeSettingsModule } from '../runtime-settings/runtime-settings.module';
import { AuthModule } from '../auth/auth.module';
import { AppApiKeysModule } from '../api-keys/app-api-keys.module';
import { DeveloperAuthorizationModule } from '../developer-sdk/developer-authorization.module';
import { DeveloperSdkAuthGuard } from '../developer-sdk/developer-sdk-auth.guard';

@Module({
  imports: [
    MulterModule.register({
      dest: './uploads',
    }),
    RuntimeSettingsModule,
    forwardRef(() => AuthModule),
    AppApiKeysModule,
    DeveloperAuthorizationModule,
  ],
  controllers: [UploadController],
  providers: [UploadService, DeveloperSdkAuthGuard],
  exports: [UploadService],
})
export class UploadModule {}
