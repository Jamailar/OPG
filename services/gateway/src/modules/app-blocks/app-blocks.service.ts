import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Buffer } from 'buffer';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AiChatService } from '../ai-chat/ai-chat.service';
import { AppSchemaService } from '../app-schema/app-schema.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { UploadService } from '../upload/upload.service';

const IDENTIFIER_RE = /^[a-z][a-z0-9_]{1,78}$/;

@Injectable()
export class AppBlocksService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly appSchemaService: AppSchemaService,
    private readonly aiChatService: AiChatService,
    private readonly uploadService: UploadService,
    private readonly realtimeEventsService: RealtimeEventsService,
  ) {}

  async upsertAiBlock(appRef: string, body: Record<string, unknown>) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const slug = this.normalizeIdentifier(body.slug || body.name, 'ai block slug');
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_ai_blocks (
          app_id, slug, type, model_slot, prompt_template, input_schema_json,
          output_schema_json, tool_bindings_json, settings_json, status
        ) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, 'ACTIVE')
        ON CONFLICT (app_id, slug) WHERE status <> 'DELETED'
        DO UPDATE SET type = EXCLUDED.type, model_slot = EXCLUDED.model_slot,
                      prompt_template = EXCLUDED.prompt_template,
                      input_schema_json = EXCLUDED.input_schema_json,
                      output_schema_json = EXCLUDED.output_schema_json,
                      tool_bindings_json = EXCLUDED.tool_bindings_json,
                      settings_json = EXCLUDED.settings_json,
                      updated_at = now()
        RETURNING *
      `,
      app.id,
      slug,
      String(body.type || 'text_generation').slice(0, 40),
      this.optionalString(body.model_slot || body.modelSlot, 80),
      this.optionalString(body.prompt_template || body.promptTemplate, 20000),
      JSON.stringify(this.jsonObject(body.input_schema || body.input_schema_json)),
      JSON.stringify(this.jsonObject(body.output_schema || body.output_schema_json)),
      JSON.stringify(Array.isArray(body.tool_bindings) ? body.tool_bindings : []),
      JSON.stringify(this.jsonObject(body.settings || body.settings_json)),
    ) as Promise<any[]>);
    return { ok: true, app, block: rows[0] };
  }

  async upsertVideoBlock(appRef: string, body: Record<string, unknown>) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const slug = this.normalizeIdentifier(body.slug || body.name, 'video block slug');
    const rows = await (this.prisma.$queryRawUnsafe(
      `
        INSERT INTO app_video_blocks (
          app_id, slug, provider_slot, input_schema_json, output_schema_json, settings_json, status
        ) VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, 'ACTIVE')
        ON CONFLICT (app_id, slug) WHERE status <> 'DELETED'
        DO UPDATE SET provider_slot = EXCLUDED.provider_slot,
                      input_schema_json = EXCLUDED.input_schema_json,
                      output_schema_json = EXCLUDED.output_schema_json,
                      settings_json = EXCLUDED.settings_json,
                      updated_at = now()
        RETURNING *
      `,
      app.id,
      slug,
      this.optionalString(body.provider_slot || body.providerSlot, 80),
      JSON.stringify(this.jsonObject(body.input_schema || body.input_schema_json)),
      JSON.stringify(this.jsonObject(body.output_schema || body.output_schema_json)),
      JSON.stringify(this.jsonObject(body.settings || body.settings_json)),
    ) as Promise<any[]>);
    return { ok: true, app, block: rows[0] };
  }

  async runAiBlock(appRef: string, blockRef: string, actor: any, input: Record<string, unknown>) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const block = await this.resolveAiBlock(app.id, blockRef);
    const prompt = this.renderPrompt(String(block.prompt_template || ''), input);
    const payload = {
      ...(this.jsonObject(block.settings_json).payload || {}),
      messages: [{ role: 'user', content: prompt || JSON.stringify(input) }],
      ...(block.model_slot ? { model_slot: block.model_slot } : {}),
    };
    const runRows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_ai_runs (app_id, block_id, actor_user_id, input_json, status, started_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, 'RUNNING', now()) RETURNING id`,
      app.id,
      block.id,
      this.actorUserId(actor),
      JSON.stringify(input),
    ) as Promise<Array<{ id: string }>>);
    try {
      const output = await this.aiChatService.chatLegacy(app.slug, payload, {
        user_id: this.actorUserId(actor) || undefined,
        request_path: `app-blocks/ai/${block.slug}`,
      });
      await this.prisma.$executeRawUnsafe(
        `UPDATE app_ai_runs SET status = 'SUCCEEDED', output_json = $1::jsonb, finished_at = now() WHERE id = $2::uuid`,
        JSON.stringify(output),
        runRows[0].id,
      );
      await this.realtimeEventsService.publish(`apps.${app.slug}.ai.${runRows[0].id}`, 'completed', { block: block.slug, run_id: runRows[0].id }, { app_id: app.id, app_slug: app.slug, resource_id: runRows[0].id });
      return { ok: true, run_id: runRows[0].id, block: block.slug, output };
    } catch (error: any) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE app_ai_runs SET status = 'FAILED', error_json = $1::jsonb, finished_at = now() WHERE id = $2::uuid`,
        JSON.stringify({ message: String(error?.message || error).slice(0, 2000) }),
        runRows[0].id,
      );
      throw error;
    }
  }

  async runVideoBlock(appRef: string, blockRef: string, actor: any, input: Record<string, unknown>) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const block = await this.resolveVideoBlock(app.id, blockRef);
    const payload = { ...this.jsonObject(block.settings_json).payload, ...input };
    const jobRows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_video_jobs (app_id, block_id, input_json, status)
       VALUES ($1::uuid, $2::uuid, $3::jsonb, 'RUNNING') RETURNING id`,
      app.id,
      block.id,
      JSON.stringify(payload),
    ) as Promise<Array<{ id: string }>>);
    const output = await this.aiChatService.invokeVideoAsync(app.slug, payload, {
      user_id: this.actorUserId(actor) || undefined,
      request_path: `app-blocks/video/${block.slug}`,
    });
    await this.prisma.$executeRawUnsafe(
      `UPDATE app_video_jobs SET status = 'QUEUED', output_json = $1::jsonb, provider_task_id = $2, updated_at = now() WHERE id = $3::uuid`,
      JSON.stringify(output),
      String((output as any)?.data?.task_id || (output as any)?.task_id || '').slice(0, 160) || null,
      jobRows[0].id,
    );
    await this.realtimeEventsService.publish(`apps.${app.slug}.video.${jobRows[0].id}`, 'progress', { block: block.slug, job_id: jobRows[0].id, status: 'QUEUED' }, { app_id: app.id, app_slug: app.slug, resource_id: jobRows[0].id });
    return { ok: true, job_id: jobRows[0].id, block: block.slug, output };
  }

  async saveStorageObject(appRef: string, actor: any, input: Record<string, unknown>) {
    const app = await this.appSchemaService.resolveApp(appRef);
    const bucketSlug = this.normalizeIdentifier(input.bucket || 'default', 'bucket slug');
    const bucket = await this.ensureBucket(app.id, bucketSlug);
    const content = String(input.content || input.text || '');
    const filename = String(input.filename || `${Date.now()}.txt`);
    const contentType = String(input.content_type || input.contentType || 'text/plain');
    const uploaded = await this.uploadService.uploadBuffer(this.actorUserId(actor) || 'system', filename, contentType, Buffer.from(content), app.slug, `apps/${app.slug}/${bucketSlug}`, app.id);
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_storage_files (app_id, bucket_id, file_key, file_url, content_type, size_bytes, metadata_json, created_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::uuid) RETURNING *`,
      app.id,
      bucket.id,
      uploaded.file_key,
      uploaded.file_url,
      contentType,
      Buffer.byteLength(content),
      JSON.stringify(this.jsonObject(input.metadata)),
      this.actorUserId(actor),
    ) as Promise<any[]>);
    return { ok: true, app, file: this.serializeStorageFile(rows[0]) };
  }

  private async resolveAiBlock(appId: string, blockRef: string) {
    const rows = await (this.prisma.$queryRawUnsafe(`SELECT * FROM app_ai_blocks WHERE app_id = $1::uuid AND (id::text = $2 OR slug = $2) AND status = 'ACTIVE' LIMIT 1`, appId, blockRef) as Promise<any[]>);
    if (!rows[0]) throw new NotFoundException('AI block not found');
    return rows[0];
  }

  private async resolveVideoBlock(appId: string, blockRef: string) {
    const rows = await (this.prisma.$queryRawUnsafe(`SELECT * FROM app_video_blocks WHERE app_id = $1::uuid AND (id::text = $2 OR slug = $2) AND status = 'ACTIVE' LIMIT 1`, appId, blockRef) as Promise<any[]>);
    if (!rows[0]) throw new NotFoundException('Video block not found');
    return rows[0];
  }

  private async ensureBucket(appId: string, slug: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_storage_buckets (app_id, slug) VALUES ($1::uuid, $2)
       ON CONFLICT (app_id, slug) WHERE status <> 'DELETED' DO UPDATE SET updated_at = now()
       RETURNING id, slug`,
      appId,
      slug,
    ) as Promise<Array<{ id: string; slug: string }>>);
    return rows[0];
  }

  private renderPrompt(template: string, input: Record<string, unknown>) {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => String(input[key] ?? ''));
  }

  private normalizeIdentifier(value: unknown, label: string) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
    if (!IDENTIFIER_RE.test(normalized)) throw new BadRequestException(`Invalid ${label}`);
    return normalized;
  }

  private optionalString(value: unknown, maxLength: number) {
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  private actorUserId(actor: any) {
    const userId = String(actor?.userId || actor?.id || '').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId) ? userId : null;
  }

  private jsonObject(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  }

  private serializeStorageFile(row: any) {
    if (!row || typeof row !== 'object') return row;
    const size = row.size_bytes;
    return {
      ...row,
      size_bytes: typeof size === 'bigint' ? Number(size) : size,
    };
  }
}
