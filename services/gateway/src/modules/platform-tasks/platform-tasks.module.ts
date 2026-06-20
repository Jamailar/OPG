import { Module } from '@nestjs/common';
import { PlatformTaskQueueService } from './platform-task-queue.service';
import { PlatformTaskWorkerService } from './platform-task-worker.service';
import { PlatformTasksService } from './platform-tasks.service';

@Module({
  providers: [PlatformTaskQueueService, PlatformTasksService, PlatformTaskWorkerService],
  exports: [PlatformTasksService, PlatformTaskQueueService],
})
export class PlatformTasksModule {}
