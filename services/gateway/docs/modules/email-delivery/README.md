# Email Delivery 模块文档

> 模块名称：`email-delivery`  
> 最后更新：2026-06-18

## 1. 模块定位
- 负责 `email-delivery` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。
- 平台邮件能力统一收口在“邮件服务”页面：供应商、发件邮箱、租户绑定、联系人、模板、营销投递都不再放进平台设置页。

## 1.1 产品架构
- Provider 层：`email_providers` 保存 Cloudflare Email Sending、SMTP、Resend、SendGrid、Postmark、Mailgun 等供应商；`config_json` 保存非密配置，`secrets_ciphertext` 或旧 Cloudflare token 字段保存密钥。
- Sender 层：`email_senders.provider_id` 绑定供应商，支持一个供应商下多个发件邮箱，也支持全局或单租户发件邮箱。
- App Settings 层：`app_email_settings` 只选择租户默认营销/通知发件邮箱，并保存退订、Reply-To、页脚等租户级设置。
- Delivery 层：`email_campaigns` + `email_campaign_recipients` 维持现有队列、锁定、重试、退订和 bounce 抑制逻辑。
- UI 层：`PlatformEmailServicePage.tsx` 按供应商分组显示发件邮箱；SMTP 配置不再进入运行时设置大表单。

## 1.2 实现边界
- 必须用现成库：SMTP 使用 `nodemailer`，避免自研 SMTP 协议、TLS、认证和连接细节。
- 轻量自研：Resend、SendGrid、Postmark、Mailgun 仅封装稳定 HTTP API，不引入多个供应商 SDK，降低依赖体积和升级面。
- 必须自研：供应商抽象、密钥加密、默认发件邮箱解析、租户权限边界、投递队列、重试和退订签名。
- Cloudflare 兼容：旧 `email_cf_accounts` 表和旧 `/email/cloudflare/accounts` API 保留；迁移会把旧账号投影到 `email_providers`。

## 1.3 性能策略
- 投递队列继续使用 `FOR UPDATE SKIP LOCKED` 批量领取，避免多实例重复发送。
- `EMAIL_DELIVERY_BATCH_SIZE` 控制单轮投递规模，失败按指数退避写回 `next_retry_at`。
- Provider/sender 列表按 `provider_id/status/updated_at` 建索引；旧 Cloudflare sender 通过迁移补齐 `provider_id`，减少运行时 fallback 成本。
- API 型供应商只在发送时调用；管理页列表不主动拉远端详情，避免页面加载受第三方服务影响。

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
- `email_providers`
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
