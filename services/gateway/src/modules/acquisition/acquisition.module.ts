import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AcquisitionAdminController } from './acquisition-admin.controller';
import { AcquisitionController } from './acquisition.controller';
import { AcquisitionUsersController } from './acquisition-users.controller';
import { AcquisitionService } from './acquisition.service';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';

@Module({
  imports: [AuthModule],
  controllers: [AcquisitionController, AcquisitionUsersController, AcquisitionAdminController],
  providers: [AcquisitionService, PlatformAdminAccessGuard],
  exports: [AcquisitionService],
})
export class AcquisitionModule {}
