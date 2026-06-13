# Feedback 模块文档

> 模块名称：`feedback`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `feedback` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/feedback/feedback.module.ts`
- `src/modules/feedback/feedback.service.ts`

## 3. Controller 与路由
当前模块没有 Controller 文件。

## 4. Service 能力
### FeedbackService
- 服务文件：`src/modules/feedback/feedback.service.ts`
- 核心方法：
- `onModuleInit()`
- `getMyFeedbackByAppSlug()`
- `getFeedbackByAppId()`
- `listComments()`
- `serializeFeedbackRow()`
- `serializeCommentRow()`
- `parseObject()`
- `feedbackSelectColumns()`
- `cleanText()`
- `cleanOptional()`
- `deriveTitle()`
- `deriveBugReportContent()`
- `buildSubmitContext()`
- `normalizeBugLog()`
- `normalizeSmallObject()`
- `normalizeAttachments()`
- `normalizePriority()`
- `normalizePriorityFilter()`
- `normalizeStatus()`
- `resolveAppBySlug()`
- `resolveAppById()`
- `ensureUserInApp()`
- `ensureActorUserExists()`
- `ensureSchemaReady()`
- `verifySchemaReady()`

## 5. 数据库/存储依赖（自动扫描）
- `information_schema`
- `required_columns`
- `user_ai_points_ledger`
- `user_ai_points_wallets`
- `user_feedback_comments`
- `user_feedbacks`
- `user_notifications`
- `users`

## 6. 模块依赖（自动扫描）
- `ai-chat`
- `redeem`

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-06-10：自动生成/刷新模块文档结构与清单。
