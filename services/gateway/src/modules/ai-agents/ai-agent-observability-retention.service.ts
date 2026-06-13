import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';

const RETENTION_BATCH_SIZE = 5000;

@Injectable()
export class AiAgentObservabilityRetentionService {
  private readonly logger = new Logger(AiAgentObservabilityRetentionService.name);

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  @Cron('0 * * * *')
  async pruneExpiredAgentLogs() {
    try {
      const stepRows = await (this.prisma.$queryRawUnsafe(
        `WITH deleted AS (
           DELETE FROM ai_agent_run_steps
            WHERE id IN (
              SELECT id
                FROM ai_agent_run_steps
               WHERE expires_at < now()
               ORDER BY expires_at ASC
               LIMIT $1
            )
            RETURNING 1
         )
         SELECT COUNT(*)::bigint AS deleted_count FROM deleted`,
        RETENTION_BATCH_SIZE,
      ) as Promise<Array<{ deleted_count: string | number }>>);
      const runRows = await (this.prisma.$queryRawUnsafe(
        `WITH deleted AS (
           DELETE FROM ai_agent_runs
            WHERE id IN (
              SELECT id
                FROM ai_agent_runs
               WHERE expires_at < now()
               ORDER BY expires_at ASC
               LIMIT $1
            )
            RETURNING 1
         )
         SELECT COUNT(*)::bigint AS deleted_count FROM deleted`,
        RETENTION_BATCH_SIZE,
      ) as Promise<Array<{ deleted_count: string | number }>>);
      const deletedSteps = Number(stepRows[0]?.deleted_count || 0);
      const deletedRuns = Number(runRows[0]?.deleted_count || 0);
      if (deletedSteps > 0 || deletedRuns > 0) {
        this.logger.log(`pruned expired ai agent logs: runs=${deletedRuns}, steps=${deletedSteps}`);
      }
    } catch (error: any) {
      this.logger.warn(`failed to prune expired ai agent logs: ${error?.message || error}`);
    }
  }
}
