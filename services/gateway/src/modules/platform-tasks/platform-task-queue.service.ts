import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import configuration from '../../config/configuration';
import { PlatformTaskQueueBackendStatus } from './platform-tasks.types';

type PlatformQueueJob = {
  task_id: string;
  module: string;
  action: string;
};

@Injectable()
export class PlatformTaskQueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PlatformTaskQueueService.name);
  private readonly queueName = 'platform-tasks';
  private redis: IORedis | null = null;
  private queue: Queue | null = null;
  private available = false;
  private lastError: string | null = null;

  constructor(@Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>) {}

  async onModuleInit() {
    await this.initialize();
  }

  async onApplicationShutdown() {
    await this.queue?.close().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }

  async enqueue(task: { id: string; module: string; action: string; queue_name?: string | null; priority?: number | null }) {
    if (!this.queue || !this.available) {
      return { backend: 'db' as const, enqueued: false };
    }
    try {
      await this.queue.add(
        task.queue_name || this.queueName,
        { task_id: task.id, module: task.module, action: task.action },
        {
          jobId: task.id,
          priority: this.normalizePriority(task.priority),
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 2000 },
        },
      );
      return { backend: 'bullmq' as const, enqueued: true };
    } catch (error: any) {
      this.available = false;
      this.lastError = String(error?.message || error || 'unknown queue error').slice(0, 500);
      this.logger.warn(`platform task queue enqueue failed; falling back to DB: ${this.lastError}`);
      return { backend: 'db' as const, enqueued: false };
    }
  }

  getStatus(): PlatformTaskQueueBackendStatus {
    return {
      backend: this.queue && this.available ? 'bullmq' : 'db',
      available: this.available,
      queue_name: this.queueName,
      redis_url_configured: Boolean(this.config.redis.url),
      last_error: this.lastError,
    };
  }

  private async initialize() {
    if (!this.config.redis.url) {
      this.available = false;
      this.lastError = 'REDIS_URL is not configured';
      return;
    }
    try {
      this.redis = new IORedis(this.config.redis.url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
      });
      await this.redis.connect();
      this.queue = new Queue(this.queueName, {
        connection: {
          url: this.config.redis.url,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        },
      });
      this.available = true;
      this.lastError = null;
    } catch (error: any) {
      this.available = false;
      this.lastError = String(error?.message || error || 'unknown redis error').slice(0, 500);
      this.logger.warn(`platform task queue disabled; using DB fallback: ${this.lastError}`);
      if (this.redis) {
        this.redis.disconnect();
      }
      this.redis = null;
      this.queue = null;
    }
  }

  private normalizePriority(priority: number | null | undefined) {
    const value = Number(priority ?? 0);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return Math.min(2_097_152, Math.max(1, Math.round(value)));
  }
}
