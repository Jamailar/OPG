import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { PlatformAdminAccessGuard } from '../../common/guards/platform-admin-access.guard';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { AiChatService } from '../ai-chat/ai-chat.service';
import { EmailDeliveryService } from '../email-delivery/email-delivery.service';
import { OutboundProxyService } from '../outbound-proxy/outbound-proxy.service';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminAiDebugJwtAuthGuard } from './guards/platform-admin-ai-debug-jwt-auth.guard';
import { RuntimeSettingsService } from '../runtime-settings/runtime-settings.service';
import { AiGatewayObservabilityService } from '../ai-chat/ai-gateway-observability.service';
import { PlatformObservabilityService } from '../observability/platform-observability.service';
import { PlatformTasksService } from '../platform-tasks/platform-tasks.service';
import { PlatformTaskStatus } from '../platform-tasks/platform-tasks.types';

@ApiTags('PlatformAdmin')
@Controller(tenantControllerPaths('platform-admin', true))
@UseGuards(PlatformAdminAiDebugJwtAuthGuard, AdminRoleGuard, PlatformAdminAccessGuard)
@ApiBearerAuth()
export class PlatformAdminController {
  constructor(
    private readonly platformAdminService: PlatformAdminService,
    private readonly aiChatService: AiChatService,
    private readonly emailDeliveryService: EmailDeliveryService,
    private readonly outboundProxyService: OutboundProxyService,
    private readonly runtimeSettingsService: RuntimeSettingsService,
    private readonly aiGatewayObservabilityService: AiGatewayObservabilityService,
    private readonly platformObservabilityService: PlatformObservabilityService,
    private readonly platformTasksService: PlatformTasksService,
  ) {}

  @Get('apps')
  @ApiOperation({ summary: '租户应用列表' })
  async listApps(@Query('include_inactive') includeInactive?: string) {
    return this.platformAdminService.listApps(includeInactive !== 'false');
  }

  @Get('runtime-settings')
  @ApiOperation({ summary: '平台运行时设置' })
  async getRuntimeSettings() {
    return this.runtimeSettingsService.getAdminRuntimeSettings();
  }

  @Patch('runtime-settings')
  @ApiOperation({ summary: '更新平台运行时设置' })
  async updateRuntimeSettings(@Req() req: any, @Body() body: any) {
    return this.runtimeSettingsService.updateAdminRuntimeSettings(req.user.id, body || {});
  }

  @Get('observability/runtime')
  @ApiOperation({ summary: '平台运行观测摘要' })
  async getPlatformObservabilityRuntime() {
    return this.platformObservabilityService.getRuntimeSummary();
  }

  @Get('observability/request-events')
  @ApiOperation({ summary: '平台请求事件' })
  async listPlatformRequestEvents(
    @Query('app_id') appId?: string,
    @Query('actor_user_id') actorUserId?: string,
    @Query('request_id') requestId?: string,
    @Query('module') module?: string,
    @Query('operation') operation?: string,
    @Query('resource_type') resourceType?: string,
    @Query('resource_id') resourceId?: string,
    @Query('success') success?: string,
    @Query('status_min') statusMin?: string,
    @Query('days') days?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.platformObservabilityService.listRequestEvents({
      app_id: appId,
      actor_user_id: actorUserId,
      request_id: requestId,
      module,
      operation,
      resource_type: resourceType,
      resource_id: resourceId,
      success,
      status_min: statusMin,
      days,
      page,
      page_size: pageSize,
    });
  }

  @Get('observability/audit-events')
  @ApiOperation({ summary: '平台审计事件' })
  async listPlatformAuditEvents(
    @Query('actor_user_id') actorUserId?: string,
    @Query('app_id') appId?: string,
    @Query('module') module?: string,
    @Query('action') action?: string,
    @Query('resource_type') resourceType?: string,
    @Query('resource_id') resourceId?: string,
    @Query('days') days?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.platformObservabilityService.listAuditEvents({
      actor_user_id: actorUserId,
      app_id: appId,
      module,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      days,
      page,
      page_size: pageSize,
    });
  }


  @Get('tasks/runtime')
  @ApiOperation({ summary: '平台任务运行摘要' })
  async getPlatformTaskRuntime() {
    return this.platformTasksService.getRuntime();
  }

  @Get('tasks')
  @ApiOperation({ summary: '平台任务列表' })
  async listPlatformTasks(
    @Query('app_id') appId?: string,
    @Query('module') module?: string,
    @Query('action') action?: string,
    @Query('status') status?: string,
    @Query('queue_name') queueName?: string,
    @Query('request_id') requestId?: string,
    @Query('source_type') sourceType?: string,
    @Query('source_id') sourceId?: string,
    @Query('days') days?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.platformTasksService.listTasks({
      app_id: appId,
      module,
      action,
      status,
      queue_name: queueName,
      request_id: requestId,
      source_type: sourceType,
      source_id: sourceId,
      days,
      page,
      page_size: pageSize,
    });
  }

  @Get('tasks/:task_id')
  @ApiOperation({ summary: '平台任务详情' })
  async getPlatformTask(@Param('task_id') taskId: string) {
    return this.platformTasksService.getTask(taskId);
  }

  @Post('tasks')
  @ApiOperation({ summary: '创建平台任务' })
  async createPlatformTask(@Req() req: any, @Body() body: any) {
    return this.platformTasksService.createTask(body || {}, req.user?.id);
  }

  @Post('tasks/:task_id/transition')
  @ApiOperation({ summary: '更新平台任务状态' })
  async transitionPlatformTask(@Req() req: any, @Param('task_id') taskId: string, @Body() body: any) {
    return this.platformTasksService.transitionTask(taskId, String(body?.status || '') as PlatformTaskStatus, body || {}, req.user?.id);
  }

  @Post('tasks/:task_id/events')
  @ApiOperation({ summary: '追加平台任务事件' })
  async appendPlatformTaskEvent(@Param('task_id') taskId: string, @Body() body: any) {
    return this.platformTasksService.appendEvent(taskId, body || {});
  }

  @Post('tasks/:task_id/logs')
  @ApiOperation({ summary: '追加平台任务日志' })
  async appendPlatformTaskLog(@Param('task_id') taskId: string, @Body() body: any) {
    return this.platformTasksService.appendLog(taskId, body || {});
  }

  @Post('tasks/:task_id/cancel')
  @ApiOperation({ summary: '取消平台任务' })
  async cancelPlatformTask(@Req() req: any, @Param('task_id') taskId: string) {
    return this.platformTasksService.cancelTask(taskId, req.user?.id);
  }

  @Post('tasks/workers/heartbeat')
  @ApiOperation({ summary: '上报平台任务 worker 心跳' })
  async recordPlatformTaskWorkerHeartbeat(@Body() body: any) {
    return this.platformTasksService.recordWorkerHeartbeat(body || {});
  }

  @Get('storage/providers')
  @ApiOperation({ summary: '平台对象存储 provider 列表' })
  async listStorageProviders() {
    return this.runtimeSettingsService.listStorageProviders();
  }

  @Post('storage/providers')
  @ApiOperation({ summary: '创建平台对象存储 provider' })
  async createStorageProvider(@Req() req: any, @Body() body: any) {
    return this.runtimeSettingsService.createStorageProvider(req.user.id, body || {});
  }

  @Patch('storage/providers/:provider_id')
  @ApiOperation({ summary: '更新平台对象存储 provider' })
  async updateStorageProvider(@Req() req: any, @Param('provider_id') providerId: string, @Body() body: any) {
    return this.runtimeSettingsService.updateStorageProvider(providerId, req.user.id, body || {});
  }

  @Delete('storage/providers/:provider_id')
  @ApiOperation({ summary: '删除平台对象存储 provider' })
  async deleteStorageProvider(@Param('provider_id') providerId: string) {
    return this.runtimeSettingsService.deleteStorageProvider(providerId);
  }

  @Post('storage/providers/:provider_id/test')
  @ApiOperation({ summary: '测试平台对象存储 provider' })
  async testStorageProvider(@Param('provider_id') providerId: string) {
    return this.runtimeSettingsService.testStorageProvider(providerId);
  }

  @Get('integration-api-keys')
  @ApiOperation({ summary: '平台集成 API Key 列表' })
  async listPlatformApiKeys() {
    return this.runtimeSettingsService.listPlatformApiKeys();
  }

