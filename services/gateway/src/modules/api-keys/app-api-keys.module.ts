import { Module } from '@nestjs/common';
import { AppApiKeysService } from './app-api-keys.service';

@Module({
  providers: [AppApiKeysService],
  exports: [AppApiKeysService],
})
export class AppApiKeysModule {}
