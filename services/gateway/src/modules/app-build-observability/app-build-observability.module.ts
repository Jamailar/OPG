import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AppSchemaModule } from '../app-schema/app-schema.module';
import { AppBuildObservabilityController } from './app-build-observability.controller';
import { AppBuildObservabilityService } from './app-build-observability.service';

@Module({
  imports: [AppSchemaModule],
  controllers: [AppBuildObservabilityController],
  providers: [AppBuildObservabilityService, JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard],
  exports: [AppBuildObservabilityService],
})
export class AppBuildObservabilityModule {}