  @Post('integration-api-keys')
  @ApiOperation({ summary: '创建平台集成 API Key' })
  async createPlatformApiKey(@Req() req: any, @Body() body: any) {
    return this.runtimeSettingsService.createPlatformApiKey(req.user.id, body || {});
  }

  @Post('integration-api-keys/:api_key_id/revoke')
  @ApiOperation({ summary: '撤销平台集成 API Key' })
  async revokePlatformApiKey(@Param('api_key_id') apiKeyId: string) {
    return this.runtimeSettingsService.revokePlatformApiKey(apiKeyId);
  }

  @Get('smtp/providers')
  @ApiOperation({ summary: '平台 SMTP provider 列表' })
  async listSmtpProviders() {
    return this.runtimeSettingsService.listSmtpProviders();
  }

  @Post('smtp/providers')
  @ApiOperation({ summary: '创建平台 SMTP provider' })
  async createSmtpProvider(@Req() req: any, @Body() body: any) {
    return this.runtimeSettingsService.createSmtpProvider(req.user.id, body || {});
  }

  @Patch('smtp/providers/:provider_id')
  @ApiOperation({ summary: '更新平台 SMTP provider' })
  async updateSmtpProvider(@Req() req: any, @Param('provider_id') providerId: string, @Body() body: any) {
    return this.runtimeSettingsService.updateSmtpProvider(providerId, req.user.id, body || {});
  }

  @Delete('smtp/providers/:provider_id')
  @ApiOperation({ summary: '删除平台 SMTP provider' })
  async deleteSmtpProvider(@Param('provider_id') providerId: string) {
    return this.runtimeSettingsService.deleteSmtpProvider(providerId);
  }

  @Post('smtp/providers/:provider_id/test')
  @ApiOperation({ summary: '测试平台 SMTP provider' })
  async testSmtpProvider(@Param('provider_id') providerId: string) {
    return this.runtimeSettingsService.testSmtpProvider(providerId);
  }

  @Get('wechat/open-apps')
  @ApiOperation({ summary: '全局微信网页登录应用列表' })
  async listGlobalWechatOpenApps(@Req() req: any) {
    return this.platformAdminService.listGlobalWechatOpenApps(req.user.id);
  }

  @Post('wechat/open-apps')
  @ApiOperation({ summary: '创建全局微信网页登录应用' })
  async createGlobalWechatOpenApp(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.createGlobalWechatOpenApp(req.user.id, body);
  }

  @Put('wechat/open-apps/:open_app_id')
  @ApiOperation({ summary: '更新全局微信网页登录应用' })
  async updateGlobalWechatOpenApp(@Req() req: any, @Param('open_app_id') openAppId: string, @Body() body: any) {
    return this.platformAdminService.updateGlobalWechatOpenApp(openAppId, req.user.id, body);
  }

  @Delete('wechat/open-apps/:open_app_id')
  @ApiOperation({ summary: '删除全局微信网页登录应用' })
  async deleteGlobalWechatOpenApp(@Req() req: any, @Param('open_app_id') openAppId: string) {
    return this.platformAdminService.deleteGlobalWechatOpenApp(openAppId, req.user.id);
  }

  @Post('wechat/open-apps/:open_app_id/test')
  @ApiOperation({ summary: '测试全局微信网页登录应用' })
  async testGlobalWechatOpenApp(@Req() req: any, @Param('open_app_id') openAppId: string) {
    return this.platformAdminService.testGlobalWechatOpenApp(openAppId, req.user.id);
  }

  @Get('google/oauth-clients')
  @ApiOperation({ summary: '全局 Google 登录应用列表' })
  async listGlobalGoogleOAuthClients(@Req() req: any) {
    return this.platformAdminService.listGlobalGoogleOAuthClients(req.user.id);
  }

  @Post('google/oauth-clients')
  @ApiOperation({ summary: '创建全局 Google 登录应用' })
  async createGlobalGoogleOAuthClient(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.createGlobalGoogleOAuthClient(req.user.id, body);
  }

  @Put('google/oauth-clients/:client_id')
  @ApiOperation({ summary: '更新全局 Google 登录应用' })
  async updateGlobalGoogleOAuthClient(@Req() req: any, @Param('client_id') clientId: string, @Body() body: any) {
    return this.platformAdminService.updateGlobalGoogleOAuthClient(clientId, req.user.id, body);
  }

  @Delete('google/oauth-clients/:client_id')
  @ApiOperation({ summary: '删除全局 Google 登录应用' })
  async deleteGlobalGoogleOAuthClient(@Req() req: any, @Param('client_id') clientId: string) {
    return this.platformAdminService.deleteGlobalGoogleOAuthClient(clientId, req.user.id);
  }

  @Post('google/oauth-clients/:client_id/test')
  @ApiOperation({ summary: '测试全局 Google 登录应用' })
  async testGlobalGoogleOAuthClient(@Req() req: any, @Param('client_id') clientId: string) {
    return this.platformAdminService.testGlobalGoogleOAuthClient(clientId, req.user.id);
  }

  @Get('proxies')
  @ApiOperation({ summary: '出站代理列表' })
  async listOutboundProxies(
    @Query('q') q?: string,
    @Query('protocol') protocol?: string,
    @Query('status') status?: string,
  ) {
    return this.outboundProxyService.listProxies({ q, protocol, status });
  }

  @Post('proxies')
  @ApiOperation({ summary: '创建出站代理' })
  async createOutboundProxy(@Req() req: any, @Body() body: any) {
    return this.outboundProxyService.createProxy(req.user.id, body || {});
  }

  @Put('proxies/:proxy_id')
  @ApiOperation({ summary: '更新出站代理' })
  async updateOutboundProxy(@Req() req: any, @Param('proxy_id') proxyId: string, @Body() body: any) {
    return this.outboundProxyService.updateProxy(proxyId, req.user.id, body || {});
  }

  @Delete('proxies/:proxy_id')
  @ApiOperation({ summary: '删除出站代理' })
  async deleteOutboundProxy(@Param('proxy_id') proxyId: string) {
    return this.outboundProxyService.deleteProxy(proxyId);
  }

  @Post('proxies/:proxy_id/test')
  @ApiOperation({ summary: '测试出站代理' })
  async testOutboundProxy(@Param('proxy_id') proxyId: string, @Body() body: any) {
    return this.outboundProxyService.testProxy(proxyId, body || {});
  }

  @Post('proxies/batch-test')
  @ApiOperation({ summary: '批量测试出站代理' })
  async batchTestOutboundProxies(@Body() body: any) {
    return this.outboundProxyService.batchTest(body || {});
  }

  @Post('proxies/import')
  @ApiOperation({ summary: '导入出站代理' })
  async importOutboundProxies(@Req() req: any, @Body() body: any) {
    return this.outboundProxyService.importProxies(req.user.id, body || {});
  }

  @Get('proxies/export')
  @ApiOperation({ summary: '导出出站代理' })
  async exportOutboundProxies() {
    return this.outboundProxyService.exportProxies();
  }

  @Get('proxies/:proxy_id/check-logs')
  @ApiOperation({ summary: '出站代理检测日志' })
  async listOutboundProxyCheckLogs(@Param('proxy_id') proxyId: string, @Query('limit') limit?: string) {
    return this.outboundProxyService.listCheckLogs(proxyId, { limit: Number(limit) });
  }

  @Get('github/oauth-apps')
  @ApiOperation({ summary: '全局 GitHub 登录应用列表' })
  async listGlobalGitHubOAuthApps(@Req() req: any) {
    return this.platformAdminService.listGlobalGitHubOAuthApps(req.user.id);
  }

  @Post('github/oauth-apps')
  @ApiOperation({ summary: '创建全局 GitHub 登录应用' })
  async createGlobalGitHubOAuthApp(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.createGlobalGitHubOAuthApp(req.user.id, body);
  }

  @Put('github/oauth-apps/:app_id')
  @ApiOperation({ summary: '更新全局 GitHub 登录应用' })
  async updateGlobalGitHubOAuthApp(@Req() req: any, @Param('app_id') appId: string, @Body() body: any) {
    return this.platformAdminService.updateGlobalGitHubOAuthApp(appId, req.user.id, body);
  }

