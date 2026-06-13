import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiDebugJwtAuthGuard } from '../ai-chat/guards/ai-debug-jwt-auth.guard';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AiAgentsService } from './ai-agents.service';

@ApiTags('AIAgentsPlatform')
@Controller('/api/v1/platform-admin')
@UseGuards(AiDebugJwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class AiAgentsPlatformController {
  constructor(private readonly aiAgentsService: AiAgentsService) {}

  @Get('agents')
  @ApiOperation({ summary: '平台 Agent 列表' })
  async listAgents() {
    return this.aiAgentsService.listPlatformAgents();
  }

  @Get('agents/:agent_id')
  @ApiOperation({ summary: '平台 Agent 详情' })
  async getAgent(@Param('agent_id') agentId: string) {
    return this.aiAgentsService.getPlatformAgent(agentId);
  }

  @Post('agents')
  @ApiOperation({ summary: '创建平台 Agent' })
  async createAgent(@Req() req: any, @Body() body: Record<string, unknown>) {
    return this.aiAgentsService.createPlatformAgent(req.user.id, body);
  }

  @Put('agents/:agent_id')
  @ApiOperation({ summary: '更新平台 Agent（生成新版本）' })
  async updateAgent(@Req() req: any, @Param('agent_id') agentId: string, @Body() body: Record<string, unknown>) {
    return this.aiAgentsService.updatePlatformAgent(agentId, req.user.id, body);
  }

  @Post('agents/:agent_id/publish')
  @ApiOperation({ summary: '发布平台 Agent 最新版本' })
  async publishAgent(@Req() req: any, @Param('agent_id') agentId: string) {
    return this.aiAgentsService.publishPlatformAgent(agentId, req.user.id);
  }

  @Post('agents/:agent_id/archive')
  @ApiOperation({ summary: '归档平台 Agent' })
  async archiveAgent(@Req() req: any, @Param('agent_id') agentId: string) {
    return this.aiAgentsService.archivePlatformAgent(agentId, req.user.id);
  }

  @Delete('agents/:agent_id')
  @ApiOperation({ summary: '删除平台 Agent' })
  async deleteAgent(@Param('agent_id') agentId: string) {
    return this.aiAgentsService.deletePlatformAgent(agentId);
  }

  @Post('agents/:agent_id/test')
  @ApiOperation({ summary: '平台管理员测试 Agent 最新版本' })
  async testAgent(@Req() req: any, @Param('agent_id') agentId: string, @Body() body: Record<string, unknown>) {
    return this.aiAgentsService.runPlatformAgentTest(agentId, req.user.id, body);
  }

  @Get('agent-tools')
  @ApiOperation({ summary: '平台 Agent 工具目录' })
  async listTools() {
    return this.aiAgentsService.listToolCatalog();
  }

  @Get('agent-runs')
  @ApiOperation({ summary: '平台 Agent 运行日志' })
  async listRuns(
    @Query('agent_id') agentId?: string,
    @Query('app_id') appId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.aiAgentsService.listAgentRuns({
      agent_id: agentId,
      app_id: appId,
      status,
      page: page ? Number(page) : undefined,
      page_size: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('agent-runs/:run_id')
  @ApiOperation({ summary: '平台 Agent 运行详情' })
  async getRun(@Param('run_id') runId: string) {
    return this.aiAgentsService.getAgentRunDetail(runId);
  }

  @Get('apps/:app_id/agents')
  @ApiOperation({ summary: '租户 Agent 发布绑定列表' })
  async listAppBindings(@Param('app_id') appId: string) {
    return this.aiAgentsService.listAppAgentBindings(appId);
  }

  @Put('apps/:app_id/agents/:agent_id/binding')
  @ApiOperation({ summary: '更新租户 Agent 绑定' })
  async upsertAppBinding(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('agent_id') agentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.aiAgentsService.upsertAppAgentBinding(appId, agentId, req.user.id, body);
  }

  @Delete('apps/:app_id/agents/:agent_id/binding')
  @ApiOperation({ summary: '删除租户 Agent 绑定' })
  async deleteAppBinding(@Param('app_id') appId: string, @Param('agent_id') agentId: string) {
    return this.aiAgentsService.deleteAppAgentBinding(appId, agentId);
  }
}
