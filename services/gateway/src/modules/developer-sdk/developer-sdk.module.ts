import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AppApiKeysModule } from '../api-keys/app-api-keys.module';
import { DeveloperSdkAuthGuard } from './developer-sdk-auth.guard';
import { DeveloperSdkController } from './developer-sdk.controller';
import { DeveloperSdkService } from './developer-sdk.service';
import { DeveloperDatabaseService } from './developer-database.service';
import { DeveloperSdkLoginService } from './developer-sdk-login.service';
import { DeveloperAuthorizationModule } from './developer-authorization.module';

@Module({
  imports: [AuthModule, AppApiKeysModule, DeveloperAuthorizationModule],
  controllers: [DeveloperSdkController],
  providers: [DeveloperSdkService, DeveloperDatabaseService, DeveloperSdkLoginService, DeveloperSdkAuthGuard],
  exports: [DeveloperSdkService, DeveloperDatabaseService, DeveloperSdkLoginService],
})
export class DeveloperSdkModule {}
