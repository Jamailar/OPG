import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AuthModule } from '../auth/auth.module';
import { AppSchemaPlatformController } from './app-schema-platform.controller';
import { AppSchemaService } from './app-schema.service';

@Module({
  imports: [AuthModule],
  controllers: [AppSchemaPlatformController],
  providers: [AppSchemaService, JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard],
  exports: [AppSchemaService],
})
export class AppSchemaModule {}
