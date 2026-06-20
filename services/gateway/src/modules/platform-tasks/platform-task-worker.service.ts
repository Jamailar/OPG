import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import configuration from '../../config/configuration';
import { PlatformTasksService } from './platform-tasks.service';

@Injectable()
export class PlatformTaskWorkerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PlatformTaskWorkerService.name);
  private readonly queueName = 'platform-tasks';
  private readonly workerId = `${process.pid}@${process.env.HOSTNAME || 'gateway'}:platform-task-worker`.slice(0, 128);
  private redis: IORedis | null = null;
  private worker: Worker | null = null;
  private polling = false;
  private disabled = false;

  constructor(
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly tasksService: PlatformTasksService,
  ) {}

  async onModuleInit() {
    this.disabled = String(process.env.OPG_PLATFORM_TASK_WORKER_DISABLED || '').toLowerCase() === 'true';
    if (this.disabled) {
      await this.heartbeat('disabled');
      return;
    }
    await this.startBullWorker();
    await this.heartbeat('online');
  }

  async onApplicationShutdown() {
    await this.worker?.close().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }

  @Cron('*/15 * * * * *')
  async pollDatabaseQueue() {
    if (this.disabled || this.polling) return;
    this.polling = true;
    try {
      const limit = this.intEnv('OPG_PLATFORM_TASK_DB_POLL_BATCH', 5, 1, 50);
      for (let index = 0; index < limit; index += 1) {
        const result = await this.tasksService.claimAndRunNext(this.workerId);
        if (!result) break;
      }
    } catch (error: any) {
      this.logger.warn(`platform task DB poll failed: ${error?.message || error}`);
    } finally {
      this.polling = false;
    }
  }

  @Cron('*/30 * * * * *')
  async heartbeat(status = 'online') {
    await this.tasksService.recordWorkerHeartbeat({
      worker_id: this.workerId,
      kind: 'gateway',
      queue_names: [this.queueName],
      status,
      metadata: {
        bullmq_worker: Boolean(this.worker),
        registered_handlers: this.tasksService.listRegisteredHandlers(),
      },
    }).catch((error: any) => {
      this.logger.warn(`platform task worker heartbeat failed: ${error?.message || error}`);
    });
  }

  private async startBullWorker() {
    const redisUrl = String(this.config.redis.url || '').trim();
    if (!redisUrl) {
      this.logger.warn('platform task BullMQ worker disabled because REDIS_URL is not configured');
      return;
    }
    try {
      this.redis = new IORedis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
      });
      await this.redis.connect();
      this.worker = new Worker(
        this.queueName,
        async (job) => {
          const taskId = String(job.data?.task_id || job.id || '').trim();
          if (!taskId) throw new Error('platform task job missing task_id');
          await this.tasksService.runTaskWorker(taskId, this.workerId);
        },
        {
          connection: this.redis as any,
          concurrency: this.intEnv('OPG_PLATFORM_TASK_WORKER_CONCURRENCY', 2, 1, 20),
        },
      );
      this.worker.on('failed', (job, error) => {
        this.logger.warn(`platform task job failed: job=${job?.id || '-'} error=${error?.message || error}`);
      });
    } catch (error: any) {
      this.logger.warn(`platform task BullMQ worker unavailable; DB polling remains active: ${error?.message || error}`);
      await this.worker?.close().catch(() => undefined);
      await this.redis?.quit().catch(() => undefined);
      this.worker = null;
      this.redis = null;
    }
  }

  private intEnv(name: string, fallback: number, min: number, max: number) {
    const parsed = Number.parseInt(String(process.env[name] || '').trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }
}