  @Delete('github/oauth-apps/:app_id')
  @ApiOperation({ summary: '删除全局 GitHub 登录应用' })
  async deleteGlobalGitHubOAuthApp(@Req() req: any, @Param('app_id') appId: string) {
    return this.platformAdminService.deleteGlobalGitHubOAuthApp(appId, req.user.id);
  }

  @Post('github/oauth-apps/:app_id/test')
  @ApiOperation({ summary: '测试全局 GitHub 登录应用' })
  async testGlobalGitHubOAuthApp(@Req() req: any, @Param('app_id') appId: string) {
    return this.platformAdminService.testGlobalGitHubOAuthApp(appId, req.user.id);
  }

  @Get('apple/login-credentials')
  @ApiOperation({ summary: '全局 Apple 登录凭证列表' })
  async listGlobalAppleLoginCredentials(@Req() req: any) {
    return this.platformAdminService.listGlobalAppleLoginCredentials(req.user.id);
  }

  @Post('apple/login-credentials')
  @ApiOperation({ summary: '创建全局 Apple 登录凭证' })
  async createGlobalAppleLoginCredential(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.createGlobalAppleLoginCredential(req.user.id, body || {});
  }

  @Put('apple/login-credentials/:credential_id')
  @ApiOperation({ summary: '更新全局 Apple 登录凭证' })
  async updateGlobalAppleLoginCredential(@Req() req: any, @Param('credential_id') credentialId: string, @Body() body: any) {
    return this.platformAdminService.updateGlobalAppleLoginCredential(credentialId, req.user.id, body || {});
  }

  @Delete('apple/login-credentials/:credential_id')
  @ApiOperation({ summary: '删除全局 Apple 登录凭证' })
  async deleteGlobalAppleLoginCredential(@Req() req: any, @Param('credential_id') credentialId: string) {
    return this.platformAdminService.deleteGlobalAppleLoginCredential(credentialId, req.user.id);
  }

  @Post('apple/login-credentials/:credential_id/test')
  @ApiOperation({ summary: '测试全局 Apple 登录凭证' })
  async testGlobalAppleLoginCredential(@Req() req: any, @Param('credential_id') credentialId: string) {
    return this.platformAdminService.testGlobalAppleLoginCredential(credentialId, req.user.id);
  }

  @Get('payments/methods')
  @ApiOperation({ summary: '平台支付方式配置列表（支付宝/微信）' })
  async listGlobalPaymentMethods(@Req() req: any) {
    return this.platformAdminService.listGlobalPaymentMethods(req.user.id);
  }

  @Get('email/cloudflare/accounts')
  @ApiOperation({ summary: 'Cloudflare 邮件账号列表' })
  async listEmailCloudflareAccounts() {
    return this.emailDeliveryService.listCloudflareAccounts();
  }

  @Post('email/cloudflare/accounts')
  @ApiOperation({ summary: '创建 Cloudflare 邮件账号' })
  async createEmailCloudflareAccount(@Req() req: any, @Body() body: any) {
    return this.emailDeliveryService.createCloudflareAccount(req.user.id, body || {});
  }

  @Post('email/cloudflare/accounts/verify-token')
  @ApiOperation({ summary: '验证 Cloudflare 邮件账号令牌' })
  async verifyEmailCloudflareToken(@Body() body: any) {
    return this.emailDeliveryService.verifyCloudflareToken(body || {});
  }

  @Patch('email/cloudflare/accounts/:account_id')
  @ApiOperation({ summary: '更新 Cloudflare 邮件账号' })
  async updateEmailCloudflareAccount(@Param('account_id') accountId: string, @Body() body: any) {
    return this.emailDeliveryService.updateCloudflareAccount(accountId, body || {});
  }

  @Delete('email/cloudflare/accounts/:account_id')
  @ApiOperation({ summary: '删除 Cloudflare 邮件账号' })
  async deleteEmailCloudflareAccount(@Param('account_id') accountId: string) {
    return this.emailDeliveryService.deleteCloudflareAccount(accountId);
  }

  @Post('email/cloudflare/accounts/:account_id/test')
  @ApiOperation({ summary: '测试 Cloudflare 邮件账号' })
  async testEmailCloudflareAccount(@Param('account_id') accountId: string) {
    return this.emailDeliveryService.testCloudflareAccount(accountId);
  }

  @Get('email/cloudflare/accounts/:account_id/sending-domains')
  @ApiOperation({ summary: 'Cloudflare 邮件发送域名列表' })
  async listEmailCloudflareSendingDomains(@Param('account_id') accountId: string) {
    return this.emailDeliveryService.listCloudflareSendingDomains(accountId);
  }

  @Get('email/senders')
  @ApiOperation({ summary: '发件邮箱列表' })
  async listEmailSenders(@Query('app_id') appId?: string) {
    return this.emailDeliveryService.listSenders(appId);
  }

  @Post('email/senders')
  @ApiOperation({ summary: '创建发件邮箱' })
  async createEmailSender(@Req() req: any, @Body() body: any) {
    return this.emailDeliveryService.createSender(req.user.id, body || {});
  }

  @Patch('email/senders/:sender_id')
  @ApiOperation({ summary: '更新发件邮箱' })
  async updateEmailSender(@Param('sender_id') senderId: string, @Body() body: any) {
    return this.emailDeliveryService.updateSender(senderId, body || {});
  }

  @Delete('email/senders/:sender_id')
  @ApiOperation({ summary: '删除发件邮箱' })
  async deleteEmailSender(@Param('sender_id') senderId: string) {
    return this.emailDeliveryService.deleteSender(senderId);
  }

  @Post('email/senders/:sender_id/test')
  @ApiOperation({ summary: '测试发件邮箱' })
  async testEmailSender(@Param('sender_id') senderId: string, @Body() body: any) {
    return this.emailDeliveryService.testSender(senderId, body || {});
  }

  @Post('payments/methods')
  @ApiOperation({ summary: '创建平台支付方式配置' })
  async createGlobalPaymentMethod(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.createGlobalPaymentMethod(req.user.id, body || {});
  }

  @Put('payments/methods/:method_id')
  @ApiOperation({ summary: '更新平台支付方式配置' })
  async updateGlobalPaymentMethod(@Req() req: any, @Param('method_id') methodId: string, @Body() body: any) {
    return this.platformAdminService.updateGlobalPaymentMethod(methodId, req.user.id, body || {});
  }

  @Delete('payments/methods/:method_id')
  @ApiOperation({ summary: '删除平台支付方式配置' })
  async deleteGlobalPaymentMethod(@Req() req: any, @Param('method_id') methodId: string) {
    return this.platformAdminService.deleteGlobalPaymentMethod(methodId, req.user.id);
  }

  @Post('payments/methods/test')
  @ApiOperation({ summary: '测试平台支付方式连通性' })
  async testGlobalPaymentMethod(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.testGlobalPaymentMethod(req.user.id, body || {});
  }

  @Get('payments/apps/:app_id/products')
  @ApiOperation({ summary: '平台支付测试：获取租户支付商品列表' })
  async listAppPaymentProductsForTest(@Req() req: any, @Param('app_id') appId: string) {
    return this.platformAdminService.listAppPaymentProductsForTest(appId, req.user.id);
  }

  @Get('apps/:app_id/payments/orders')
  @ApiOperation({ summary: '租户订单列表（平台视角）' })
  async listAppPaymentOrders(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('status') status?: string,
  ) {
    return this.platformAdminService.listAppPaymentOrders(appId, req.user.id, {
      page,
      page_size: pageSize,
      status,
    });
  }

  @Get('payments/apps/:app_id/orders')
  @ApiOperation({ summary: '租户订单列表（平台视角，兼容旧路径）' })
  async listAppPaymentOrdersLegacyPath(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('status') status?: string,
  ) {
    return this.platformAdminService.listAppPaymentOrders(appId, req.user.id, {
      page,
      page_size: pageSize,
      status,
    });
  }

  @Get('payments/orders')
  @ApiOperation({ summary: '租户订单列表（平台视角，query 兼容路径）' })
  async listAppPaymentOrdersQueryPath(
    @Req() req: any,
    @Query('app_id') appId?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('status') status?: string,
  ) {
    return this.platformAdminService.listAppPaymentOrders(String(appId || '').trim(), req.user.id, {
      page,
      page_size: pageSize,
      status,
    });
  }

  @Post('apps/:app_id/payments/orders/:order_id/refund')
  @ApiOperation({ summary: '租户订单退款（平台视角，支付宝）' })
  async refundAppPaymentOrder(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('order_id') orderId: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.refundAppPaymentOrder(appId, req.user.id, orderId, body || {});
  }

