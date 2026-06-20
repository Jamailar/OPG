import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AppApiKeysModule } from '../api-keys/app-api-keys.module';
import { AppFunctionsModule } from '../app-functions/app-functions.module';
import { AppBlocksModule } from '../app-blocks/app-blocks.module';
import { AppConnectorsModule } from '../app-connectors/app-connectors.module';
import { AppSchemaModule } from '../app-schema/app-schema.module';
import { AuthModule } from '../auth/auth.module';
import { DeveloperAuthorizationModule } from '../developer-sdk/developer-authorization.module';
import { DeveloperSdkAuthGuard } from '../developer-sdk/developer-sdk-auth.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { AppWorkflowsAppController } from './app-workflows-app.controller';
import { AppWorkflowsPlatformController } from './app-workflows-platform.controller';
import { AppWorkflowsService } from './app-workflows.service';

@Module({
  imports: [AuthModule, AppApiKeysModule, DeveloperAuthorizationModule, AppSchemaModule, AppFunctionsModule, AppBlocksModule, AppConnectorsModule, RealtimeModule],
  controllers: [AppWorkflowsPlatformController, AppWorkflowsAppController],
  providers: [AppWorkflowsService, JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard, DeveloperSdkAuthGuard],
  exports: [AppWorkflowsService],
})
export class AppWorkflowsModule {}
