import { Module } from '@nestjs/common';
import { AcquisitionModule } from '../acquisition/acquisition.module';
import { AdminNotificationsModule } from '../admin-notifications/admin-notifications.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AppFormsPlatformController } from './app-forms-platform.controller';
import { AppFormsPublicController } from './app-forms-public.controller';
import { AppFormsService } from './app-forms.service';

@Module({
  imports: [AuthModule, AcquisitionModule, AdminNotificationsModule],
  controllers: [AppFormsPublicController, AppFormsPlatformController],
  providers: [AppFormsService, PlatformAdminAccessGuard],
  exports: [AppFormsService],
})
export class AppFormsModule {}
