import { Module } from '@nestjs/common';
import { UploadModule } from '../upload/upload.module';
import { TenantSitePublicController } from './tenant-site-public.controller';
import { TenantSiteService } from './tenant-site.service';

@Module({
  imports: [UploadModule],
  controllers: [TenantSitePublicController],
  providers: [TenantSiteService],
  exports: [TenantSiteService],
})
export class TenantSiteModule {}
