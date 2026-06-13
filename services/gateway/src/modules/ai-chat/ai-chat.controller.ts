import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Response, Express } from 'express';
import { AiChatService, ForwardedAiResponse } from './ai-chat.service';
import { AiDebugJwtAuthGuard } from './guards/ai-debug-jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { resolveAppSlug, tenantControllerPaths } from '../../common/utils/controller-paths';

@ApiTags('AIChat')
@Controller([...tenantControllerPaths('ai', true), ...tenantControllerPaths('ai-chat', true)])
@UseGuards(AiDebugJwtAuthGuard)
@ApiBearerAuth()
export class AiChatController {
  constructor(private readonly aiChatService: AiChatService) {}

  @Post('chat')
  @ApiOperation({ summary: 'AI 对话（兼容模式）' })
  async chat(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.chatLegacy(appSlug, body, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Post('chat/completions')
  @ApiOperation({ summary: 'OpenAI-compatible 聊天转发' })
  async chatCompletions(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.forwardChatCompletions(appSlug, body, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Get('models')
  @ApiOperation({ summary: '获取当前租户可用 AI 模型列表' })
  async listModels(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Query('capability') capability?: string,
  ) {
    const appSlug = app || req.user.appSlug;
    return this.aiChatService.listAvailableModels(appSlug, capability);
  }

  @Get('default-models')
  @Public()
  @ApiOperation({ summary: '获取当前租户默认模型列表' })
  async listDefaultModels(@Req() req: any, @Param('app') app: string | undefined) {
    const appSlug = resolveAppSlug(req, app);
    if (!appSlug) {
      throw new BadRequestException('app is required');
    }
    return this.aiChatService.listDefaultModelSlots(appSlug);
  }

  @Get('models/pricing')
  @Public()
  @ApiOperation({ summary: '获取当前租户可用 AI 模型价格（按能力分组）' })
  async listModelPricing(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Query('app') _appQuery: string | undefined,
    @Query('refresh') refresh: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = resolveAppSlug(req, app);
    if (!appSlug) {
      throw new BadRequestException('app is required');
    }
    const normalizedRefresh = String(refresh || '').trim().toLowerCase();
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=30');
    return this.aiChatService.listOpenAiModelPricing(appSlug, {
      refresh: normalizedRefresh === '1' || normalizedRefresh === 'true',
    });
  }

  @Post('capabilities/:capability/invoke')
  @ApiOperation({ summary: '按能力调用 AI（chat/embedding/tts/stt/image/video）' })
  async invokeByCapability(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Param('capability') capability: string,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.forwardCapability(req, app, capability, body, res);
  }

  @Post('embeddings')
  @ApiOperation({ summary: 'OpenAI-compatible Embeddings 转发' })
  async embeddings(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.forwardCapability(req, app, 'embedding', body, res);
  }

  @Post('audio/speech')
  @ApiOperation({ summary: 'OpenAI-compatible TTS 转发' })
  async textToSpeech(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.forwardCapability(req, app, 'tts', body, res);
  }

  @Post('google/tts/speech')
  @ApiOperation({ summary: 'Google Gemini TTS 转发' })
  async googleTtsSpeech(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.forwardGoogleTtsSpeech(appSlug, body, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Post('audio/speech/tasks/query')
  @ApiOperation({ summary: 'MiniMax 异步语音任务查询' })
  async queryTtsTask(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.queryTtsAsyncTask(appSlug, body, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Get('audio/voices/minimax')
  @ApiOperation({ summary: '获取 MiniMax 音色列表' })
  async getMinimaxVoices(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Query('q') q?: string,
    @Query('language') language?: string,
    @Query('language_boost') languageBoost?: string,
    @Query('language_en') languageEn?: string,
    @Query('language_zh') languageZh?: string,
    @Query('gender') gender?: string,
    @Query('limit') limit?: string,
    @Query('grouped') grouped?: string,
  ) {
    return this.aiChatService.listMinimaxVoices(app || req.user.appSlug, {
      q,
      language,
      language_boost: languageBoost,
      language_en: languageEn,
      language_zh: languageZh,
      gender,
      limit,
      grouped,
    });
  }

  @Get('audio/voices/gemini')
  @ApiOperation({ summary: '获取 Gemini TTS 音色列表' })
  async getGeminiVoices(
    @Query('q') q?: string,
    @Query('language') language?: string,
    @Query('limit') limit?: string,
  ) {
    return this.aiChatService.listGeminiVoices({
      q,
      language,
      limit,
    });
  }

  @Post('audio/transcriptions')
  @ApiOperation({ summary: 'OpenAI-compatible STT 转发' })
  async transcription(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.forwardCapability(req, app, 'stt', body, res);
  }

  @Post('images/generations')
  @ApiOperation({ summary: 'OpenAI-compatible 图片生成转发' })
  async imageGeneration(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.forwardCapability(req, app, 'image', body, res);
  }

  @Post('images/edits')
  @ApiOperation({ summary: 'OpenAI-compatible 图片编辑转发' })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'image', maxCount: 4 },
      { name: 'mask', maxCount: 1 },
    ]),
  )
  async imageEdits(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
    const payload = this.buildOpenAiImageEditPayload(body || {}, files);
    return this.forwardCapability(req, app, 'image', payload, res);
  }

  @Post('images/edit')
  @ApiOperation({ summary: 'OpenAI-compatible 图片编辑转发（别名）' })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'image', maxCount: 4 },
      { name: 'mask', maxCount: 1 },
    ]),
  )
  async imageEditLegacy(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
    const payload = this.buildOpenAiImageEditPayload(body || {}, files);
    return this.forwardCapability(req, app, 'image', payload, res);
  }