  @Post('payments/apps/:app_id/orders/:order_id/refund')
  @ApiOperation({ summary: '租户订单退款（平台视角，兼容旧路径）' })
  async refundAppPaymentOrderLegacyPath(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('order_id') orderId: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.refundAppPaymentOrder(appId, req.user.id, orderId, body || {});
  }

  @Post('payments/orders/:order_id/refund')
  @ApiOperation({ summary: '租户订单退款（平台视角，query 兼容路径）' })
  async refundAppPaymentOrderQueryPath(
    @Req() req: any,
    @Param('order_id') orderId: string,
    @Query('app_id') appId: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.refundAppPaymentOrder(String(appId || '').trim(), req.user.id, orderId, body || {});
  }

  @Post('payments/testing/one-time')
  @ApiOperation({ summary: '平台支付测试：支付宝单次支付' })
  async runPlatformPaymentOneTimeTest(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.runPlatformPaymentOneTimeTest(req.user.id, body || {});
  }

  @Post('payments/testing/wechat/one-time')
  @ApiOperation({ summary: '平台支付测试：微信单次支付' })
  async runPlatformPaymentWechatOneTimeTest(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.runPlatformPaymentWechatOneTimeTest(req.user.id, body || {});
  }

  @Post('payments/testing/recurring')
  @ApiOperation({ summary: '平台支付测试：支付宝签约' })
  async runPlatformPaymentRecurringTest(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.runPlatformPaymentRecurringTest(req.user.id, body || {});
  }

  @Post('payments/testing/full-flow')
  @ApiOperation({ summary: '平台支付测试：支付宝全链路' })
  async runPlatformPaymentFullFlowTest(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.runPlatformPaymentFullFlowTest(req.user.id, body || {});
  }

  @Get('sms/provider-catalog')
  @ApiOperation({ summary: '平台短信供应商类型目录' })
  async listSmsProviderCatalog(@Req() req: any) {
    return this.platformAdminService.listSmsProviderCatalog(req.user.id);
  }

  @Get('sms/providers')
  @ApiOperation({ summary: '平台短信服务配置列表' })
  async listGlobalSmsProviders(@Req() req: any) {
    return this.platformAdminService.listGlobalSmsProviders(req.user.id);
  }

  @Post('sms/providers')
  @ApiOperation({ summary: '创建平台短信服务配置' })
  async createGlobalSmsProvider(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.createGlobalSmsProvider(req.user.id, body || {});
  }

  @Put('sms/providers/:provider_id')
  @ApiOperation({ summary: '更新平台短信服务配置' })
  async updateGlobalSmsProvider(@Req() req: any, @Param('provider_id') providerId: string, @Body() body: any) {
    return this.platformAdminService.updateGlobalSmsProvider(providerId, req.user.id, body || {});
  }

  @Delete('sms/providers/:provider_id')
  @ApiOperation({ summary: '删除平台短信服务配置' })
  async deleteGlobalSmsProvider(@Req() req: any, @Param('provider_id') providerId: string) {
    return this.platformAdminService.deleteGlobalSmsProvider(providerId, req.user.id);
  }

  @Post('sms/providers/test')
  @ApiOperation({ summary: '测试平台短信服务连通性' })
  async testGlobalSmsProvider(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.testGlobalSmsProvider(req.user.id, body || {});
  }

  @Get('sms/signatures')
  @ApiOperation({ summary: '平台短信签名列表' })
  async listGlobalSmsSignatures(@Req() req: any, @Query('provider_id') providerId?: string) {
    return this.platformAdminService.listGlobalSmsSignatures(req.user.id, { provider_id: providerId });
  }

  @Post('sms/signatures')
  @ApiOperation({ summary: '创建平台短信签名' })
  async createGlobalSmsSignature(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.createGlobalSmsSignature(req.user.id, body || {});
  }

  @Put('sms/signatures/:signature_id')
  @ApiOperation({ summary: '更新平台短信签名' })
  async updateGlobalSmsSignature(@Req() req: any, @Param('signature_id') signatureId: string, @Body() body: any) {
    return this.platformAdminService.updateGlobalSmsSignature(signatureId, req.user.id, body || {});
  }

  @Delete('sms/signatures/:signature_id')
  @ApiOperation({ summary: '删除平台短信签名' })
  async deleteGlobalSmsSignature(@Req() req: any, @Param('signature_id') signatureId: string) {
    return this.platformAdminService.deleteGlobalSmsSignature(signatureId, req.user.id);
  }

  @Get('sms/templates')
  @ApiOperation({ summary: '平台短信模板列表' })
  async listGlobalSmsTemplates(@Req() req: any, @Query('provider_id') providerId?: string) {
    return this.platformAdminService.listGlobalSmsTemplates(req.user.id, { provider_id: providerId });
  }

  @Post('sms/templates')
  @ApiOperation({ summary: '创建平台短信模板' })
  async createGlobalSmsTemplate(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.createGlobalSmsTemplate(req.user.id, body || {});
  }

  @Put('sms/templates/:template_id')
  @ApiOperation({ summary: '更新平台短信模板' })
  async updateGlobalSmsTemplate(@Req() req: any, @Param('template_id') templateId: string, @Body() body: any) {
    return this.platformAdminService.updateGlobalSmsTemplate(templateId, req.user.id, body || {});
  }

  @Delete('sms/templates/:template_id')
  @ApiOperation({ summary: '删除平台短信模板' })
  async deleteGlobalSmsTemplate(@Req() req: any, @Param('template_id') templateId: string) {
    return this.platformAdminService.deleteGlobalSmsTemplate(templateId, req.user.id);
  }

  @Get('sms/events')
  @ApiOperation({ summary: '平台短信发送与配置审计事件' })
  async listSmsMessageEvents(@Req() req: any, @Query() query: any) {
    return this.platformAdminService.listSmsMessageEvents(req.user.id, query || {});
  }

  @Get('sms/summary')
  @ApiOperation({ summary: '平台短信可观测汇总' })
  async getSmsObservabilitySummary(@Req() req: any, @Query() query: any) {
    return this.platformAdminService.getSmsObservabilitySummary(req.user.id, query || {});
  }

  @Get('apps/:app_id')
  @ApiOperation({ summary: '租户应用详情' })
  async getApp(@Param('app_id') appId: string) {
    return this.platformAdminService.getAppDetail(appId);
  }

  @Post('apps')
  @ApiOperation({ summary: '创建租户应用' })
  async createApp(@Body() body: any) {
    return this.platformAdminService.createApp(body);
  }

  @Put('apps/:app_id')
  @ApiOperation({ summary: '更新租户应用' })
  async updateApp(@Param('app_id') appId: string, @Body() body: any) {
    return this.platformAdminService.updateApp(appId, body);
  }

  @Get('apps/:app_id/stats')
  @ApiOperation({ summary: '租户统计' })
  async getAppStats(@Param('app_id') appId: string) {
    return this.platformAdminService.getAppStats(appId);
  }

  @Post('apps/:app_id/sms/test-send')
  @ApiOperation({ summary: '租户应用短信测试发送' })
  async sendAppSmsTestCode(@Req() req: any, @Param('app_id') appId: string, @Body() body: any) {
    return this.platformAdminService.sendAppSmsTestCode(appId, req.user.id, body || {});
  }

  @Get('apps/:app_id/email/settings')
  @ApiOperation({ summary: '租户邮件配置' })
  async getAppEmailSettings(@Param('app_id') appId: string) {
    return this.emailDeliveryService.getAppEmailSettings(appId);
  }

  @Put('apps/:app_id/email/settings')
  @ApiOperation({ summary: '更新租户邮件配置' })
  async updateAppEmailSettings(@Param('app_id') appId: string, @Body() body: any) {
    return this.emailDeliveryService.updateAppEmailSettings(appId, body || {});
  }

  @Get('apps/:app_id/email/contacts')
  @ApiOperation({ summary: '租户邮件联系人列表' })
  async listAppEmailContacts(@Param('app_id') appId: string, @Query() query: any) {
    return this.emailDeliveryService.listContacts(appId, query || {});
  }

