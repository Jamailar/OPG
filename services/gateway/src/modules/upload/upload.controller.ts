import { BadRequestException, Body, Controller, Param, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { diskStorage, memoryStorage } from 'multer';
import { extname } from 'path';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { UploadService } from './upload.service';

@ApiTags('Upload')
@Controller(tenantControllerPaths('upload', true))
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('presigned-url')
  @ApiOperation({ summary: '获取预签名上传URL' })
  async getPresignedUrl(
    @Req() req: any,
    @Param('app') app: string,
    @Body()
    body: {
      filename: string;
      content_type?: string;
      contentType?: string;
      key_prefix?: string;
      keyPrefix?: string;
      app_slug?: string;
      appSlug?: string;
      app_id?: string;
      appId?: string;
    },
  ) {
    return this.uploadService.getPresignedUrl(
      req.user.id,
      body.filename,
      body.content_type || body.contentType || 'application/octet-stream',
      body.app_slug || body.appSlug || app || req.user.appSlug,
      body.key_prefix || body.keyPrefix,
      body.app_id || body.appId,
    );
  }

  @Post('audio')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/audio',
        filename: (_req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join('');
          cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: '上传音频文件' })
  @ApiConsumes('multipart/form-data')
  async uploadAudio(@UploadedFile() file: Express.Multer.File, @Req() req: any, @Param('app') app: string) {
    return this.uploadService.uploadAudio(file, req.user.id, app || req.user.appSlug);
  }

  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/images',
        filename: (_req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join('');
          cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: '上传图片文件' })
  @ApiConsumes('multipart/form-data')
  async uploadImage(@UploadedFile() file: Express.Multer.File, @Req() req: any, @Param('app') app: string) {
    return this.uploadService.uploadImage(file, req.user.id, app || req.user.appSlug);
  }

  @Post('image-buffer')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: '上传图片到 OSS（服务端中转，避免浏览器直传跨域限制）' })
  @ApiConsumes('multipart/form-data')
  async uploadImageBuffer(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
    @Param('app') app: string,
    @Body()
    body: {
      app_slug?: string;
      appSlug?: string;
      app_id?: string;
      appId?: string;
      key_prefix?: string;
      keyPrefix?: string;
    },
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const appSlug = body.app_slug || body.appSlug || app || req.user.appSlug;
    const keyPrefix = body.key_prefix || body.keyPrefix || 'uploads/images';
    const appId = body.app_id || body.appId;
    return this.uploadService.uploadBuffer(
      req.user.id,
      file.originalname,
      file.mimetype || 'application/octet-stream',
      file.buffer,
      appSlug,
      keyPrefix,
      appId,
    );
  }

  @Post('file-buffer')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: '上传任意文件到 OSS（服务端中转）' })
  @ApiConsumes('multipart/form-data')
  async uploadFileBuffer(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
    @Param('app') app: string,
    @Body()
    body: {
      app_slug?: string;
      appSlug?: string;
      app_id?: string;
      appId?: string;
      key_prefix?: string;
      keyPrefix?: string;
      content_type?: string;
      contentType?: string;
    },
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const appSlug = body.app_slug || body.appSlug || app || req.user.appSlug;
    const keyPrefix = body.key_prefix || body.keyPrefix || 'uploads/files';
    const appId = body.app_id || body.appId;
    return this.uploadService.uploadBuffer(
      req.user.id,
      file.originalname,
      body.content_type || body.contentType || file.mimetype || 'application/octet-stream',
      file.buffer,
      appSlug,
      keyPrefix,
      appId,
    );
  }

  @Post('file')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/files',
        filename: (_req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join('');
          cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: '上传通用文件' })
  @ApiConsumes('multipart/form-data')
  async uploadFile(@UploadedFile() file: Express.Multer.File, @Req() req: any, @Param('app') app: string) {
    return this.uploadService.uploadFile(file, req.user.id, app || req.user.appSlug);
  }
}
