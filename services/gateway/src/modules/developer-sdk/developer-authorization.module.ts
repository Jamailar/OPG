import { Module } from '@nestjs/common';
import { DeveloperAuthorizationService } from './developer-authorization.service';

@Module({
  providers: [DeveloperAuthorizationService],
  exports: [DeveloperAuthorizationService],
})
export class DeveloperAuthorizationModule {}
