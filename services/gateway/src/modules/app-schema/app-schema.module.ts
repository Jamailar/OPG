import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AppApiKeysModule } from '../api-keys/app-api-keys.module';
import { AuthModule } from '../auth/auth.module';
import { DeveloperAuthorizationModule } from '../developer-sdk/developer-authorization.module';
import { DeveloperSdkAuthGuard } from '../developer-sdk/developer-sdk-auth.guard';
import { AppDataController } from './app-data.controller';
import { AppSchemaPlatformController } from './app-schema-platform.controller';
import { AppSchemaService } from './app-schema.service';

@Module({
  imports: [AuthModule, AppApiKeysModule, DeveloperAuthorizationModule],
  controllers: [AppSchemaPlatformController, AppDataController],
  providers: [AppSchemaService, JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard, DeveloperSdkAuthGuard],
  exports: [AppSchemaService],
})
export class AppSchemaModule {}
