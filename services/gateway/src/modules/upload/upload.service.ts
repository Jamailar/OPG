import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { PrismaClient } from '@prisma/client';
import configuration from '../../config/configuration';
import { PRISMA_CLIENT } from '../../config/database.module';
import { RuntimeSettingsService } from '../runtime-settings/runtime-settings.service';

// ali-oss provides runtime JS API; keep typed as any for compatibility with current TS config.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OSS = require('ali-oss');
const MAX_READABLE_URL_EXPIRES_SECONDS = 24 * 60 * 60;

@Injectable()
export class UploadService {
  private cdnBaseUrl: string;
  private cdnAuthEnabled: boolean;
  private cdnAuthKey: string;
  private cdnAuthWindowSeconds: number;
  private ossBucket: string;
  private ossEndpoint: string;
  private ossAccessKeyId: string;
  private ossAccessKeySecret: string;
  private ossTimeoutMs: number;
  private ossClient: any | null;
  private storageConfigExpiresAt = 0;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
    private readonly runtimeSettingsService: RuntimeSettingsService,
  ) {
    const configuredCdnWindowSeconds = Number(this.config.aliyun?.oss?.cdnAuthWindowSeconds || 120);
    this.cdnBaseUrl = this.config.aliyun?.oss?.cdnBaseUrl || '';
    this.cdnAuthEnabled = Boolean(this.config.aliyun?.oss?.cdnAuthEnabled);
    this.cdnAuthKey = String(this.config.aliyun?.oss?.cdnAuthKey || '').trim();
    this.cdnAuthWindowSeconds = Number.isFinite(configuredCdnWindowSeconds)
      ? Math.max(30, Math.min(MAX_READABLE_URL_EXPIRES_SECONDS, Math.floor(configuredCdnWindowSeconds)))
      : 120;
    this.ossBucket = (this.config.aliyun?.oss?.bucket || '').trim();
    this.ossEndpoint = this.normalizeEndpoint(this.config.aliyun?.oss?.endpoint || '');
    this.ossAccessKeyId = String(this.config.aliyun?.accessKeyId || '').trim();
    this.ossAccessKeySecret = String(this.config.aliyun?.accessKeySecret || '').trim();
    this.ossTimeoutMs = Number(this.config.aliyun?.oss?.timeoutMs || 300_000);
    this.ossClient = this.buildOssClient();
  }

  async getPresignedUrl(
    userId: string,
    filename: string,
    contentType: string,
    appSlug?: string,
    keyPrefix?: string,
    appId?: string,
  ) {
    await this.refreshStorageProviderConfig();
    if (!filename) {
      throw new BadRequestException('filename is required');
    }

    const resolvedAppId = await this.resolveAppId(appSlug, appId);
    const normalizedPrefix = this.normalizeKeyPrefix(keyPrefix, 'uploads');
    const fileKey = this.buildObjectKey(resolvedAppId, userId, filename, normalizedPrefix);
    const fileUrl = this.buildFileUrl(fileKey);
    const uploadUrl = await this.buildUploadUrl(fileKey, fileUrl, contentType || 'application/octet-stream');

    return {
      upload_url: uploadUrl,
      file_url: fileUrl,
      file_key: fileKey,
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
      },
    };
  }

  async uploadBuffer(
    userId: string,
    filename: string,
    contentType: string,
    fileBuffer: Buffer,
    appSlug?: string,
    keyPrefix = 'uploads',
    appId?: string,
  ) {
    await this.refreshStorageProviderConfig();
    if (!filename) {
      throw new BadRequestException('filename is required');
    }
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException('file buffer is empty');
    }

    const resolvedAppId = await this.resolveAppId(appSlug, appId);
    const fileKey = this.buildObjectKey(resolvedAppId, userId, filename, keyPrefix);
    const normalizedType = contentType || 'application/octet-stream';

    if (this.ossClient) {
      await this.ossClient.put(fileKey, fileBuffer, {
        headers: {
          'Content-Type': normalizedType,
        },
      });
    } else {
      await this.persistLocalFile(fileKey, fileBuffer);
    }

    return {
      file_key: fileKey,
      file_url: this.buildFileUrl(fileKey),
    };
  }

  async uploadStreamToKey(
    fileKey: string,
    contentType: string,
    stream: Readable,
  ): Promise<{ file_key: string; file_url: string }> {
    await this.refreshStorageProviderConfig();
    const normalizedKey = String(fileKey || '').replace(/^\/+/, '');
    if (!this.isLikelyManagedObjectKey(normalizedKey)) {
      throw new BadRequestException('invalid managed file key');
    }
    const normalizedType = contentType || 'application/octet-stream';

    if (this.ossClient) {
      await this.ossClient.putStream(normalizedKey, stream, {
        headers: {
          'Content-Type': normalizedType,
        },
      });
    } else {
      await this.persistLocalStream(normalizedKey, stream);
    }

    return {
      file_key: normalizedKey,
      file_url: this.buildFileUrl(normalizedKey),
    };
  }

  async deleteByFileUrl(fileUrl: string | null | undefined): Promise<{ deleted: boolean; file_key: string | null }> {
    await this.refreshStorageProviderConfig();
    const fileKey = this.extractManagedFileKey(fileUrl);
    if (!fileKey) {
      return { deleted: false, file_key: null };
    }

    if (this.ossClient) {
      try {
        await this.ossClient.delete(fileKey);
        return { deleted: true, file_key: fileKey };
      } catch (error: any) {
        const code = String(error?.code || '').toLowerCase();
        const status = Number(error?.status || 0);
        if (code.includes('nosuchkey') || status === 404) {
          return { deleted: false, file_key: fileKey };
        }
        throw error;
      }
    }

    const localPath = path.resolve(process.cwd(), 'uploads', fileKey);
    try {
      await fs.unlink(localPath);
      return { deleted: true, file_key: fileKey };
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return { deleted: false, file_key: fileKey };
      }
      throw error;
    }
  }

  getManagedFileKey(fileRef: string | null | undefined): string | null {
    return this.extractManagedFileKey(fileRef);
  }

  isManagedFileReference(fileRef: string | null | undefined): boolean {
    return Boolean(this.extractManagedFileKey(fileRef));
  }

  async resolveReadableUrl(fileRef: string | null | undefined, expiresSeconds = 120): Promise<string | null> {
    await this.refreshStorageProviderConfig();
    const raw = String(fileRef || '').trim();
    if (!raw) {
      return null;
    }

    const fileKey = this.extractManagedFileKey(raw);
    if (!fileKey) {
      return raw;
    }

    const cdnSignedUrl = this.buildCdnReadableUrl(fileKey, expiresSeconds);
    if (cdnSignedUrl) {
      return cdnSignedUrl;
    }

    if (this.ossClient) {
      const signed = this.ossClient.signatureUrl(fileKey, {
        method: 'GET',
        expires: Math.max(30, Math.min(MAX_READABLE_URL_EXPIRES_SECONDS, Math.floor(expiresSeconds || 120))),
      });
      if (typeof signed === 'string' && signed) {
        return signed.startsWith('http://') ? `https://${signed.slice('http://'.length)}` : signed;
      }
    }

    return this.buildFileUrl(fileKey);
  }

  private buildCdnReadableUrl(fileKey: string, expiresSeconds: number): string | null {
    const normalizedBase = this.cdnBaseUrl.replace(/\/+$/, '');
    if (!normalizedBase) {
      return null;
    }

    const normalizedKey = String(fileKey || '').replace(/^\/+/, '');
    if (!normalizedKey) {
      return null;
    }

    const normalizedExpires = Math.max(
      30,
      Math.min(MAX_READABLE_URL_EXPIRES_SECONDS, Math.floor(expiresSeconds || this.cdnAuthWindowSeconds)),
    );
    const rawUrl = `${normalizedBase}/${normalizedKey}`;

    if (!this.cdnAuthEnabled || !this.cdnAuthKey) {
      return rawUrl;
    }

    try {
      const url = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
      const expireAt = Math.floor(Date.now() / 1000) + normalizedExpires;
      const rand = '0';
      const uid = '0';
      const signSource = `${url.pathname}-${expireAt}-${rand}-${uid}-${this.cdnAuthKey}`;
      const digest = createHash('md5').update(signSource).digest('hex');
      url.searchParams.set('auth_key', `${expireAt}-${rand}-${uid}-${digest}`);
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  async uploadAudio(file: Express.Multer.File, _userId: string, _appSlug?: string) {
    await this.refreshStorageProviderConfig();
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const allowedAudioTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/x-m4a'];
    if (!allowedAudioTypes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid audio file type');
    }

    const filePath = `/uploads/audio/${Date.now()}-${file.originalname}`;
    return {
      filename: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: filePath,
      url: this.cdnBaseUrl + filePath,
    };
  }

  async uploadImage(file: Express.Multer.File, _userId: string, _appSlug?: string) {
    await this.refreshStorageProviderConfig();
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedImageTypes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid image file type');
    }

    const filePath = `/uploads/images/${Date.now()}-${file.originalname}`;
    return {
      filename: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: filePath,
      url: this.cdnBaseUrl + filePath,
    };
  }

  async uploadFile(file: Express.Multer.File, _userId: string, _appSlug?: string) {
    await this.refreshStorageProviderConfig();
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const filePath = `/uploads/files/${Date.now()}-${file.originalname}`;
    return {
      filename: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: filePath,
      url: this.cdnBaseUrl + filePath,
    };
  }

  private buildFileUrl(fileKey: string) {
    if (this.cdnBaseUrl) {
      return `${this.cdnBaseUrl.replace(/\/+$/, '')}/${fileKey}`;
    }
    if (this.ossBucket && this.ossEndpoint) {
      return `https://${this.ossBucket}.${this.ossEndpoint}/${fileKey}`;
    }
    return `/uploads/${fileKey}`;
  }

  private async resolveAppId(appSlug?: string, appId?: string) {
    if (appId) {
      const byId = await this.prisma.app.findUnique({ where: { id: appId } });
      if (byId) return byId.id;
    }
    const slug = appSlug || this.config.app.defaultSlug;
    const bySlug = await this.prisma.app.findUnique({ where: { slug } });
    if (bySlug) return bySlug.id;
    if (appId) {
      throw new BadRequestException(`App not found: id=${appId}, slug=${slug}`);
    }
    throw new BadRequestException(`App not found: ${slug}`);
  }

  private buildObjectKey(appId: string, userId: string, filename: string, keyPrefix: string) {
    const ext = this.extractSafeExtension(filename);
    const safeBase = this.extractSafeBasename(filename);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return `${keyPrefix}/${appId}/${userId}/${stamp}-${safeBase}${ext}`;
  }

  private extractSafeExtension(filename: string) {
    const rawExt = path.extname(filename || '').toLowerCase();
    const normalized = rawExt.replace(/[^a-z0-9.]/g, '').slice(0, 10);
    return normalized || '.bin';
  }

  private extractSafeBasename(filename: string) {
    const rawExt = path.extname(filename || '');
    const rawBase = path.basename(filename || 'file', rawExt);
    const normalized = rawBase.replace(/[^a-z0-9_-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return normalized.slice(0, 60) || 'file';
  }

  private normalizeKeyPrefix(rawPrefix: string | undefined, fallback: string) {
    const trimmed = (rawPrefix || '').trim().replace(/^\/+|\/+$/g, '');
    if (!trimmed) return fallback;
    if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(trimmed)) return fallback;
    return trimmed;
  }

  private async buildUploadUrl(fileKey: string, fallbackFileUrl: string, contentType: string) {
    if (this.ossClient) {
      const signed = this.ossClient.signatureUrl(fileKey, {
        method: 'PUT',
        expires: 3600,
        headers: {
          'Content-Type': contentType,
        },
      });
      if (typeof signed === 'string' && signed.startsWith('http://')) {
        return `https://${signed.slice('http://'.length)}`;
      }
      return signed;
    }

    return `${fallbackFileUrl}?mock_presigned=1&content_type=${encodeURIComponent(contentType)}`;
  }

  private normalizeEndpoint(endpoint: string) {
    const trimmed = (endpoint || '').trim();
    if (!trimmed) {
      return '';
    }
    return trimmed.replace(/^https?:\/\//i, '').replace(/\/+$/g, '');
  }

  private extractManagedFileKey(fileUrl: string | null | undefined): string | null {
    const raw = String(fileUrl || '').trim();
    if (!raw) {
      return null;
    }

    if (raw.startsWith('/uploads/')) {
      return raw.slice('/uploads/'.length).replace(/^\/+/, '');
    }

    const normalizedRawKey = raw.replace(/^\/+/, '');
    if (this.isLikelyManagedObjectKey(normalizedRawKey)) {
      return normalizedRawKey;
    }

    const normalizedCdn = this.cdnBaseUrl.replace(/\/+$/, '');
    if (normalizedCdn && raw.startsWith(`${normalizedCdn}/`)) {
      return raw.slice(normalizedCdn.length + 1).replace(/^\/+/, '');
    }

    try {
      const parsed = new URL(raw);
      const pathname = parsed.pathname.replace(/^\/+/, '');
      if (!pathname) {
        return null;
      }

      if (this.ossBucket && this.ossEndpoint) {
        const expectedHost = `${this.ossBucket}.${this.ossEndpoint}`.toLowerCase();
        if (parsed.host.toLowerCase() === expectedHost) {
          return pathname;
        }
      }

      if (normalizedCdn) {
        const cdnParsed = new URL(normalizedCdn.startsWith('http') ? normalizedCdn : `https://${normalizedCdn}`);
        if (parsed.host.toLowerCase() === cdnParsed.host.toLowerCase()) {
          const cdnPath = cdnParsed.pathname.replace(/^\/+|\/+$/g, '');
          if (!cdnPath) {
            return pathname;
          }
          if (pathname.startsWith(`${cdnPath}/`)) {
            return pathname.slice(cdnPath.length + 1);
          }
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private isLikelyManagedObjectKey(value: string): boolean {
    const normalized = String(value || '').trim();
    if (!normalized || normalized.includes('://') || normalized.startsWith('data:')) {
      return false;
    }
    if (!normalized.includes('/') || normalized.includes('..')) {
      return false;
    }
    if (!/^[a-z0-9][a-z0-9/_.,@+=:-]*$/i.test(normalized)) {
      return false;
    }
    const prefix = normalized.split('/')[0]?.toLowerCase();
    return ['ai', 'uploads', 'generated', 'assets'].includes(prefix);
  }

  private buildOssClient() {
    const accessKeyId = this.ossAccessKeyId || this.config.aliyun?.accessKeyId;
    const accessKeySecret = this.ossAccessKeySecret || this.config.aliyun?.accessKeySecret;

    if (!accessKeyId || !accessKeySecret || !this.ossBucket || !this.ossEndpoint) {
      return null;
    }

    return new OSS({
      accessKeyId,
      accessKeySecret,
      bucket: this.ossBucket,
      endpoint: this.ossEndpoint,
      secure: true,
      timeout: this.ossTimeoutMs || Number(this.config.aliyun?.oss?.timeoutMs || 300_000),
    });
  }

  private async refreshStorageProviderConfig(force = false) {
    if (!force && Date.now() < this.storageConfigExpiresAt) {
      return;
    }

    const provider = await this.runtimeSettingsService.resolveDefaultStorageProviderConfig().catch(() => null);
    if (provider?.provider_type === 'ALIYUN_OSS') {
      const nextBucket = String(provider.bucket || '').trim();
      const nextEndpoint = this.normalizeEndpoint(provider.endpoint || '');
      const nextAccessKeyId = String(provider.access_key_id || '').trim();
      const nextAccessKeySecret = String(provider.access_key_secret || '').trim();
      if (nextBucket && nextEndpoint && nextAccessKeyId && nextAccessKeySecret) {
        const changed =
          this.ossBucket !== nextBucket ||
          this.ossEndpoint !== nextEndpoint ||
          this.ossAccessKeyId !== nextAccessKeyId ||
          this.ossAccessKeySecret !== nextAccessKeySecret;
        this.ossBucket = nextBucket;
        this.ossEndpoint = nextEndpoint;
        this.ossAccessKeyId = nextAccessKeyId;
        this.ossAccessKeySecret = nextAccessKeySecret;
        this.ossTimeoutMs = Number(provider.timeout_ms || 300_000);
        this.cdnBaseUrl = String(provider.cdn_base_url || '').trim();
        this.cdnAuthEnabled = Boolean(provider.cdn_auth_enabled);
        this.cdnAuthKey = String(provider.cdn_auth_key || '').trim();
        const cdnWindow = Number(provider.cdn_auth_window_seconds || 120);
        this.cdnAuthWindowSeconds = Number.isFinite(cdnWindow)
          ? Math.max(30, Math.min(MAX_READABLE_URL_EXPIRES_SECONDS, Math.floor(cdnWindow)))
          : 120;
        if (changed || !this.ossClient) {
          this.ossClient = this.buildOssClient();
        }
        this.storageConfigExpiresAt = Date.now() + 30_000;
        return;
      }
    }

    this.storageConfigExpiresAt = Date.now() + 30_000;
  }

  private async persistLocalFile(fileKey: string, fileBuffer: Buffer) {
    const localPath = path.resolve(process.cwd(), 'uploads', fileKey);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, fileBuffer);
  }

  private async persistLocalStream(fileKey: string, stream: Readable) {
    const localPath = path.resolve(process.cwd(), 'uploads', fileKey);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await pipeline(stream, createWriteStream(localPath));
  }
}
