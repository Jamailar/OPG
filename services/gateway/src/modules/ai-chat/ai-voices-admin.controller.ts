import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AiDebugJwtAuthGuard } from './guards/ai-debug-jwt-auth.guard';
import { AiVoicesService } from './ai-voices.service';

@ApiTags('PlatformAIVoices')
@Controller('/api/v1/platform-admin/ai/voices')
@UseGuards(AiDebugJwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class AiVoicesAdminController {
  constructor(private readonly aiVoicesService: AiVoicesService) {}

  @Get()
  @ApiOperation({ summary: 'List voice assets' })
  async listVoices(@Query() query: Record<string, unknown>) {
    return this.aiVoicesService.listAdminVoices(query || {});
  }

  @Post('migration-jobs')
  @ApiOperation({ summary: 'Create voice migration job' })
  async createMigrationJob(@Req() req: any, @Body() body: Record<string, unknown>) {
    return this.aiVoicesService.createMigrationJob(req.user?.id || null, body || {});
  }

  @Get('migration-jobs/:job_id')
  @ApiOperation({ summary: 'Get voice migration job' })
  async getMigrationJob(@Param('job_id') jobId: string) {
    return this.aiVoicesService.getMigrationJob(jobId);
  }

  @Post(':voice_id/migrate')
  @ApiOperation({ summary: 'Migrate one voice asset' })
  async migrateVoice(@Param('voice_id') voiceId: string, @Body() body: Record<string, unknown>) {
    return this.aiVoicesService.migrateVoice(voiceId, body || {});
  }

  @Post(':voice_id/retry-clone')
  @ApiOperation({ summary: 'Retry voice clone' })
  async retryClone(@Param('voice_id') voiceId: string, @Body() body: Record<string, unknown>) {
    return this.aiVoicesService.retryClone(voiceId, body || {});
  }

  @Post(':voice_id/activate-mapping')
  @ApiOperation({ summary: 'Activate voice provider mapping' })
  async activateMapping(@Param('voice_id') voiceId: string, @Body() body: Record<string, unknown>) {
    return this.aiVoicesService.activateMapping(voiceId, String(body?.mapping_id || body?.mappingId || '').trim());
  }
}
