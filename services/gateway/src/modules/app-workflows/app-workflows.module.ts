import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AppFunctionsModule } from '../app-functions/app-functions.module';
import { AppSchemaModule } from '../app-schema/app-schema.module';
import { DeveloperSdkAuthGuard } from '../developer-sdk/developer-sdk-auth.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { AppWorkflowsAppController } from './app-workflows-app.controller';
import { AppWorkflowsPlatformController } from './app-workflows-platform.controller';
import { AppWorkflowsService } from './app-workflows.service';

@Module({
  imports: [AppSchemaModule, AppFunctionsModule, RealtimeModule],
  controllers: [AppWorkflowsPlatformController, AppWorkflowsAppController],
  providers: [AppWorkflowsService, JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard, DeveloperSdkAuthGuard],
  exports: [AppWorkflowsService],
})
export class AppWorkflowsModule {}
