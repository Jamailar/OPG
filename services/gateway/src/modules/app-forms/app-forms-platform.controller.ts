import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { AppFormsService } from './app-forms.service';

@ApiTags('App Forms')
@Controller('/api/v1/platform-admin/apps/:app_id/forms')
@UseGuards(JwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class AppFormsPlatformController {
  constructor(private readonly appFormsService: AppFormsService) {}

  @Get()
  @ApiOperation({ summary: '表单列表' })
  async listForms(@Param('app_id') appId: string) {
    return this.appFormsService.listForms(appId);
  }

  @Post()
  @ApiOperation({ summary: '创建表单' })
  async createForm(@Param('app_id') appId: string, @Req() req: any, @Body() body: unknown) {
    return this.appFormsService.createForm(appId, req?.user?.id || req?.user?.userId || null, body);
  }

  @Get(':form_id')
  @ApiOperation({ summary: '表单详情' })
  async getForm(@Param('app_id') appId: string, @Param('form_id') formId: string) {
    return this.appFormsService.getForm(appId, formId);
  }

  @Patch(':form_id')
  @ApiOperation({ summary: '更新表单' })
  async updateForm(@Param('app_id') appId: string, @Param('form_id') formId: string, @Req() req: any, @Body() body: unknown) {
    return this.appFormsService.updateForm(appId, formId, req?.user?.id || req?.user?.userId || null, body);
  }

  @Delete(':form_id')
  @ApiOperation({ summary: '删除表单' })
  async deleteForm(@Param('app_id') appId: string, @Param('form_id') formId: string) {
    return this.appFormsService.deleteForm(appId, formId);
  }

  @Post(':form_id/publish')
  @ApiOperation({ summary: '发布表单版本' })
  async publishForm(@Param('app_id') appId: string, @Param('form_id') formId: string, @Req() req: any) {
    return this.appFormsService.publishForm(appId, formId, req?.user?.id || req?.user?.userId || null);
  }

  @Get(':form_id/responses')
  @ApiOperation({ summary: '表单提交记录' })
  async listResponses(
    @Param('app_id') appId: string,
    @Param('form_id') formId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.appFormsService.listResponses(appId, formId, query);
  }

  @Get(':form_id/metrics')
  @ApiOperation({ summary: '表单指标' })
  async getMetrics(@Param('app_id') appId: string, @Param('form_id') formId: string) {
    return this.appFormsService.getMetrics(appId, formId);
  }

  @Post(':form_id/questions')
  @ApiOperation({ summary: '新增问题' })
  async createQuestion(@Param('app_id') appId: string, @Param('form_id') formId: string, @Body() body: unknown) {
    return this.appFormsService.createQuestion(appId, formId, body);
  }

  @Patch(':form_id/questions/reorder')
  @ApiOperation({ summary: '调整问题顺序' })
  async reorderQuestions(@Param('app_id') appId: string, @Param('form_id') formId: string, @Body() body: unknown) {
    return this.appFormsService.reorderQuestions(appId, formId, body);
  }

  @Patch(':form_id/questions/:question_id')
  @ApiOperation({ summary: '更新问题' })
  async updateQuestion(
    @Param('app_id') appId: string,
    @Param('form_id') formId: string,
    @Param('question_id') questionId: string,
    @Body() body: unknown,
  ) {
    return this.appFormsService.updateQuestion(appId, formId, questionId, body);
  }

  @Delete(':form_id/questions/:question_id')
  @ApiOperation({ summary: '删除问题' })
  async deleteQuestion(@Param('app_id') appId: string, @Param('form_id') formId: string, @Param('question_id') questionId: string) {
    return this.appFormsService.deleteQuestion(appId, formId, questionId);
  }

  @Post(':form_id/logic-rules')
  @ApiOperation({ summary: '新增逻辑规则' })
  async createLogicRule(@Param('app_id') appId: string, @Param('form_id') formId: string, @Body() body: unknown) {
    return this.appFormsService.createLogicRule(appId, formId, body);
  }

  @Patch(':form_id/logic-rules/:rule_id')
  @ApiOperation({ summary: '更新逻辑规则' })
  async updateLogicRule(
    @Param('app_id') appId: string,
    @Param('form_id') formId: string,
    @Param('rule_id') ruleId: string,
    @Body() body: unknown,
  ) {
    return this.appFormsService.updateLogicRule(appId, formId, ruleId, body);
  }

  @Delete(':form_id/logic-rules/:rule_id')
  @ApiOperation({ summary: '删除逻辑规则' })
  async deleteLogicRule(@Param('app_id') appId: string, @Param('form_id') formId: string, @Param('rule_id') ruleId: string) {
    return this.appFormsService.deleteLogicRule(appId, formId, ruleId);
  }

  @Post(':form_id/actions')
  @ApiOperation({ summary: '新增表单动作' })
  async createAction(@Param('app_id') appId: string, @Param('form_id') formId: string, @Body() body: unknown) {
    return this.appFormsService.createAction(appId, formId, body);
  }

  @Patch(':form_id/actions/:action_id')
  @ApiOperation({ summary: '更新表单动作' })
  async updateAction(
    @Param('app_id') appId: string,
    @Param('form_id') formId: string,
    @Param('action_id') actionId: string,
    @Body() body: unknown,
  ) {
    return this.appFormsService.updateAction(appId, formId, actionId, body);
  }

  @Delete(':form_id/actions/:action_id')
  @ApiOperation({ summary: '删除表单动作' })
  async deleteAction(@Param('app_id') appId: string, @Param('form_id') formId: string, @Param('action_id') actionId: string) {
    return this.appFormsService.deleteAction(appId, formId, actionId);
  }
}
