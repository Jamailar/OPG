import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User as UserType } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { tenantControllerPaths } from '../../common/utils/controller-paths';
import configuration from '../../config/configuration';
import {
  ForgotPasswordDto,
  LoginEmailCodeDto,
  LoginSmsDto,
  RefreshTokenDto,
  RegisterDto,
  ResetPasswordDto,
  SendVerificationCodeDto,
  VerifyEmailDto,
} from './dto/auth.dto';
import { AccountBindingService } from './account-binding.service';
import { AuthService } from './auth.service';
import { AppleIdentityService } from './apple-identity.service';
import { IosAppAttestService } from './ios-app-attest.service';

@ApiTags('Auth')
@Controller(tenantControllerPaths('auth', true))
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly accountBindingService: AccountBindingService,
    private readonly appleIdentityService: AppleIdentityService,
    private readonly iosAppAttestService: IosAppAttestService,
    @Inject(configuration.KEY) private readonly config: ConfigType<typeof configuration>,
  ) {}

  private resolveBodyAppSlug(routeApp?: string, body?: Record<string, unknown>, queryApp?: string) {
    return (
      String(routeApp || '').trim() ||
      String(body?.app_slug || body?.appSlug || body?.app || '').trim() ||
      String(queryApp || '').trim() ||
      this.platformAppSlug()
    );
  }

  private resolveRouteAppSlug(routeApp?: string) {
    return String(routeApp || '').trim() || this.platformAppSlug();
  }

  private platformAppSlug() {
    return String(this.config.app.platformSlug || 'platform').trim().toLowerCase() || 'platform';
  }

  private buildCurrentCallbackUrl(req: any): string {
    const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0]?.trim();
    const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0]?.trim();
    const proto = forwardedProto || req.protocol || 'https';
    const host = forwardedHost || req.headers?.host || '';
    const path = String(req.originalUrl || req.url || '').split('?')[0] || '';
    return host && path ? `${proto}://${host}${path}` : '';
  }

  private normalizeRefreshToken(raw: unknown): string | null {
    const value = String(raw || '').trim();
    if (!value) return null;
    return value.replace(/^Bearer\s+/i, '').trim() || null;
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登录' })
  async login(@Body() body: { email?: string; username?: string; password?: string }, @Param('app') app?: string) {
    const email = String(body?.email || body?.username || '').trim();
    const password = String(body?.password || '');
    if (!email || !password) {
      throw new BadRequestException('Email and password are required');
    }
    return this.authService.login(email, password, this.resolveRouteAppSlug(app));
  }

  @Public()
  @Post('send-email-login-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '发送邮箱登录验证码' })
  async sendEmailLoginCode(@Body() body: { email?: string }, @Param('app') app?: string) {
    return this.authService.sendEmailLoginCode(String(body?.email || ''), this.resolveRouteAppSlug(app));
  }

  @Public()
  @Post('login/email-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '邮箱验证码登录' })
  async loginWithEmailCode(@Body() body: LoginEmailCodeDto, @Param('app') app?: string) {
    return this.authService.loginWithEmailCode(body.email, body.code, this.resolveRouteAppSlug(app));
  }

  @Public()
  @Post('register')
  @ApiOperation({ summary: '注册' })
  async register(@Body() dto: RegisterDto, @Param('app') app?: string) {
    return this.authService.register(
      {
        email: dto.email,
        password: dto.password,
        fullName: dto.fullName,
        inviteCode: dto.invite_code,
      },
      this.resolveRouteAppSlug(app),
    );
  }

  @Public()
  @Post(['refresh', 'refresh-token', 'refresh_token', 'refresh token', 'refresh/:token'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '刷新 token' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: any,
    @Param('app') app?: string,
    @Param('token') pathToken?: string,
    @Query('refresh_token') queryToken?: string,
    @Query('refreshToken') queryTokenCamel?: string,
    @Query('token') queryPlainToken?: string,
  ) {
    const refreshToken =
      this.normalizeRefreshToken(dto.refresh_token) ||
      this.normalizeRefreshToken(dto.refreshToken) ||
      this.normalizeRefreshToken(dto.token) ||
      this.normalizeRefreshToken(pathToken) ||
      this.normalizeRefreshToken(queryToken) ||
      this.normalizeRefreshToken(queryTokenCamel) ||
      this.normalizeRefreshToken(queryPlainToken) ||
      this.normalizeRefreshToken(req.cookies?.refresh_token);
    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token provided');
    }
    return this.authService.refreshToken(refreshToken, this.resolveRouteAppSlug(app));
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '退出登录' })
  async logout(@CurrentUser() user: UserType & { sessionId?: string | null }) {
    return this.authService.logout(user.id, user.sessionId);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取当前用户' })
  async getProfile(@CurrentUser() user: UserType) {
    return this.authService.getProfile(user.id);
  }

  @Public()
  @Post('send-verification-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '发送邮箱验证码' })
  async sendVerificationCode(@Body() dto: SendVerificationCodeDto & Record<string, unknown>, @Param('app') app?: string, @Query('app') queryApp?: string) {
    return this.authService.sendVerificationCode(dto.email, dto.password, this.resolveBodyAppSlug(app, dto, queryApp));
  }

  @Public()
  @Post('verify-email')
  @ApiOperation({ summary: '邮箱验证码注册' })
  async verifyEmail(@Body() dto: VerifyEmailDto & Record<string, unknown>, @Param('app') app?: string, @Query('app') queryApp?: string) {
    return this.authService.verifyEmail(dto.email, dto.verification_code, dto.password, this.resolveBodyAppSlug(app, dto, queryApp), dto.invite_code);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '忘记密码' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Public()
  @Post('reset-password')
  @ApiOperation({ summary: '重置密码' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.email, dto.verification_code, dto.new_password);
  }

  @Public()
  @Post('send-sms-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '发送短信验证码' })
  async sendSmsCode(@Body() body: { phone: string }, @Param('app') app?: string) {
    return this.authService.sendSmsCode(body.phone, this.resolveRouteAppSlug(app));
  }

  @Public()
  @Post('login/sms')
  @ApiOperation({ summary: '短信登录' })
  async loginWithSms(@Body() body: LoginSmsDto, @Param('app') app?: string) {
    return this.authService.loginWithSms(body.phone, body.code, this.resolveRouteAppSlug(app), body.invite_code);
  }

  @Public()
  @Post('register/sms')
  @ApiOperation({ summary: '短信注册（兼容别名）' })
  async registerWithSms(@Body() body: LoginSmsDto, @Param('app') app?: string) {
    return this.authService.loginWithSms(body.phone, body.code, this.resolveRouteAppSlug(app), body.invite_code);
  }

  @Public()
  @Get('login/providers')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @ApiOperation({ summary: '获取登录方式' })
  async getLoginProviders(@Param('app') app?: string) {
    return this.authService.getLoginProviders(this.resolveRouteAppSlug(app));
  }

  @Public()
  @Get('login/wechat/url')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @ApiOperation({ summary: '获取微信登录 URL' })
  async getWechatLoginUrl(@Param('app') app?: string, @Query('state') state?: string) {
    return this.authService.getWechatLoginUrl(this.resolveRouteAppSlug(app), state);
  }

  @Public()
  @Get('login/wechat/web')
  @ApiOperation({ summary: '获取微信网页登录 URL' })
  async getWechatWebLoginUrl(@Param('app') app?: string, @Query('state') state?: string) {
    return this.authService.getWechatLoginUrl(this.resolveRouteAppSlug(app), state);
  }

  @Public()
  @Get('login/wechat/status')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @ApiOperation({ summary: '查询微信扫码登录状态' })
  async getWechatLoginStatus(@Query('session_id') sessionId: string, @Param('app') app?: string) {
    return this.authService.getWechatLoginStatus(sessionId, this.resolveRouteAppSlug(app));
  }

  @Public()
  @Post('login/wechat')
  @ApiOperation({ summary: '微信登录' })
  async loginWithWechat(@Body() body: { code: string }, @Param('app') app?: string) {
    return this.authService.loginWithWechat(body.code, this.resolveRouteAppSlug(app));
  }

  @Public()
  @Get('login/wechat/callback')
  @ApiOperation({ summary: '微信登录回调' })
  async loginWithWechatCallback(@Query('code') code: string, @Query('state') state?: string, @Param('app') app?: string) {
    return this.authService.loginWithWechatCallback(code, this.resolveRouteAppSlug(app), state);
  }

  @Public()
  @Post('login/google')
  @ApiOperation({ summary: 'Google 登录' })
  async loginWithGoogle(@Body() body: { id_token: string }, @Param('app') app?: string) {
    return this.authService.loginWithGoogle(body.id_token, this.resolveRouteAppSlug(app));
  }

  @Public()
  @Get('login/google/callback')
  @ApiOperation({ summary: 'Google 登录回调' })
  async loginWithGoogleCallback(
    @Req() req: any,
    @Query('code') code?: string,
    @Query('credential') credential?: string,
    @Query('id_token') idToken?: string,
    @Query('state') state?: string,
    @Param('app') app?: string,
  ) {
    return this.authService.loginWithGoogleCallback(code, credential || idToken, this.resolveRouteAppSlug(app), this.buildCurrentCallbackUrl(req), state);
  }

  @Public()
  @Get('login/google/config')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @ApiOperation({ summary: '获取 Google 登录配置' })
  async getGoogleLoginConfig(@Param('app') app?: string) {
    return this.authService.getGoogleLoginConfig(this.resolveRouteAppSlug(app));
  }

  @Public()
  @Post('login/github')
  @ApiOperation({ summary: 'GitHub 登录' })
  async loginWithGitHub(@Body() body: { code: string; redirect_uri?: string }, @Param('app') app?: string) {
    return this.authService.loginWithGitHub(body.code, this.resolveRouteAppSlug(app), body.redirect_uri);
  }

  @Public()
  @Get('login/github/callback')
  @ApiOperation({ summary: 'GitHub 登录回调' })
  async loginWithGitHubCallback(
    @Req() req: any,
    @Query('code') code: string,
    @Query('state') state?: string,
    @Param('app') app?: string,
  ) {
    return this.authService.loginWithGitHubCallback(code, this.resolveRouteAppSlug(app), this.buildCurrentCallbackUrl(req), state);
  }

  @Public()
  @Get('login/github/config')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @ApiOperation({ summary: '获取 GitHub 登录配置' })
  async getGitHubLoginConfig(@Param('app') app?: string) {
    return this.authService.getGitHubLoginConfig(this.resolveRouteAppSlug(app));
  }

  @Public()
  @Get('apple/config')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @ApiOperation({ summary: '获取 Apple 登录配置' })
  async getAppleLoginConfig(@Param('app') app?: string) {
    return this.appleIdentityService.getPublicConfig(this.resolveRouteAppSlug(app));
  }

  @Public()
  @Post('login/apple')
  @ApiOperation({ summary: 'Apple 登录' })
  async loginWithApple(
    @Body() body: {
      identity_token?: string;
      nonce?: string;
      full_name?: string;
      app_attest_key_id?: string;
      app_attest_assertion?: string;
      app_attest_challenge_id?: string;
    },
    @Req() req: any,
    @Param('app') app?: string,
  ) {
    return this.accountBindingService.loginWithApple(body || {}, this.resolveRouteAppSlug(app), req);
  }

  @Public()
  @Post('ios/app-attest/challenge')
  @ApiOperation({ summary: '创建 iOS App Attest challenge' })
  async createIosAppAttestChallenge(
    @Body() body: { purpose?: string; key_id?: string },
    @Req() req: any,
    @Param('app') app?: string,
  ) {
    return this.iosAppAttestService.createChallenge(this.resolveRouteAppSlug(app), body || {}, req);
  }

  @Public()
  @Post('ios/app-attest/register')
  @ApiOperation({ summary: '注册 iOS App Attest 设备' })
  async registerIosAppAttestDevice(
    @Body() body: { key_id?: string; attestation_object?: string; challenge_id?: string },
    @Req() req: any,
    @Param('app') app?: string,
  ) {
    return this.iosAppAttestService.registerDevice(this.resolveRouteAppSlug(app), body || {}, req);
  }

  @Public()
  @Post('ios/device-login')
  @ApiOperation({ summary: 'iOS 设备无账号登录' })
  async loginWithIosDevice(
    @Body() body: { key_id?: string; assertion?: string; challenge_id?: string },
    @Req() req: any,
    @Param('app') app?: string,
  ) {
    return this.accountBindingService.loginWithDevice(body || {}, this.resolveRouteAppSlug(app), req);
  }

  @Post('bind-wechat')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '绑定微信' })
  async bindWechat(@CurrentUser() user: UserType, @Body() body: { code: string }) {
    return this.authService.bindWechat(user.id, body.code);
  }

  @Get('bind-wechat/url')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @ApiOperation({ summary: '获取微信绑定 URL' })
  async getWechatBindUrl(@CurrentUser() user: UserType, @Query('state') state?: string) {
    return this.authService.getWechatBindUrl(user.id, state);
  }

  @Get('bind-wechat/status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @ApiOperation({ summary: '查询微信绑定状态' })
  async getWechatBindStatus(@CurrentUser() user: UserType, @Query('session_id') sessionId: string) {
    return this.authService.getWechatBindStatus(user.id, sessionId);
  }

  @Post('unbind-wechat')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '解绑微信' })
  async unbindWechat(@CurrentUser() user: UserType) {
    return this.authService.unbindWechat(user.id);
  }

  @Post('account/delete')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '删除账号' })
  async deleteAccount(@CurrentUser() user: UserType) {
    return this.authService.deleteAccount(user.id);
  }
}
