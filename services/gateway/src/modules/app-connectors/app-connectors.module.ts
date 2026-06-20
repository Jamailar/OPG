import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AppApiKeysModule } from '../api-keys/app-api-keys.module';
import { AppSchemaModule } from '../app-schema/app-schema.module';
import { AuthModule } from '../auth/auth.module';
import { DeveloperAuthorizationModule } from '../developer-sdk/developer-authorization.module';
import { DeveloperSdkAuthGuard } from '../developer-sdk/developer-sdk-auth.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { AppConnectorsAppController } from './app-connectors-app.controller';
import { AppConnectorsPlatformController } from './app-connectors-platform.controller';
import { AppConnectorsService } from './app-connectors.service';

@Module({
  imports: [AuthModule, AppApiKeysModule, DeveloperAuthorizationModule, AppSchemaModule, RealtimeModule],
  controllers: [AppConnectorsPlatformController, AppConnectorsAppController],
  providers: [AppConnectorsService, JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard, DeveloperSdkAuthGuard],
  exports: [AppConnectorsService],
})
export class AppConnectorsModule {}
