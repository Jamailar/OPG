import { Body, Controller, Delete, Get, Param, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { resolveAppSlug, tenantControllerPaths } from '../../common/utils/controller-paths';
import { OpenAiCompatAuthGuard } from './guards/openai-compat-auth.guard';
import { AiVoicesService } from './ai-voices.service';

@ApiTags('AIVoices')
@Controller([...tenantControllerPaths('audio/voices', true), '/v1/audio/voices'])
@UseGuards(OpenAiCompatAuthGuard)
@ApiBearerAuth()
export class AiVoicesController {
  constructor(private readonly aiVoicesService: AiVoicesService) {}

  @Post('clone')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: 'Create a portable cloned voice' })
  @ApiConsumes('multipart/form-data')
  async cloneVoice(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const appSlug = this.resolveApp(req);
    return this.aiVoicesService.cloneVoice({
      appSlug,
      userId: req.user?.id || null,
      file,
      sample_file_url: String(body?.sample_file_url || body?.sampleFileUrl || '').trim(),
      sample_file_key: String(body?.sample_file_key || body?.sampleFileKey || '').trim(),
      name: String(body?.name || body?.display_name || '').trim(),
      language: String(body?.language || '').trim(),
      model: String(body?.model || '').trim(),
      metadata: typeof body?.metadata === 'object' && body?.metadata !== null
        ? body.metadata as Record<string, unknown>
        : undefined,
    });
  }

  @Get()
  @ApiOperation({ summary: 'List portable voices' })
  async listVoices(@Req() req: any, @Query() query: Record<string, unknown>) {
    const appSlug = this.resolveApp(req);
    return this.aiVoicesService.listVoices(appSlug, req.user?.id || null, query || {});
  }

  @Get(':voice_id')
  @ApiOperation({ summary: 'Get portable voice status' })
  async getVoice(@Req() req: any, @Param('voice_id') voiceId: string) {
    const appSlug = this.resolveApp(req);
    return this.aiVoicesService.getVoiceByPublicId(appSlug, voiceId, req.user?.id || null);
  }

  @Delete(':voice_id')
  @ApiOperation({ summary: 'Delete portable voice' })
  async deleteVoice(@Req() req: any, @Param('voice_id') voiceId: string) {
    const appSlug = this.resolveApp(req);
    return this.aiVoicesService.deleteVoice(appSlug, voiceId, req.user?.id || null);
  }

  private resolveApp(req: any): string {
    return resolveAppSlug(req) || '';
  }
}
