import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import { UsersService } from './users.service';
import { AppApiKeysService } from '../api-keys/app-api-keys.service';
import { AccountBindingService } from '../auth/account-binding.service';

@ApiTags('Users')
@Controller(tenantControllerPaths('users', true))
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly appApiKeysService: AppApiKeysService,
    private readonly accountBindingService: AccountBindingService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: '获取当前用户信息' })
  async me(@Req() req: any) {
    return this.usersService.getMe(req.user.id);
  }

  @Get('me/points')
  @ApiOperation({ summary: '获取当前用户 AI 积分余额' })
  async myPoints(@Req() req: any, @Param('app') app?: string) {
    return this.usersService.getMyPoints(app || req.user.appSlug, req.user.id);
  }

  @Get('me/ai-usage-logs')
  @ApiOperation({ summary: '获取当前用户 AI 调用记录' })
  async myAiUsageLogs(
    @Req() req: any,
    @Param('app') app?: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ) {
    return this.usersService.getMyAiUsageLogs(app || req.user.appSlug, req.user.id, {
      limit,
      page,
    });
  }

  @Put('me')
  @ApiOperation({ summary: '更新当前用户信息' })
  async updateMe(@Req() req: any, @Body() body: Record<string, unknown>) {
    return this.usersService.updateMe(req.user.id, body);
  }

  @Get('me/identities')
  @ApiOperation({ summary: '列出当前用户登录方式' })
  async listMyIdentities(@Req() req: any) {
    return this.accountBindingService.listIdentities(req.user.id);
  }

  @Post('me/identities/apple/bind')
  @ApiOperation({ summary: '绑定 Apple 登录' })
  async bindAppleIdentity(
    @Req() req: any,
    @Param('app') app: string | undefined,
    @Body() body: {
      identity_token?: string;
      nonce?: string;
      full_name?: string;
      app_attest_key_id?: string;
      app_attest_assertion?: string;
      app_attest_challenge_id?: string;
    },
  ) {
    return this.accountBindingService.bindApple(req.user.id, body || {}, app || req.user.appSlug, req);
  }

  @Post('me/identities/apple/unbind')
  @ApiOperation({ summary: '解绑 Apple 登录' })
  async unbindAppleIdentity(@Req() req: any, @Param('app') app: string | undefined, @Body() body: Record<string, unknown>) {
    return this.accountBindingService.unbindApple(req.user.id, body || {}, app || req.user.appSlug, req);
  }

  @Post('me/merge')
  @ApiOperation({ summary: '合并访客账号' })
  async mergeGuestAccount(@Req() req: any, @Param('app') app: string | undefined, @Body() body: { target_user_id?: string } & Record<string, unknown>) {
    return this.accountBindingService.mergeGuestIntoAccount(req.user.id, body || {}, app || req.user.appSlug, req);
  }

  @Get('me/devices')
  @ApiOperation({ summary: '列出当前用户设备' })
  async listMyDevices(@Req() req: any) {
    return this.accountBindingService.listDevices(req.user.id);
  }

  @Post('me/devices/:device_id/revoke')
  @ApiOperation({ summary: '撤销当前用户设备' })
  async revokeMyDevice(@Req() req: any, @Param('device_id') deviceId: string) {
    return this.accountBindingService.revokeDevice(req.user.id, deviceId);
  }

  @Post('me/delete-account')
  @ApiOperation({ summary: '删除当前账号' })
  async deleteMyAccount(@Req() req: any, @Param('app') app: string | undefined, @Body() body: { reason?: string } & Record<string, unknown>) {
    return this.accountBindingService.deleteAccount(req.user.id, body || {}, app || req.user.appSlug, req);
  }

  @Get('me/api-keys')
  @ApiOperation({ summary: '列出当前用户 API Keys' })
  async listMyApiKeys(@Req() req: any, @Param('app') app?: string) {
    return this.appApiKeysService.listApiKeys(app || req.user.appSlug, req.user.id);
  }

  @Post('me/api-keys')
  @ApiOperation({ summary: '创建当前用户 API Key' })
  async createMyApiKey(@Req() req: any, @Param('app') app?: string, @Body() body?: { name?: string }) {
    return this.appApiKeysService.createApiKey(app || req.user.appSlug, req.user.id, body?.name);
  }

  @Post('me/api-keys/ensure-default')
  @ApiOperation({ summary: '确保当前用户存在默认 API Key（幂等）' })
  async ensureMyDefaultApiKey(@Req() req: any, @Param('app') app?: string, @Body() body?: { name?: string }) {
    return this.appApiKeysService.ensureDefaultApiKey(app || req.user.appSlug, req.user.id, body?.name);
  }

  @Post('me/api-keys/:key_id/revoke')
  @ApiOperation({ summary: '撤销当前用户 API Key' })
  async revokeMyApiKey(@Req() req: any, @Param('app') app: string | undefined, @Param('key_id') keyId: string) {
    return this.appApiKeysService.revokeApiKey(app || req.user.appSlug, req.user.id, keyId);
  }

  @Post('me/behavior-events')
  @ApiOperation({ summary: '上报用户行为事件' })
  async trackBehaviorEvents(@Req() req: any, @Param('app') app: string, @Body() body: Record<string, unknown>) {
    return this.usersService.trackBehaviorEvents(app || req.user.appSlug, req.user.id, body, req);
  }

  @Post('me/avatar')
  @ApiOperation({ summary: '更新头像' })
  async uploadAvatar(@Req() req: any, @Body() body: { avatar_url?: string; avatarUrl?: string }) {
    const avatarUrl = body.avatar_url || body.avatarUrl || '';
    return this.usersService.uploadAvatar(req.user.id, avatarUrl);
  }

  @Post('change-password')
  @ApiOperation({ summary: '修改密码（旧密码）' })
  async changePassword(
    @Req() req: any,
    @Body() body: { old_password?: string; oldPassword?: string; new_password?: string; newPassword?: string },
  ) {
    return this.usersService.changePassword(
      req.user.id,
      body.old_password || body.oldPassword || '',
      body.new_password || body.newPassword || '',
    );
  }

  @Post('me/send-password-change-code')
  @ApiOperation({ summary: '发送修改密码验证码' })
  async sendPasswordChangeCode(@Req() req: any, @Body() body: { method?: string }) {
    return this.usersService.sendPasswordChangeCode(req.user.id, body?.method);
  }

  @Post('me/change-password')
  @ApiOperation({ summary: '验证码修改密码' })
  async changePasswordWithCode(
    @Req() req: any,
    @Body() body: { code?: string; verification_code?: string; new_password?: string; newPassword?: string },
  ) {
    return this.usersService.changePasswordWithCode(
      req.user.id,
      body.code || body.verification_code || '',
      body.new_password || body.newPassword || '',
    );
  }

  @Post('me/send-email-change-code')
  @ApiOperation({ summary: '发送修改邮箱验证码' })
  async sendEmailChangeCode(@Req() req: any, @Body() body: { new_email?: string; newEmail?: string }) {
    return this.usersService.sendEmailChangeCode(req.user.id, body.new_email || body.newEmail || '');
  }

  @Post('me/change-email')
  @ApiOperation({ summary: '修改邮箱' })
  async changeEmail(
    @Req() req: any,
    @Body() body: { new_email?: string; newEmail?: string; code?: string; verification_code?: string },
  ) {
    return this.usersService.changeEmail(
      req.user.id,
      body.new_email || body.newEmail || '',
      body.code || body.verification_code || '',
    );
  }

  @Post('me/send-phone-bind-code')
  @ApiOperation({ summary: '发送绑定手机验证码' })
  async sendPhoneBindCode(@Req() req: any, @Body() body: { phone: string }) {
    return this.usersService.sendPhoneBindCode(req.user.id, body.phone);
  }

  @Post('me/bind-phone')
  @ApiOperation({ summary: '绑定手机' })
  async bindPhone(@Req() req: any, @Body() body: { phone: string; code: string }) {
    return this.usersService.bindPhone(req.user.id, body.phone, body.code);
  }

  @Get('list')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '用户列表（管理员）' })
  async listUsers(@Req() req: any, @Param('app') app?: string, @Query('q') q?: string) {
    return this.usersService.listUsers(app || req.user.appSlug, q);
  }

  @Post('admin/delete')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '管理员删除用户' })
  async adminDeleteUser(@Req() req: any, @Param('app') app: string, @Body() body: { user_id: string }) {
    return this.usersService.adminDeleteUser(app || req.user.appSlug, body.user_id);
  }

  @Get('admin/page-permissions/catalog')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '管理员页面权限目录' })
  async getPermissionCatalog() {
    return this.usersService.getAdminPermissionCatalog();
  }

  @Get('admin/me/page-permissions')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '当前管理员页面权限' })
  async getMyPermissions(@Req() req: any, @Param('app') app?: string) {
    return this.usersService.getMyAdminPagePermissions(req.user.id, app || req.user.appSlug);
  }

  @Get('admin/permission-groups')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '权限组列表' })
  async listPermissionGroups(@Req() req: any, @Param('app') app?: string) {
    return this.usersService.listAdminPermissionGroups(req.user.id, app || req.user.appSlug);
  }

  @Post('admin/permission-groups')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '创建权限组' })
  async createPermissionGroup(
    @Req() req: any,
    @Param('app') app: string,
    @Body() body: { name: string; description?: string; page_permissions: string[] },
  ) {
    return this.usersService.createAdminPermissionGroup(req.user.id, body, app || req.user.appSlug);
  }

  @Put('admin/permission-groups/:group_id')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '更新权限组' })
  async updatePermissionGroup(
    @Req() req: any,
    @Param('app') app: string,
    @Param('group_id') groupId: string,
    @Body() body: { name?: string; description?: string; page_permissions?: string[] },
  ) {
    return this.usersService.updateAdminPermissionGroup(req.user.id, groupId, body, app || req.user.appSlug);
  }

  @Delete('admin/permission-groups/:group_id')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '删除权限组' })
  async deletePermissionGroup(@Req() req: any, @Param('app') app: string, @Param('group_id') groupId: string) {
    return this.usersService.deleteAdminPermissionGroup(groupId, app || req.user.appSlug);
  }

  @Get('admin/sub-admins')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '子管理员列表' })
  async listSubAdmins(@Req() req: any, @Param('app') app: string) {
    return this.usersService.listSubAdmins(app || req.user.appSlug);
  }

  @Post('admin/sub-admins/assign')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '指派子管理员' })
  async assignSubAdmin(
    @Req() req: any,
    @Param('app') app: string,
    @Body() body: { email: string; password?: string; display_name?: string; page_permissions: string[] },
  ) {
    return this.usersService.assignSubAdmin(req.user.id, body, app || req.user.appSlug);
  }

  @Patch('admin/sub-admins/:sub_admin_id/permissions')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '更新子管理员权限' })
  async patchSubAdminPermissions(
    @Req() req: any,
    @Param('app') app: string,
    @Param('sub_admin_id') subAdminId: string,
    @Body() body: { page_permissions: string[] },
  ) {
    return this.usersService.updateSubAdminPermissions(req.user.id, subAdminId, body, app || req.user.appSlug);
  }

  @Delete('admin/sub-admins/:sub_admin_id')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '删除子管理员' })
  async deleteSubAdmin(@Req() req: any, @Param('app') app: string, @Param('sub_admin_id') subAdminId: string) {
    return this.usersService.deleteSubAdmin(subAdminId, app || req.user.appSlug);
  }

  @Post('redeem')
  @ApiOperation({ summary: '用户兑换会员码' })
  async redeem(@Req() req: any, @Param('app') app: string, @Body() body: { code: string }) {
    return this.usersService.redeem(app || req.user.appSlug, req.user.id, body.code);
  }

  @Get('redeem/preview')
  @ApiOperation({ summary: '预览兑换码权益' })
  async previewRedeem(@Req() req: any, @Param('app') app: string, @Query('code') code: string) {
    return this.usersService.previewRedeem(app || req.user.appSlug, code);
  }

  @Get('me/entitlements')
  @ApiOperation({ summary: '当前用户权益详情' })
  async myEntitlements(@Req() req: any, @Param('app') app: string) {
    return this.usersService.listMyEntitlements(app || req.user.appSlug, req.user.id);
  }

  @Get('me/notifications')
  @ApiOperation({ summary: '当前用户通知列表' })
  async myNotifications(
    @Req() req: any,
    @Param('app') app: string,
    @Query('unread_only') unreadOnly?: string,
    @Query('limit') limit?: number,
  ) {
    return this.usersService.listMyNotifications(app || req.user.appSlug, req.user.id, {
      unread_only: unreadOnly === '1' || unreadOnly === 'true',
      limit: limit || 20,
    });
  }

  @Get('me/notifications/sync')
  @ApiOperation({ summary: '轻量同步当前用户通知' })
  async syncMyNotifications(
    @Req() req: any,
    @Param('app') app: string,
    @Query('cursor') cursor?: string,
    @Query('unread_only') unreadOnly?: string,
    @Query('limit') limit?: number,
  ) {
    return this.usersService.syncMyNotifications(app || req.user.appSlug, req.user.id, {
      cursor,
      unread_only: unreadOnly === '1' || unreadOnly === 'true',
      limit: limit || 20,
    });
  }

  @Post('me/notifications/:notification_id/read')
  @ApiOperation({ summary: '标记通知已读' })
  async readNotification(
    @Req() req: any,
    @Param('app') app: string,
    @Param('notification_id') notificationId: string,
  ) {
    return this.usersService.markNotificationRead(app || req.user.appSlug, req.user.id, notificationId);
  }

  @Post('me/notifications/read-all')
  @ApiOperation({ summary: '全部通知标记已读' })
  async readAllNotifications(@Req() req: any, @Param('app') app: string) {
    return this.usersService.markAllNotificationsRead(app || req.user.appSlug, req.user.id);
  }

  @Post('me/feedback')
  @ApiOperation({ summary: '提交用户反馈' })
  async submitFeedback(
    @Req() req: any,
    @Param('app') app: string,
    @Body()
    body: {
      title?: string;
      content?: string;
      category?: string;
      priority?: string;
      context?: Record<string, unknown>;
      source?: string;
      client?: Record<string, unknown>;
      log_text?: string;
      logs?: string | string[];
      attachments?: Array<Record<string, unknown>>;
    },
  ) {
    return this.usersService.submitMyFeedback(app || req.user.appSlug, req.user.id, body || {});
  }

  @Get('me/feedbacks')
  @ApiOperation({ summary: '我的用户反馈列表' })
  async listMyFeedbacks(
    @Req() req: any,
    @Param('app') app: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('status') status?: string,
  ) {
    return this.usersService.listMyFeedbacks(app || req.user.appSlug, req.user.id, {
      page,
      page_size: pageSize,
      status,
    });
  }

  @Get('me/feedbacks/:feedback_id')
  @ApiOperation({ summary: '我的用户反馈详情' })
  async getMyFeedback(
    @Req() req: any,
    @Param('app') app: string,
    @Param('feedback_id') feedbackId: string,
  ) {
    return this.usersService.getMyFeedback(app || req.user.appSlug, req.user.id, feedbackId);
  }

  @Post('me/feedbacks/:feedback_id/comments')
  @ApiOperation({ summary: '回复我的用户反馈' })
  async addMyFeedbackComment(
    @Req() req: any,
    @Param('app') app: string,
    @Param('feedback_id') feedbackId: string,
    @Body() body: { body?: string },
  ) {
    return this.usersService.addMyFeedbackComment(app || req.user.appSlug, req.user.id, feedbackId, body || {});
  }

  @Post('admin/redeem-codes')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '管理员创建兑换码' })
  async createRedeemCodes(
    @Req() req: any,
    @Param('app') app: string,
    @Body() body: { days: number; count?: number; expires_at?: string },
  ) {
    return this.usersService.createRedeemCodes(app || req.user.appSlug, req.user.id, body);
  }

  @Get('admin/redeem-codes')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '管理员兑换码列表' })
  async listRedeemCodes(
    @Req() req: any,
    @Param('app') app: string,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
  ) {
    return this.usersService.listRedeemCodes(app || req.user.appSlug, page || 1, pageSize || 20);
  }

  @Post('admin/redeem-codes/:code/void')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '管理员作废兑换码' })
  async voidRedeemCode(
    @Req() req: any,
    @Param('app') app: string,
    @Param('code') code: string,
    @Body() body: { reason?: string },
  ) {
    return this.usersService.voidRedeemCode(app || req.user.appSlug, code, body.reason);
  }

  @Get('admin/redeem-code-redemptions')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '管理员兑换记录列表' })
  async listRedeemCodeRedemptions(
    @Req() req: any,
    @Param('app') app: string,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
    @Query('batch_id') batchId?: string,
  ) {
    return this.usersService.listRedeemCodeRedemptions(
      app || req.user.appSlug,
      page || 1,
      pageSize || 20,
      batchId,
    );
  }

  @Post('admin/redeem-code-redemptions/:redemption_id/revoke')
  @UseGuards(AdminRoleGuard)
  @ApiOperation({ summary: '管理员撤销兑换记录并回收权益' })
  async revokeRedeemCodeRedemption(
    @Req() req: any,
    @Param('app') app: string,
    @Param('redemption_id') redemptionId: string,
    @Body() body: { reason?: string },
  ) {
    return this.usersService.revokeRedeemCodeRedemption(
      app || req.user.appSlug,
      redemptionId,
      req.user.id,
      body?.reason,
    );
  }
}
