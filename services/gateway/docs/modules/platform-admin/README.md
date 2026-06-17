# Platform Admin 模块文档

> 模块名称：`platform-admin`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `platform-admin` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/platform-admin/feedback-admin-api.controller.ts`
- `src/modules/platform-admin/guards/platform-admin-ai-debug-jwt-auth.guard.ts`
- `src/modules/platform-admin/platform-admin.controller.ts`
- `src/modules/platform-admin/platform-admin.module.ts`
- `src/modules/platform-admin/platform-admin.service.ts`
- `src/modules/platform-admin/platform-analytics-facts-read-state.service.ts`
- `src/modules/platform-admin/platform-analytics-facts-refresh-state.repository.ts`
- `src/modules/platform-admin/platform-analytics-response-cache.service.ts`
- `src/modules/platform-admin/platform-analytics-schema-health.service.ts`
- `src/modules/platform-admin/platform-analytics-source-tables.service.ts`
- `src/modules/platform-admin/platform-analytics.types.ts`
- `src/modules/platform-admin/platform-app-analytics.service.ts`

## 3. Controller 与路由
### FeedbackAdminApiController
- 控制器文件：`src/modules/platform-admin/feedback-admin-api.controller.ts`
- 基础路由：`['/api/v1/platform-admin/feedback-issues', '/platform-admin/feedback-issues']`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `(root)` | `listFeedbackIssues()` |
| GET | `:feedback_id` | `getFeedbackIssue()` |
| PATCH | `:feedback_id` | `updateFeedbackIssue()` |
| POST | `:feedback_id/comments` | `addFeedbackIssueComment()` |
| POST | `:feedback_id/review` | `reviewFeedbackIssue()` |

### PlatformAdminController
- 控制器文件：`src/modules/platform-admin/platform-admin.controller.ts`
- 基础路由：`tenantControllerPaths('platform-admin', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `apps` | `listApps()` |
| GET | `wechat/open-apps` | `listGlobalWechatOpenApps()` |
| POST | `wechat/open-apps` | `createGlobalWechatOpenApp()` |
| PUT | `wechat/open-apps/:open_app_id` | `updateGlobalWechatOpenApp()` |
| DELETE | `wechat/open-apps/:open_app_id` | `deleteGlobalWechatOpenApp()` |
| POST | `wechat/open-apps/:open_app_id/test` | `testGlobalWechatOpenApp()` |
| GET | `google/oauth-clients` | `listGlobalGoogleOAuthClients()` |
| POST | `google/oauth-clients` | `createGlobalGoogleOAuthClient()` |
| PUT | `google/oauth-clients/:client_id` | `updateGlobalGoogleOAuthClient()` |
| DELETE | `google/oauth-clients/:client_id` | `deleteGlobalGoogleOAuthClient()` |
| POST | `google/oauth-clients/:client_id/test` | `testGlobalGoogleOAuthClient()` |
| GET | `proxies` | `listOutboundProxies()` |
| POST | `proxies` | `createOutboundProxy()` |
| PUT | `proxies/:proxy_id` | `updateOutboundProxy()` |
| DELETE | `proxies/:proxy_id` | `deleteOutboundProxy()` |
| POST | `proxies/:proxy_id/test` | `testOutboundProxy()` |
| POST | `proxies/batch-test` | `batchTestOutboundProxies()` |
| POST | `proxies/import` | `importOutboundProxies()` |
| GET | `proxies/export` | `exportOutboundProxies()` |
| GET | `proxies/:proxy_id/check-logs` | `listOutboundProxyCheckLogs()` |
| GET | `github/oauth-apps` | `listGlobalGitHubOAuthApps()` |
| POST | `github/oauth-apps` | `createGlobalGitHubOAuthApp()` |
| PUT | `github/oauth-apps/:app_id` | `updateGlobalGitHubOAuthApp()` |
| DELETE | `github/oauth-apps/:app_id` | `deleteGlobalGitHubOAuthApp()` |
| POST | `github/oauth-apps/:app_id/test` | `testGlobalGitHubOAuthApp()` |
| GET | `apple/login-credentials` | `listGlobalAppleLoginCredentials()` |
| POST | `apple/login-credentials` | `createGlobalAppleLoginCredential()` |
| PUT | `apple/login-credentials/:credential_id` | `updateGlobalAppleLoginCredential()` |
| DELETE | `apple/login-credentials/:credential_id` | `deleteGlobalAppleLoginCredential()` |
| POST | `apple/login-credentials/:credential_id/test` | `testGlobalAppleLoginCredential()` |
| GET | `payments/methods` | `listGlobalPaymentMethods()` |
| GET | `email/cloudflare/accounts` | `listEmailCloudflareAccounts()` |
| POST | `email/cloudflare/accounts` | `createEmailCloudflareAccount()` |
| POST | `email/cloudflare/accounts/verify-token` | `verifyEmailCloudflareToken()` |
| PATCH | `email/cloudflare/accounts/:account_id` | `updateEmailCloudflareAccount()` |
| DELETE | `email/cloudflare/accounts/:account_id` | `deleteEmailCloudflareAccount()` |
| POST | `email/cloudflare/accounts/:account_id/test` | `testEmailCloudflareAccount()` |
| GET | `email/cloudflare/accounts/:account_id/sending-domains` | `listEmailCloudflareSendingDomains()` |
| GET | `email/senders` | `listEmailSenders()` |
| POST | `email/senders` | `createEmailSender()` |
| PATCH | `email/senders/:sender_id` | `updateEmailSender()` |
| DELETE | `email/senders/:sender_id` | `deleteEmailSender()` |
| POST | `email/senders/:sender_id/test` | `testEmailSender()` |
| POST | `payments/methods` | `createGlobalPaymentMethod()` |
| PUT | `payments/methods/:method_id` | `updateGlobalPaymentMethod()` |
| DELETE | `payments/methods/:method_id` | `deleteGlobalPaymentMethod()` |
| POST | `payments/methods/test` | `testGlobalPaymentMethod()` |
| GET | `payments/apps/:app_id/products` | `listAppPaymentProductsForTest()` |
| GET | `apps/:app_id/payments/orders` | `listAppPaymentOrders()` |
| GET | `payments/apps/:app_id/orders` | `listAppPaymentOrdersLegacyPath()` |
| GET | `payments/orders` | `listAppPaymentOrdersQueryPath()` |
| POST | `apps/:app_id/payments/orders/:order_id/refund` | `refundAppPaymentOrder()` |
| POST | `payments/apps/:app_id/orders/:order_id/refund` | `refundAppPaymentOrderLegacyPath()` |
| POST | `payments/orders/:order_id/refund` | `refundAppPaymentOrderQueryPath()` |
| POST | `payments/testing/one-time` | `runPlatformPaymentOneTimeTest()` |
| POST | `payments/testing/wechat/one-time` | `runPlatformPaymentWechatOneTimeTest()` |
| POST | `payments/testing/recurring` | `runPlatformPaymentRecurringTest()` |
| POST | `payments/testing/full-flow` | `runPlatformPaymentFullFlowTest()` |
| GET | `sms/provider-catalog` | `listSmsProviderCatalog()` |
| GET | `sms/providers` | `listGlobalSmsProviders()` |
| POST | `sms/providers` | `createGlobalSmsProvider()` |
| PUT | `sms/providers/:provider_id` | `updateGlobalSmsProvider()` |
| DELETE | `sms/providers/:provider_id` | `deleteGlobalSmsProvider()` |
| POST | `sms/providers/test` | `testGlobalSmsProvider()` |
| GET | `sms/signatures` | `listGlobalSmsSignatures()` |
| POST | `sms/signatures` | `createGlobalSmsSignature()` |
| PUT | `sms/signatures/:signature_id` | `updateGlobalSmsSignature()` |
| DELETE | `sms/signatures/:signature_id` | `deleteGlobalSmsSignature()` |
| GET | `sms/templates` | `listGlobalSmsTemplates()` |
| POST | `sms/templates` | `createGlobalSmsTemplate()` |
| PUT | `sms/templates/:template_id` | `updateGlobalSmsTemplate()` |
| DELETE | `sms/templates/:template_id` | `deleteGlobalSmsTemplate()` |
| GET | `sms/events` | `listSmsMessageEvents()` |
| GET | `sms/summary` | `getSmsObservabilitySummary()` |
| GET | `apps/:app_id` | `getApp()` |
| POST | `apps` | `createApp()` |
| PUT | `apps/:app_id` | `updateApp()` |
| GET | `apps/:app_id/stats` | `getAppStats()` |
| POST | `apps/:app_id/sms/test-send` | `sendAppSmsTestCode()` |
| GET | `apps/:app_id/email/settings` | `getAppEmailSettings()` |
| PUT | `apps/:app_id/email/settings` | `updateAppEmailSettings()` |
| GET | `apps/:app_id/email/contacts` | `listAppEmailContacts()` |
| POST | `apps/:app_id/email/contacts/import` | `importAppEmailContacts()` |
| PATCH | `apps/:app_id/email/contacts/:contact_id` | `updateAppEmailContact()` |
| GET | `apps/:app_id/email/templates` | `listAppEmailTemplates()` |
| POST | `apps/:app_id/email/templates` | `createAppEmailTemplate()` |
| PATCH | `apps/:app_id/email/templates/:template_id` | `updateAppEmailTemplate()` |
| GET | `apps/:app_id/email/campaigns` | `listAppEmailCampaigns()` |
| POST | `apps/:app_id/email/campaigns` | `createAppEmailCampaign()` |
| POST | `apps/:app_id/email/campaigns/:campaign_id/send-test` | `sendAppEmailCampaignTest()` |
| POST | `apps/:app_id/email/campaigns/:campaign_id/schedule` | `scheduleAppEmailCampaign()` |
| POST | `apps/:app_id/email/campaigns/:campaign_id/cancel` | `cancelAppEmailCampaign()` |
| GET | `apps/:app_id/email/campaigns/:campaign_id/recipients` | `listAppEmailCampaignRecipients()` |
| GET | `apps/:app_id/site` | `getAppSiteSettings()` |
| PUT | `apps/:app_id/site` | `updateAppSiteSettings()` |
| POST | `apps/:app_id/site/downloads/:platform/upload-url` | `createAppSiteDownloadUploadUrl()` |
| POST | `apps/:app_id/site/downloads/:platform/confirm-upload` | `confirmAppSiteDownloadUpload()` |
| GET | `apps/:app_id/business-analytics` | `getAppBusinessAnalytics()` |
| GET | `apps/:app_id/analytics/overview` | `getAppAnalyticsOverview()` |
| GET | `apps/:app_id/analytics/growth` | `getAppAnalyticsGrowth()` |
| GET | `apps/:app_id/analytics/retention` | `getAppAnalyticsRetention()` |
| GET | `apps/:app_id/analytics/profiles` | `getAppAnalyticsProfiles()` |
| GET | `apps/:app_id/analytics/conversion` | `getAppAnalyticsConversion()` |
| GET | `apps/:app_id/analytics/users` | `getAppAnalyticsUsers()` |
| GET | `apps/:app_id/ai/usage/summary` | `getAppAiUsageSummary()` |
| GET | `apps/:app_id/ai/usage/breakdown` | `getAppAiUsageBreakdown()` |
| GET | `apps/:app_id/ai/usage/logs` | `listAppAiUsageLogs()` |
| GET | `apps/:app_id/admins` | `listAppAdmins()` |
| GET | `apps/:app_id/admin-permissions/me` | `getMyAppAdminPermissions()` |
| POST | `apps/:app_id/users/:user_id/deactivate` | `deactivateTenantUser()` |
| POST | `apps/:app_id/users/:user_id/restore` | `restoreTenantUser()` |
| POST | `apps/:app_id/users/:user_id/unlink-phone` | `unlinkTenantUserPhone()` |
| POST | `apps/:app_id/users/:user_id/unlink-email` | `unlinkTenantUserEmail()` |
| POST | `apps/:app_id/admins` | `createOrUpdateAdmin()` |
| PUT | `apps/:app_id/admins/:admin_user_id/password` | `resetAdminPassword()` |
| PATCH | `apps/:app_id/admins/:admin_user_id/permissions` | `updateAdminPermissions()` |
| PATCH | `apps/:app_id/admins/:admin_user_id/status` | `updateAdminStatus()` |
| DELETE | `apps/:app_id/admins/:admin_user_id` | `deleteAdmin()` |
| GET | `ai/sources` | `listGlobalAiSources()` |
| GET | `ai/provider-templates` | `listGlobalAiProviderTemplates()` |
| GET | `ai/gateway/runtime` | `getAiGatewayRuntimeStats()` |
| POST | `ai/sources` | `createGlobalAiSource()` |
| POST | `ai/sources/test` | `testGlobalAiSourceConnectivity()` |
| PUT | `ai/sources/:source_id` | `updateGlobalAiSource()` |
| DELETE | `ai/sources/:source_id` | `deleteGlobalAiSource()` |
| GET | `ai/models` | `listGlobalAiModels()` |
| POST | `ai/models` | `createGlobalAiModel()` |
| POST | `ai/models/test` | `testGlobalAiModelConnectivity()` |
| POST | `ai/models/test-batch` | `testGlobalAiModelConnectivityBatch()` |
| GET | `ai/models/:model_id/sources` | `listGlobalAiModelSourceRoutes()` |
| PUT | `ai/models/:model_id/sources` | `replaceGlobalAiModelSourceRoutes()` |
| POST | `ai/models/playground` | `runGlobalAiModelPlayground()` |
| POST | `ai/models/playground/query` | `queryGlobalAiModelPlaygroundTask()` |
| PUT | `ai/models/:model_id` | `updateGlobalAiModel()` |
| DELETE | `ai/models/:model_id` | `deleteGlobalAiModel()` |
| GET | `ai/usage/summary` | `getGlobalAiUsageSummary()` |
| GET | `ai/usage/breakdown` | `getGlobalAiUsageBreakdown()` |
| GET | `ai/usage/logs` | `listGlobalAiUsageLogs()` |
| GET | `apps/:app_id/ai/model-routes` | `listAppAiModelRoutes()` |
| PUT | `apps/:app_id/ai/model-routes/:model_id` | `upsertAppAiModelRoute()` |
| DELETE | `apps/:app_id/ai/model-routes/:model_id` | `deleteAppAiModelRoute()` |
| GET | `apps/:app_id/ai/default-models` | `listAppAiCapabilityDefaults()` |
| PUT | `apps/:app_id/ai/default-models/:capability` | `upsertAppAiCapabilityDefault()` |
| DELETE | `apps/:app_id/ai/default-models/:capability` | `deleteAppAiCapabilityDefault()` |
| GET | `apps/:app_id/ai/default-model-slots` | `listAppAiDefaultModelSlots()` |
| PUT | `apps/:app_id/ai/default-model-slots/:slot_key` | `upsertAppAiDefaultModelSlot()` |
| DELETE | `apps/:app_id/ai/default-model-slots/:slot_key` | `deleteAppAiDefaultModelSlot()` |
| GET | `apps/:app_id/ai/points-settings` | `getAppAiPointsSettings()` |
| PUT | `apps/:app_id/ai/points-settings` | `updateAppAiPointsSettings()` |
| POST | `apps/:app_id/ai/points/grant` | `grantAppAiPoints()` |
| GET | `apps/:app_id/feedbacks` | `listAppFeedbacks()` |
| GET | `apps/:app_id/feedbacks/:feedback_id` | `getAppFeedback()` |
| PATCH | `apps/:app_id/feedbacks/:feedback_id` | `updateAppFeedback()` |
| POST | `apps/:app_id/feedbacks/:feedback_id/comments` | `addAppFeedbackComment()` |
| POST | `apps/:app_id/feedbacks/:feedback_id/review` | `reviewAppFeedback()` |
| GET | `apps/:app_id/site/messages` | `listAppSiteMessages()` |
| PATCH | `apps/:app_id/site/messages/:message_id` | `updateAppSiteMessage()` |
| GET | `apps/:app_id/site/cookie-consents` | `listAppSiteCookieConsents()` |
| GET | `apps/:app_id/redeem/packages` | `listRedeemPackages()` |
| POST | `apps/:app_id/redeem/packages` | `createRedeemPackage()` |
| PUT | `apps/:app_id/redeem/packages/:package_id` | `updateRedeemPackage()` |
| DELETE | `apps/:app_id/redeem/packages/:package_id` | `deleteRedeemPackage()` |
| POST | `apps/:app_id/redeem/packages/:package_id/distribute` | `distributeRedeemPackageToUser()` |
| POST | `apps/:app_id/redeem/codes/batches` | `createRedeemCodeBatch()` |
| GET | `apps/:app_id/redeem/codes` | `listRedeemCodes()` |
| GET | `apps/:app_id/redeem/redemptions` | `listRedeemCodeRedemptions()` |
| POST | `apps/:app_id/redeem/redemptions/:redemption_id/revoke` | `revokeRedeemCodeRedemption()` |
| GET | `apps/:app_id/redeem/codes/batches` | `listRedeemCodeBatches()` |
| GET | `apps/:app_id/redeem/codes/batches/:batch_id/txt` | `getRedeemBatchTxt()` |
| POST | `apps/:app_id/redeem/codes/:code/void` | `voidRedeemCode()` |

## 4. Service 能力
### PlatformAdminService
- 服务文件：`src/modules/platform-admin/platform-admin.service.ts`
- 核心方法：
- `onModuleInit()`
- `listApps()`
- `listGlobalWechatOpenApps()`
- `deleteGlobalWechatOpenApp()`
- `testGlobalWechatOpenApp()`
- `listGlobalGoogleOAuthClients()`
- `deleteGlobalGoogleOAuthClient()`
- `testGlobalGoogleOAuthClient()`
- `listGlobalGitHubOAuthApps()`
- `deleteGlobalGitHubOAuthApp()`
- `testGlobalGitHubOAuthApp()`
- `listGlobalAppleLoginCredentials()`
- `createGlobalAppleLoginCredential()`
- `updateGlobalAppleLoginCredential()`
- `deleteGlobalAppleLoginCredential()`
- `testGlobalAppleLoginCredential()`
- `listGlobalPaymentMethods()`
- `deleteGlobalPaymentMethod()`
- `testGlobalPaymentMethod()`
- `listSmsProviderCatalog()`
- `listGlobalSmsProviders()`
- `createGlobalSmsProvider()`
- `updateGlobalSmsProvider()`
- `deleteGlobalSmsProvider()`
- `testGlobalSmsProvider()`
- `listGlobalSmsSignatures()`
- `createGlobalSmsSignature()`
- `updateGlobalSmsSignature()`
- `deleteGlobalSmsSignature()`
- `listGlobalSmsTemplates()`
- `createGlobalSmsTemplate()`
- `updateGlobalSmsTemplate()`
- `deleteGlobalSmsTemplate()`
- `listSmsMessageEvents()`
- `getSmsObservabilitySummary()`
- `listAppPaymentProductsForTest()`
- `getAppDetail()`
- `createApp()`
- `updateApp()`
- `getAppSiteSettings()`
- `updateAppSiteSettings()`
- `createAppSiteDownloadUploadUrl()`
- `confirmAppSiteDownloadUpload()`
- `getAppStats()`
- `getAppBusinessAnalytics()`
- `getAppAnalyticsOverview()`
- `getAppAnalyticsGrowth()`
- `getAppAnalyticsRetention()`
- `getAppAnalyticsProfiles()`
- `getAppAnalyticsConversion()`
- `getAppAnalyticsUsers()`
- `deactivateTenantUser()`
- `restoreTenantUser()`
- `unlinkTenantUserPhone()`
- `unlinkTenantUserEmail()`
- `listAppAdmins()`
- `getMyAppAdminPermissions()`
- `createOrUpdateAppAdmin()`
- `updateAdminPermissions()`
- `updateAdminStatus()`
- `deleteAppAdmin()`
- `listGlobalAiSources()`
- `listGlobalAiProviderTemplates()`
- `createGlobalAiSource()`
- `updateGlobalAiSource()`
- `deleteGlobalAiSource()`
- `testGlobalAiSourceConnectivity()`
- `listGlobalAiModels()`
- `createGlobalAiModel()`
- `updateGlobalAiModel()`
- `listGlobalAiModelSourceRoutes()`
- `replaceGlobalAiModelSourceRoutes()`
- `deleteGlobalAiModel()`
- `testGlobalAiModelConnectivity()`
- `getGlobalAiUsageSummary()`
- `getGlobalAiUsageBreakdown()`
- `getAppAiUsageSummary()`
- `getAppAiUsageBreakdown()`
- `resolveAiModelBatchTestStatus()`
- `resolveAiModelBatchTestMessage()`
- `listGlobalAiUsageLogs()`
- `listAppAiUsageLogs()`
- `listAppAiModelRoutes()`
- `upsertAppAiModelRoute()`
- `deleteAppAiModelRoute()`
- `listAppAiCapabilityDefaults()`
- `upsertAppAiCapabilityDefault()`
- `deleteAppAiCapabilityDefault()`
- `listAppAiDefaultModelSlots()`
- `upsertAppAiDefaultModelSlot()`
- `deleteAppAiDefaultModelSlot()`
- `getAppAiPointsSettings()`
- `updateAppAiPointsSettings()`
- `grantAppAiPoints()`
- `getAppFeedback()`
- `updateAppSiteMessage()`
- `listRedeemPackages()`
- `deleteRedeemPackage()`
- `listRedeemCodes()`
- `listRedeemCodeRedemptions()`
- `listRedeemCodeBatches()`
- `voidRedeemCode()`
- `ensureAppExists()`
- `attachRedeemPackagePaymentProducts()`
- `serializeRedeemPackagePaymentProduct()`
- `normalizeCurrencyAmount()`
- `buildRedeemPackagePaymentCode()`
- `normalizeMembershipDaysFromGrants()`
- `normalizeRedeemBillingInput()`
- `normalizeExecuteTime()`
- `ensurePaymentProductsTableForRedeem()`
- `syncRedeemPackagePaymentProduct()`
- `deactivateRedeemPackagePaymentProduct()`
- `ensureSuperAdmin()`
- `ensureAdminUser()`
- `ensureWechatOpenAppSchema()`
- `ensureGoogleOAuthClientSchema()`
- `ensureGitHubOAuthAppSchema()`
- `ensurePaymentMethodSchema()`
- `initializeWechatOpenAppSchema()`
- `initializeGoogleOAuthClientSchema()`
- `initializeGitHubOAuthAppSchema()`
- `initializePaymentMethodSchema()`
- `getWechatOpenAppRow()`
- `getGoogleOAuthClientRow()`
- `getGitHubOAuthAppRow()`
- `getPaymentMethodRow()`
- `getAppleLoginCredentialRow()`
- `normalizeAppleLoginCredentialPayload()`
- `serializeAppleLoginCredential()`
- `normalizePaymentProviderType()`
- `normalizePaymentMethodConfig()`
- `assertPaymentMethodConfig()`
- `serializePaymentMethod()`
- `parseBooleanLike()`
- `normalizeOptionalUuid()`
- `ensureOutboundProxyExists()`
- `describeNetworkFailure()`
- `serializeWechatOpenApp()`
- `serializeGoogleOAuthClient()`
- `serializeGitHubOAuthApp()`
- `maskSecret()`
- `serializeApp()`
- `parsePermissionArray()`
- `normalizeAdminPermissions()`
- `fetchAdminPermissions()`
- `upsertAdminPermissions()`
- `resolveAnalyticsRange()`
- `parseDateOrThrow()`
- `normalizePositiveInt()`
- `normalizeAnalyticsGranularity()`
- `normalizeTimezone()`
- `resolvePaymentsTableAvailability()`
- `isTableAvailable()`
- `normalizeSlugAliases()`
- `listSlugAliasesForApps()`
- `assertSlugNotUsedByAlias()`
- `replaceAppSlugAliases()`
- `toFiniteInteger()`
- `toFiniteNumber()`
- `normalizeNullableString()`
- `normalizePlaygroundPayload()`
- `resolvePlaygroundApp()`
- `serializeAiPlaygroundResult()`
- `serializeAiPlaygroundRoute()`
- `buildAiPlaygroundResponseExcerpt()`
- `extractAiPlaygroundText()`
- `stringifyAiTextContent()`
- `extractAiPlaygroundAudio()`
- `extractAiPlaygroundImages()`
- `extractAiPlaygroundVideos()`
- `extractAiPlaygroundEmbeddings()`
- `countSuperAdmins()`
- `countUsersByRole()`
- `findActiveUserInApp()`
- `findActiveAdminActor()`
- `findUserInAppIncludingDeleted()`
- `updateTenantUserContact()`
- `serializeManagedUser()`
- `buildDeactivatedEmail()`
- `buildPhonePlaceholderEmail()`
- `roleEquals()`
- `roundTo2()`

### PlatformAnalyticsFactsReadStateService
- 服务文件：`src/modules/platform-admin/platform-analytics-facts-read-state.service.ts`
- 核心方法：
- `hasMaterializedFacts()`
- `shouldRefreshFacts()`
- `buildReadState()`
- `resolveFactStatus()`
- `toDateOnly()`
- `toInt()`
- `toNullableDate()`
- `minDate()`

### PlatformAnalyticsResponseCacheService
- 服务文件：`src/modules/platform-admin/platform-analytics-response-cache.service.ts`
- 核心方法：
- `clear()`
- `buildCacheKey()`

### PlatformAnalyticsSchemaHealthService
- 服务文件：`src/modules/platform-admin/platform-analytics-schema-health.service.ts`
- 核心方法：
- `isReadModelReady()`
- `verifyReadModelSchema()`
- `isRelationAvailable()`

### PlatformAnalyticsSourceTablesService
- 服务文件：`src/modules/platform-admin/platform-analytics-source-tables.service.ts`
- 核心方法：
- `resolveAvailability()`
- `isTableAvailable()`

### PlatformAppAnalyticsService
- 服务文件：`src/modules/platform-admin/platform-app-analytics.service.ts`
- 核心方法：
- `onModuleInit()`
- `getOverview()`
- `getGrowth()`
- `getRetention()`
- `getProfiles()`
- `getConversion()`
- `getUsers()`
- `buildSummaryQuery()`
- `buildOverviewTrendQuery()`
- `buildGrowthSummaryQuery()`
- `buildGrowthTrendQuery()`
- `buildRetentionSummaryQuery()`
- `buildRetentionCohortQuery()`
- `buildLifecycleDistributionQuery()`
- `buildReactivationTrendQuery()`
- `buildMembershipDistributionQuery()`
- `buildLoginMethodDistributionQuery()`
- `buildSourceDistributionQuery()`
- `buildActivitySegmentQuery()`
- `buildPaymentSegmentQuery()`
- `buildConversionSummaryQuery()`
- `buildPaymentTrendQuery()`
- `buildOverviewTrendFactsQuery()`
- `buildGrowthTrendFactsQuery()`
- `buildRetentionCohortFactsQuery()`
- `buildReactivationTrendFactsQuery()`
- `buildPaymentTrendFactsQuery()`
- `buildConversionSummaryFactsQuery()`
- `buildSegmentSnapshotQuery()`
- `buildUsersOrderBySql()`
- `buildUsersQueryParams()`
- `resolveUsersSortColumn()`
- `buildActivityUnionSql()`
- `buildPaidOrdersSql()`
- `buildFirstSourceSql()`
- `buildAiUsageSql()`
- `buildPointsWalletSql()`
- `ensureAppExists()`
- `resolveQuery()`
- `serializeRange()`
- `normalizeGranularity()`
- `normalizeMembershipType()`
- `normalizeLoginMethod()`
- `normalizePaidStatus()`
- `normalizeAccountStatus()`
- `normalizeCreatedScope()`
- `normalizeLastLoginScope()`
- `normalizeOptionalString()`
- `normalizeTimezone()`
- `finalizeSeriesSql()`
- `parseDate()`
- `normalizePositiveInt()`
- `daysAgo()`
- `buildRefreshKey()`
- `prepareFactsForRead()`
- `processFactsRefreshQueue()`
- `isFactsRefreshInProgress()`
- `startOfDay()`
- `refreshAnalyticsFacts()`
- `restorePersistedFactsRefreshQueue()`
- `enqueueHotWindowRefreshes()`
- `buildRefreshQueryFromStateRow()`
- `shouldQueuePersistedRefresh()`
- `refreshDailyFacts()`
- `refreshCohortFacts()`
- `refreshConversionFacts()`
- `refreshSegmentSnapshot()`
- `refreshUserSummaries()`
- `refreshUserActivitySummary()`
- `refreshUserPaymentSummary()`
- `refreshUserAiUsageSummary()`
- `refreshUserProfileSummary()`
- `toDateOnly()`
- `toDateOnlyValue()`
- `loginMethodExpr()`
- `toInt()`
- `toNumber()`
- `toRatio()`
- `round2()`
- `nullableString()`
- `toIsoString()`
- `toNullableIsoString()`
- `toNullableDate()`
- `minDate()`

## 5. 数据库/存储依赖（自动扫描）
- `activations`
- `active_30d`
- `active_7d`
- `active_in_range`
- `active_users`
- `activity`
- `activity_agg`
- `activity_daily`
- `activity_events`
- `admin_page_permissions`
- `ai_usage`
- `ai_usage_agg`
- `ai_usage_logs`
- `alipay_agreements`
- `alipay_deductions`
- `alipay_orders`
- `analytics_fact_refresh_state`
- `app_slug_aliases`
- `app_user_activity_summary`
- `app_user_ai_usage_summary`
- `app_user_cohort_facts`
- `app_user_conversion_facts`
- `app_user_daily_facts`
- `app_user_payment_summary`
- `app_user_profile_summary`
- `app_user_segment_snapshots`
- `apple_login_credentials`
- `apps`
- `base_users`
- `cohort_retention`
- `cohort_users`
- `daily`
- `dau`
- `days`
- `deductions_daily`
- `enriched_users`
- `filtered_users`
- `first_in_period`
- `first_source`
- `github_oauth_apps`
- `google_oauth_clients`
- `latest_activity`
- `login_users`
- `mau`
- `new_users`
- `orders_daily`
- `outbound_proxies`
- `paged_users`
- `paid_orders`
- `paid_orders_agg`
- `paid_users_in_range`
- `paid_users_total`
- `payment_agg`
- `payment_daily`
- `payment_products`
- `payment_stats`
- `payments`
- `period_ranges`
- `periods`
- `platform_payment_methods`
- `platform_sms_providers`
- `platform_sms_signatures`
- `platform_sms_templates`
- `points_wallets`
- `reactivated`
- `reactivation_daily`
- `registration_stats`
- `registrations`
- `segment_rows`
- `user_ai_points_ledger`
- `user_ai_points_wallets`
- `user_behavior_events`
- `user_totals`
- `users`
- `wau`
- `wechat_open_apps`

## 6. 模块依赖（自动扫描）
- `..`
- `ai-chat`
- `auth`
- `behavior-analytics`
- `email-delivery`
- `feedback`
- `outbound-proxy`
- `payments`
- `redeem`
- `tenant-site`

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-06-10：自动生成/刷新模块文档结构与清单。