  @Post('images/variations')
  @ApiOperation({ summary: 'OpenAI-compatible 图片变体转发' })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'image', maxCount: 1 },
    ]),
  )
  async imageVariations(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
    const payload = this.buildOpenAiImageEditPayload(body || {}, files);
    return this.forwardCapability(req, app, 'image', payload, res);
  }

  @Post('videos/generations')
  @ApiOperation({ summary: '视频生成转发（能力路由）' })
  async videoGeneration(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.forwardCapability(req, app, 'video', body, res);
  }

  @Post('videos/generations/async')
  @ApiOperation({ summary: '视频生成异步创建（能力路由）' })
  async videoGenerationAsync(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.invokeVideoAsync(appSlug, body, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Post('videos/generations/tasks/query')
  @ApiOperation({ summary: '视频生成异步任务查询（能力路由）' })
  async queryVideoTask(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.queryVideoAsyncTask(appSlug, body, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Post('video-translation/jobs')
  @ApiOperation({ summary: '提交视频翻译任务' })
  async submitVideoTranslationJob(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.submitVideoTranslationJob(appSlug, body, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Post('video-translation/jobs/query')
  @ApiOperation({ summary: '查询视频翻译任务' })
  async queryVideoTranslationJob(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.queryVideoTranslationJob(appSlug, body, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Get('video-translation/jobs/:task_id')
  @ApiOperation({ summary: '查询视频翻译任务' })
  async getVideoTranslationJob(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Param('task_id') taskId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.queryVideoTranslationJob(appSlug, { task_id: taskId }, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Post('video-retalk/jobs')
  @ApiOperation({ summary: '提交 VideoRetalk 任务' })
  async submitVideoRetalkJob(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.submitVideoRetalkJob(appSlug, body, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Post('video-retalk/jobs/query')
  @ApiOperation({ summary: '查询 VideoRetalk 任务' })
  async queryVideoRetalkJob(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: Record<string, unknown> = {},
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.queryVideoRetalkJob(appSlug, body, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Get('video-retalk/jobs/:task_id')
  @ApiOperation({ summary: '查询 VideoRetalk 任务' })
  async getVideoRetalkJob(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Param('task_id') taskId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.queryVideoRetalkJob(appSlug, { task_id: taskId }, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  @Get('history')
  @ApiOperation({ summary: '获取对话历史' })
  async getHistory(@Req() req: any, @Query('limit') limit?: number) {
    return this.aiChatService.getChatHistory(req.user.userId, limit || 20);
  }

  private async forwardCapability(
    req: any,
    app: string | undefined,
    capability: string,
    body: Record<string, unknown>,
    res: Response,
  ) {
    const appSlug = app || req.user.appSlug;
    const forwarded = await this.aiChatService.invokeByCapability(appSlug, capability, body, {
      user_id: req.user.id,
      request_path: req.originalUrl || req.url,
    });
    return this.writeForwardedResponse(res, forwarded);
  }

  private buildOpenAiImageEditPayload(
    body: Record<string, unknown>,
    files: Record<string, Express.Multer.File[]>,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...body };
    const imageFiles = Array.isArray(files.image) ? files.image : [];
    const maskFile = Array.isArray(files.mask) ? files.mask[0] : undefined;

    if (imageFiles.length > 0) {
      const dataUrls = imageFiles
        .filter((file) => file?.buffer?.length)
        .map((file) => {
          const mime = file.mimetype || 'application/octet-stream';
          return `data:${mime};base64,${file.buffer.toString('base64')}`;
        });
      if (dataUrls[0]) {
        payload.image = dataUrls[0];
      }
      if (dataUrls.length > 1) {
        payload.images = dataUrls;
      }
    }

    if (maskFile?.buffer?.length) {
      const mime = maskFile.mimetype || 'application/octet-stream';
      payload.mask = `data:${mime};base64,${maskFile.buffer.toString('base64')}`;
    }

    return payload;
  }

  private async writeForwardedResponse(res: Response, forwarded: ForwardedAiResponse) {
    if (forwarded.stream) {
      await this.pipeStream(res, forwarded.status, forwarded.headers, forwarded.body);
      return;
    }

    if ('binary' in forwarded && forwarded.binary) {
      res.status(forwarded.status || 200);
      Object.entries(forwarded.headers || {}).forEach(([key, value]) => {
        if (value) {
          res.setHeader(key, value);
        }
      });
      res.send(forwarded.body);
      return;
    }

    if ('data' in forwarded) {
      return forwarded.data;
    }

    return;
  }

  private async pipeStream(
    res: Response,
    status: number,
    headers: Record<string, string>,
    body: ReadableStream<Uint8Array> | null,
  ) {
    res.status(status || 200);
    Object.entries(headers).forEach(([key, value]) => {
      if (value) {
        res.setHeader(key, value);
      }
    });
    const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
    const isSseStream = contentType.includes('text/event-stream');
    if (isSseStream) {
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Content-Encoding', 'identity');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.removeHeader('Content-Length');
    }
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    if (!body) {
      res.end();
      return;
    }

    const reader = body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        if (chunk.value) {
          res.write(Buffer.from(chunk.value));
          const flush = (res as unknown as { flush?: () => void }).flush;
          if (isSseStream && typeof flush === 'function') {
            flush.call(res);
          }
        }
      }
    } finally {
      reader.releaseLock();
      res.end();
    }
  }
}
