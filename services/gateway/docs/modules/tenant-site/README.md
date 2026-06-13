# Tenant Site 模块文档

> 模块名称：`tenant-site`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `tenant-site` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/tenant-site/tenant-site-public.controller.ts`
- `src/modules/tenant-site/tenant-site.module.ts`
- `src/modules/tenant-site/tenant-site.service.ts`
- `src/modules/tenant-site/tenant-site.types.ts`

## 3. Controller 与路由
### TenantSitePublicController
- 控制器文件：`src/modules/tenant-site/tenant-site-public.controller.ts`
- 基础路由：`tenantControllerPaths('site', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `config` | `getConfig()` |
| GET | `downloads` | `getDownloads()` |
| GET | `cookies` | `getCookiePolicy()` |
| POST | `newsletter` | `submitNewsletter()` |
| POST | `contact` | `submitContact()` |
| POST | `cookie-consent` | `saveCookieConsent()` |

## 4. Service 能力
### TenantSiteService
- 服务文件：`src/modules/tenant-site/tenant-site.service.ts`
- 核心方法：
- `onModuleInit()`
- `getPublicSiteConfig()`
- `getAdminSiteSettings()`
- `updateAdminSiteSettings()`
- `createDownloadUploadUrl()`
- `confirmDownloadUpload()`
- `submitNewsletter()`
- `submitContact()`
- `updateAdminMessage()`
- `getCookiePolicy()`
- `saveCookieConsent()`
- `extractSiteSettings()`
- `normalizeSettings()`
- `normalizeDownloadItem()`
- `serializeDownloadItem()`
- `serializeMessage()`
- `serializeCookieConsent()`
- `resolveAppBySlug()`
- `resolveAppById()`
- `normalizeEmail()`
- `normalizeNullableString()`
- `normalizeContext()`
- `inferSource()`
- `normalizeMessageType()`
- `normalizeMessageStatus()`
- `normalizeDownloadPlatform()`
- `normalizeFilename()`
- `normalizeCookieRegion()`
- `normalizeOptionalCookieRegion()`
- `normalizeConsentId()`
- `parseBooleanLike()`
- `normalizeSearchQuery()`
- `isLikelyBotSubmission()`
- `enforceSubmissionWindow()`
- `getClientIp()`
- `hashValue()`
- `serializeDate()`
- `formatDate()`
- `ensureSchema()`
- `initializeSchema()`

## 5. 数据库/存储依赖（自动扫描）
- `tenant_site_cookie_consents`
- `tenant_site_messages`

## 6. 模块依赖（自动扫描）
- `upload`

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-06-10：自动生成/刷新模块文档结构与清单。