  @Post('apps/:app_id/email/contacts/import')
  @ApiOperation({ summary: '导入租户邮件联系人' })
  async importAppEmailContacts(@Param('app_id') appId: string, @Body() body: any) {
    return this.emailDeliveryService.importContacts(appId, body || {});
  }

  @Patch('apps/:app_id/email/contacts/:contact_id')
  @ApiOperation({ summary: '更新租户邮件联系人' })
  async updateAppEmailContact(@Param('app_id') appId: string, @Param('contact_id') contactId: string, @Body() body: any) {
    return this.emailDeliveryService.updateContact(appId, contactId, body || {});
  }

  @Get('apps/:app_id/email/templates')
  @ApiOperation({ summary: '租户邮件模板列表' })
  async listAppEmailTemplates(@Param('app_id') appId: string) {
    return this.emailDeliveryService.listTemplates(appId);
  }

  @Post('apps/:app_id/email/templates')
  @ApiOperation({ summary: '创建租户邮件模板' })
  async createAppEmailTemplate(@Param('app_id') appId: string, @Body() body: any) {
    return this.emailDeliveryService.saveTemplate(appId, body || {});
  }

  @Patch('apps/:app_id/email/templates/:template_id')
  @ApiOperation({ summary: '更新租户邮件模板' })
  async updateAppEmailTemplate(@Param('app_id') appId: string, @Param('template_id') templateId: string, @Body() body: any) {
    return this.emailDeliveryService.saveTemplate(appId, body || {}, templateId);
  }

  @Get('apps/:app_id/email/campaigns')
  @ApiOperation({ summary: '租户邮件批次列表' })
  async listAppEmailCampaigns(@Param('app_id') appId: string, @Query() query: any) {
    return this.emailDeliveryService.listCampaigns(appId, query || {});
  }

  @Post('apps/:app_id/email/campaigns')
  @ApiOperation({ summary: '创建租户邮件批次' })
  async createAppEmailCampaign(@Req() req: any, @Param('app_id') appId: string, @Body() body: any) {
    return this.emailDeliveryService.createCampaign(appId, req.user.id, body || {});
  }

  @Post('apps/:app_id/email/campaigns/:campaign_id/send-test')
  @ApiOperation({ summary: '测试发送租户邮件批次' })
  async sendAppEmailCampaignTest(@Param('app_id') appId: string, @Param('campaign_id') campaignId: string, @Body() body: any) {
    return this.emailDeliveryService.sendTestCampaign(appId, campaignId, body || {});
  }

  @Post('apps/:app_id/email/campaigns/:campaign_id/schedule')
  @ApiOperation({ summary: '发送或定时发送租户邮件批次' })
  async scheduleAppEmailCampaign(@Param('app_id') appId: string, @Param('campaign_id') campaignId: string, @Body() body: any) {
    return this.emailDeliveryService.scheduleCampaign(appId, campaignId, body || {});
  }

  @Post('apps/:app_id/email/campaigns/:campaign_id/cancel')
  @ApiOperation({ summary: '取消租户邮件批次' })
  async cancelAppEmailCampaign(@Param('app_id') appId: string, @Param('campaign_id') campaignId: string) {
    return this.emailDeliveryService.cancelCampaign(appId, campaignId);
  }

  @Get('apps/:app_id/email/campaigns/:campaign_id/recipients')
  @ApiOperation({ summary: '租户邮件批次收件人明细' })
  async listAppEmailCampaignRecipients(@Param('app_id') appId: string, @Param('campaign_id') campaignId: string, @Query() query: any) {
    return this.emailDeliveryService.listCampaignRecipients(appId, campaignId, query || {});
  }

  @Get('apps/:app_id/site')
  @ApiOperation({ summary: '租户官网配置' })
  async getAppSiteSettings(@Param('app_id') appId: string) {
    return this.platformAdminService.getAppSiteSettings(appId);
  }

  @Put('apps/:app_id/site')
  @ApiOperation({ summary: '更新租户官网配置' })
  async updateAppSiteSettings(@Param('app_id') appId: string, @Body() body: any) {
    return this.platformAdminService.updateAppSiteSettings(appId, body || {});
  }

  @Post('apps/:app_id/site/downloads/:platform/upload-url')
  @ApiOperation({ summary: '创建官网安装包临时上传地址' })
  async createAppSiteDownloadUploadUrl(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('platform') platform: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.createAppSiteDownloadUploadUrl(appId, req.user.id, platform, body || {});
  }

  @Post('apps/:app_id/site/downloads/:platform/confirm-upload')
  @ApiOperation({ summary: '确认官网安装包发布' })
  async confirmAppSiteDownloadUpload(
    @Param('app_id') appId: string,
    @Param('platform') platform: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.confirmAppSiteDownloadUpload(appId, platform, body || {});
  }

  @Get('apps/:app_id/business-analytics')
  @ApiOperation({ summary: '租户经营分析（用户/订单/账单）' })
  async getAppBusinessAnalytics(
    @Param('app_id') appId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('recent_limit') recentLimit?: string,
  ) {
    return this.platformAdminService.getAppBusinessAnalytics(appId, {
      days,
      from,
      to,
      recent_limit: recentLimit,
    });
  }

  @Get('apps/:app_id/analytics/overview')
  @ApiOperation({ summary: '租户用户分析总览' })
  async getAppAnalyticsOverview(
    @Param('app_id') appId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('timezone') timezone?: string,
    @Query('granularity') granularity?: string,
  ) {
    return this.platformAdminService.getAppAnalyticsOverview(appId, { days, from, to, timezone, granularity });
  }

  @Get('apps/:app_id/analytics/growth')
  @ApiOperation({ summary: '租户用户分析-增长' })
  async getAppAnalyticsGrowth(
    @Param('app_id') appId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('timezone') timezone?: string,
    @Query('granularity') granularity?: string,
  ) {
    return this.platformAdminService.getAppAnalyticsGrowth(appId, { days, from, to, timezone, granularity });
  }

  @Get('apps/:app_id/analytics/retention')
  @ApiOperation({ summary: '租户用户分析-留存' })
  async getAppAnalyticsRetention(
    @Param('app_id') appId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('timezone') timezone?: string,
    @Query('granularity') granularity?: string,
  ) {
    return this.platformAdminService.getAppAnalyticsRetention(appId, { days, from, to, timezone, granularity });
  }

  @Get('apps/:app_id/analytics/profiles')
  @ApiOperation({ summary: '租户用户分析-画像' })
  async getAppAnalyticsProfiles(
    @Param('app_id') appId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('timezone') timezone?: string,
    @Query('granularity') granularity?: string,
  ) {
    return this.platformAdminService.getAppAnalyticsProfiles(appId, { days, from, to, timezone, granularity });
  }

  @Get('apps/:app_id/analytics/conversion')
  @ApiOperation({ summary: '租户用户分析-转化' })
  async getAppAnalyticsConversion(
    @Param('app_id') appId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('timezone') timezone?: string,
    @Query('granularity') granularity?: string,
  ) {
    return this.platformAdminService.getAppAnalyticsConversion(appId, { days, from, to, timezone, granularity });
  }

  @Get('apps/:app_id/analytics/users')
  @ApiOperation({ summary: '租户用户分析-用户明细' })
  async getAppAnalyticsUsers(
    @Param('app_id') appId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('timezone') timezone?: string,
    @Query('granularity') granularity?: string,
    @Query('segment') segment?: string,
    @Query('created_scope') createdScope?: string,
    @Query('last_login_scope') lastLoginScope?: string,
    @Query('login_method') loginMethod?: string,
    @Query('membership_type') membershipType?: string,
    @Query('source') source?: string,
    @Query('paid_status') paidStatus?: string,
    @Query('account_status') accountStatus?: string,
    @Query('sort_by') sortBy?: string,
    @Query('sort_order') sortOrder?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.platformAdminService.getAppAnalyticsUsers(appId, {
      days,
      from,
      to,
      timezone,
      granularity,
      segment,
      created_scope: createdScope,
      last_login_scope: lastLoginScope,
      login_method: loginMethod,
      membership_type: membershipType,
      source,
      paid_status: paidStatus,
      account_status: accountStatus,
      sort_by: sortBy,
      sort_order: sortOrder,
      page,
      page_size: pageSize,
    });
  }

