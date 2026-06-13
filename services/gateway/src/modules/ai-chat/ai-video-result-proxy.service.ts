import { BadGatewayException, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { Readable, Transform, TransformCallback } from 'stream';
import { PRISMA_CLIENT } from '../../config/database.module';
import { OutboundHttpClientService } from '../outbound-proxy/outbound-http-client.service';
import { UploadService } from '../upload/upload.service';

type VideoResultProxyProvider = 'runninghub';

type VideoResultProxySettings = {
  enabled: boolean;
  providers: VideoResultProxyProvider[];
  retentionDays: number;
  maxFileBytes: number;
  signedUrlTtlSeconds: number;
};

type VideoResultAssetRow = {
  id: string;
  app_id: string;
  provider: string;
  provider_task_id: string;
  source_url_hash: string;
  oss_file_key: string | null;
  file_url: string | null;
  mime_type: string | null;
  byte_size: bigint | number | null;
  sha256: string | null;
  status: string;
  expires_at: Date;
  deleted_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

export type VideoResultProxyResolveInput = {
  appId: string;
  appSlug: string;
  provider: VideoResultProxyProvider;
  providerTaskId: string;
  sourceUrls: string[];
  outboundProxyId?: string | null;
  waitTimeoutMs?: number;
};

export type VideoResultProxyResolveResult = {
  enabled: boolean;
  ready: boolean;
  urls: string[];
};

class ByteLimitHashTransform extends Transform {
  private readonly hash = createHash('sha256');
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  get bytes() {
    return this.totalBytes;
  }

  digest() {
    return this.hash.digest('hex');
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.totalBytes += buffer.length;
    if (this.totalBytes > this.maxBytes) {
      callback(new BadGatewayException('video result exceeds proxy size limit'));
      return;
    }
    this.hash.update(buffer);
    callback(null, buffer);
  }
}

@Injectable()
export class AiVideoResultProxyService {
  private readonly logger = new Logger(AiVideoResultProxyService.name);
  private readonly settingsCache = new Map<string, { value: VideoResultProxySettings; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly uploadService: UploadService,
    private readonly outboundHttp: OutboundHttpClientService,
  ) {}

  async resolveVideoUrls(input: VideoResultProxyResolveInput): Promise<VideoResultProxyResolveResult> {
    const settings = await this.getSettings(input.appId);
    const sourceUrls = input.sourceUrls.map((url) => String(url || '').trim()).filter(Boolean);
    if (!settings.enabled || !settings.providers.includes(input.provider) || sourceUrls.length === 0) {
      return { enabled: false, ready: true, urls: sourceUrls };
    }

    const pending: Array<{ rowId: string; sourceUrl: string; sourceHash: string }> = [];
    const readyUrls: string[] = [];

    for (const sourceUrl of sourceUrls) {
      const sourceHash = this.hashValue(sourceUrl);
      const row = await this.findOrCreateAsset(input, sourceHash, settings);
      if (row.status === 'READY' && row.oss_file_key && !this.isExpired(row.expires_at)) {
        const readable = await this.uploadService.resolveReadableUrl(row.oss_file_key, settings.signedUrlTtlSeconds);
        if (readable) {
          readyUrls.push(readable);
          continue;
        }
      }
      pending.push({ rowId: row.id, sourceUrl, sourceHash });
    }

    if (pending.length === 0) {
      return { enabled: true, ready: true, urls: readyUrls };
    }

    for (const item of pending) {
      this.startMaterialization({
        ...input,
        rowId: item.rowId,
        sourceUrl: item.sourceUrl,
        sourceHash: item.sourceHash,
        settings,
      });
    }

    const waited = await this.waitForReadyUrls(input, sourceUrls, settings, input.waitTimeoutMs || 0);
    if (waited.ready) {
      return waited;
    }
    return { enabled: true, ready: false, urls: readyUrls };
  }

  @Cron('17 * * * *')
  async cleanupExpiredAssets() {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM ai_video_result_assets
        WHERE status = 'READY'
          AND deleted_at IS NULL
          AND expires_at <= now()
        ORDER BY expires_at ASC
        LIMIT 100`,
    ) as Promise<VideoResultAssetRow[]>);
    for (const row of rows) {
      try {
        if (row.oss_file_key) {
          await this.uploadService.deleteByFileUrl(row.oss_file_key);
        }
        await this.prisma.$executeRawUnsafe(
          `UPDATE ai_video_result_assets
              SET status = 'DELETED',
                  deleted_at = now(),
                  updated_at = now()
            WHERE id = $1::uuid`,
          row.id,
        );
      } catch (error: any) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE ai_video_result_assets
              SET last_error = $2,
                  updated_at = now()
            WHERE id = $1::uuid`,
          row.id,
          this.truncate(String(error?.message || error), 900),
        );
      }
    }
  }

  private startMaterialization(input: VideoResultProxyResolveInput & {
    rowId: string;
    sourceUrl: string;
    sourceHash: string;
    settings: VideoResultProxySettings;
  }) {
    if (this.inflight.has(input.rowId)) {
      return;
    }
    const promise = this.materializeOne(input)
      .catch((error) => {
        this.logger.warn(`video result proxy failed row=${input.rowId}: ${error?.message || error}`);
      })
      .finally(() => {
        this.inflight.delete(input.rowId);
      });
    this.inflight.set(input.rowId, promise);
  }

  private async materializeOne(input: VideoResultProxyResolveInput & {
    rowId: string;
    sourceUrl: string;
    sourceHash: string;
    settings: VideoResultProxySettings;
  }) {
    const claimed = await this.claimAsset(input.rowId);
    if (!claimed) {
      return;
    }

    try {
      const response = await this.outboundHttp.fetch(
        input.sourceUrl,
        { method: 'GET' },
        { proxyId: input.outboundProxyId || null, timeoutMs: 30_000 },
      );
      if (!response.ok || !response.body) {
        throw new BadGatewayException(`video result download failed: ${response.status}`);
      }

      const contentLength = this.parseContentLength(response.headers.get('content-length'));
      if (contentLength !== null && contentLength > input.settings.maxFileBytes) {
        throw new BadGatewayException('video result exceeds proxy size limit');
      }

      const mimeType = this.normalizeVideoMimeType(response.headers.get('content-type'), input.sourceUrl);
      const extension = this.extensionForMimeType(mimeType, input.sourceUrl);
      const objectKey = this.buildObjectKey(input.appId, input.provider, input.providerTaskId, input.sourceHash, extension);
      const metered = new ByteLimitHashTransform(input.settings.maxFileBytes);
      const sourceStream = Readable.fromWeb(response.body as any);
      const upload = await this.uploadService.uploadStreamToKey(objectKey, mimeType, sourceStream.pipe(metered));
      const sha256 = metered.digest();

      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_video_result_assets
            SET oss_file_key = $2,
                file_url = $3,
                mime_type = $4,
                byte_size = $5,
                sha256 = $6,
                status = 'READY',
                last_error = NULL,
                updated_at = now()
          WHERE id = $1::uuid`,
        input.rowId,
        upload.file_key,
        upload.file_url,
        mimeType,
        metered.bytes,
        sha256,
      );
    } catch (error: any) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE ai_video_result_assets
            SET status = 'FAILED',
                last_error = $2,
                updated_at = now()
          WHERE id = $1::uuid`,
        input.rowId,
        this.truncate(String(error?.message || error), 900),
      );
      throw error;
    }
  }

  private async waitForReadyUrls(
    input: VideoResultProxyResolveInput,
    sourceUrls: string[],
    settings: VideoResultProxySettings,
    waitTimeoutMs: number,
  ): Promise<VideoResultProxyResolveResult> {
    const deadline = Date.now() + Math.max(0, Math.min(waitTimeoutMs, 120_000));
    while (Date.now() <= deadline) {
      const urls: string[] = [];
      let ready = true;
      for (const sourceUrl of sourceUrls) {
        const row = await this.findAsset(input.appId, input.provider, input.providerTaskId, this.hashValue(sourceUrl));
        if (!row || row.status !== 'READY' || !row.oss_file_key || this.isExpired(row.expires_at)) {
          ready = false;
          break;
        }
        const readable = await this.uploadService.resolveReadableUrl(row.oss_file_key, settings.signedUrlTtlSeconds);
        if (!readable) {
          ready = false;
          break;
        }
        urls.push(readable);
      }
      if (ready) {
        return { enabled: true, ready: true, urls };
      }
      if (Date.now() + 500 > deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { enabled: true, ready: false, urls: [] };
  }

  private async findOrCreateAsset(
    input: VideoResultProxyResolveInput,
    sourceHash: string,
    settings: VideoResultProxySettings,
  ): Promise<VideoResultAssetRow> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO ai_video_result_assets (
         id, app_id, provider, provider_task_id, source_url_hash, status, expires_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2, $3, $4, 'PENDING', now() + ($5::int * interval '1 day')
       )
       ON CONFLICT (app_id, provider, provider_task_id, source_url_hash)
       DO UPDATE SET
         expires_at = GREATEST(ai_video_result_assets.expires_at, EXCLUDED.expires_at),
         updated_at = now()
       RETURNING *`,
      input.appId,
      input.provider,
      input.providerTaskId,
      sourceHash,
      settings.retentionDays,
    ) as Promise<VideoResultAssetRow[]>);
    return rows[0];
  }

  private async findAsset(appId: string, provider: string, providerTaskId: string, sourceHash: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
         FROM ai_video_result_assets
        WHERE app_id = $1::uuid
          AND provider = $2
          AND provider_task_id = $3
          AND source_url_hash = $4
        LIMIT 1`,
      appId,
      provider,
      providerTaskId,
      sourceHash,
    ) as Promise<VideoResultAssetRow[]>);
    return rows[0] || null;
  }

  private async claimAsset(rowId: string): Promise<boolean> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE ai_video_result_assets
          SET status = 'UPLOADING',
              last_error = NULL,
              updated_at = now()
        WHERE id = $1::uuid
          AND deleted_at IS NULL
          AND (
            status IN ('PENDING', 'FAILED')
            OR (status = 'UPLOADING' AND updated_at < now() - interval '15 minutes')
          )
        RETURNING id`,
      rowId,
    ) as Promise<Array<{ id: string }>>);
    return rows.length > 0;
  }

  private async getSettings(appId: string): Promise<VideoResultProxySettings> {
    const cached = this.settingsCache.get(appId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT extra_json
         FROM app_settings
        WHERE app_id = $1::uuid
        LIMIT 1`,
      appId,
    ) as Promise<Array<{ extra_json: unknown }>>);
    const settings = this.normalizeSettings(rows[0]?.extra_json);
    this.settingsCache.set(appId, { value: settings, expiresAt: Date.now() + 60_000 });
    return settings;
  }

  private normalizeSettings(extraJson: unknown): VideoResultProxySettings {
    const root = this.asObject(extraJson);
    const ai = this.asObject(root.ai);
    const proxy = this.asObject(ai.video_download_proxy);
    const providersRaw = Array.isArray(proxy.providers) ? proxy.providers : ['runninghub'];
    const providers = providersRaw
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item): item is VideoResultProxyProvider => item === 'runninghub');
    const retentionDays = this.boundedInt(proxy.retention_days, 7, 1, 365);
    const maxFileMb = this.boundedInt(proxy.max_file_mb, 1024, 1, 10 * 1024);
    return {
      enabled: proxy.enabled === true,
      providers: providers.length ? providers : ['runninghub'],
      retentionDays,
      maxFileBytes: maxFileMb * 1024 * 1024,
      signedUrlTtlSeconds: this.boundedInt(proxy.signed_url_ttl_seconds, 600, 30, 24 * 60 * 60),
    };
  }

  private buildObjectKey(appId: string, provider: string, providerTaskId: string, sourceHash: string, extension: string) {
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const safeTaskId = String(providerTaskId || 'task').replace(/[^a-z0-9_-]/gi, '-').slice(0, 96) || 'task';
    return `ai/video-results/${appId}/${provider}/${yyyy}/${mm}/${safeTaskId}/${sourceHash.slice(0, 16)}${extension}`;
  }

  private hashValue(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private isExpired(expiresAt: Date) {
    return expiresAt && expiresAt.getTime() <= Date.now();
  }

  private parseContentLength(value: string | null): number | null {
    const parsed = Number(value || '');
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  private normalizeVideoMimeType(value: string | null, sourceUrl: string) {
    const raw = String(value || '').split(';')[0]?.trim().toLowerCase();
    if (raw && raw.startsWith('video/')) {
      return raw;
    }
    const lower = sourceUrl.toLowerCase();
    if (lower.includes('.webm')) return 'video/webm';
    if (lower.includes('.mov')) return 'video/quicktime';
    if (lower.includes('.m4v')) return 'video/x-m4v';
    return 'video/mp4';
  }

  private extensionForMimeType(mimeType: string, sourceUrl: string) {
    const pathname = (() => {
      try {
        return new URL(sourceUrl).pathname.toLowerCase();
      } catch {
        return sourceUrl.toLowerCase();
      }
    })();
    if (pathname.endsWith('.webm')) return '.webm';
    if (pathname.endsWith('.mov')) return '.mov';
    if (pathname.endsWith('.m4v')) return '.m4v';
    if (mimeType === 'video/webm') return '.webm';
    if (mimeType === 'video/quicktime') return '.mov';
    if (mimeType === 'video/x-m4v') return '.m4v';
    return '.mp4';
  }

  private asObject(value: unknown): Record<string, any> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, any>;
    }
    return {};
  }

  private boundedInt(value: unknown, fallback: number, min: number, max: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
  }

  private truncate(value: string, max: number) {
    return value.length > max ? value.slice(0, max) : value;
  }
}
