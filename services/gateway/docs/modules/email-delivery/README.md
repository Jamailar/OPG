# Email Delivery 模块文档

> 模块名称：`email-delivery`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `email-delivery` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/email-delivery/cloudflare-email.service.ts`
- `src/modules/email-delivery/email-delivery.controller.ts`
- `src/modules/email-delivery/email-delivery.module.ts`
- `src/modules/email-delivery/email-delivery.service.ts`
- `src/modules/email-delivery/email-delivery.types.ts`

## 3. Controller 与路由
### EmailDeliveryController
- 控制器文件：`src/modules/email-delivery/email-delivery.controller.ts`
- 基础路由：`tenantControllerPaths('email', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `unsubscribe` | `unsubscribe()` |
| POST | `unsubscribe` | `unsubscribePost()` |

## 4. Service 能力
### CloudflareEmailService
- 服务文件：`src/modules/email-delivery/cloudflare-email.service.ts`
- 核心方法：
- `verifyToken()`
- `listAccounts()`
- `listSendingDomains()`
- `send()`

### EmailDeliveryService
- 服务文件：`src/modules/email-delivery/email-delivery.service.ts`
- 核心方法：
- `onModuleInit()`
- `listCloudflareAccounts()`
- `verifyCloudflareToken()`
- `createCloudflareAccount()`
- `updateCloudflareAccount()`
- `deleteCloudflareAccount()`
- `testCloudflareAccount()`
- `listCloudflareSendingDomains()`
- `listSenders()`
- `createSender()`
- `updateSender()`
- `deleteSender()`
- `testSender()`
- `sendAppNotificationEmail()`
- `getAppEmailSettings()`
- `updateAppEmailSettings()`
- `listContacts()`
- `importContacts()`
- `updateContact()`
- `listTemplates()`
- `saveTemplate()`
- `listCampaigns()`
- `createCampaign()`
- `sendTestCampaign()`
- `scheduleCampaign()`
- `cancelCampaign()`
- `listCampaignRecipients()`
- `unsubscribe()`
- `processPendingDeliveries()`
- `deliverRecipient()`
- `claimDueRecipients()`
- `markDeliveryFailure()`
- `refreshCampaignCounts()`
- `sendWithSender()`
- `getCloudflareAccountSecret()`
- `resolveCloudflareAccountFromToken()`
- `safeListCloudflareAccounts()`
- `getSender()`
- `getSenderWithAccount()`
- `requireSenderForApp()`
- `getCampaign()`
- `resolveDefaultSenderId()`
- `requireApp()`
- `resolveAppBySlug()`
- `buildUnsubscribeUrl()`
- `suppressEmail()`
- `renderTemplate()`
- `escapeHtml()`
- `parseContactLines()`
- `encryptSecret()`
- `decryptSecret()`
- `secretKey()`
- `signUnsubscribeToken()`
- `verifyUnsubscribeToken()`
- `normalizeEmail()`
- `requiredEmail()`
- `optionalString()`
- `optionalCloudflareAccountId()`
- `requiredString()`
- `optionalUuid()`
- `normalizeActiveStatus()`
- `normalizePurpose()`
- `normalizeContactStatus()`
- `isRetryableDeliveryError()`
- `normalizePage()`
- `normalizePageSize()`
- `ensureSchema()`

## 5. 数据库/存储依赖（自动扫描）
- `app_email_settings`
- `apps`
- `email_campaign_recipients`
- `email_campaigns`
- `email_cf_accounts`
- `email_contacts`
- `email_senders`
- `email_suppression_list`
- `email_templates`
- `skip`

## 6. 模块依赖（自动扫描）
- （未检测到模块级依赖导入）

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-06-10：自动生成/刷新模块文档结构与清单。