  @Get('apps/:app_id/ai/usage/summary')
  @ApiOperation({ summary: '租户 AI 调用汇总（按日/能力/模型/来源）' })
  async getAppAiUsageSummary(
    @Param('app_id') appId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('capability') capability?: string,
    @Query('model_id') modelId?: string,
    @Query('model_key') modelKey?: string,
    @Query('source_id') sourceId?: string,
    @Query('success') success?: string,
  ) {
    return this.platformAdminService.getAppAiUsageSummary(appId, {
      days,
      from,
      to,
      capability,
      model_id: modelId,
      model_key: modelKey,
      source_id: sourceId,
      success,
    });
  }

  @Get('apps/:app_id/ai/usage/breakdown')
  @ApiOperation({ summary: '租户 AI 调用明细分布（能力/模型/来源/用户）' })
  async getAppAiUsageBreakdown(
    @Param('app_id') appId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('capability') capability?: string,
    @Query('model_id') modelId?: string,
    @Query('model_key') modelKey?: string,
    @Query('source_id') sourceId?: string,
    @Query('success') success?: string,
  ) {
    return this.platformAdminService.getAppAiUsageBreakdown(appId, {
      days,
      from,
      to,
      capability,
      model_id: modelId,
      model_key: modelKey,
      source_id: sourceId,
      success,
    });
  }

  @Get('apps/:app_id/ai/usage/logs')
  @ApiOperation({ summary: '租户 AI 调用日志（含积分与成本）' })
  async listAppAiUsageLogs(
    @Param('app_id') appId: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('capability') capability?: string,
    @Query('model_id') modelId?: string,
    @Query('model_key') modelKey?: string,
    @Query('source_id') sourceId?: string,
    @Query('success') success?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.platformAdminService.listAppAiUsageLogs(appId, {
      days,
      from,
      to,
      capability,
      model_id: modelId,
      model_key: modelKey,
      source_id: sourceId,
      success,
      page,
      page_size: pageSize,
    });
  }

  @Get('apps/:app_id/admins')
  @ApiOperation({ summary: '租户管理员列表' })
  async listAppAdmins(@Param('app_id') appId: string) {
    return this.platformAdminService.listAppAdmins(appId);
  }

  @Get('apps/:app_id/admin-permissions/me')
  @ApiOperation({ summary: '当前租户管理员权限' })
  async getMyAppAdminPermissions(@Req() req: any, @Param('app_id') appId: string) {
    return this.platformAdminService.getMyAppAdminPermissions(appId, req.user.id);
  }

  @Post('apps/:app_id/users/:user_id/deactivate')
  @ApiOperation({ summary: '注销租户用户' })
  async deactivateTenantUser(@Req() req: any, @Param('app_id') appId: string, @Param('user_id') userId: string, @Body() body: any) {
    return this.platformAdminService.deactivateTenantUser(appId, userId, req.user.id, body || {});
  }

  @Post('apps/:app_id/users/:user_id/restore')
  @ApiOperation({ summary: '恢复租户用户' })
  async restoreTenantUser(@Param('app_id') appId: string, @Param('user_id') userId: string) {
    return this.platformAdminService.restoreTenantUser(appId, userId);
  }

  @Post('apps/:app_id/users/:user_id/unlink-phone')
  @ApiOperation({ summary: '解绑租户用户手机号' })
  async unlinkTenantUserPhone(@Param('app_id') appId: string, @Param('user_id') userId: string) {
    return this.platformAdminService.unlinkTenantUserPhone(appId, userId);
  }

  @Post('apps/:app_id/users/:user_id/unlink-email')
  @ApiOperation({ summary: '解绑租户用户邮箱' })
  async unlinkTenantUserEmail(@Param('app_id') appId: string, @Param('user_id') userId: string) {
    return this.platformAdminService.unlinkTenantUserEmail(appId, userId);
  }

  @Post('apps/:app_id/admins')
  @ApiOperation({ summary: '创建或更新租户管理员' })
  async createOrUpdateAdmin(@Req() req: any, @Param('app_id') appId: string, @Body() body: any) {
    return this.platformAdminService.createOrUpdateAppAdmin(appId, body, req.user.id);
  }

  @Put('apps/:app_id/admins/:admin_user_id/password')
  @ApiOperation({ summary: '重置管理员密码' })
  async resetAdminPassword(
    @Param('app_id') appId: string,
    @Param('admin_user_id') adminUserId: string,
    @Body() body: { new_password: string; invalidate_sessions?: boolean },
  ) {
    return this.platformAdminService.resetAdminPassword(appId, adminUserId, body);
  }

  @Patch('apps/:app_id/admins/:admin_user_id/permissions')
  @ApiOperation({ summary: '更新管理员页面权限' })
  async updateAdminPermissions(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('admin_user_id') adminUserId: string,
    @Body() body: { page_permissions: string[] },
  ) {
    return this.platformAdminService.updateAdminPermissions(appId, adminUserId, body.page_permissions || [], req.user.id);
  }

  @Patch('apps/:app_id/admins/:admin_user_id/status')
  @ApiOperation({ summary: '更新管理员状态' })
  async updateAdminStatus(
    @Param('app_id') appId: string,
    @Param('admin_user_id') adminUserId: string,
    @Body() body: { is_active: boolean },
  ) {
    return this.platformAdminService.updateAdminStatus(appId, adminUserId, !!body.is_active);
  }

  @Delete('apps/:app_id/admins/:admin_user_id')
  @ApiOperation({ summary: '删除管理员' })
  async deleteAdmin(@Param('app_id') appId: string, @Param('admin_user_id') adminUserId: string) {
    return this.platformAdminService.deleteAppAdmin(appId, adminUserId);
  }

  @Get('ai/sources')
  @ApiOperation({ summary: '全局 AI 源列表' })
  async listGlobalAiSources() {
    return this.platformAdminService.listGlobalAiSources();
  }

  @Get('ai/provider-templates')
  @ApiOperation({ summary: '全局 AI 供应商模板' })
  async listGlobalAiProviderTemplates() {
    return this.platformAdminService.listGlobalAiProviderTemplates();
  }

  @Get('ai/gateway/runtime')
  @ApiOperation({ summary: 'AI 网关运行状态' })
  async getAiGatewayRuntimeStats() {
    return this.aiChatService.getGatewayRuntimeStats();
  }

  @Get('ai/gateway/provider-health')
  @ApiOperation({ summary: 'AI 网关供应商健康状态' })
  async listAiGatewayProviderHealth(
    @Query('provider_type') providerType?: string,
    @Query('source_id') sourceId?: string,
    @Query('model_id') modelId?: string,
    @Query('model_key') modelKey?: string,
    @Query('capability') capability?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.aiGatewayObservabilityService.listProviderHealth({
      provider_type: providerType,
      source_id: sourceId,
      model_id: modelId,
      model_key: modelKey,
      capability,
      status,
      page,
      page_size: pageSize,
    });
  }

  @Get('ai/gateway/request-events')
  @ApiOperation({ summary: 'AI 网关请求事件' })
  async listAiGatewayRequestEvents(
    @Query('app_id') appId?: string,
    @Query('user_id') userId?: string,
    @Query('request_id') requestId?: string,
    @Query('usage_reference_id') usageReferenceId?: string,
    @Query('source_id') sourceId?: string,
    @Query('model_id') modelId?: string,
    @Query('model_key') modelKey?: string,
    @Query('capability') capability?: string,
    @Query('stage') stage?: string,
    @Query('success') success?: string,
    @Query('days') days?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.aiGatewayObservabilityService.listRequestEvents({
      app_id: appId,
      user_id: userId,
      request_id: requestId,
      usage_reference_id: usageReferenceId,
      source_id: sourceId,
      model_id: modelId,
      model_key: modelKey,
      capability,
      stage,
      success,
      days,
      page,
      page_size: pageSize,
    });
  }

  @Get('ai/audit-events')
  @ApiOperation({ summary: 'AI 配置审计事件' })
  async listAiAuditEvents(
    @Query('actor_user_id') actorUserId?: string,
    @Query('app_id') appId?: string,
    @Query('action') action?: string,
    @Query('resource_type') resourceType?: string,
    @Query('resource_id') resourceId?: string,
    @Query('days') days?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.aiGatewayObservabilityService.listAuditEvents({
      actor_user_id: actorUserId,
      app_id: appId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      days,
      page,
      page_size: pageSize,
    });
  }

  @Post('ai/sources')
  @ApiOperation({ summary: '创建全局 AI 源' })
  async createGlobalAiSource(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.createGlobalAiSource(req.user.id, body);
  }

