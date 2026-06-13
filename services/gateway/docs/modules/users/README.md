# Users 模块文档

> 模块名称：`users`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `users` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/users/dto/user.dto.ts`
- `src/modules/users/users.controller.ts`
- `src/modules/users/users.module.ts`
- `src/modules/users/users.service.ts`

## 3. Controller 与路由
### UsersController
- 控制器文件：`src/modules/users/users.controller.ts`
- 基础路由：`tenantControllerPaths('users', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `me` | `me()` |
| GET | `me/points` | `myPoints()` |
| GET | `me/ai-usage-logs` | `myAiUsageLogs()` |
| PUT | `me` | `updateMe()` |
| GET | `me/identities` | `listMyIdentities()` |
| POST | `me/identities/apple/bind` | `bindAppleIdentity()` |
| POST | `me/identities/apple/unbind` | `unbindAppleIdentity()` |
| POST | `me/merge` | `mergeGuestAccount()` |
| GET | `me/devices` | `listMyDevices()` |
| POST | `me/devices/:device_id/revoke` | `revokeMyDevice()` |
| POST | `me/delete-account` | `deleteMyAccount()` |
| GET | `me/api-keys` | `listMyApiKeys()` |
| POST | `me/api-keys` | `createMyApiKey()` |
| POST | `me/api-keys/ensure-default` | `ensureMyDefaultApiKey()` |
| POST | `me/api-keys/:key_id/revoke` | `revokeMyApiKey()` |
| POST | `me/behavior-events` | `trackBehaviorEvents()` |
| POST | `me/avatar` | `uploadAvatar()` |
| POST | `change-password` | `changePassword()` |
| POST | `me/send-password-change-code` | `sendPasswordChangeCode()` |
| POST | `me/change-password` | `changePasswordWithCode()` |
| POST | `me/send-email-change-code` | `sendEmailChangeCode()` |
| POST | `me/change-email` | `changeEmail()` |
| POST | `me/send-phone-bind-code` | `sendPhoneBindCode()` |
| POST | `me/bind-phone` | `bindPhone()` |
| GET | `list` | `listUsers()` |
| POST | `admin/delete` | `adminDeleteUser()` |
| GET | `admin/page-permissions/catalog` | `getPermissionCatalog()` |
| GET | `admin/me/page-permissions` | `getMyPermissions()` |
| GET | `admin/permission-groups` | `listPermissionGroups()` |
| POST | `admin/permission-groups` | `createPermissionGroup()` |
| PUT | `admin/permission-groups/:group_id` | `updatePermissionGroup()` |
| DELETE | `admin/permission-groups/:group_id` | `deletePermissionGroup()` |
| GET | `admin/sub-admins` | `listSubAdmins()` |
| POST | `admin/sub-admins/assign` | `assignSubAdmin()` |
| PATCH | `admin/sub-admins/:sub_admin_id/permissions` | `patchSubAdminPermissions()` |
| DELETE | `admin/sub-admins/:sub_admin_id` | `deleteSubAdmin()` |
| POST | `redeem` | `redeem()` |
| GET | `redeem/preview` | `previewRedeem()` |
| GET | `me/entitlements` | `myEntitlements()` |
| GET | `me/notifications` | `myNotifications()` |
| GET | `me/notifications/sync` | `syncMyNotifications()` |
| POST | `me/notifications/:notification_id/read` | `readNotification()` |
| POST | `me/notifications/read-all` | `readAllNotifications()` |
| POST | `me/feedback` | `submitFeedback()` |
| GET | `me/feedbacks` | `listMyFeedbacks()` |
| GET | `me/feedbacks/:feedback_id` | `getMyFeedback()` |
| POST | `me/feedbacks/:feedback_id/comments` | `addMyFeedbackComment()` |
| POST | `admin/redeem-codes` | `createRedeemCodes()` |
| GET | `admin/redeem-codes` | `listRedeemCodes()` |
| POST | `admin/redeem-codes/:code/void` | `voidRedeemCode()` |
| GET | `admin/redeem-code-redemptions` | `listRedeemCodeRedemptions()` |
| POST | `admin/redeem-code-redemptions/:redemption_id/revoke` | `revokeRedeemCodeRedemption()` |

## 4. Service 能力
### UsersService
- 服务文件：`src/modules/users/users.service.ts`
- 核心方法：
- `getMe()`
- `updateMe()`
- `getMyPoints()`
- `uploadAvatar()`
- `changePassword()`
- `sendPasswordChangeCode()`
- `changePasswordWithCode()`
- `sendEmailChangeCode()`
- `changeEmail()`
- `sendPhoneBindCode()`
- `bindPhone()`
- `listUsers()`
- `adminDeleteUser()`
- `redeem()`
- `previewRedeem()`
- `listMyEntitlements()`
- `markNotificationRead()`
- `markAllNotificationsRead()`
- `getMyFeedback()`
- `addMyFeedbackComment()`
- `listRedeemCodes()`
- `voidRedeemCode()`
- `getAdminPermissionCatalog()`
- `getMyAdminPagePermissions()`
- `listAdminPermissionGroups()`
- `deleteAdminPermissionGroup()`
- `listSubAdmins()`
- `deleteSubAdmin()`
- `resolveAppId()`
- `tenantUserExists()`
- `ensureActiveUser()`
- `assertPhoneAvailable()`
- `toUserProfile()`
- `stringOrUndefined()`
- `normalizePositiveInt()`
- `toSafeInteger()`
- `toSafeDecimal2()`
- `generateVerificationCode()`
- `asString()`
- `readUserAgent()`
- `readClientIp()`
- `parseJsonArray()`
- `fetchAdminAllowedPages()`

## 5. 数据库/存储依赖（自动扫描）
- `admin_page_permissions`
- `admin_permission_groups`
- `ai_global_models`
- `ai_usage_logs`

## 6. 模块依赖（自动扫描）
- `ai-chat`
- `api-keys`
- `auth`
- `behavior-analytics`
- `feedback`
- `redeem`

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-06-10：自动生成/刷新模块文档结构与清单。
