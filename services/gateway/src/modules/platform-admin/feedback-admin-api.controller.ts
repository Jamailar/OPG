import { Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import { FeedbackAdminApiKeyGuard } from '../../common/guards/feedback-admin-api-key.guard';
import { FeedbackService } from '../feedback/feedback.service';
import { RuntimeSettingsService } from '../runtime-settings/runtime-settings.service';

type FeedbackAdminActorRow = {
  id: string;
};

@ApiTags('FeedbackAdminApi')
@Controller(['/api/v1/platform-admin/feedback-issues', '/platform-admin/feedback-issues'])
@UseGuards(FeedbackAdminApiKeyGuard)
@ApiBearerAuth()
export class FeedbackAdminApiController {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly feedbackService: FeedbackService,
    private readonly runtimeSettingsService: RuntimeSettingsService,
  ) {}

  @Get()
  @ApiOperation({ summary: '管理员 Key 读取反馈工单列表' })
  async listFeedbackIssues(
    @Query('app_id') appId?: string,
    @Query('app_slug') appSlug?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('assignee_user_id') assigneeUserId?: string,
    @Query('q') q?: string,
  ) {
    const resolvedAppId = await this.resolveAppId({ appId, appSlug });
    return this.feedbackService.listFeedbacksByAppId(resolvedAppId, {
      page,
      page_size: pageSize,
      status,
      priority,
      assignee_user_id: assigneeUserId,
      q,
    });
  }

  @Get(':feedback_id')
  @ApiOperation({ summary: '管理员 Key 读取反馈工单详情' })
  async getFeedbackIssue(
    @Param('feedback_id') feedbackId: string,
    @Query('app_id') appId?: string,
    @Query('app_slug') appSlug?: string,
  ) {
    const resolvedAppId = await this.resolveAppId({ appId, appSlug });
    return this.feedbackService.getFeedbackByAppId(resolvedAppId, feedbackId);
  }

  @Patch(':feedback_id')
  @ApiOperation({ summary: '管理员 Key 更新反馈工单' })
  async updateFeedbackIssue(
    @Param('feedback_id') feedbackId: string,
    @Query('app_id') appId: string | undefined,
    @Query('app_slug') appSlug: string | undefined,
    @Body() body: Record<string, unknown> = {},
  ) {
    const resolvedAppId = await this.resolveAppId({
      appId: appId || String(body.app_id || ''),
      appSlug: appSlug || String(body.app_slug || ''),
    });
    const actorUserId = await this.resolveActorUserId(resolvedAppId, body);
    return this.feedbackService.updateFeedbackByAppId(resolvedAppId, feedbackId, actorUserId, body);
  }

  @Post(':feedback_id/comments')
  @ApiOperation({ summary: '管理员 Key 新增反馈工单评论' })
  async addFeedbackIssueComment(
    @Param('feedback_id') feedbackId: string,
    @Query('app_id') appId: string | undefined,
    @Query('app_slug') appSlug: string | undefined,
    @Body() body: { app_id?: string; app_slug?: string; body?: string; is_internal?: boolean; actor_user_id?: string } = {},
  ) {
    const resolvedAppId = await this.resolveAppId({
      appId: appId || String(body.app_id || ''),
      appSlug: appSlug || String(body.app_slug || ''),
    });
    const actorUserId = await this.resolveActorUserId(resolvedAppId, body);
    return this.feedbackService.addFeedbackCommentByAppId(resolvedAppId, feedbackId, actorUserId, body);
  }

  @Post(':feedback_id/review')
  @ApiOperation({ summary: '管理员 Key 评审反馈工单' })
  async reviewFeedbackIssue(
    @Param('feedback_id') feedbackId: string,
    @Query('app_id') appId: string | undefined,
    @Query('app_slug') appSlug: string | undefined,
    @Body() body: { app_id?: string; app_slug?: string; action?: string; note?: string; actor_user_id?: string } = {},
  ) {
    const resolvedAppId = await this.resolveAppId({
      appId: appId || String(body.app_id || ''),
      appSlug: appSlug || String(body.app_slug || ''),
    });
    const actorUserId = await this.resolveActorUserId(resolvedAppId, body);
    return this.feedbackService.reviewFeedbackByAppId(resolvedAppId, feedbackId, actorUserId, body);
  }

  private async resolveAppId(input: { appId?: string; appSlug?: string }): Promise<string> {
    const appId = String(input.appId || '').trim();
    if (appId) {
      const app = await this.prisma.app.findUnique({ where: { id: appId }, select: { id: true } });
      if (!app) {
        throw new NotFoundException('App not found');
      }
      return app.id;
    }

    const appSlug = String(input.appSlug || '').trim().toLowerCase();
    if (!appSlug) {
      throw new NotFoundException('app_id or app_slug is required');
    }
    const app = await this.prisma.app.findUnique({ where: { slug: appSlug }, select: { id: true } });
    if (!app) {
      throw new NotFoundException('App not found');
    }
    return app.id;
  }

  private async resolveActorUserId(appId: string, body: Record<string, unknown>): Promise<string> {
    const integrationSettings = (await this.runtimeSettingsService.getIntegrationSettings().catch(() => ({}))) as Record<string, unknown>;
    const configuredActor = String(integrationSettings.feedback_admin_actor_user_id || '').trim();
    const requestedActor = String(body.actor_user_id || configuredActor || process.env.FEEDBACK_ADMIN_API_ACTOR_USER_ID || '').trim();
    if (requestedActor) {
      const rows = (await this.prisma.$queryRawUnsafe(
        `SELECT id
         FROM users
         WHERE app_id = $1::uuid
           AND id = $2::uuid
           AND deleted_at IS NULL
         LIMIT 1`,
        appId,
        requestedActor,
      )) as FeedbackAdminActorRow[];
      if (rows[0]) {
        return rows[0].id;
      }
    }

    const rows = (await this.prisma.$queryRawUnsafe(
      `SELECT id
       FROM users
       WHERE app_id = $1::uuid
         AND deleted_at IS NULL
         AND (role = 'ADMIN' OR is_superuser = true)
       ORDER BY is_superuser DESC, created_at ASC
       LIMIT 1`,
      appId,
    )) as FeedbackAdminActorRow[];
    if (!rows[0]) {
      throw new NotFoundException('No admin user found for feedback API actor');
    }
    return rows[0].id;
  }
}
