import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { tenantControllerPaths, resolveAppSlug } from '../../common/utils/controller-paths';
import { AiAgentsService } from './ai-agents.service';

@ApiTags('AIAgentsApp')
@Controller(tenantControllerPaths('agent', true))
export class AiAgentsAppController {
  constructor(private readonly aiAgentsService: AiAgentsService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: '当前 app 已发布 Agent 列表' })
  async listAppAgents(@Req() req: any) {
    const appSlug = resolveAppSlug(req);
    return this.aiAgentsService.listPublishedAgentsForApp(String(appSlug || ''));
  }

  @Get(':slug/meta')
  @Public()
  @ApiOperation({ summary: '获取 Agent 元信息' })
  async getAgentMeta(@Req() req: any, @Param('slug') slug: string) {
    const appSlug = resolveAppSlug(req);
    return this.aiAgentsService.getAgentMetaForApp(String(appSlug || ''), slug);
  }

  @Post(':slug/run')
  @Public()
  @ApiOperation({ summary: '执行 Agent' })
  async runAgent(@Req() req: any, @Param('slug') slug: string, @Body() body: Record<string, unknown>) {
    const appSlug = resolveAppSlug(req);
    return this.aiAgentsService.runAgentForApp(req, String(appSlug || ''), slug, body);
  }

  @Post(':slug/stream')
  @Public()
  @ApiOperation({ summary: '流式执行 Agent' })
  async runAgentStream(
    @Req() req: any,
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const appSlug = resolveAppSlug(req);
    const streamResponse = await this.aiAgentsService.runAgentForAppStream(req, String(appSlug || ''), slug, body);
    await this.pipeStream(res, streamResponse.status, streamResponse.headers, streamResponse.body);
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
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.removeHeader('Content-Length');
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
        if (chunk.done) break;
        if (chunk.value) {
          res.write(Buffer.from(chunk.value));
          const flush = (res as unknown as { flush?: () => void }).flush;
          if (typeof flush === 'function') {
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