  @Post('ai/sources/test')
  @ApiOperation({ summary: '测试全局 AI 源连通性' })
  async testGlobalAiSourceConnectivity(@Body() body: any) {
    return this.platformAdminService.testGlobalAiSourceConnectivity(body);
  }

  @Put('ai/sources/:source_id')
  @ApiOperation({ summary: '更新全局 AI 源' })
  async updateGlobalAiSource(
    @Req() req: any,
    @Param('source_id') sourceId: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.updateGlobalAiSource(sourceId, req.user.id, body);
  }

  @Delete('ai/sources/:source_id')
  @ApiOperation({ summary: '删除全局 AI 源' })
  async deleteGlobalAiSource(@Param('source_id') sourceId: string) {
    return this.platformAdminService.deleteGlobalAiSource(sourceId);
  }

  @Get('ai/models')
  @ApiOperation({ summary: '全局 AI 模型列表' })
  async listGlobalAiModels() {
    return this.platformAdminService.listGlobalAiModels();
  }

  @Post('ai/models')
  @ApiOperation({ summary: '创建全局 AI 模型' })
  async createGlobalAiModel(@Req() req: any, @Body() body: any) {
    return this.platformAdminService.createGlobalAiModel(req.user.id, body);
  }

  @Post('ai/models/test')
  @ApiOperation({ summary: '测试全局 AI 模型连通性' })
  async testGlobalAiModelConnectivity(@Body() body: any) {
    return this.platformAdminService.testGlobalAiModelConnectivity(body);
  }

  @Post('ai/models/test-batch')
  @ApiOperation({ summary: '批量测试全局 AI 模型连通性' })
  async testGlobalAiModelConnectivityBatch(@Body() body: any) {
    return this.platformAdminService.testGlobalAiModelConnectivityBatch(body || {});
  }

  @Get('ai/models/:model_id/sources')
  @ApiOperation({ summary: '全局 AI 模型来源优先级' })
  async listGlobalAiModelSourceRoutes(@Param('model_id') modelId: string) {
    return this.platformAdminService.listGlobalAiModelSourceRoutes(modelId);
  }

  @Put('ai/models/:model_id/sources')
  @ApiOperation({ summary: '更新全局 AI 模型来源优先级' })
  async replaceGlobalAiModelSourceRoutes(
    @Req() req: any,
    @Param('model_id') modelId: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.replaceGlobalAiModelSourceRoutes(modelId, req.user.id, body || {});
  }

  @Post('ai/models/playground')
  @ApiOperation({ summary: '执行全局 AI 模型 Playground 调试调用' })
  async runGlobalAiModelPlayground(@Body() body: any) {
    return this.platformAdminService.runGlobalAiModelPlayground(body || {});
  }

  @Post('ai/models/playground/query')
  @ApiOperation({ summary: '查询全局 AI 视频 Playground 异步任务' })
  async queryGlobalAiModelPlaygroundTask(@Body() body: any) {
    return this.platformAdminService.queryGlobalAiModelPlaygroundTask(body || {});
  }

  @Put('ai/models/:model_id')
  @ApiOperation({ summary: '更新全局 AI 模型' })
  async updateGlobalAiModel(
    @Req() req: any,
    @Param('model_id') modelId: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.updateGlobalAiModel(modelId, req.user.id, body);
  }

  @Delete('ai/models/:model_id')
  @ApiOperation({ summary: '删除全局 AI 模型' })
  async deleteGlobalAiModel(@Param('model_id') modelId: string) {
    return this.platformAdminService.deleteGlobalAiModel(modelId);
  }

  @Get('ai/usage/summary')
  @ApiOperation({ summary: 'AI Token 与成本汇总（按模型/按天）' })
  async getGlobalAiUsageSummary(
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('app_id') appId?: string,
    @Query('capability') capability?: string,
    @Query('model_id') modelId?: string,
    @Query('model_key') modelKey?: string,
    @Query('source_id') sourceId?: string,
    @Query('success') success?: string,
  ) {
    return this.platformAdminService.getGlobalAiUsageSummary({
      days,
      from,
      to,
      app_id: appId,
      capability,
      model_id: modelId,
      model_key: modelKey,
      source_id: sourceId,
      success,
    });
  }

  @Get('ai/usage/breakdown')
  @ApiOperation({ summary: 'AI 调用明细分布（按能力/模型/来源/用户）' })
  async getGlobalAiUsageBreakdown(
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('app_id') appId?: string,
    @Query('capability') capability?: string,
    @Query('model_id') modelId?: string,
    @Query('model_key') modelKey?: string,
    @Query('source_id') sourceId?: string,
    @Query('success') success?: string,
  ) {
    return this.platformAdminService.getGlobalAiUsageBreakdown({
      days,
      from,
      to,
      app_id: appId,
      capability,
      model_id: modelId,
      model_key: modelKey,
      source_id: sourceId,
      success,
    });
  }

  @Get('ai/usage/logs')
  @ApiOperation({ summary: 'AI 调用日志（含 token 与成本）' })
  async listGlobalAiUsageLogs(
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('app_id') appId?: string,
    @Query('capability') capability?: string,
    @Query('model_id') modelId?: string,
    @Query('model_key') modelKey?: string,
    @Query('source_id') sourceId?: string,
    @Query('success') success?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.platformAdminService.listGlobalAiUsageLogs({
      days,
      from,
      to,
      app_id: appId,
      capability,
      model_id: modelId,
      model_key: modelKey,
      source_id: sourceId,
      success,
      page,
      page_size: pageSize,
    });
  }

  @Get('apps/:app_id/ai/model-routes')
  @ApiOperation({ summary: '租户 AI 模型路由覆盖列表' })
  async listAppAiModelRoutes(@Param('app_id') appId: string) {
    return this.platformAdminService.listAppAiModelRoutes(appId);
  }

  @Put('apps/:app_id/ai/model-routes/:model_id')
  @ApiOperation({ summary: '创建或更新租户模型路由覆盖' })
  async upsertAppAiModelRoute(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('model_id') modelId: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.upsertAppAiModelRoute(appId, modelId, req.user.id, body);
  }

  @Delete('apps/:app_id/ai/model-routes/:model_id')
  @ApiOperation({ summary: '删除租户模型路由覆盖' })
  async deleteAppAiModelRoute(@Param('app_id') appId: string, @Param('model_id') modelId: string) {
    return this.platformAdminService.deleteAppAiModelRoute(appId, modelId);
  }

  @Put('apps/:app_id/ai/model-visibility/:model_id')
  @ApiOperation({ summary: '设置租户模型展示状态' })
  async updateAppAiModelVisibility(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('model_id') modelId: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.upsertAppAiModelVisibility(appId, modelId, req.user.id, body || {});
  }

  @Get('apps/:app_id/ai/default-models')
  @ApiOperation({ summary: '租户 capability 默认模型（Auto）' })
  async listAppAiCapabilityDefaults(@Param('app_id') appId: string) {
    return this.platformAdminService.listAppAiCapabilityDefaults(appId);
  }

  @Put('apps/:app_id/ai/default-models/:capability')
  @ApiOperation({ summary: '设置租户 capability 默认模型（Auto）' })
  async upsertAppAiCapabilityDefault(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('capability') capability: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.upsertAppAiCapabilityDefault(appId, capability, req.user.id, body);
  }

  @Delete('apps/:app_id/ai/default-models/:capability')
  @ApiOperation({ summary: '移除租户 capability 默认模型（回退全局）' })
  async deleteAppAiCapabilityDefault(@Param('app_id') appId: string, @Param('capability') capability: string) {
    return this.platformAdminService.deleteAppAiCapabilityDefault(appId, capability);
  }

  @Get('apps/:app_id/ai/default-model-slots')
  @ApiOperation({ summary: '租户默认模型列表' })
  async listAppAiDefaultModelSlots(@Param('app_id') appId: string) {
    return this.platformAdminService.listAppAiDefaultModelSlots(appId);
  }

  @Put('apps/:app_id/ai/default-model-slots/:slot_key')
  @ApiOperation({ summary: '设置租户默认模型主备' })
  async upsertAppAiDefaultModelSlot(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('slot_key') slotKey: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.upsertAppAiDefaultModelSlot(appId, slotKey, req.user.id, body);
  }

