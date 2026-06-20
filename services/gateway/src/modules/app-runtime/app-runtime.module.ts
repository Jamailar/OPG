import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AppSchemaModule } from '../app-schema/app-schema.module';
import { PlatformTasksModule } from '../platform-tasks/platform-tasks.module';
import { AppRuntimeController } from './app-runtime.controller';
import { AppRuntimeService } from './app-runtime.service';

@Module({
  imports: [AppSchemaModule, PlatformTasksModule],
  controllers: [AppRuntimeController],
  providers: [AppRuntimeService, JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard],
  exports: [AppRuntimeService],
})
export class AppRuntimeModule {}
