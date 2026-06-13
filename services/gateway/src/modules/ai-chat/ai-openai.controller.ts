import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response, Express } from 'express';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { AiChatService, ForwardedAiResponse } from './ai-chat.service';
import { OpenAiCompatAuthGuard } from './guards/openai-compat-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { resolveAppSlug } from '../../common/utils/controller-paths';

@ApiTags('AIOpenAICompat')
@Controller(['/:app/v1', '/api/v1', '/v1'])
@UseGuards(OpenAiCompatAuthGuard)
@ApiBearerAuth()
export class AiOpenAiController {
  constructor(private readonly aiChatService: AiChatService) {}

  @Post('chat/completions')
  @ApiOperation({ summary: 'OpenAI-compatible chat/completions' })
  async chatCompletions(@Req() req: any, @Body() body: Record<string, unknown>, @Res() res: Response) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.forwardChatCompletions(appSlug, body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('completions')
  @ApiOperation({ summary: 'OpenAI-compatible completions (text)' })
  async completions(@Req() req: any, @Body() body: Record<string, unknown>, @Res() res: Response) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.forwardCompletions(appSlug, body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('responses')
  @ApiOperation({ summary: 'OpenAI-compatible responses (supports stream)' })
  async responses(@Req() req: any, @Body() body: Record<string, unknown>, @Res() res: Response) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.forwardResponses(appSlug, body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Get('models')
  @ApiOperation({ summary: 'OpenAI-compatible models list' })
  async models(@Req() req: any, @Res() res: Response) {
    return this.handleJson(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.listOpenAiModels(appSlug);
    });
  }

  @Get('models/pricing')
  @Public()
  @ApiOperation({ summary: 'OpenAI-compatible model pricing by type' })
  async modelPricing(@Req() req: any, @Query('app') _appQuery: string | undefined, @Res() res: Response) {
    const refresh = String(req.query?.refresh || '').trim().toLowerCase();
    const shouldRefresh = refresh === '1' || refresh === 'true';
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=30');
    return this.handleJson(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.listOpenAiModelPricing(appSlug, { refresh: shouldRefresh });
    });
  }

  @Get('default-models')
  @Public()
  @ApiOperation({ summary: 'App default model list' })
  async defaultModels(@Req() req: any, @Res() res: Response) {
    return this.handleJson(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.listDefaultModelSlots(appSlug);
    });
  }

