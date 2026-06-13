import { Injectable, Logger } from '@nestjs/common';
import { RuntimeSettingsService } from '../runtime-settings/runtime-settings.service';

type UsageQueueTask = {
  label: string;
  run: () => Promise<void>;
};

type UsageQueueOverflowPolicy = 'sync' | 'drop';

@Injectable()
export class AiGatewayUsageQueueService {
  private readonly logger = new Logger(AiGatewayUsageQueueService.name);
  private readonly queue: UsageQueueTask[] = [];
  private activeWorkers = 0;
  private droppedTasks = 0;
  private completedTasks = 0;
  private failedTasks = 0;

  private workerCount = this.readPositiveInt('AI_GATEWAY_USAGE_WORKERS', 4, 1, 32);
  private maxQueueSize = this.readPositiveInt('AI_GATEWAY_USAGE_QUEUE_SIZE', 1000, 1, 100000);
  private overflowPolicy = this.readOverflowPolicy();
  private tuningLoadedAt = 0;
  private tuningLoading: Promise<void> | null = null;

  constructor(private readonly runtimeSettingsService: RuntimeSettingsService) {}

  enqueue(label: string, run: () => Promise<void>): void {
    this.ensureTuningFresh();
    if (this.queue.length >= this.maxQueueSize) {
      if (this.overflowPolicy === 'drop') {
        this.droppedTasks += 1;
        this.logger.warn(`AI usage queue full; dropped task label=${label} dropped=${this.droppedTasks}`);
        return;
      }

      void this.runInline(label, run);
      return;
    }

    this.queue.push({ label, run });
    this.drain();
  }

  getStats() {
    return {
      active_workers: this.activeWorkers,
      worker_count: this.workerCount,
      queue_length: this.queue.length,
      max_queue_size: this.maxQueueSize,
      overflow_policy: this.overflowPolicy,
      dropped_tasks: this.droppedTasks,
      completed_tasks: this.completedTasks,
      failed_tasks: this.failedTasks,
    };
  }

  private drain(): void {
    while (this.activeWorkers < this.workerCount && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) {
        return;
      }
      this.activeWorkers += 1;
      void this.runQueuedTask(task);
    }
  }

  private async runQueuedTask(task: UsageQueueTask): Promise<void> {
    try {
      await task.run();
      this.completedTasks += 1;
    } catch (error: any) {
      this.failedTasks += 1;
      this.logger.warn(`AI usage queue task failed label=${task.label}: ${error?.message || 'unknown error'}`);
    } finally {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      this.drain();
    }
  }

  private async runInline(label: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      this.completedTasks += 1;
      this.logger.warn(`AI usage queue full; ran task inline label=${label}`);
    } catch (error: any) {
      this.failedTasks += 1;
      this.logger.warn(`AI usage inline task failed label=${label}: ${error?.message || 'unknown error'}`);
    }
  }

  private readOverflowPolicy(): UsageQueueOverflowPolicy {
    const raw = String(process.env.AI_GATEWAY_USAGE_QUEUE_OVERFLOW || 'sync').trim().toLowerCase();
    return raw === 'drop' ? 'drop' : 'sync';
  }

  private readPositiveInt(name: string, fallback: number, min: number, max: number): number {
    const parsed = Number.parseInt(String(process.env[name] || '').trim(), 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }

  private ensureTuningFresh(): void {
    if (this.tuningLoadedAt > 0 && Date.now() - this.tuningLoadedAt < 15000) {
      return;
    }
    if (!this.tuningLoading) {
      this.tuningLoading = this.refreshTuning().finally(() => {
        this.tuningLoading = null;
      });
    }
  }

  private async refreshTuning(): Promise<void> {
    try {
      const tuning = await this.runtimeSettingsService.getAiGatewayTuning();
      this.workerCount = this.numberValue(tuning.usage_workers, this.readPositiveInt('AI_GATEWAY_USAGE_WORKERS', 4, 1, 32), 1, 32);
      this.maxQueueSize = this.numberValue(tuning.usage_queue_size, this.readPositiveInt('AI_GATEWAY_USAGE_QUEUE_SIZE', 1000, 1, 100000), 1, 100000);
      const overflow = String(tuning.usage_queue_overflow || '').trim().toLowerCase();
      this.overflowPolicy = overflow === 'drop' ? 'drop' : this.readOverflowPolicy();
      this.tuningLoadedAt = Date.now();
    } catch (error: any) {
      this.logger.warn(`AI usage queue tuning refresh failed: ${error?.message || error}`);
      this.tuningLoadedAt = Date.now();
    }
  }

  private numberValue(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }
}
