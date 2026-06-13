# Auth 模块文档

> 模块名称：`auth`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `auth` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/auth/account-binding.service.ts`
- `src/modules/auth/apple-identity.service.ts`
- `src/modules/auth/auth.controller.ts`
- `src/modules/auth/auth.module.ts`
- `src/modules/auth/auth.service.ts`
- `src/modules/auth/dto/auth.dto.ts`
- `src/modules/auth/email-verification.service.ts`
- `src/modules/auth/ios-app-attest.service.ts`
- `src/modules/auth/jwt.strategy.ts`

## 3. Controller 与路由
### AuthController
- 控制器文件：`src/modules/auth/auth.controller.ts`
- 基础路由：`tenantControllerPaths('auth', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| POST | `login` | `login()` |
| POST | `send-email-login-code` | `sendEmailLoginCode()` |
| POST | `login/email-code` | `loginWithEmailCode()` |
| POST | `register` | `register()` |
| POST | `refresh` | `refresh()` |
| POST | `logout` | `logout()` |
| GET | `me` | `getProfile()` |
| POST | `send-verification-code` | `sendVerificationCode()` |
| POST | `verify-email` | `verifyEmail()` |
| POST | `forgot-password` | `forgotPassword()` |
| POST | `reset-password` | `resetPassword()` |
| POST | `send-sms-code` | `sendSmsCode()` |
| POST | `login/sms` | `loginWithSms()` |
| POST | `register/sms` | `registerWithSms()` |
| GET | `login/providers` | `getLoginProviders()` |
| GET | `login/wechat/url` | `getWechatLoginUrl()` |
| GET | `login/wechat/web` | `getWechatWebLoginUrl()` |
| GET | `login/wechat/status` | `getWechatLoginStatus()` |
| POST | `login/wechat` | `loginWithWechat()` |
| GET | `login/wechat/callback` | `loginWithWechatCallback()` |
| POST | `login/google` | `loginWithGoogle()` |
| GET | `login/google/callback` | `loginWithGoogleCallback()` |
| GET | `login/google/config` | `getGoogleLoginConfig()` |
| POST | `login/github` | `loginWithGitHub()` |
| GET | `login/github/callback` | `loginWithGitHubCallback()` |
| GET | `login/github/config` | `getGitHubLoginConfig()` |
| GET | `apple/config` | `getAppleLoginConfig()` |
| POST | `login/apple` | `loginWithApple()` |
| POST | `ios/app-attest/challenge` | `createIosAppAttestChallenge()` |
| POST | `ios/app-attest/register` | `registerIosAppAttestDevice()` |
| POST | `ios/device-login` | `loginWithIosDevice()` |
| POST | `bind-wechat` | `bindWechat()` |
| GET | `bind-wechat/url` | `getWechatBindUrl()` |
| GET | `bind-wechat/status` | `getWechatBindStatus()` |
| POST | `unbind-wechat` | `unbindWechat()` |
| POST | `account/delete` | `deleteAccount()` |

## 4. Service 能力
### AccountBindingService
- 服务文件：`src/modules/auth/account-binding.service.ts`
- 核心方法：
- `loginWithDevice()`
- `listIdentities()`
- `unbindApple()`
- `mergeGuestIntoAccount()`
- `listDevices()`
- `revokeDevice()`
- `deleteAccount()`
- `findOrCreateAppleUser()`
- `createGuestUser()`
- `requireUser()`
- `findIdentity()`
- `maskSubject()`

### AppleIdentityService
- 服务文件：`src/modules/auth/apple-identity.service.ts`
- 核心方法：
- `getPublicConfig()`
- `resolveAppWithSettings()`
- `resolveAppleLoginConfig()`
- `sha256Base64Url()`

### AuthService
- 服务文件：`src/modules/auth/auth.service.ts`
- 核心方法：
- `clearOAuthConfigCache()`
- `onModuleInit()`
- `login()`
- `sendEmailLoginCode()`
- `loginWithEmailCode()`
- `register()`
- `refreshToken()`
- `verifyAccessToken()`
- `validateAccessTokenPayload()`
- `logout()`
- `getProfile()`
- `sendVerificationCode()`
- `verifyEmail()`
- `forgotPassword()`
- `resetPassword()`
- `sendSmsCode()`
- `sendSmsCodeForAppId()`
- `normalizeSmsPhone()`
- `normalizeSmsPhoneVariants()`
- `verifySmsCodeForAppId()`
- `sendSmsCodeForResolvedApp()`
- `loginWithSms()`
- `getWechatLoginUrl()`
- `getWechatBindUrl()`
- `getWechatBindStatus()`
- `getWechatLoginStatus()`
- `loginWithWechat()`
- `loginWithGoogle()`
- `loginWithWechatCallback()`
- `getGoogleLoginConfig()`
- `loginWithGitHub()`
- `loginWithGitHubCallback()`
- `getGitHubLoginConfig()`
- `getLoginProviders()`
- `findOAuthIdentity()`
- `loginWithApple()`
- `bindWechat()`
- `unbindWechat()`
- `deleteAccount()`
- `createUserWithCompat()`
- `isUniqueConstraintError()`
- `createUserWithRawSql()`
- `detectUserCreateSchemaMode()`
- `isUserEnumSchemaMismatch()`
- `resolveAppWithSettings()`
- `resolveAppByIdWithSettings()`
- `resolveWechatWebLoginConfig()`
- `resolveGoogleLoginConfig()`
- `resolveGitHubLoginConfig()`
- `verifyGoogleIdToken()`
- `fetchGoogleIdToken()`
- `fetchGitHubUserProfile()`
- `resolveGitHubVerifiedEmail()`
- `assertOAuthRedirectUriAllowed()`
- `resolveOAuthRedirectAllowedHosts()`
- `normalizeOAuthRedirectHost()`
- `resolveWechatRedirectUri()`
- `normalizeWechatRedirectUri()`
- `normalizeWechatRedirectHost()`
- `buildDefaultWechatRedirectUri()`
- `buildWechatQrConnectUrl()`
- `resolveWechatQrContent()`
- `resolveWechatQrContentWithRetry()`
- `extractWechatConfirmUrl()`
- `extractUuidFromConfirmUrl()`
- `extractWechatQrUuid()`
- `fetchWechatQrScanStatus()`
- `refreshWechatLoginSessionStatus()`
- `cleanupWechatLoginSessions()`
- `buildWechatSessionStatusResponse()`
- `fetchWechatAccessToken()`
- `exchangeWechatCode()`
- `fetchWechatUserProfile()`
- `normalizeWechatDisplayName()`
- `buildWechatPlaceholderEmail()`
- `buildGooglePlaceholderEmail()`
- `buildGitHubPlaceholderEmail()`
- `normalizeExternalDisplayName()`
- `buildPhonePlaceholderEmail()`
- `buildPhoneIdentityVariants()`
- `pickPhoneLoginUser()`
- `ensureRefreshSessionSchema()`
- `ensureSmsVerificationSchema()`
- `assertSmsSendCooldown()`
- `verifySmsCode()`
- `hashSmsCode()`
- `resolveSmsDispatchMode()`
- `deleteSmsCode()`
- `normalizePhone()`
- `normalizeSmsCode()`
- `parseBooleanLike()`
- `parseSmsProviderType()`
- `extractAppSmsRouteConfig()`
- `resolveSmsRouteConfig()`
- `buildSmsRouteCacheKey()`
- `rethrowSmsDispatchFetchError()`
- `pickSmsTemplateVariables()`
- `buildAliyunSignedUrl()`
- `aliyunPercentEncode()`
- `ensureWechatOpenAppSchema()`
- `ensureGoogleOAuthClientSchema()`
- `ensureGitHubOAuthAppSchema()`
- `resolveApp()`
- `buildAuthResponse()`
- `normalizeAppSlug()`
- `hashRefreshToken()`
- `hashSessionToken()`
- `pruneAuthUserSessions()`
- `revokeAllAuthUserSessions()`
- `findActiveAuthSession()`
- `dateFromUnixSeconds()`
- `dateFromTokenTime()`
- `getRefreshTokenInactivityMs()`
- `getRefreshTokenAbsoluteMs()`
- `validateSessionUser()`
- `ensureInviteCodeForUser()`
- `tryApplyInviteReward()`
- `ensureInviteSchema()`
- `generateInviteCode()`
- `normalizeInviteCode()`
- `rotateInviteCodeForUser()`
- `pickUserProfile()`
- `generateSessionToken()`
- `getInviteCodeCacheKey()`
- `getCachedInviteCode()`
- `setCachedInviteCode()`
- `generateVerificationCode()`
- `normalizeEmail()`
- `preprocessPassword()`
- `hashPassword()`
- `verifyPassword()`

### EmailVerificationService
- 服务文件：`src/modules/auth/email-verification.service.ts`
- 核心方法：
- `onModuleInit()`
- `ensureSchema()`
- `initSchema()`
- `assertCooldown()`
- `sendVerificationEmail()`
- `dispatchVerificationEmail()`
- `buildVerificationHtml()`
- `normalizeEmail()`
- `normalizeCode()`
- `generateCode()`
- `hashCode()`
- `parseObject()`
- `escapeHtml()`
- `resolveAppWithSettings()`
- `resolveAppByIdWithSettings()`
- `getTransporter()`
- `readAppSettingsCache()`
- `writeAppSettingsCache()`

### IosAppAttestService
- 服务文件：`src/modules/auth/ios-app-attest.service.ts`
- 核心方法：
- `createChallenge()`
- `registerDevice()`
- `verifyAssertionForSensitiveRequest()`
- `verifySensitiveIfRequired()`
- `verifyAssertion()`
- `attachDeviceToUser()`
- `requireAppleConfig()`
- `consumeChallenge()`
- `parseAttestationObject()`
- `parseAssertion()`
- `serializeDevice()`

## 5. 数据库/存储依赖（自动扫描）
- `app_settings`
- `apple_login_credentials`
- `apps`
- `auth_email_verification_codes`
- `auth_invite_codes`
- `auth_invite_redemptions`
- `auth_sms_verification_codes`
- `auth_user_sessions`
- `github_oauth_apps`
- `google_oauth_clients`
- `ios_app_attest_devices`
- `ios_auth_challenges`
- `platform_sms_providers`
- `platform_sms_signatures`
- `platform_sms_templates`
- `ranked`
- `user_entitlements`
- `user_identities`
- `users`
- `wechat_open_apps`

## 6. 模块依赖（自动扫描）
- `..`
- `ai-chat`
- `email-delivery`
- `outbound-proxy`
- `redeem`

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-06-10：自动生成/刷新模块文档结构与清单。
