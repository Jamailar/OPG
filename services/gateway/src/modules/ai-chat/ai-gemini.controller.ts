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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AiChatService, ForwardedAiResponse } from './ai-chat.service';
import { OpenAiCompatAuthGuard } from './guards/openai-compat-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { resolveAppSlug, tenantRootControllerPaths } from '../../common/utils/controller-paths';

@ApiTags('AIGeminiCompat')
@Controller(tenantRootControllerPaths('v1beta', true))
@UseGuards(OpenAiCompatAuthGuard)
@ApiBearerAuth()
export class AiGeminiController {
  constructor(private readonly aiChatService: AiChatService) {}

  @Get('models')
  @ApiOperation({ summary: 'Gemini-compatible models list' })
  async models(@Req() req: any, @Res() res: Response) {
    return this.handleJson(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.listGeminiModels(appSlug);
    });
  }

  @Get('models/pricing')
  @Public()
  @ApiOperation({ summary: 'Gemini-compatible model pricing by type' })
  async modelPricing(@Req() req: any, @Query('app') _appQuery: string | undefined, @Res() res: Response) {
    const refresh = String(req.query?.refresh || '').trim().toLowerCase();
    const shouldRefresh = refresh === '1' || refresh === 'true';
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=30');
    return this.handleJson(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.listOpenAiModelPricing(appSlug, { refresh: shouldRefresh });
    });
  }

  @Get('models/:model')
  @ApiOperation({ summary: 'Gemini-compatible model detail' })
  async modelDetail(@Req() req: any, @Param('model') model: string, @Res() res: Response) {
    return this.handleJson(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.getGeminiModel(appSlug, model);
    });
  }

  @Post(['models/:model\\:generateContent', 'models/:model/generateContent'])
  @ApiOperation({ summary: 'Gemini-compatible generateContent' })
  async generateContent(
    @Req() req: any,
    @Param('model') model: string,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.forwardGeminiGenerateContent(appSlug, model, body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post(['models/:model\\:streamGenerateContent', 'models/:model/streamGenerateContent'])
  @ApiOperation({ summary: 'Gemini-compatible streamGenerateContent' })
  async streamGenerateContent(
    @Req() req: any,
    @Param('model') model: string,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.handleForwarded(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.forwardGeminiStreamGenerateContent(appSlug, model, body || {}, {
        user_id: req.user.id,
        request_path: req.originalUrl || req.url,
      });
    });
  }

  @Post(['models/:model\\:embedContent', 'models/:model/embedContent'])
  @ApiOperation({ summary: 'Gemini-compatible embedContent' })
  async embedContent(
    @Req() req: any,
    @Param('model') model: string,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.handleJson(res, async () => {
      const appSlug = this.resolveApp(req);
      return this.aiChatService.forwardGeminiEmbedContent(appSlug, model, body || {}, {
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
      return this.writeGeminiError(res, error);
    }
  }

  private async handleForwarded(res: Response, handler: () => Promise<ForwardedAiResponse>) {
    try {
      const forwarded = await handler();
      return this.writeForwardedResponse(res, forwarded);
    } catch (error: any) {
      return this.writeGeminiError(res, error);
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
      res.status(forwarded.status || 200);
      Object.entries(forwarded.headers || {}).forEach(([key, value]) => {
        if (value) {
          res.setHeader(key, value);
        }
      });
      if (!forwarded.body) {
        res.end();
        return;
      }
      const reader = forwarded.body.getReader();
      const pump = async () => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          if (chunk.value) {
            res.write(Buffer.from(chunk.value));
          }
        }
        res.end();
      };
      await pump();
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

    if (!('data' in forwarded)) {
      throw new BadRequestException('invalid forwarded JSON response');
    }

    return res.status(200).json(forwarded.data);
  }

  private writeGeminiError(res: Response, error: unknown) {
    const status = this.resolveStatus(error);
    const message = this.resolveMessage(error);
    return res.status(status).json({
      error: {
        code: status,
        message,
        status: this.resolveGeminiStatus(status),
      },
    });
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
      return error.message;
    }
    return 'Internal Server Error';
  }

  private resolveGeminiStatus(status: number): string {
    if (status === 400) {
      return 'INVALID_ARGUMENT';
    }
    if (status === 401) {
      return 'UNAUTHENTICATED';
    }
    if (status === 403) {
      return 'PERMISSION_DENIED';
    }
    if (status === 404) {
      return 'NOT_FOUND';
    }
    if (status === 429) {
      return 'RESOURCE_EXHAUSTED';
    }
    if (status >= 500) {
      return 'INTERNAL';
    }
    return 'UNKNOWN';
  }
}
