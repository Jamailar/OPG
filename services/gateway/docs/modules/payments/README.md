# Payments 模块文档

> 模块名称：`payments`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `payments` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/payments/apple-iap.service.ts`
- `src/modules/payments/payments.controller.ts`
- `src/modules/payments/payments.module.ts`
- `src/modules/payments/payments.service.ts`

## 3. Controller 与路由
### PaymentsController
- 控制器文件：`src/modules/payments/payments.controller.ts`
- 基础路由：`tenantControllerPaths('payments', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `products` | `listProducts()` |
| GET | `products/:product_id` | `getProduct()` |
| POST | `orders/page-pay` | `createPagePayOrder()` |
| POST | `orders/wechat/native` | `createWechatNativeOrder()` |
| POST | `orders/checkout` | `createCheckoutOrder()` |
| GET | `orders/:out_trade_no` | `getOrderStatus()` |
| POST | `apple/transactions/verify` | `verifyAppleTransaction()` |
| POST | `apple/restore` | `restoreApplePurchases()` |
| GET | `subscriptions/me` | `listMySubscriptions()` |
| POST | `agreements/page-sign` | `createAgreementSign()` |
| GET | `agreements/me` | `listMyAgreements()` |
| POST | `callbacks/trade-notify` | `tradeNotifyCallback()` |
| GET | `callbacks/trade-return` | `tradeReturnCallback()` |
| POST | `callbacks/agreement-notify` | `agreementNotifyCallback()` |
| POST | `callbacks/wechat-notify` | `wechatNotifyCallback()` |
| POST | `callbacks/apple` | `appleNotifyCallback()` |
| POST | `callbacks/:provider/:method_id` | `saasNotifyCallback()` |
| GET | `admin/products` | `adminListProducts()` |
| POST | `admin/products` | `adminCreateProduct()` |
| PUT | `admin/products/:product_id` | `adminUpdateProduct()` |
| POST | `admin/products/:product_id/delete` | `adminDeleteProductLegacy()` |
| POST | `admin/testing/one-time` | `adminRunOneTimeTest()` |
| POST | `admin/testing/recurring` | `adminRunRecurringTest()` |
| POST | `admin/testing/full-flow` | `adminRunFullFlowTest()` |
| POST | `admin/testing/wechat/one-time` | `adminRunWechatOneTimeTest()` |
| GET | `admin/orders` | `adminListOrders()` |
| GET | `admin/dashboard-metrics` | `adminDashboardMetrics()` |
| POST | `admin/orders/:order_id/refund` | `adminRefundOrder()` |
| GET | `admin/agreements` | `adminListAgreements()` |
| GET | `admin/deductions` | `adminListDeductions()` |
| POST | `admin/deductions/execute` | `adminExecuteDeduction()` |
| POST | `admin/deductions/trigger-auto-run` | `adminTriggerAutoRun()` |
| POST | `admin/agreements/:agreement_id/unsign` | `adminUnsignAgreement()` |
| DELETE | `admin/products/:product_id` | `adminDeleteProduct()` |

## 4. Service 能力
### AppleIapService
- 服务文件：`src/modules/payments/apple-iap.service.ts`
- 核心方法：
- `verifyTransaction()`
- `restorePurchases()`
- `listMySubscriptions()`
- `processNotification()`
- `requireAppleConfig()`
- `decodeSignedTransaction()`
- `decodeSignedRenewal()`
- `decodeSignedNotification()`
- `createSignedDataVerifier()`
- `createAppStoreClient()`
- `resolveAppleEnvironment()`
- `loadAppleRootCertificates()`
- `fetchSignedTransactionInfo()`
- `syncTransactionHistory()`
- `refreshEntitlementFromLatestTransaction()`
- `findPaymentProductId()`
- `findUserIdForOriginalTransaction()`

#### Apple App Store Server Notifications V2
- 回调入口：`POST /{app}/v1/payments/callbacks/apple`，请求体接受 Apple V2 `signedPayload`。
- 签名校验与 JWS 解码必须使用官方 `@apple/app-store-server-library`，不要自研证书链/JWS 验证。
- 回调按 `notificationUUID` 幂等写入 `apple_iap_notifications`；重复通知直接返回 success，避免 Apple 重试造成重复发放。
- 已覆盖 Apple 官方 V2 类型集合：订阅购买/续订/恢复、续订偏好变更、续订状态变更、优惠兑换、过期、续订失败、宽限期过期、价格变更、退款/撤销/退款反转、消费请求、续期扩展、测试通知、外部购买 token、同意撤回、元数据更新、迁移、一次性收费。
- `SUBSCRIBED`、`DID_RENEW`、`OFFER_REDEEMED`、`RENEWAL_EXTENDED`、`REFUND_REVERSED`、`ONE_TIME_CHARGE`、`MIGRATION` 会授予或延长权益。
- `DID_FAIL_TO_RENEW` 会按 subtype 写入 `GRACE_PERIOD` 或 `BILLING_RETRY`；宽限期权益使用 `gracePeriodExpiresDate`。
- `EXPIRED`、`GRACE_PERIOD_EXPIRED` 会收敛为过期权益；`REFUND`、`REVOKE` 会撤销权益。
- `TEST`、`EXTERNAL_PURCHASE_TOKEN`、`RESCIND_CONSENT` 等无交易 payload 的通知只做验签、幂等记录和处理状态标记。
- 交易表记录 renewal、revocation、price、app account token、通知签名时间等关键字段，并用 `last_notification_signed_date` 避免旧通知覆盖新状态。
- 如果通知携带的 `appAccountToken` 是 OPG 用户 UUID，会自动关联用户；否则先记录未关联交易，后续客户端 verify/restore 会补齐用户与权益。
- 本次变更没有新增外部 API 或平台能力入口，`packages/cli`、`packages/sdk`、MCP tool schema 与 `docs/CLI_USAGE.md` 不需要同步更新。

### PaymentsService
- 服务文件：`src/modules/payments/payments.service.ts`
- 核心方法：
- `onModuleInit()`
- `runAutoDeductionInterval()`
- `listProducts()`
- `getProductForPurchase()`
- `normalizePaymentProviderType()`
- `isSaasProvider()`
- `hasPlatformPaymentMethodsTable()`
- `getAllowedPaymentMethodIds()`
- `alipayConfigFromMethod()`
- `wechatConfigFromMethod()`
- `isResolvedAlipayConfigured()`
- `isResolvedWechatConfigured()`
- `getOrderStatus()`
- `listMyAgreements()`
- `processTradeReturn()`
- `processAgreementNotify()`
- `processWechatNotify()`
- `adminListProducts()`
- `adminCreateProduct()`
- `adminDeleteProduct()`
- `adminDashboardMetrics()`
- `adminListDeductions()`
- `platformListProductsForApp()`
- `adminTriggerAutoRun()`
- `adminUnsignAgreement()`
- `requireAdminPagePermission()`
- `resolveTargetUser()`
- `ensureUserInApp()`
- `ensurePlatformSuperAdmin()`
- `resolveAppById()`
- `resolveAppForPlatformTest()`
- `resolveTargetUserForPlatformTest()`
- `resolveAppBySlug()`
- `getProductById()`
- `buildRedeemPackagePaymentCode()`
- `parseRedeemPackageIdFromPaymentCode()`
- `getProductByRedeemPackageId()`
- `ensurePaymentProductByRedeemPackageId()`
- `getResolvableProduct()`
- `ensureDefaultPointsTopupProduct()`
- `grantRedeemPackageForOrderIfNeeded()`
- `getAgreementById()`
- `syncAlipayOrderStatus()`
- `syncWechatOrderStatus()`
- `getRequiredActiveProduct()`
- `buildWechatNotifyAck()`
- `getAppSettings()`
- `getDefaultEnvAlipayConfig()`
- `getDefaultEnvWechatPayConfig()`
- `parseBooleanLike()`
- `asConfigMap()`
- `ensureRuntimePaymentConfig()`
- `loadRuntimePaymentConfig()`
- `refreshRuntimePaymentConfig()`
- `alipayConfig()`
- `wechatPayConfig()`
- `isAlipayConfigured()`
- `isWechatPayConfigured()`
- `normalizePem()`
- `wrapPemBase64()`
- `buildPrivateKeyPemCandidates()`
- `resolveAlipayPrivateKey()`
- `alipayGatewayUrl()`
- `normalizeBaseUrl()`
- `resolveSaasReturnUrl()`
- `readJsonResponse()`
- `headerValue()`
- `safeCompareHex()`
- `extractSaasPaymentEvent()`
- `resolveApiBaseUrl()`
- `resolveUserWebBaseUrl()`
- `resolveTradeReturnMode()`
- `resolveTradeNotifyUrl()`
- `resolveTradeReturnUrl()`
- `resolveAgreementNotifyUrl()`
- `resolveAgreementReturnUrl()`
- `allowLocalReturnUrl()`
- `isAcceptableReturnUrl()`
- `isLocalHostname()`
- `resolveWechatNotifyUrl()`
- `signAlipayParams()`
- `buildAlipaySignContent()`
- `verifyAlipayNotifySignature()`
- `getOrderByOutTradeNo()`
- `resolveAlipaySignAlgorithm()`
- `buildAlipayFormHtml()`
- `escapeHtml()`
- `formatAlipayTimestamp()`
- `alipayExecuteRequest()`
- `amountToFen()`
- `fenToAmount()`
- `normalizePointsValue()`
- `toSafeInteger()`
- `refundOrderPointsIfNeeded()`
- `grantOrderTopupPointsByTradeNoIfNeeded()`
- `grantOrderTopupPointsIfNeeded()`
- `wechatGatewayUrl()`
- `buildWechatSign()`
- `buildWechatXml()`
- `parseWechatXml()`
- `verifyWechatSign()`
- `wechatOrderQuery()`
- `serializeProduct()`
- `normalizeAmount()`
- `normalizeOrderAmount()`
- `normalizePointsPerYuan()`
- `calculateTopupPointsByAmount()`
- `isSystemPointsTopupProduct()`
- `tryFormatAmount()`
- `formatAmount()`
- `resolveDashboardRange()`
- `formatDashboardTrendLabel()`
- `getShanghaiDayStart()`
- `tableExists()`
- `normalizeExecuteTime()`
- `resolveExecuteTime()`
- `parseExecuteTime()`
- `calculateNextDeduction()`
- `rollForwardDueDate()`
- `buildRecurringPaymentType()`
- `assertAdminTestAllowed()`
- `assertAlipayRealGatewayReady()`
- `assertWechatRealGatewayReady()`
- `isSandboxGateway()`
- `parseJsonStringArray()`
- `nullableString()`
- `genTradeNo()`
- `genUuid()`
- `ensureSchema()`
- `initializeSchema()`

## 5. 数据库/存储依赖（自动扫描）
- `admin_page_permissions`
- `alipay_agreements`
- `alipay_deductions`
- `alipay_orders`
- `alipay_refunds`
- `app_domains`
- `app_settings`
- `apple_iap_notifications`
- `apple_iap_transactions`
- `apps`
- `entitlement_packages`
- `payment_products`
- `platform_payment_methods`
- `user_ai_points_ledger`
- `user_behavior_events`
- `user_entitlements`
- `users`

## 6. 模块依赖（自动扫描）
- `ai-chat`
- `auth`
- `redeem`

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-06-10：自动生成/刷新模块文档结构与清单。
