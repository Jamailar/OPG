import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AppSchemaModule } from '../app-schema/app-schema.module';
import { DeveloperSdkAuthGuard } from '../developer-sdk/developer-sdk-auth.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { AppFunctionsAppController } from './app-functions-app.controller';
import { AppFunctionsPlatformController } from './app-functions-platform.controller';
import { AppFunctionsService } from './app-functions.service';

@Module({
  imports: [AppSchemaModule, RealtimeModule],
  controllers: [AppFunctionsPlatformController, AppFunctionsAppController],
  providers: [AppFunctionsService, JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard, DeveloperSdkAuthGuard],
  exports: [AppFunctionsService],
})
export class AppFunctionsModule {}