  @Delete('apps/:app_id/ai/default-model-slots/:slot_key')
  @ApiOperation({ summary: '移除租户默认模型主备' })
  async deleteAppAiDefaultModelSlot(@Param('app_id') appId: string, @Param('slot_key') slotKey: string) {
    return this.platformAdminService.deleteAppAiDefaultModelSlot(appId, slotKey);
  }

  @Get('apps/:app_id/ai/points-settings')
  @ApiOperation({ summary: '读取租户 AI 积分扣费规则' })
  async getAppAiPointsSettings(@Param('app_id') appId: string) {
    return this.platformAdminService.getAppAiPointsSettings(appId);
  }

  @Put('apps/:app_id/ai/points-settings')
  @ApiOperation({ summary: '更新租户 AI 积分扣费规则' })
  async updateAppAiPointsSettings(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    return this.platformAdminService.updateAppAiPointsSettings(appId, req.user.id, body);
  }

  @Post('apps/:app_id/ai/points/grant')
  @ApiOperation({ summary: '按租户手动赠送用户积分' })
  async grantAppAiPoints(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    return this.platformAdminService.grantAppAiPoints(appId, req.user.id, body);
  }

  @Get('apps/:app_id/feedbacks')
  @ApiOperation({ summary: '用户反馈列表' })
  async listAppFeedbacks(
    @Param('app_id') appId: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('assignee_user_id') assigneeUserId?: string,
    @Query('q') q?: string,
  ) {
    return this.platformAdminService.listAppFeedbacks(appId, {
      page,
      page_size: pageSize,
      status,
      priority,
      assignee_user_id: assigneeUserId,
      q,
    });
  }

  @Get('apps/:app_id/feedbacks/:feedback_id')
  @ApiOperation({ summary: '用户反馈详情' })
  async getAppFeedback(@Param('app_id') appId: string, @Param('feedback_id') feedbackId: string) {
    return this.platformAdminService.getAppFeedback(appId, feedbackId);
  }

  @Patch('apps/:app_id/feedbacks/:feedback_id')
  @ApiOperation({ summary: '更新用户反馈工单' })
  async updateAppFeedback(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('feedback_id') feedbackId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    return this.platformAdminService.updateAppFeedback(appId, feedbackId, req.user.id, body);
  }

  @Post('apps/:app_id/feedbacks/:feedback_id/comments')
  @ApiOperation({ summary: '新增用户反馈评论' })
  async addAppFeedbackComment(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('feedback_id') feedbackId: string,
    @Body() body: { body?: string; is_internal?: boolean },
  ) {
    return this.platformAdminService.addAppFeedbackComment(appId, feedbackId, req.user.id, body || {});
  }

  @Post('apps/:app_id/feedbacks/:feedback_id/review')
  @ApiOperation({ summary: '处理用户反馈（无用/谢谢/有用）' })
  async reviewAppFeedback(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('feedback_id') feedbackId: string,
    @Body() body: { action?: string; note?: string },
  ) {
    return this.platformAdminService.reviewAppFeedback(appId, feedbackId, req.user.id, body || {});
  }

  @Get('apps/:app_id/site/messages')
  @ApiOperation({ summary: '租户官网表单消息列表' })
  async listAppSiteMessages(
    @Param('app_id') appId: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.platformAdminService.listAppSiteMessages(appId, {
      type,
      status,
      category,
      q,
      page,
      page_size: pageSize,
    });
  }

  @Patch('apps/:app_id/site/messages/:message_id')
  @ApiOperation({ summary: '更新租户官网表单消息状态' })
  async updateAppSiteMessage(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('message_id') messageId: string,
    @Body() body: { status?: string; note?: string; admin_note?: string },
  ) {
    return this.platformAdminService.updateAppSiteMessage(appId, messageId, req.user.id, body || {});
  }

  @Get('apps/:app_id/site/cookie-consents')
  @ApiOperation({ summary: '租户 Cookie 偏好记录' })
  async listAppSiteCookieConsents(
    @Param('app_id') appId: string,
    @Query('region_mode') regionMode?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.platformAdminService.listAppSiteCookieConsents(appId, {
      region_mode: regionMode,
      page,
      page_size: pageSize,
    });
  }

  @Get('apps/:app_id/redeem/packages')
  @ApiOperation({ summary: '产品列表' })
  async listRedeemPackages(@Param('app_id') appId: string) {
    return this.platformAdminService.listRedeemPackages(appId);
  }

  @Post('apps/:app_id/redeem/packages')
  @ApiOperation({ summary: '创建产品' })
  async createRedeemPackage(@Req() req: any, @Param('app_id') appId: string, @Body() body: any) {
    return this.platformAdminService.createRedeemPackage(appId, req.user.id, body);
  }

  @Put('apps/:app_id/redeem/packages/:package_id')
  @ApiOperation({ summary: '更新产品' })
  async updateRedeemPackage(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('package_id') packageId: string,
    @Body() body: any,
  ) {
    return this.platformAdminService.updateRedeemPackage(appId, packageId, req.user.id, body);
  }

  @Delete('apps/:app_id/redeem/packages/:package_id')
  @ApiOperation({ summary: '删除产品' })
  async deleteRedeemPackage(@Param('app_id') appId: string, @Param('package_id') packageId: string) {
    return this.platformAdminService.deleteRedeemPackage(appId, packageId);
  }

  @Post('apps/:app_id/redeem/packages/:package_id/distribute')
  @ApiOperation({ summary: '分发产品到指定用户' })
  async distributeRedeemPackageToUser(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('package_id') packageId: string,
    @Body() body: { user_id: string },
  ) {
    return this.platformAdminService.distributeRedeemPackageToUser(appId, packageId, req.user.id, body);
  }

  @Post('apps/:app_id/redeem/codes/batches')
  @ApiOperation({ summary: '批量生成兑换码' })
  async createRedeemCodeBatch(@Req() req: any, @Param('app_id') appId: string, @Body() body: any) {
    return this.platformAdminService.createRedeemCodeBatch(appId, req.user.id, body);
  }

  @Get('apps/:app_id/redeem/codes')
  @ApiOperation({ summary: '兑换码列表' })
  async listRedeemCodes(
    @Param('app_id') appId: string,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
    @Query('batch_id') batchId?: string,
  ) {
    return this.platformAdminService.listRedeemCodes(appId, page || 1, pageSize || 20, batchId);
  }

  @Get('apps/:app_id/redeem/redemptions')
  @ApiOperation({ summary: '兑换记录列表' })
  async listRedeemCodeRedemptions(
    @Param('app_id') appId: string,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
    @Query('batch_id') batchId?: string,
  ) {
    return this.platformAdminService.listRedeemCodeRedemptions(appId, page || 1, pageSize || 20, batchId);
  }

  @Post('apps/:app_id/redeem/redemptions/:redemption_id/revoke')
  @ApiOperation({ summary: '撤销兑换记录并回收权益' })
  async revokeRedeemCodeRedemption(
    @Req() req: any,
    @Param('app_id') appId: string,
    @Param('redemption_id') redemptionId: string,
    @Body() body: { reason?: string },
  ) {
    return this.platformAdminService.revokeRedeemCodeRedemption(appId, redemptionId, req.user.id, body?.reason);
  }

  @Get('apps/:app_id/redeem/codes/batches')
  @ApiOperation({ summary: '兑换码批次列表' })
  async listRedeemCodeBatches(
    @Param('app_id') appId: string,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
  ) {
    return this.platformAdminService.listRedeemCodeBatches(appId, page || 1, pageSize || 20);
  }

  @Get('apps/:app_id/redeem/codes/batches/:batch_id/txt')
  @ApiOperation({ summary: '下载兑换码 TXT 内容' })
  async getRedeemBatchTxt(
    @Param('app_id') appId: string,
    @Param('batch_id') batchId: string,
    @Query('format') format?: 'code' | 'url',
    @Query('base_url') baseUrl?: string,
  ) {
    return this.platformAdminService.getRedeemBatchTxt(appId, batchId, { format, baseUrl });
  }

  @Post('apps/:app_id/redeem/codes/:code/void')
  @ApiOperation({ summary: '作废兑换码' })
  async voidRedeemCode(
    @Param('app_id') appId: string,
    @Param('code') code: string,
    @Body() body: { reason?: string },
  ) {
    return this.platformAdminService.voidRedeemCode(appId, code, body?.reason);
  }
}
