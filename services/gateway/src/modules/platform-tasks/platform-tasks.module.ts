import { Module } from '@nestjs/common';
import { PlatformTaskQueueService } from './platform-task-queue.service';
import { PlatformTasksService } from './platform-tasks.service';

@Module({
  providers: [PlatformTaskQueueService, PlatformTasksService],
  exports: [PlatformTasksService, PlatformTaskQueueService],
})
export class PlatformTasksModule {}