  @Get('models/:model')
  @ApiOperation({ summary: 'OpenAI-compatible model detail' })
  async modelDetail(@Req() req: any, @Param('model') model: string, @Res() res: Response) {
    return this.handleJson(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.getOpenAiModel(appSlug, model);
    });
  }

  @Post('embeddings')
  @ApiOperation({ summary: 'OpenAI-compatible embeddings' })
  async embeddings(@Req() req: any, @Body() body: Record<string, unknown>, @Res() res: Response) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.invokeByCapability(appSlug, 'embedding', body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('audio/speech')
  @ApiOperation({ summary: 'OpenAI-compatible audio/speech' })
  async speech(@Req() req: any, @Body() body: Record<string, unknown>, @Res() res: Response) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.invokeByCapability(appSlug, 'tts', body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('google/tts/speech')
  @ApiOperation({ summary: 'Google Gemini TTS speech' })
  async googleTtsSpeech(@Req() req: any, @Body() body: Record<string, unknown>, @Res() res: Response) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.forwardGoogleTtsSpeech(appSlug, body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('vertex/tts/speech')
  @ApiOperation({ summary: 'Vertex AI Gemini TTS speech' })
  async vertexTtsSpeech(@Req() req: any, @Body() body: Record<string, unknown>, @Res() res: Response) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.forwardVertexTtsSpeech(appSlug, body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('audio/transcriptions')
  @ApiOperation({ summary: 'OpenAI-compatible audio/transcriptions' })
  @UseInterceptors(FileInterceptor('file'))
  async transcriptions(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      const payload = this.buildOpenAiAudioPayload(body || {}, file, 'transcribe');
      return this.aiChatService.invokeByCapability(appSlug, 'stt', payload, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('audio/translations')
  @ApiOperation({ summary: 'OpenAI-compatible audio/translations' })
  @UseInterceptors(FileInterceptor('file'))
  async translations(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      const payload = this.buildOpenAiAudioPayload(body || {}, file, 'translate');
      return this.aiChatService.invokeByCapability(appSlug, 'stt', payload, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('images/generations')
  @ApiOperation({ summary: 'OpenAI-compatible images/generations' })
  async images(@Req() req: any, @Body() body: Record<string, unknown>, @Res() res: Response) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.invokeByCapability(appSlug, 'image', body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('videos/generations')
  @ApiOperation({ summary: 'OpenAI-compatible videos/generations' })
  async videos(@Req() req: any, @Body() body: Record<string, unknown>, @Res() res: Response) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.invokeByCapability(appSlug, 'video', body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('videos/generations/async')
  @ApiOperation({ summary: 'OpenAI-compatible videos/generations async' })
  async videosAsync(@Req() req: any, @Body() body: Record<string, unknown>, @Res() res: Response) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.invokeVideoAsync(appSlug, body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('videos/generations/tasks/query')
  @ApiOperation({ summary: 'OpenAI-compatible videos/generations task query' })
  async videoTaskQuery(@Req() req: any, @Body() body: Record<string, unknown>, @Res() res: Response) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.queryVideoAsyncTask(appSlug, body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('images/edits')
  @ApiOperation({ summary: 'OpenAI-compatible images/edits' })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'image', maxCount: 4 },
      { name: 'mask', maxCount: 1 },
    ]),
  )
  async imageEdits(
    @Req() req: any,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      const payload = this.buildOpenAiImageEditPayload(body || {}, files);
      return this.aiChatService.invokeByCapability(appSlug, 'image', payload, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('images/edit')
  @ApiOperation({ summary: 'OpenAI-compatible images/edit' })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'image', maxCount: 4 },
      { name: 'mask', maxCount: 1 },
    ]),
  )
  async imageEditLegacy(
    @Req() req: any,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      const payload = this.buildOpenAiImageEditPayload(body || {}, files);
      return this.aiChatService.invokeByCapability(appSlug, 'image', payload, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post('images/variations')
  @ApiOperation({ summary: 'OpenAI-compatible images/variations' })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'image', maxCount: 1 },
    ]),
  )
  async imageVariations(
    @Req() req: any,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      const payload = this.buildOpenAiImageEditPayload(body || {}, files);
      return this.aiChatService.invokeByCapability(appSlug, 'image', payload, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  private async handleJson(res: Response, handler: () => Promise<Record<string, unknown>>) {
    try {
      const payload = await handler();
      return res.status(200).json(payload);
    } catch (error: any) {
      return this.writeOpenAiError(res, error);
    }
  }

  private async handleForwarded(res: Response, handler: () => Promise<ForwardedAiResponse>) {
    try {
      const forwarded = await handler();
      return this.writeForwardedResponse(res, forwarded);
    } catch (error: any) {
      return this.writeOpenAiError(res, error);
    }
  }

  private resolveApp(req: any): string {
    const appSlug = resolveAppSlug(req);
    if (!appSlug) {
      throw new BadRequestException('app is required');
    }
    return appSlug;
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
      res.status(200).json(forwarded.data);
      return;
    }

    res.status(200).json({});
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

  private writeOpenAiError(res: Response, error: unknown) {
    const status = this.resolveStatus(error);
    const message = this.resolveMessage(error);
    const type = this.resolveErrorType(status);
    return res.status(status).json({
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    });
  }

  private buildOpenAiAudioPayload(
    body: Record<string, unknown>,
    file: Express.Multer.File | undefined,
    defaultTask: 'transcribe' | 'translate',
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      ...body,
      task: body.task ?? defaultTask,
    };

    if (file && file.buffer?.length) {
      payload.__multipart = {
        file_field_name: 'file',
        file_base64: file.buffer.toString('base64'),
        file_name: file.originalname || 'audio.wav',
        file_mime_type: file.mimetype || 'application/octet-stream',
      };
      return payload;
    }

    const fileBase64 = typeof body.file_base64 === 'string' ? body.file_base64.trim() : '';
    if (!fileBase64) {
      throw new BadRequestException('file is required (multipart file or file_base64)');
    }
    payload.__multipart = {
      file_field_name: 'file',
      file_base64: fileBase64,
      file_name: typeof body.file_name === 'string' ? body.file_name : 'audio.wav',
      file_mime_type: typeof body.file_mime_type === 'string' ? body.file_mime_type : 'application/octet-stream',
    };
    return payload;
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

  private resolveStatus(error: unknown): number {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    return 500;
  }

  private resolveMessage(error: unknown): string {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'string') {
        return response;
      }
      if (response && typeof response === 'object') {
        const payload = response as Record<string, unknown>;
        if (typeof payload.message === 'string' && payload.message.trim()) {
          return payload.message;
        }
      }
      return error.message;
    }
    if (error instanceof Error) {
      return error.message || 'Internal server error';
    }
    return 'Internal server error';
  }

  private resolveErrorType(status: number): string {
    if (status === 400 || status === 404 || status === 422) {
      return 'invalid_request_error';
    }
    if (status === 401 || status === 403) {
      return 'authentication_error';
    }
    if (status === 429) {
      return 'rate_limit_error';
    }
    return 'api_error';
  }
}
