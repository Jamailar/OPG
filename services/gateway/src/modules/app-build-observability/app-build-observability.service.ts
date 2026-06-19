import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AppSchemaService } from '../app-schema/app-schema.service';

@Injectable()
export class AppBuildObservabilityService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly appSchemaService: AppSchemaService,
  ) {}

  async summary(appRef: string) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const [schema, functions, workflows, ai, video] = await Promise.all([
      this.one(`SELECT COUNT(*)::int AS total FROM app_schema_change_events WHERE app_id = $1::uuid`, app.id),
      this.one(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed FROM app_function_runs WHERE app_id = $1::uuid`, app.id),
      this.one(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed FROM app_workflow_runs WHERE app_id = $1::uuid`, app.id),
      this.one(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed FROM app_ai_runs WHERE app_id = $1::uuid`, app.id),
      this.one(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('FAILED', 'ERROR'))::int AS failed FROM app_video_jobs WHERE app_id = $1::uuid`, app.id),
    ]);
    return {
      app,
      summary: {
        schema_events: Number(schema.total || 0),
        function_runs: Number(functions.total || 0),
        function_failures: Number(functions.failed || 0),
        workflow_runs: Number(workflows.total || 0),
        workflow_failures: Number(workflows.failed || 0),
        ai_runs: Number(ai.total || 0),
        ai_failures: Number(ai.failed || 0),
        video_jobs: Number(video.total || 0),
        video_failures: Number(video.failed || 0),
      },
    };
  }

  async events(appRef: string, query: Record<string, unknown> = {}) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const limit = Math.min(Math.max(Number(query.limit || 50), 1), 200);
    const [schemaEvents, functionRuns, workflowRuns, aiRuns, videoJobs] = await Promise.all([
      this.prisma.$queryRawUnsafe(
        `
          SELECT 'schema' AS source, action AS event, resource_type, resource_id::text,
                 after_json AS payload, created_at
          FROM app_schema_change_events
          WHERE app_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT $2
        `,
        app.id,
        limit,
      ) as Promise<any[]>,
      this.prisma.$queryRawUnsafe(
        `
          SELECT 'function' AS source, status AS event, 'function_run' AS resource_type, id::text AS resource_id,
                 jsonb_build_object('function_id', function_id, 'error', error_json) AS payload, created_at
          FROM app_function_runs
          WHERE app_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT $2
        `,
        app.id,
        limit,
      ) as Promise<any[]>,
      this.prisma.$queryRawUnsafe(
        `
          SELECT 'workflow' AS source, status AS event, 'workflow_run' AS resource_type, id::text AS resource_id,
                 jsonb_build_object('workflow_id', workflow_id, 'error', error_json) AS payload, created_at
          FROM app_workflow_runs
          WHERE app_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT $2
        `,
        app.id,
        limit,
      ) as Promise<any[]>,
      this.prisma.$queryRawUnsafe(
        `
          SELECT 'ai' AS source, status AS event, 'ai_run' AS resource_type, id::text AS resource_id,
                 jsonb_build_object('block_id', block_id, 'error', error_json) AS payload, created_at
          FROM app_ai_runs
          WHERE app_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT $2
        `,
        app.id,
        limit,
      ) as Promise<any[]>,
      this.prisma.$queryRawUnsafe(
        `
          SELECT 'video' AS source, status AS event, 'video_job' AS resource_type, id::text AS resource_id,
                 jsonb_build_object('block_id', block_id, 'provider_task_id', provider_task_id, 'error', error_json) AS payload, created_at
          FROM app_video_jobs
          WHERE app_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT $2
        `,
        app.id,
        limit,
      ) as Promise<any[]>,
    ]);
    const items = [...schemaEvents, ...functionRuns, ...workflowRuns, ...aiRuns, ...videoJobs]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
    return { app, items, limit };
  }

  private async one(sql: string, appId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(sql, appId) as Promise<Array<Record<string, unknown>>>);
    return rows[0] || {};
  }
}
