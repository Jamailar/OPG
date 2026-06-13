import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { PRISMA_CLIENT } from '../../config/database.module';
import { UploadService } from '../upload/upload.service';
import { RuntimeSettingsService } from '../runtime-settings/runtime-settings.service';
import { AiRoutingService, ResolvedAiRoute } from './ai-routing.service';
import { AiUpstreamClientService } from './ai-upstream-client.service';

type VoiceAssetRow = {
  id: string;
  app_id: string;
  user_id: string | null;
  public_voice_id: string;
  display_name: string;
  language: string | null;
  status: string;
  active_mapping_id: string | null;
  sample_file_key: string;
  sample_file_url: string;
  sample_mime_type: string | null;
  sample_size_bytes: bigint | number | null;
  sample_sha256: string | null;
  sample_duration_ms: number | null;
  metadata_json: unknown;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type VoiceAssetWithMappingRow = VoiceAssetRow & {
  mapping_id: string | null;
  mapping_provider_type: string | null;
  mapping_source_id: string | null;
  mapping_global_model_id: string | null;
  mapping_global_model_api_type: string | null;
  mapping_provider_voice_id: string | null;
  mapping_status: string | null;
  mapping_error_message: string | null;
};

export type ResolvedPlatformVoice = {
  public_voice_id: string;
  provider_voice_id: string;
  provider_type: string;
  source_id: string;
  global_model_id: string | null;
  global_model_is_voice_clone?: boolean;
};

type CloneVoiceInput = {
  appSlug: string;
  userId?: string | null;
  file?: Express.Multer.File;
  sample_file_url?: string;
  sample_file_key?: string;
  name?: string;
  language?: string;
  model?: string;
  metadata?: Record<string, unknown>;
};

type VoiceCloneProviderResult = {
  providerVoiceId: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  sampleDurationMs?: number | null;
  targetGlobalModelId?: string | null;
};

const DASHSCOPE_COSYVOICE_V35_MODELS = new Set(['cosyvoice-v3.5-plus', 'cosyvoice-v3.5-flash']);
const DASHSCOPE_COSYVOICE_V35_LANGUAGE_HINTS: Record<string, string> = {
  zh: '中文',
  en: '英文',
  fr: '法语',
  de: '德语',
  ja: '日语',
  ko: '韩语',
  ru: '俄语',
  pt: '葡萄牙语',
  th: '泰语',
  id: '印尼语',
  vi: '越南语',
};

@Injectable()
export class AiVoicesService implements OnModuleInit {
  private readonly logger = new Logger(AiVoicesService.name);
  private readonly voiceCache = new Map<string, { value: ResolvedPlatformVoice; expiresAt: number }>();
  private migrationWorkerBusy = false;
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;
  private readonly minimaxVoiceCloneMinDurationMs = 10 * 1000;
  private readonly minimaxVoiceCloneMaxDurationMs = 5 * 60 * 1000;
  private readonly ffprobeAvailable = this.checkFfprobeAvailable();
  private ffprobeUnavailableWarned = false;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly uploadService: UploadService,
    private readonly runtimeSettingsService: RuntimeSettingsService,
    private readonly aiRoutingService: AiRoutingService,
    private readonly aiUpstreamClient: AiUpstreamClientService,
  ) {
    if (!this.ffprobeAvailable) {
      this.logger.warn('MiniMax voice clone duration check: ffprobe is unavailable; duration will be validated by upstream API only');
    }
  }

  async onModuleInit() {
    await this.ensureSchema();
  }

  async cloneVoice(input: CloneVoiceInput) {
    await this.ensureSchema();
    const app = await this.resolveApp(input.appSlug);
    const displayName = this.normalizeString(input.name, 128) || 'Custom voice';
    const language = this.normalizeString(input.language, 32);
    const modelKey = await this.resolveVoiceCloneModelKey(input.model);
    if (!modelKey) {
      throw new BadRequestException('voice clone model is required');
    }

    const sample = await this.persistSample(app.slug, app.id, input.userId || null, input);
    const cloneTraceId = this.generateVoiceCloneTraceId();
    const providerVoiceId = this.generateProviderVoiceId(cloneTraceId);
    const route = await this.resolveVoiceCloneRoute(app.slug, modelKey);
    this.logger.log(`Voice clone request started: app=${app.slug}, user=${input.userId || 'anon'}, model=${modelKey}, traceId=${cloneTraceId}, provider=${route.source.provider_type}, sourceId=${route.source.id}`);

    let publicVoiceId: string | null = null;
    let voiceAssetId: string | null = null;
    try {
      const cloneResult = await this.invokeVoiceCloneProvider(route, {
        traceId: cloneTraceId,
        providerVoiceId,
        displayName,
        language: language || undefined,
        sampleFileRef: sample.file_key || sample.file_url,
      });
      publicVoiceId = this.generatePublicVoiceId();
      const rows = await (this.prisma.$queryRawUnsafe(
        `INSERT INTO ai_voice_assets (
           app_id, user_id, public_voice_id, display_name, language, status,
           sample_file_key, sample_file_url, sample_mime_type, sample_size_bytes, sample_sha256, sample_duration_ms,
           metadata_json, created_at, updated_at
         )
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'creating', $6, $7, $8, $9, $10, $11, $12::jsonb, now(), now())
         RETURNING id`,
        app.id,
        input.userId || null,
        publicVoiceId,
        displayName,
        language || null,
        sample.file_key,
        sample.file_url,
        sample.mime_type || null,
        sample.size_bytes || null,
        sample.sha256 || null,
        cloneResult.sampleDurationMs ?? sample.sample_duration_ms,
        JSON.stringify(this.normalizeObject(input.metadata)),
      ) as Promise<Array<{ id: string }>>);
      voiceAssetId = rows[0]?.id || null;
      if (!voiceAssetId) {
        throw new BadGatewayException('failed to create voice asset');
      }
      if (cloneResult.sampleDurationMs != null) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE ai_voice_assets SET sample_duration_ms = $1::int, updated_at = now() WHERE id = $2::uuid`,
          cloneResult.sampleDurationMs,
          voiceAssetId,
        );
      }
      const mapping = await this.createReadyMapping(voiceAssetId, route, cloneResult.providerVoiceId, cloneResult.request, cloneResult.response, {
        globalModelId: cloneResult.targetGlobalModelId || null,
      });
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_voice_assets
         SET status = 'ready', active_mapping_id = $1::uuid, updated_at = now()
         WHERE id = $2::uuid`,
        mapping.id,
        voiceAssetId,
      );
      this.invalidateVoiceCache(publicVoiceId);
      this.logger.log(`Voice clone request succeeded: app=${app.slug}, publicVoiceId=${publicVoiceId}, route=${route.source.provider_type}`);
      return this.getVoiceByPublicId(app.slug, publicVoiceId, input.userId || null);
    } catch (error: any) {
      const message = this.truncate(String(error?.message || error || 'voice clone failed'), 1600);
      this.logger.error(
        `Voice clone request failed: app=${app.slug}, traceId=${cloneTraceId}, publicVoiceId=${publicVoiceId || 'not_issued'}, user=${input.userId || 'anon'}, provider=${route.source.provider_type}, model=${modelKey}, error=${message}`,
        error?.stack,
      );
      if (voiceAssetId) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE ai_voice_assets SET status = 'failed', updated_at = now() WHERE id = $1::uuid`,
          voiceAssetId,
        );
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO ai_voice_provider_mappings (
             voice_asset_id, provider_type, source_id, global_model_id, provider_voice_id,
             status, provider_request_json, provider_response_json, error_message, created_at, updated_at
           )
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, 'failed', '{}'::jsonb, '{}'::jsonb, $6, now(), now())`,
          voiceAssetId,
          route.source.provider_type,
          route.source.id,
          route.model_id,
          providerVoiceId,
          message,
        );
      }
      throw error;
    }
  }

  async listVoices(appSlug: string, userId: string | null | undefined, query: Record<string, unknown> = {}) {
    await this.ensureSchema();
    const app = await this.resolveApp(appSlug);
    const page = this.boundInt(query.page, 1, 1, 100000);
    const pageSize = this.boundInt(query.page_size ?? query.pageSize, 20, 1, 100);
    const requestedStatus = this.normalizeString(query.status, 32);
    const status = ['all', 'any', '*'].includes(requestedStatus) ? '' : (requestedStatus || 'ready');
    const usableOnly = !requestedStatus || requestedStatus === 'ready';
    const includeDeleted = query.include_deleted === true || query.include_deleted === 'true';
    const offset = (page - 1) * pageSize;
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         v.*,
         m.id AS mapping_id,
         m.provider_type AS mapping_provider_type,
         m.source_id AS mapping_source_id,
         m.global_model_id AS mapping_global_model_id,
         gm.api_type AS mapping_global_model_api_type,
         m.provider_voice_id AS mapping_provider_voice_id,
         m.status AS mapping_status,
         m.error_message AS mapping_error_message
       FROM ai_voice_assets v
       LEFT JOIN ai_voice_provider_mappings m ON m.id = v.active_mapping_id
       LEFT JOIN ai_global_models gm ON gm.id = m.global_model_id
       WHERE v.app_id = $1::uuid
         AND ($2::uuid IS NULL OR v.user_id = $2::uuid OR v.user_id IS NULL)
         AND ($3 = '' OR v.status = $3)
         AND ($4::boolean = true OR v.deleted_at IS NULL)
         AND ($5::boolean = false OR (m.status = 'ready' AND m.provider_voice_id IS NOT NULL))
       ORDER BY v.created_at DESC
       LIMIT $6 OFFSET $7`,
      app.id,
      userId || null,
      status || '',
      includeDeleted,
      usableOnly,
      pageSize,
      offset,
    ) as Promise<VoiceAssetWithMappingRow[]>);
    return {
      items: rows.map((row) => this.serializeVoice(row, false)),
      page,
      page_size: pageSize,
      has_more: rows.length === pageSize,
    };
  }

  async getVoiceByPublicId(appSlug: string, publicVoiceId: string, userId?: string | null) {
    await this.ensureSchema();
    const app = await this.resolveApp(appSlug);
    const row = await this.findUserOwnedVoiceRow(app.id, publicVoiceId, userId || null);
    if (!row) {
      throw new NotFoundException('voice not found');
    }
    return this.serializeVoice(row, false);
  }

  async deleteVoice(appSlug: string, publicVoiceId: string, userId?: string | null) {
    await this.ensureSchema();
    const app = await this.resolveApp(appSlug);
    const row = await this.findVoiceRow(app.id, publicVoiceId, userId || null);
    if (!row) {
      throw new NotFoundException('voice not found');
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_voice_assets
       SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()), updated_at = now()
       WHERE id = $1::uuid`,
      row.id,
    );
    this.invalidateVoiceCache(publicVoiceId);
    return { voice_id: publicVoiceId, deleted: true };
  }

  async resolveVoiceForTts(appSlug: string, payload: Record<string, unknown>, userId?: string | null): Promise<ResolvedPlatformVoice | null> {
    const publicVoiceId = this.extractPublicVoiceId(payload);
    if (!publicVoiceId) {
      return null;
    }
    await this.ensureSchema();
    const app = await this.resolveApp(appSlug);
    const cacheKey = `${app.id}:${userId || ''}:${publicVoiceId}`;
    const cached = this.voiceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const row = await this.findVoiceRow(app.id, publicVoiceId, userId || null);
    if (!row) {
      this.logger.warn(`TTS voice resolution failed: app=${appSlug}, user=${userId || 'anon'}, voice=${publicVoiceId}, reason=not_found`);
      throw new NotFoundException(`voice not found: ${publicVoiceId}`);
    }
    if (row.deleted_at || row.status !== 'ready') {
      this.logger.warn(`TTS voice resolution failed: app=${appSlug}, user=${userId || 'anon'}, voice=${publicVoiceId}, reason=asset_not_ready, status=${row.status || 'unknown'}, deleted=${row.deleted_at ? 'true' : 'false'}, mappingStatus=${row.mapping_status || 'none'}`);
      throw new BadRequestException(`voice is not ready: ${publicVoiceId}`);
    }
    if (!row.mapping_id || !row.mapping_provider_voice_id || row.mapping_status !== 'ready') {
      this.logger.warn(`TTS voice resolution failed: app=${appSlug}, user=${userId || 'anon'}, voice=${publicVoiceId}, reason=mapping_not_ready, status=${row.status || 'unknown'}, mappingId=${row.mapping_id || 'none'}, mappingStatus=${row.mapping_status || 'none'}`);
      throw new BadRequestException(`voice provider mapping is not ready: ${publicVoiceId}`);
    }

    const resolved: ResolvedPlatformVoice = {
      public_voice_id: row.public_voice_id,
      provider_voice_id: row.mapping_provider_voice_id,
      provider_type: row.mapping_provider_type || '',
      source_id: row.mapping_source_id || '',
      global_model_id: row.mapping_global_model_id || null,
      global_model_is_voice_clone: this.isVoiceCloneApiType(row.mapping_global_model_api_type),
    };
    this.voiceCache.set(cacheKey, { value: resolved, expiresAt: Date.now() + 60_000 });
    return resolved;
  }

  applyResolvedVoiceToPayload(payload: Record<string, unknown>, voice: ResolvedPlatformVoice): Record<string, unknown> {
    const next = { ...payload };
    next.voice = voice.provider_voice_id;
    next.voice_id = voice.provider_voice_id;
    const voiceSetting = this.normalizeObject(next.voice_setting);
    next.voice_setting = {
      ...voiceSetting,
      voice_id: voice.provider_voice_id,
    };
    return next;
  }

  filterRoutesForVoice(routes: ResolvedAiRoute[], voice: ResolvedPlatformVoice): ResolvedAiRoute[] {
    const sameSourceRoutes = this.filterSpeechRoutes(routes).filter((route) => route.source.id === voice.source_id);
    if (sameSourceRoutes.length === 0) {
      throw new BadRequestException('selected voice is not available for the requested TTS provider');
    }
    if (voice.global_model_id && !voice.global_model_is_voice_clone) {
      const sameModelRoutes = sameSourceRoutes.filter((route) => route.model_id === voice.global_model_id);
      if (sameModelRoutes.length > 0) {
        return sameModelRoutes;
      }
      throw new BadRequestException('selected voice is not available for the requested TTS model');
    }
    return sameSourceRoutes;
  }

  filterSpeechRoutes(routes: ResolvedAiRoute[]): ResolvedAiRoute[] {
    const filtered = routes.filter((route) => !this.isVoiceCloneRoute(route));
    if (filtered.length > 0) {
      return filtered;
    }
    throw new BadRequestException('selected model is not configured for TTS speech');
  }

  async listAdminVoices(query: Record<string, unknown> = {}) {
    await this.ensureSchema();
    const page = this.boundInt(query.page, 1, 1, 100000);
    const pageSize = this.boundInt(query.page_size ?? query.pageSize, 20, 1, 100);
    const appId = this.normalizeString(query.app_id, 64);
    const userId = this.normalizeString(query.user_id, 64);
    const status = this.normalizeString(query.status, 32);
    const provider = this.normalizeString(query.provider_type, 64);
    const offset = (page - 1) * pageSize;
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         v.*,
         m.id AS mapping_id,
         m.provider_type AS mapping_provider_type,
         m.source_id AS mapping_source_id,
         m.global_model_id AS mapping_global_model_id,
         gm.api_type AS mapping_global_model_api_type,
         m.provider_voice_id AS mapping_provider_voice_id,
         m.status AS mapping_status,
         m.error_message AS mapping_error_message
       FROM ai_voice_assets v
       LEFT JOIN ai_voice_provider_mappings m ON m.id = v.active_mapping_id
       LEFT JOIN ai_global_models gm ON gm.id = m.global_model_id
       WHERE ($1::uuid IS NULL OR v.app_id = $1::uuid)
         AND ($2::uuid IS NULL OR v.user_id = $2::uuid)
         AND ($3 = '' OR v.status = $3)
         AND ($4 = '' OR m.provider_type = $4)
       ORDER BY v.created_at DESC
       LIMIT $5 OFFSET $6`,
      appId || null,
      userId || null,
      status || '',
      provider || '',
      pageSize,
      offset,
    ) as Promise<VoiceAssetWithMappingRow[]>);
    return {
      items: rows.map((row) => this.serializeVoice(row, true)),
      page,
      page_size: pageSize,
      has_more: rows.length === pageSize,
    };
  }

  async createMigrationJob(userId: string | null | undefined, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const toSourceId = this.normalizeString(payload.to_source_id ?? payload.source_id, 64);
    if (!toSourceId) {
      throw new BadRequestException('to_source_id is required');
    }
    const toModelId = this.normalizeString(payload.to_global_model_id ?? payload.global_model_id ?? payload.model_id, 64);
    const filter = this.normalizeObject(payload.filter);
    const fromProviderType = this.normalizeString(payload.from_provider_type ?? filter.from_provider_type, 64);
    const appId = this.normalizeString(payload.app_id ?? filter.app_id, 64);

    const jobRows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO ai_voice_migration_jobs (
         status, from_provider_type, to_source_id, to_global_model_id, filter_json,
         created_by_user_id, created_at, updated_at
       )
       VALUES ('pending', $1, $2::uuid, $3::uuid, $4::jsonb, $5::uuid, now(), now())
       RETURNING id`,
      fromProviderType || null,
      toSourceId,
      toModelId || null,
      JSON.stringify(filter),
      userId || null,
    ) as Promise<Array<{ id: string }>>);
    const jobId = jobRows[0]?.id;
    if (!jobId) {
      throw new BadGatewayException('failed to create migration job');
    }

    const inserted = await this.prisma.$executeRawUnsafe(
      `INSERT INTO ai_voice_migration_items (job_id, voice_asset_id, old_mapping_id, status, created_at, updated_at)
       SELECT $1::uuid, v.id, v.active_mapping_id, 'pending', now(), now()
       FROM ai_voice_assets v
       LEFT JOIN ai_voice_provider_mappings m ON m.id = v.active_mapping_id
       WHERE v.deleted_at IS NULL
         AND v.status = 'ready'
         AND ($2::uuid IS NULL OR v.app_id = $2::uuid)
         AND ($3 = '' OR m.provider_type = $3)
       ON CONFLICT (job_id, voice_asset_id) DO NOTHING`,
      jobId,
      appId || null,
      fromProviderType || '',
    );
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_voice_migration_jobs SET total_count = $1, updated_at = now() WHERE id = $2::uuid`,
      Number(inserted || 0),
      jobId,
    );
    return this.getMigrationJob(jobId);
  }

  async getMigrationJob(jobId: string) {
    await this.ensureSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM ai_voice_migration_jobs WHERE id = $1::uuid LIMIT 1`,
      jobId,
    ) as Promise<any[]>);
    if (!rows[0]) {
      throw new NotFoundException('migration job not found');
    }
    const itemRows = await (this.prisma.$queryRawUnsafe(
      `SELECT status, COUNT(*)::int AS count
       FROM ai_voice_migration_items
       WHERE job_id = $1::uuid
       GROUP BY status`,
      jobId,
    ) as Promise<any[]>);
    return {
      ...this.serializeJsonRow(rows[0]),
      item_counts: itemRows.reduce((acc, row) => ({ ...acc, [row.status]: Number(row.count || 0) }), {}),
    };
  }

  async activateMapping(publicVoiceId: string, mappingId: string) {
    await this.ensureSchema();
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT m.voice_asset_id, v.public_voice_id
       FROM ai_voice_provider_mappings m
       JOIN ai_voice_assets v ON v.id = m.voice_asset_id
       WHERE m.id = $1::uuid AND v.public_voice_id = $2 AND m.status = 'ready'
       LIMIT 1`,
      mappingId,
      publicVoiceId,
    ) as Promise<Array<{ voice_asset_id: string; public_voice_id: string }>>);
    if (!rows[0]) {
      throw new NotFoundException('ready voice mapping not found');
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_voice_assets
       SET active_mapping_id = $1::uuid, status = 'ready', updated_at = now()
       WHERE id = $2::uuid`,
      mappingId,
      rows[0].voice_asset_id,
    );
    this.invalidateVoiceCache(publicVoiceId);
    return { voice_id: publicVoiceId, active_mapping_id: mappingId };
  }

  async migrateVoice(publicVoiceId: string, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const toSourceId = this.normalizeString(payload.to_source_id ?? payload.source_id, 64);
    const toModelId = this.normalizeString(payload.to_global_model_id ?? payload.global_model_id ?? payload.model_id, 64);
    if (!toSourceId || !toModelId) {
      throw new BadRequestException('to_source_id and to_global_model_id are required');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT v.*, a.slug AS app_slug
       FROM ai_voice_assets v
       JOIN apps a ON a.id = v.app_id
       WHERE v.public_voice_id = $1 AND v.deleted_at IS NULL
       LIMIT 1`,
      publicVoiceId,
    ) as Promise<any[]>);
    const voice = rows[0];
    if (!voice) {
      throw new NotFoundException('voice not found');
    }
    const route = await this.resolveRouteByModelAndSource(String(voice.app_slug || ''), toModelId, toSourceId);
    const providerVoiceId = this.generateProviderVoiceId(publicVoiceId);
    const cloneResult = await this.invokeVoiceCloneProvider(route, {
      publicVoiceId,
      providerVoiceId,
      displayName: voice.display_name,
      language: voice.language || undefined,
      sampleFileRef: voice.sample_file_key || voice.sample_file_url,
    });
    const mapping = await this.createReadyMapping(voice.id, route, cloneResult.providerVoiceId, cloneResult.request, cloneResult.response, {
      globalModelId: cloneResult.targetGlobalModelId || null,
    });
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_voice_assets SET active_mapping_id = $1::uuid, status = 'ready', updated_at = now() WHERE id = $2::uuid`,
      mapping.id,
      voice.id,
    );
    this.invalidateVoiceCache(publicVoiceId);
    return { voice_id: publicVoiceId, active_mapping_id: mapping.id };
  }

  async retryClone(publicVoiceId: string, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const modelKey = await this.resolveVoiceCloneModelKey(payload.model);
    if (!modelKey) {
      throw new BadRequestException('voice clone model is required');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT v.*, a.slug AS app_slug
       FROM ai_voice_assets v
       JOIN apps a ON a.id = v.app_id
       WHERE v.public_voice_id = $1 AND v.deleted_at IS NULL
       LIMIT 1`,
      publicVoiceId,
    ) as Promise<any[]>);
    const voice = rows[0];
    if (!voice) {
      throw new NotFoundException('voice not found');
    }
    const route = await this.resolveVoiceCloneRoute(String(voice.app_slug || ''), modelKey);
    const providerVoiceId = this.generateProviderVoiceId(publicVoiceId);
    const cloneResult = await this.invokeVoiceCloneProvider(route, {
      publicVoiceId,
      providerVoiceId,
      displayName: voice.display_name,
      language: voice.language || undefined,
      sampleFileRef: voice.sample_file_key || voice.sample_file_url,
    });
    const mapping = await this.createReadyMapping(voice.id, route, cloneResult.providerVoiceId, cloneResult.request, cloneResult.response, {
      globalModelId: cloneResult.targetGlobalModelId || null,
    });
    await this.prisma.$executeRawUnsafe(
      `UPDATE ai_voice_assets SET active_mapping_id = $1::uuid, status = 'ready', updated_at = now() WHERE id = $2::uuid`,
      mapping.id,
      voice.id,
    );
    this.invalidateVoiceCache(publicVoiceId);
    return { voice_id: publicVoiceId, active_mapping_id: mapping.id };
  }

  private async resolveVoiceCloneModelKey(inputModel: unknown) {
    const requested = this.normalizeString(inputModel, 255);
    if (requested) {
      return requested;
    }
    const tuning = await this.runtimeSettingsService.getAiGatewayTuning().catch(() => ({} as Record<string, unknown>));
    const configured = this.normalizeString(tuning.voice_clone_model_key, 255);
    if (configured) {
      return configured;
    }
    return this.normalizeString(process.env.AI_VOICE_CLONE_MODEL_KEY, 255);
  }

  @Interval(15000)
  async processMigrationJobs() {
    if (this.migrationWorkerBusy) {
      return;
    }
    this.migrationWorkerBusy = true;
    try {
      const jobRows = await (this.prisma.$queryRawUnsafe(
        `SELECT * FROM ai_voice_migration_jobs
         WHERE status IN ('pending', 'running')
         ORDER BY created_at ASC
         LIMIT 1`,
      ) as Promise<any[]>);
      const job = jobRows[0];
      if (!job) {
        return;
      }
      if (job.status === 'pending') {
        await this.prisma.$executeRawUnsafe(
          `UPDATE ai_voice_migration_jobs SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1::uuid`,
          job.id,
        );
      }
      await this.processMigrationJobItems(job);
    } catch (error: any) {
      this.logger.warn(`voice migration worker failed: ${error?.message || error}`);
    } finally {
      this.migrationWorkerBusy = false;
    }
  }

  private async processMigrationJobItems(job: any) {
    const items = await (this.prisma.$queryRawUnsafe(
      `SELECT i.*, v.public_voice_id, v.display_name, v.language, v.sample_file_key, v.sample_file_url, a.slug AS app_slug
       FROM ai_voice_migration_items i
       JOIN ai_voice_assets v ON v.id = i.voice_asset_id
       JOIN apps a ON a.id = v.app_id
       WHERE i.job_id = $1::uuid AND i.status = 'pending'
       ORDER BY i.created_at ASC
       LIMIT 3`,
      job.id,
    ) as Promise<any[]>);
    if (items.length === 0) {
      const counts = await (this.prisma.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
           COUNT(*) FILTER (WHERE status = 'succeeded')::int AS success_count
         FROM ai_voice_migration_items
         WHERE job_id = $1::uuid`,
        job.id,
      ) as Promise<Array<{ failed_count: number; success_count: number }>>);
      const failedCount = Number(counts[0]?.failed_count || 0);
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_voice_migration_jobs
         SET status = $1, success_count = $2, failed_count = $3, finished_at = now(), updated_at = now()
         WHERE id = $4::uuid`,
        failedCount > 0 ? 'completed_with_errors' : 'completed',
        Number(counts[0]?.success_count || 0),
        failedCount,
        job.id,
      );
      return;
    }

    for (const item of items) {
      const claimed = await this.prisma.$executeRawUnsafe(
        `UPDATE ai_voice_migration_items
         SET status = 'running', updated_at = now()
         WHERE id = $1::uuid AND status = 'pending'`,
        item.id,
      );
      if (Number(claimed || 0) === 0) {
        continue;
      }
      try {
        const route = await this.resolveRouteByModelAndSource(String(item.app_slug || ''), job.to_global_model_id, job.to_source_id);
        const providerVoiceId = this.generateProviderVoiceId(item.public_voice_id);
        const cloneResult = await this.invokeVoiceCloneProvider(route, {
          publicVoiceId: item.public_voice_id,
          providerVoiceId,
          displayName: item.display_name,
          language: item.language || undefined,
          sampleFileRef: item.sample_file_key || item.sample_file_url,
        });
        const mapping = await this.createReadyMapping(item.voice_asset_id, route, cloneResult.providerVoiceId, cloneResult.request, cloneResult.response, {
          globalModelId: cloneResult.targetGlobalModelId || null,
        });
        await this.prisma.$executeRawUnsafe(
          `UPDATE ai_voice_assets SET active_mapping_id = $1::uuid, status = 'ready', updated_at = now() WHERE id = $2::uuid`,
          mapping.id,
          item.voice_asset_id,
        );
        await this.prisma.$executeRawUnsafe(
          `UPDATE ai_voice_migration_items SET status = 'succeeded', new_mapping_id = $1::uuid, updated_at = now() WHERE id = $2::uuid`,
          mapping.id,
          item.id,
        );
        this.invalidateVoiceCache(item.public_voice_id);
      } catch (error: any) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE ai_voice_migration_items SET status = 'failed', error_message = $1, updated_at = now() WHERE id = $2::uuid`,
          this.truncate(String(error?.message || error), 1600),
          item.id,
        );
      }
    }
  }

  private async persistSample(appSlug: string, appId: string, userId: string | null, input: CloneVoiceInput) {
    if (input.file) {
      this.assertAllowedAudio(input.file);
      const uploaded = await this.uploadService.uploadBuffer(
        userId || 'anonymous',
        input.file.originalname || `voice-sample-${Date.now()}.wav`,
        input.file.mimetype || 'application/octet-stream',
        input.file.buffer,
        appSlug,
        'ai/voice-samples',
        appId,
      );
      return {
        file_key: uploaded.file_key,
        file_url: uploaded.file_url,
        mime_type: input.file.mimetype || 'application/octet-stream',
        size_bytes: input.file.size || input.file.buffer?.length || null,
        sha256: this.sha256(input.file.buffer),
        sample_duration_ms: null,
      };
    }

    const fileUrl = this.normalizeString(input.sample_file_url, 2048);
    const fileKey = this.normalizeString(input.sample_file_key, 1024) || this.uploadService.getManagedFileKey(fileUrl) || '';
    if (!fileKey) {
      throw new BadRequestException('sample audio file is required');
    }
    if (fileUrl && !this.uploadService.isManagedFileReference(fileUrl)) {
      throw new BadRequestException('sample_file_url must reference a managed OSS object');
    }
    if (!this.isAllowedVoiceSampleKey(fileKey)) {
      throw new BadRequestException('sample_file_key must reference a managed voice sample object');
    }
    return {
      file_key: fileKey,
      file_url: fileUrl || fileKey,
      mime_type: null,
      size_bytes: null,
      sha256: null,
      sample_duration_ms: null,
    };
  }

  private async invokeVoiceCloneProvider(
    route: ResolvedAiRoute,
    input: {
      publicVoiceId?: string;
      traceId?: string;
      providerVoiceId: string;
      displayName: string;
      language?: string;
      sampleFileRef: string;
    },
  ): Promise<VoiceCloneProviderResult> {
    const sampleUrl = await this.uploadService.resolveReadableUrl(input.sampleFileRef, 30 * 60);
    if (!sampleUrl) {
      throw new BadRequestException('sample audio file is not readable');
    }
    if (this.isDashscopeCosyVoiceRoute(route)) {
      return this.invokeDashscopeCosyVoiceCloneProvider(route, input, sampleUrl);
    }
    if (this.isMinimaxRoute(route)) {
      return this.invokeMinimaxVoiceCloneProvider(route, input, sampleUrl);
    }
    const overrides = this.normalizeObject(route.request_overrides);
    const cloneOverrides = {
      ...this.normalizeObject(overrides.clone_request),
      ...this.normalizeObject(overrides.voice_clone_request),
    };
    const requestBody: Record<string, unknown> = {
      ...cloneOverrides,
      model: route.upstream_model,
      voice_id: input.providerVoiceId,
      voice_name: input.displayName,
      audio_url: sampleUrl,
      file_url: sampleUrl,
      language: input.language,
      metadata: {
        ...this.normalizeObject(cloneOverrides.metadata),
        ...(input.publicVoiceId ? { public_voice_id: input.publicVoiceId } : {}),
        ...(input.traceId ? { voice_clone_trace_id: input.traceId } : {}),
      },
    };
    Object.keys(requestBody).forEach((key) => requestBody[key] === undefined && delete requestBody[key]);

    const endpointUrl = this.joinUrl(route.source.base_url, route.endpoint_path);
    const traceLabel = input.publicVoiceId || input.traceId || input.providerVoiceId;
    this.logger.log(`Voice clone upstream request: provider=${route.source.provider_type}, sourceId=${route.source.id}, endpoint=${endpointUrl}, model=${route.upstream_model}, voice=${traceLabel}`);
    const response = await this.aiUpstreamClient.fetch(route, endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
      body: JSON.stringify(requestBody),
    }, { timeoutMs: this.boundInt(overrides.voice_clone_timeout_ms, 120000, 5000, 600000) });

    const rawText = await this.aiUpstreamClient.readText(response, 4 * 1024 * 1024);
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = { raw: rawText };
    }
    if (!response.ok) {
      this.logger.error(`Voice clone upstream failed: provider=${route.source.provider_type}, endpoint=${endpointUrl}, status=${response.status}, statusText=${response.statusText}, voice=${traceLabel}, raw=${this.truncate(rawText, 900)}`);
      throw new BadGatewayException(`voice clone upstream failed (${response.status}): ${this.truncate(rawText, 900)}`);
    }
    const providerVoiceId = this.extractProviderVoiceId(data) || input.providerVoiceId;
    return { providerVoiceId, request: requestBody, response: data };
  }

  private async invokeDashscopeCosyVoiceCloneProvider(
    route: ResolvedAiRoute,
    input: {
      publicVoiceId?: string;
      traceId?: string;
      providerVoiceId: string;
      displayName: string;
      language?: string;
      sampleFileRef: string;
    },
    sampleUrl: string,
  ): Promise<VoiceCloneProviderResult> {
    const overrides = this.normalizeObject(route.request_overrides);
    const audioOverrides = this.normalizeObject(overrides.audio);
    const cloneOverrides = {
      ...this.normalizeObject(overrides.clone_request),
      ...this.normalizeObject(overrides.voice_clone_request),
    };
    const linkedTtsModel = await this.resolveLinkedTtsModelForCloneRoute(route);
    const targetModel =
      this.normalizeString(audioOverrides.target_model, 128) ||
      this.normalizeString(overrides.target_model, 128) ||
      linkedTtsModel.upstream_model;
    if (!targetModel) {
      throw new BadRequestException('DashScope CosyVoice voice clone requires target_model');
    }
    if (targetModel !== linkedTtsModel.upstream_model) {
      throw new BadRequestException('DashScope CosyVoice target_model must match the linked TTS model');
    }
    this.assertDashscopeCosyVoiceTargetModelSupported(targetModel);
    const languageHints = this.normalizeDashscopeLanguageHints(
      cloneOverrides.language_hints ?? audioOverrides.language_hints ?? input.language,
      'DashScope CosyVoice voice clone language_hints',
    );
    const requestBody: Record<string, unknown> = {
      ...cloneOverrides,
      model: route.upstream_model || 'voice-enrollment',
      input: {
        ...this.normalizeObject(cloneOverrides.input),
        action: 'create_voice',
        target_model: targetModel,
        prefix: this.resolveDashscopeVoicePrefix(input.providerVoiceId),
        url: sampleUrl,
        ...(languageHints.length > 0 ? { language_hints: languageHints } : {}),
      },
    };
    const endpointUrl = this.resolveDashscopeCosyVoiceCloneEndpoint(route);
    const traceLabel = input.publicVoiceId || input.traceId || input.providerVoiceId;
    this.logger.log(`DashScope CosyVoice voice clone upstream request: sourceId=${route.source.id}, endpoint=${endpointUrl}, targetModel=${targetModel}, voice=${traceLabel}`);
    const response = await this.aiUpstreamClient.fetch(route, endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
      body: JSON.stringify(requestBody),
    }, { timeoutMs: this.boundInt(overrides.voice_clone_timeout_ms, 120000, 5000, 600000) });
    const data = await this.readJsonResponse(response, 'DashScope CosyVoice voice clone', 4 * 1024 * 1024);
    const providerVoiceId = this.extractProviderVoiceId(data);
    if (!providerVoiceId) {
      throw new BadGatewayException('DashScope CosyVoice voice clone did not return voice_id');
    }
    return {
      providerVoiceId,
      request: {
        ...requestBody,
        ...(input.publicVoiceId ? { public_voice_id: input.publicVoiceId } : {}),
        ...(input.traceId ? { voice_clone_trace_id: input.traceId } : {}),
      },
      response: data,
      targetGlobalModelId: linkedTtsModel.id,
    };
  }

  private async invokeMinimaxVoiceCloneProvider(
    route: ResolvedAiRoute,
    input: {
      publicVoiceId?: string;
      traceId?: string;
      providerVoiceId: string;
      displayName: string;
      language?: string;
      sampleFileRef: string;
    },
    sampleUrl: string,
  ): Promise<VoiceCloneProviderResult> {
    const overrides = this.normalizeObject(route.request_overrides);
    const cloneOverrides = {
      ...this.normalizeObject(overrides.clone_request),
      ...this.normalizeObject(overrides.voice_clone_request),
    };
    const timeoutMs = this.boundInt(overrides.voice_clone_timeout_ms, 120000, 5000, 600000);
    const sample = await this.downloadVoiceSample(sampleUrl, timeoutMs);
    const uploadResponse = await this.uploadMinimaxVoiceCloneFile(route, sample, timeoutMs);
    const fileId = this.extractMinimaxFileId(uploadResponse);
    if (!fileId) {
      throw new BadGatewayException('MiniMax voice clone upload did not return file_id');
    }

    if (sample.durationMs == null) {
      this.logger.warn(`MiniMax voice clone duration check skipped: cannot detect duration. voice=${input.publicVoiceId || input.traceId || input.providerVoiceId}`);
    } else if (sample.durationMs < this.minimaxVoiceCloneMinDurationMs) {
      this.logger.warn(`MiniMax voice clone rejected: duration too short (${sample.durationMs}ms). voice=${input.publicVoiceId || input.traceId || input.providerVoiceId}`);
      throw new BadRequestException('MiniMax voice clone sample must be at least 10 seconds');
    } else if (sample.durationMs > this.minimaxVoiceCloneMaxDurationMs) {
      this.logger.warn(`MiniMax voice clone rejected: duration too long (${sample.durationMs}ms). voice=${input.publicVoiceId || input.traceId || input.providerVoiceId}`);
      throw new BadRequestException('MiniMax voice clone sample must not exceed 5 minutes');
    }

    const requestBody: Record<string, unknown> = {
      ...cloneOverrides,
      file_id: fileId,
      voice_id: input.providerVoiceId,
    };
    delete requestBody.audio_url;
    delete requestBody.file_url;
    delete requestBody.voice_name;
    delete requestBody.metadata;
    Object.keys(requestBody).forEach((key) => requestBody[key] === undefined && delete requestBody[key]);

    const endpointUrl = this.resolveMinimaxVoiceCloneEndpoint(route);
    const response = await this.aiUpstreamClient.fetch(route, endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
      body: JSON.stringify(requestBody),
    }, { timeoutMs });

    const data = await this.readJsonResponse(response, 'MiniMax voice clone', 4 * 1024 * 1024);
    this.logger.log(`MiniMax voice clone upstream response: status=${response.status}, voice=${input.publicVoiceId || input.traceId || input.providerVoiceId}`);
    this.assertMinimaxBaseRespOk(data, 'MiniMax voice clone');
    const providerVoiceId = this.extractProviderVoiceId(data) || input.providerVoiceId;
    return {
      providerVoiceId,
      request: {
        ...requestBody,
        upload_file_id: fileId,
        ...(input.publicVoiceId ? { public_voice_id: input.publicVoiceId } : {}),
        ...(input.traceId ? { voice_clone_trace_id: input.traceId } : {}),
      },
      response: {
        upload: uploadResponse,
        clone: data,
      },
      sampleDurationMs: sample.durationMs,
    };
  }

  private async uploadMinimaxVoiceCloneFile(
    route: ResolvedAiRoute,
    sample: { buffer: Buffer; mimeType: string; fileName: string; durationMs: number | null },
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const form = new FormData();
    const sampleBytes = new Uint8Array(sample.buffer.length);
    sampleBytes.set(sample.buffer);
    form.append('purpose', 'voice_clone');
    form.append('file', new Blob([sampleBytes], { type: sample.mimeType }), sample.fileName);
    const response = await this.aiUpstreamClient.fetch(route, this.resolveMinimaxFileUploadEndpoint(route), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${route.source.api_key}`,
        ...route.source.custom_headers,
      },
      body: form,
    }, { timeoutMs });
    const data = await this.readJsonResponse(response, 'MiniMax voice clone upload', 4 * 1024 * 1024);
    this.assertMinimaxBaseRespOk(data, 'MiniMax voice clone upload');
    return data;
  }

  private async downloadVoiceSample(sampleUrl: string, timeoutMs: number): Promise<{ buffer: Buffer; mimeType: string; fileName: string; durationMs: number | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(sampleUrl, { method: 'GET', signal: controller.signal });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new BadGatewayException('sample audio download timed out');
      }
      throw new BadGatewayException(`sample audio download failed: ${this.truncate(String(error?.message || error), 300)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new BadGatewayException(`sample audio download failed (${response.status})`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > 20 * 1024 * 1024) {
      throw new BadRequestException('MiniMax voice clone sample must not exceed 20 MB');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
      throw new BadRequestException('sample audio file is empty');
    }
    if (buffer.length > 20 * 1024 * 1024) {
      throw new BadRequestException('MiniMax voice clone sample must not exceed 20 MB');
    }
    const mimeType = (response.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim() || 'audio/mpeg';
    const durationMs = this.extractAudioDurationMs(buffer, sampleUrl);
    return {
      buffer,
      mimeType,
      fileName: this.fileNameForMimeType(mimeType),
      durationMs,
    };
  }

  private parseWavDurationMs(buffer: Buffer): number | null {
    if (buffer.length < 44) {
      return null;
    }
    const riff = buffer.toString('ascii', 0, 4);
    const wave = buffer.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      return null;
    }

    let offset = 12;
    let fmt: {
      audioFormat?: number;
      channels?: number;
      sampleRate?: number;
      byteRate?: number;
      blockAlign?: number;
      bitsPerSample?: number;
    } | null = null;
    let dataSize: number | null = null;

    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      const chunkEnd = chunkStart + chunkSize;
      if (chunkEnd > buffer.length) {
        break;
      }

      if (chunkId === 'fmt ') {
        if (chunkSize < 16) {
          break;
        }
        const audioFormat = buffer.readUInt16LE(chunkStart);
        const channels = buffer.readUInt16LE(chunkStart + 2);
        const sampleRate = buffer.readUInt32LE(chunkStart + 4);
        const byteRate = buffer.readUInt32LE(chunkStart + 8);
        const blockAlign = buffer.readUInt16LE(chunkStart + 12);
        const bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
        fmt = { audioFormat, channels, sampleRate, byteRate, blockAlign, bitsPerSample };
      } else if (chunkId === 'data' && chunkSize > 0) {
        dataSize = chunkSize;
        if (fmt?.byteRate && fmt.byteRate > 0) {
          break;
        }
      }

      offset = chunkEnd + (chunkSize % 2);
    }

    if (!fmt || dataSize === null || dataSize <= 0) {
      return null;
    }

    let durationMs: number | null = null;
    const byteRate = fmt.byteRate || 0;
    const sampleRate = fmt.sampleRate || 0;
    const channels = fmt.channels || 0;
    const bitsPerSample = fmt.bitsPerSample || 0;
    if (byteRate > 0) {
      durationMs = Math.round((dataSize / byteRate) * 1000);
    } else if (channels > 0 && bitsPerSample > 0 && sampleRate > 0) {
      durationMs = Math.round((dataSize / (sampleRate * channels * (bitsPerSample / 8))) * 1000);
    }

    return Number.isFinite(durationMs) ? durationMs : null;
  }

  private extractAudioDurationMs(buffer: Buffer, context: string): number | null {
    const wavProbe = this.parseWavDurationMs(buffer);
    if (wavProbe !== null) {
      return wavProbe;
    }

    if (!this.ffprobeAvailable) {
      if (!this.ffprobeUnavailableWarned) {
        this.ffprobeUnavailableWarned = true;
        this.logger.warn(`MiniMax voice clone duration check skipped because ffprobe is unavailable in runtime: context=${context}`);
      }
      return null;
    }

    try {
      const result = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_entries',
          'format=duration',
          '-show_streams',
          '-of',
          'json',
          '-i',
          'pipe:0',
        ],
        {
          input: buffer,
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 1024 * 1024 * 4,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );

      if (result.error) {
        return null;
      }
      if (result.status !== 0) {
        return null;
      }
      const output = (result.stdout || '').toString().trim();
      if (!output) {
        return null;
      }
      const parsed = JSON.parse(output);
      const formatDuration = Number(parsed?.format?.duration);
      const streamDuration =
        Array.isArray(parsed?.streams) && parsed.streams.length > 0
          ? Number(parsed.streams[0]?.duration)
          : Number.NaN;
      const durationSeconds = Number.isFinite(formatDuration) ? formatDuration : (Number.isFinite(streamDuration) ? streamDuration : NaN);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return null;
      }
      return Math.round(durationSeconds * 1000);
    } catch (error: any) {
      return null;
    }
  }

  private checkFfprobeAvailable(): boolean {
    try {
      const result = spawnSync('ffprobe', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000 });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  private async readJsonResponse(response: Response, label: string, maxBytes: number): Promise<Record<string, unknown>> {
    const rawText = await this.aiUpstreamClient.readText(response, maxBytes);
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = { raw: rawText };
    }
    if (!response.ok) {
      this.logger.error(`${label} request failed: status=${response.status}, statusText=${response.statusText}, payload=${this.truncate(rawText, 600)}`);
      throw new BadGatewayException(`${label} failed (${response.status}): ${this.truncate(rawText, 900)}`);
    }
    return data;
  }

  private assertMinimaxBaseRespOk(data: Record<string, unknown>, label: string) {
    const statusCode = this.getNestedNumber(data, ['base_resp', 'status_code']);
    if (statusCode !== null && statusCode !== 0) {
      const statusMsg = this.getNestedString(data, ['base_resp', 'status_msg']) || JSON.stringify(data);
      const normalizedStatusMsg = this.normalizeString(statusMsg, 400) || 'voice clone rejected by provider';
      if (this.isMinimaxDurationViolation(normalizedStatusMsg)) {
        this.logger.warn(`${label} failed by provider validation: public message = ${normalizedStatusMsg}`);
        throw new BadRequestException(`MiniMax voice clone rejected: ${normalizedStatusMsg}`);
      }
      throw new BadGatewayException(`${label} failed: ${this.truncate(statusMsg, 900)}`);
    }
  }

  private isMinimaxDurationViolation(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('duration too short')
      || normalized.includes('duration is too short')
      || normalized.includes('duration too long')
      || normalized.includes('audio duration too short')
      || normalized.includes('audio is too short')
    );
  }

  private async createReadyMapping(
    voiceAssetId: string,
    route: ResolvedAiRoute,
    providerVoiceId: string,
    request: Record<string, unknown>,
    response: Record<string, unknown>,
    options: { globalModelId?: string | null } = {},
  ): Promise<{ id: string }> {
    const globalModelId = Object.prototype.hasOwnProperty.call(options, 'globalModelId')
      ? options.globalModelId || null
      : route.model_id;
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO ai_voice_provider_mappings (
         voice_asset_id, provider_type, source_id, global_model_id, provider_voice_id,
         status, provider_request_json, provider_response_json, created_at, updated_at
       )
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, 'ready', $6::jsonb, $7::jsonb, now(), now())
       RETURNING id`,
      voiceAssetId,
      route.source.provider_type,
      route.source.id,
      globalModelId,
      providerVoiceId,
      JSON.stringify(this.redactProviderRequest(request)),
      JSON.stringify(response),
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) {
      throw new BadGatewayException('failed to create voice provider mapping');
    }
    return rows[0];
  }

  private async resolveVoiceCloneRoute(appSlug: string, modelKey: string): Promise<ResolvedAiRoute> {
    const routes = await this.aiRoutingService.resolveModelRouteCandidatesByCapability(appSlug, 'tts', modelKey);
    const route = routes.find((item) => this.isVoiceCloneRoute(item)) || routes[0];
    if (!route || !this.isVoiceCloneRoute(route)) {
      throw new BadRequestException('selected model is not configured for voice clone');
    }
    return route;
  }

  private async resolveLinkedTtsModelForCloneRoute(route: ResolvedAiRoute): Promise<{ id: string; model_key: string; upstream_model: string }> {
    const overrides = this.normalizeObject(route.request_overrides);
    const audioOverrides = this.normalizeObject(overrides.audio);
    const linkedModelId = this.normalizeString(audioOverrides.linked_tts_model_id ?? overrides.linked_tts_model_id, 64);
    const linkedModelKey = this.normalizeString(audioOverrides.linked_tts_model_key ?? overrides.linked_tts_model_key, 255);
    const targetModel = this.normalizeString(audioOverrides.target_model ?? overrides.target_model, 255);
    const conditions: string[] = [];
    const params: unknown[] = [];
    const pushParam = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (linkedModelId) {
      conditions.push(`m.id = ${pushParam(linkedModelId)}::uuid`);
    }
    if (linkedModelKey) {
      conditions.push(`m.model_key = ${pushParam(linkedModelKey)}`);
    }
    if (targetModel) {
      conditions.push(`m.upstream_model = ${pushParam(targetModel)}`);
    }
    if (conditions.length === 0) {
      throw new BadRequestException('DashScope CosyVoice voice clone requires linked_tts_model_key');
    }
    const sourceParam = pushParam(route.source.id);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT m.id, m.model_key, m.upstream_model
       FROM ai_global_models m
       WHERE m.capability = 'tts'
         AND m.is_active = true
         AND (${conditions.join(' OR ')})
         AND (
           m.default_source_id = ${sourceParam}::uuid
           OR EXISTS (
             SELECT 1 FROM ai_model_source_routes r
             WHERE r.global_model_id = m.id
               AND r.source_id = ${sourceParam}::uuid
               AND r.is_active = true
           )
         )
       ORDER BY CASE WHEN m.default_source_id = ${sourceParam}::uuid THEN 0 ELSE 1 END, m.created_at DESC
       LIMIT 1`,
      ...params,
    ) as Promise<Array<{ id: string; model_key: string; upstream_model: string }>>);
    const row = rows[0];
    if (!row) {
      throw new BadRequestException('linked TTS model is not available for the voice clone provider');
    }
    return row;
  }

  private async resolveRouteByModelAndSource(appSlug: string, modelId: string | null, sourceId: string): Promise<ResolvedAiRoute> {
    if (!modelId) {
      throw new BadRequestException('to_global_model_id is required for migration');
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT model_key FROM ai_global_models WHERE id = $1::uuid AND is_active = true LIMIT 1`,
      modelId,
    ) as Promise<Array<{ model_key: string }>>);
    const modelKey = rows[0]?.model_key;
    if (!modelKey) {
      throw new NotFoundException('target voice clone model not found');
    }
    const routes = await this.aiRoutingService.resolveModelRouteCandidatesByCapability(appSlug, 'tts', modelKey);
    const route = routes.find((item) => item.source.id === sourceId);
    if (!route || !this.isVoiceCloneRoute(route)) {
      throw new BadRequestException('target source is not configured for the voice clone model');
    }
    return route;
  }

  private async findVoiceRow(appId: string, publicVoiceId: string, userId: string | null): Promise<VoiceAssetWithMappingRow | null> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         v.*,
         m.id AS mapping_id,
         m.provider_type AS mapping_provider_type,
         m.source_id AS mapping_source_id,
         m.global_model_id AS mapping_global_model_id,
         gm.api_type AS mapping_global_model_api_type,
         m.provider_voice_id AS mapping_provider_voice_id,
         m.status AS mapping_status,
         m.error_message AS mapping_error_message
       FROM ai_voice_assets v
       LEFT JOIN ai_voice_provider_mappings m ON m.id = v.active_mapping_id
       LEFT JOIN ai_global_models gm ON gm.id = m.global_model_id
       WHERE v.app_id = $1::uuid
         AND v.public_voice_id = $2
         AND ($3::uuid IS NULL OR v.user_id = $3::uuid OR v.user_id IS NULL)
       LIMIT 1`,
      appId,
      publicVoiceId,
      userId,
    ) as Promise<VoiceAssetWithMappingRow[]>);
    return rows[0] || null;
  }

  private async findUserOwnedVoiceRow(appId: string, publicVoiceId: string, userId: string | null): Promise<VoiceAssetWithMappingRow | null> {
    if (!userId) {
      return null;
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         v.*,
         m.id AS mapping_id,
         m.provider_type AS mapping_provider_type,
         m.source_id AS mapping_source_id,
         m.global_model_id AS mapping_global_model_id,
         gm.api_type AS mapping_global_model_api_type,
         m.provider_voice_id AS mapping_provider_voice_id,
         m.status AS mapping_status,
         m.error_message AS mapping_error_message
       FROM ai_voice_assets v
       LEFT JOIN ai_voice_provider_mappings m ON m.id = v.active_mapping_id
       LEFT JOIN ai_global_models gm ON gm.id = m.global_model_id
       WHERE v.app_id = $1::uuid
         AND v.public_voice_id = $2
         AND v.user_id = $3::uuid
       LIMIT 1`,
      appId,
      publicVoiceId,
      userId,
    ) as Promise<VoiceAssetWithMappingRow[]>);
    return rows[0] || null;
  }

  private async resolveApp(appSlug: string): Promise<{ id: string; slug: string }> {
    const slug = String(appSlug || '').trim().toLowerCase();
    if (!slug) {
      throw new BadRequestException('app slug is required');
    }
    const app = await this.prisma.app.findUnique({ where: { slug } });
    if (!app) {
      throw new NotFoundException(`App not found: ${slug}`);
    }
    return { id: app.id, slug: app.slug };
  }

  private assertAllowedAudio(file: Express.Multer.File) {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('sample audio file is required');
    }
    const allowed = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg']);
    if (!allowed.has(file.mimetype || '')) {
      throw new BadRequestException('invalid sample audio file type');
    }
  }

  private serializeVoice(row: VoiceAssetWithMappingRow, includeInternal: boolean) {
    const output: Record<string, unknown> = {
      voice_id: row.public_voice_id,
      name: row.display_name,
      language: row.language,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    };
    if (includeInternal) {
      output.id = row.id;
      output.app_id = row.app_id;
      output.user_id = row.user_id;
      output.sample_file_key = row.sample_file_key;
      output.sample_file_url = row.sample_file_url;
      output.sample_mime_type = row.sample_mime_type;
      output.sample_size_bytes = row.sample_size_bytes == null ? null : Number(row.sample_size_bytes);
      output.sample_sha256 = row.sample_sha256;
      output.active_mapping = row.mapping_id
        ? {
            id: row.mapping_id,
            provider_type: row.mapping_provider_type,
            source_id: row.mapping_source_id,
            global_model_id: row.mapping_global_model_id,
            provider_voice_id: row.mapping_provider_voice_id,
            status: row.mapping_status,
            error_message: row.mapping_error_message,
          }
        : null;
    }
    return output;
  }

  private extractPublicVoiceId(payload: Record<string, unknown>): string | null {
    const voiceSetting = this.normalizeObject(payload.voice_setting);
    const candidate =
      this.normalizeString(payload.voice_id, 128) ||
      this.normalizeString(payload.voice, 128) ||
      this.normalizeString(voiceSetting.voice_id, 128);
    if (!candidate || !candidate.startsWith('voice_')) {
      return null;
    }
    return candidate;
  }

  private isVoiceCloneRoute(route: ResolvedAiRoute): boolean {
    const apiType = String(route.api_type || '').trim().toLowerCase();
    return this.isVoiceCloneApiType(apiType);
  }

  private isVoiceCloneApiType(apiType: unknown): boolean {
    const normalized = String(apiType || '').trim().toLowerCase();
    return normalized.includes('voice-clone') || normalized.includes('voice_clone');
  }

  private isMinimaxRoute(route: ResolvedAiRoute): boolean {
    const providerType = String(route.source?.provider_type || '').trim().toLowerCase();
    const baseUrl = String(route.source?.base_url || '').trim().toLowerCase();
    const apiType = String(route.api_type || '').trim().toLowerCase();
    return providerType.includes('minimax') || baseUrl.includes('minimax.io') || apiType.includes('minimax');
  }

  private isDashscopeCosyVoiceRoute(route: ResolvedAiRoute): boolean {
    const providerType = String(route.source?.provider_type || '').trim().toLowerCase();
    const baseUrl = String(route.source?.base_url || '').trim().toLowerCase();
    const apiType = String(route.api_type || '').trim().toLowerCase();
    const endpointPath = String(route.endpoint_path || '').trim().toLowerCase();
    return apiType.includes('dashscope-cosyvoice')
      || apiType.includes('cosyvoice')
      || (
        (providerType.includes('dashscope') || providerType.includes('aliyun') || baseUrl.includes('dashscope.aliyuncs.com'))
        && endpointPath.includes('/services/audio/tts/customization')
      );
  }

  private normalizeDashscopeLanguageHints(value: unknown, label = 'DashScope CosyVoice language_hints'): string[] {
    const allowed = Object.keys(DASHSCOPE_COSYVOICE_V35_LANGUAGE_HINTS);
    const allowedText = allowed.map((code) => `${code}=${DASHSCOPE_COSYVOICE_V35_LANGUAGE_HINTS[code]}`).join(', ');
    if (Array.isArray(value)) {
      const normalized = value.map((item) => this.normalizeString(item, 32)).filter(Boolean);
      if (normalized.length > 1) {
        throw new BadRequestException(`${label} only accepts one language code for CosyVoice V3.5; current DashScope API only processes the first element. Allowed values: ${allowedText}`);
      }
      normalized.forEach((item) => this.assertDashscopeCosyVoiceLanguageHint(item, label));
      return normalized;
    }
    const single = this.normalizeString(value, 32);
    if (single) {
      this.assertDashscopeCosyVoiceLanguageHint(single, label);
    }
    return single ? [single] : [];
  }

  private assertDashscopeCosyVoiceLanguageHint(value: string, label: string) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(DASHSCOPE_COSYVOICE_V35_LANGUAGE_HINTS, normalized)) {
      const allowedText = Object.entries(DASHSCOPE_COSYVOICE_V35_LANGUAGE_HINTS)
        .map(([code, name]) => `${code}=${name}`)
        .join(', ');
      throw new BadRequestException(`${label} is invalid: ${value}. Allowed CosyVoice V3.5 language codes: ${allowedText}`);
    }
  }

  private assertDashscopeCosyVoiceTargetModelSupported(targetModel: string) {
    const normalized = String(targetModel || '').trim().toLowerCase();
    if (!DASHSCOPE_COSYVOICE_V35_MODELS.has(normalized)) {
      throw new BadRequestException(
        `DashScope CosyVoice voice clone target_model is invalid: ${targetModel}. Supported CosyVoice V3.5 target models: cosyvoice-v3.5-plus, cosyvoice-v3.5-flash`,
      );
    }
  }

  private resolveDashscopeVoicePrefix(providerVoiceId: string): string {
    return String(providerVoiceId || 'arti_voice')
      .replace(/^arti_/, 'arti')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 10) || 'artivoice';
  }

  private extractProviderVoiceId(data: Record<string, unknown>): string | null {
    return this.getNestedString(data, ['voice_id'])
      || this.getNestedString(data, ['voiceId'])
      || this.getNestedString(data, ['data', 'voice_id'])
      || this.getNestedString(data, ['data', 'voiceId'])
      || this.getNestedString(data, ['data', 'voice', 'id'])
      || this.getNestedString(data, ['output', 'voice_id']);
  }

  private extractMinimaxFileId(data: Record<string, unknown>): number | string | null {
    return this.getNestedNumber(data, ['file', 'file_id'])
      ?? this.getNestedNumber(data, ['file_id'])
      ?? this.getNestedNumber(data, ['data', 'file_id'])
      ?? this.getNestedString(data, ['file', 'file_id'])
      ?? this.getNestedString(data, ['file_id'])
      ?? this.getNestedString(data, ['data', 'file_id']);
  }

  private getNestedString(value: unknown, path: string[]): string | null {
    let current: any = value;
    for (const key of path) {
      if (!current || typeof current !== 'object') {
        return null;
      }
      current = current[key];
    }
    const normalized = this.normalizeString(current, 512);
    return normalized || null;
  }

  private getNestedNumber(value: unknown, path: string[]): number | null {
    let current: any = value;
    for (const key of path) {
      if (!current || typeof current !== 'object') {
        return null;
      }
      current = current[key];
    }
    const parsed = typeof current === 'number' ? current : Number(String(current || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  private async ensureSchema() {
    if (this.schemaReady) {
      return;
    }
    if (this.schemaPromise) {
      await this.schemaPromise;
      return;
    }
    this.schemaPromise = this.createSchema();
    try {
      await this.schemaPromise;
      this.schemaReady = true;
    } finally {
      this.schemaPromise = null;
    }
  }

  private async createSchema() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_voice_assets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        public_voice_id varchar(64) NOT NULL,
        display_name varchar(128) NOT NULL DEFAULT '',
        language varchar(32) NULL,
        status varchar(32) NOT NULL DEFAULT 'creating',
        active_mapping_id uuid NULL,
        sample_file_key varchar(1024) NOT NULL,
        sample_file_url varchar(2048) NOT NULL,
        sample_mime_type varchar(128) NULL,
        sample_size_bytes bigint NULL,
        sample_sha256 varchar(64) NULL,
        sample_duration_ms integer NULL,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        deleted_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_voice_provider_mappings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        voice_asset_id uuid NOT NULL REFERENCES ai_voice_assets(id) ON DELETE CASCADE,
        provider_type varchar(64) NOT NULL,
        source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
        global_model_id uuid NULL REFERENCES ai_global_models(id) ON DELETE SET NULL,
        provider_voice_id varchar(256) NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'ready',
        provider_request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        provider_response_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        error_message text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_voice_assets_active_mapping'
        ) THEN
          ALTER TABLE ai_voice_assets
            ADD CONSTRAINT fk_ai_voice_assets_active_mapping
            FOREIGN KEY (active_mapping_id) REFERENCES ai_voice_provider_mappings(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_voice_migration_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status varchar(32) NOT NULL DEFAULT 'pending',
        from_provider_type varchar(64) NULL,
        to_source_id uuid NOT NULL REFERENCES ai_global_sources(id) ON DELETE RESTRICT,
        to_global_model_id uuid NULL REFERENCES ai_global_models(id) ON DELETE SET NULL,
        filter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        total_count integer NOT NULL DEFAULT 0,
        success_count integer NOT NULL DEFAULT 0,
        failed_count integer NOT NULL DEFAULT 0,
        created_by_user_id uuid NULL,
        started_at timestamptz NULL,
        finished_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ai_voice_migration_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid NOT NULL REFERENCES ai_voice_migration_jobs(id) ON DELETE CASCADE,
        voice_asset_id uuid NOT NULL REFERENCES ai_voice_assets(id) ON DELETE CASCADE,
        status varchar(32) NOT NULL DEFAULT 'pending',
        old_mapping_id uuid NULL REFERENCES ai_voice_provider_mappings(id) ON DELETE SET NULL,
        new_mapping_id uuid NULL REFERENCES ai_voice_provider_mappings(id) ON DELETE SET NULL,
        error_message text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const indexStatements = [
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_voice_assets_public_voice_id ON ai_voice_assets(public_voice_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_voice_assets_app_user_status ON ai_voice_assets(app_id, user_id, status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_voice_assets_deleted_status ON ai_voice_assets(deleted_at, status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_voice_provider_mappings_voice_status ON ai_voice_provider_mappings(voice_asset_id, status, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_voice_provider_mappings_provider_lookup ON ai_voice_provider_mappings(provider_type, source_id, provider_voice_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_voice_migration_jobs_status_created ON ai_voice_migration_jobs(status, created_at ASC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_voice_migration_items_job_voice ON ai_voice_migration_items(job_id, voice_asset_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_voice_migration_items_job_status ON ai_voice_migration_items(job_id, status, created_at ASC)`,
    ];
    for (const statement of indexStatements) {
      await this.prisma.$executeRawUnsafe(statement);
    }
  }

  private normalizeObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private normalizeString(value: unknown, maxLength: number): string {
    const normalized = String(value || '').trim();
    return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
  }

  private boundInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }

  private generatePublicVoiceId(): string {
    return `voice_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  }

  private generateVoiceCloneTraceId(): string {
    return `voice_clone_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  }

  private generateProviderVoiceId(publicVoiceId: string): string {
    return `arti_${publicVoiceId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  }

  private isAllowedVoiceSampleKey(fileKey: string): boolean {
    const normalized = String(fileKey || '').trim().replace(/^\/+/, '');
    return /^ai\/voice-samples\/[0-9a-f-]{8,}\/[^/]+\/[^/]+$/i.test(normalized);
  }

  private sha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private joinUrl(baseUrl: string, endpointPath: string): string {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const path = String(endpointPath || '').startsWith('/') ? String(endpointPath || '') : `/${endpointPath || ''}`;
    return `${base}${path}`;
  }

  private resolveMinimaxFileUploadEndpoint(route: ResolvedAiRoute): string {
    return this.joinUrl(this.minimaxBaseUrl(route.source.base_url), '/files/upload');
  }

  private resolveMinimaxVoiceCloneEndpoint(route: ResolvedAiRoute): string {
    const endpointPath = this.normalizeMinimaxVoiceCloneEndpointPath(route.endpoint_path);
    return this.joinUrl(this.minimaxBaseUrl(route.source.base_url), endpointPath);
  }

  private resolveDashscopeCosyVoiceCloneEndpoint(route: ResolvedAiRoute): string {
    const endpointPath = this.normalizeString(route.endpoint_path, 255) || '/services/audio/tts/customization';
    return this.joinUrl(route.source.base_url || 'https://dashscope.aliyuncs.com/api/v1', endpointPath);
  }

  private minimaxBaseUrl(baseUrl: string): string {
    const raw = this.normalizeString(baseUrl, 2048) || 'https://api.minimax.io/v1';
    const parsed = new URL(raw);
    const normalizedPath = parsed.pathname.replace(/\/+$/g, '');
    const v1Index = normalizedPath.toLowerCase().indexOf('/v1');
    parsed.pathname = v1Index >= 0 ? normalizedPath.slice(0, v1Index + 3) : `${normalizedPath || ''}/v1`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/g, '');
  }

  private normalizeMinimaxVoiceCloneEndpointPath(endpointPath: string): string {
    const normalized = this.normalizeString(endpointPath, 255) || '/voice_clone';
    if (normalized === '/audio/speech' || normalized === '/v1/audio/speech') {
      return '/voice_clone';
    }
    if (normalized === '/v1/voice_clone') {
      return '/voice_clone';
    }
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }

  private fileNameForMimeType(mimeType: string): string {
    const normalized = String(mimeType || '').toLowerCase();
    if (normalized.includes('wav')) {
      return 'voice-sample.wav';
    }
    if (normalized.includes('mp4') || normalized.includes('m4a') || normalized.includes('aac')) {
      return 'voice-sample.m4a';
    }
    return 'voice-sample.mp3';
  }

  private redactProviderRequest(request: Record<string, unknown>): Record<string, unknown> {
    const next = { ...request };
    if (typeof next.audio_url === 'string') {
      next.audio_url = this.stripQuery(next.audio_url);
    }
    if (typeof next.file_url === 'string') {
      next.file_url = this.stripQuery(next.file_url);
    }
    return next;
  }

  private stripQuery(value: unknown): string {
    const text = String(value || '');
    const index = text.indexOf('?');
    return index >= 0 ? text.slice(0, index) : text;
  }

  private serializeJsonRow(row: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    Object.entries(row).forEach(([key, value]) => {
      output[key] = typeof value === 'bigint' ? Number(value) : value;
    });
    return output;
  }

  private invalidateVoiceCache(publicVoiceId: string) {
    for (const key of this.voiceCache.keys()) {
      if (key.endsWith(`:${publicVoiceId}`)) {
        this.voiceCache.delete(key);
      }
    }
  }

  private truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  }
}
