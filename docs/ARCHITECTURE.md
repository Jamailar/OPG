# 一人集团系统产品架构

## 目标

一人集团系统不是通用 BaaS 的复制品，而是一套面向一人公司的 app 后端集群控制平面。它用一个平台后台和一个 API 网关，快速启动多个 app 的认证、租户、存储、AI、视频、消息、计费、审计和运营能力。

参考 Appwrite 的产品面：Auth、Databases、Storage、Functions、Messaging、Realtime、Sites、自托管、SDK 和 API；OPG 只吸收这些能力的控制面和协议思想，不直接把系统做成通用数据库编辑器。

## 推荐方案

推荐继续使用当前 monorepo：

- `apps/web`：Vite + React 平台管理后台。
- `services/gateway`：NestJS API 网关和业务控制面。
- PostgreSQL + Prisma：保存账户、租户、配置、任务、账单、审计真值。
- Redis：队列、缓存、实时事件 fanout。
- Object Storage：文件、素材、生成结果。
- Worker：AI、视频、消息、Webhook、定时任务异步执行。

对比方案：

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| OPG 控制平面 | 贴合一人公司，多 app、AI、视频、计费集成成本低 | 需要定义清楚协议边界 | 推荐 |
| Appwrite clone | 功能完整，开发者认知成熟 | 通用 BaaS 复杂度高，AI/视频/计费不是核心 | 不推荐 |
| 多 repo 微服务 | 团队边界清楚 | 一人维护成本高，发布链路重 | 暂不推荐 |
| 单体全栈 | 启动快 | 多 app、长任务、供应商隔离容易混乱 | 不推荐 |

## 总体架构

```text
apps/web
  Platform Console
    Apps
    Tenants
    Users / Teams / Roles
    Storage
    Jobs / Functions
    AI / Video
    Messaging
    Billing / Usage
    Logs / Audit

services/gateway
  HTTP API
  Realtime Gateway
  Admin API
  Public App API

  Core
    app-registry
    tenant-context
    permissions
    audit
    usage-ledger
    runtime-settings
    provider-adapters

  Modules
    auth
    api-keys
    storage
    jobs
    realtime
    messaging
    ai
    video
    payments
    analytics

Infrastructure
  PostgreSQL
  Redis
  Object Storage
  Worker Runtime
  Provider SDKs
```

## 模块设计

### 1. App Registry

职责：

- 管理 app、环境、租户、域名、API key、回调地址、功能开关。
- 每个 app 有独立 usage quota、provider 配置、storage bucket 和权限边界。
- 所有请求必须解析出 `appId`、`environment`、`tenantId`、`actorId`。

实现：

- 自研 `apps`、`app_environments`、`tenants`、`app_api_keys` 表。
- NestJS guard/interceptor 注入 app 上下文。
- API key 只保存 hash，明文只在创建时返回一次。

### 2. Auth / Teams / Permissions

职责：

- 提供用户、团队、角色、权限、service account。
- 支持平台后台用户和 app 终端用户分离。
- 默认拒绝访问，按 app、tenant、resource、action 授权。

实现：

- 必须用现成库：`@nestjs/jwt`、`passport-jwt`、`bcrypt`、`jose`。
- 自研权限矩阵、租户上下文、资源 owner 校验。
- 不建议第一版做通用行级数据库权限；先做业务资源权限。

### 3. Storage

职责：

- 管理 bucket、file、signed URL、metadata、quota、归档。
- 支持上传用户素材、AI 输入素材、视频生成结果、公开站点静态资源。

实现：

- 必须用现成库：Ali OSS/S3/R2 SDK、MIME 检测、图片处理库。
- 自研 bucket 权限、文件 metadata、用量计费、生命周期策略。
- 大文件直传对象存储，后端只签名并记录真值。

### 4. Jobs / Functions

职责：

- 统一执行 HTTP trigger、event trigger、cron trigger、manual trigger。
- 承载 AI、视频、消息、Webhook、数据同步等长任务。
- 提供任务日志、状态、重试、超时、取消、幂等键。

实现：

- 第一版用 BullMQ + Redis，不自研队列。
- 后续需要强隔离时接 Docker sandbox、Cloudflare Workers 或 Vercel Functions。
- 自研任务协议、执行状态机、日志脱敏、重试策略、成本记录。

### 5. Realtime

职责：

- 向前端和 app client 推送任务状态、文件状态、账单变化、系统事件。
- 替代高频轮询。

实现：

- 使用 Socket.IO + Redis adapter。
- 自研 channel 命名、订阅鉴权、事件过滤、事件 envelope。
- 事件命名格式：`apps.{appId}.{resource}.{resourceId}.{event}`。

### 6. Messaging

职责：

- 统一 Email、SMS、Push、Webhook 通知。
- 模板、provider、发送队列、失败重试、退信记录、费用记录。

实现：

- 必须用现成库：Nodemailer、FCM/APNS SDK、短信 provider SDK。
- 自研 provider adapter、模板变量校验、消息任务状态、用量账本。

### 7. AI

职责：

- 文本、图片、语音、视频等 AI 能力统一入口。
- 模型路由、provider fallback、成本估算、请求摘要、上游错误归因。

实现：

- 必须用现成库：OpenAI、Anthropic、Google、DashScope 等官方 SDK 或稳定 HTTP client。
- 自研 provider adapter、usage ledger、积分流水、任务状态、错误码。
- 前端不得直接绑定第三方 AI payload。

### 8. Video

职责：

- 视频素材处理、抽帧、转码、生成、结果归档。
- 对接 AI 视频 provider 和本地/云端渲染。

实现：

- 必须用现成库：FFmpeg、Remotion、云媒体处理服务。
- 自研素材模型、任务状态机、幂等提交、失败恢复、用户可见错误码。
- 长任务必须异步化，结果通过 Realtime 或任务 API 查看。

### 9. Billing / Usage / Audit

职责：

- 所有 AI、视频、存储、消息、支付、第三方代理成本进入统一账本。
- 审计 actor、tenant、module、action、resource、metadata。

实现：

- usage event append-only，不覆盖历史。
- 任务结果和计费流水分离。
- 后台报表读聚合表或物化视图，不直接扫明细表。

### 10. Runtime Settings

职责：

- 让环境变量保持极简，只保存进程冷启动必需项。
- 将支付、对象存储、邮件、OAuth、AI 调优、CORS、域名等配置迁入管理员 UI。
- 对业务密钥做加密入库、轮换、审计和测试连接。

实现：

- 必须保留 env：`DATABASE_URL`、`REDIS_URL`、`JWT_SECRET_KEY`、`PLATFORM_SECRETS_KEY`、`NODE_ENV`、`PORT`。
- 必须 Web 化：`ALIPAY_*`、`WECHAT_PAY_*`、`ALIYUN_*`、`SMTP_*`、`SENDER_*`、`WECHAT_AUTH_*`、`FEEDBACK_ADMIN_API_KEY`、大部分 `AI_GATEWAY_*`。
- 后端模块不得散落读取 `process.env`，统一通过 RuntimeConfigService。
- 前端通过 `/api/runtime-config` 获取非密钥配置，`VITE_*` 只作为本地开发 fallback。

## UI 原则

- 平台后台只放真实运维入口：Apps、Tenants、Users、Storage、Jobs、AI/Video、Messaging、Billing、Logs。
- 不增加解释型页面，不用长文案替代清晰操作。
- 列表、筛选、详情、状态、重试、复制 key、查看日志等交互复用现有模式。
- 高风险操作必须二次确认：删除 app、轮换 key、清空 bucket、取消任务、修改 provider。

## 必须用现成库的地方

- JWT、OAuth、密码哈希、签名验证。
- 数据库 ORM 和 migration。
- 队列和 Redis client。
- Object Storage SDK。
- WebSocket 框架和 Redis fanout。
- AI provider SDK。
- FFmpeg、Remotion、云媒体处理。
- Email、Push、SMS provider SDK。
- OpenTelemetry、日志采集、错误追踪。

## 必须自研的地方

- App、tenant、environment 控制平面。
- 权限矩阵和租户上下文。
- 模块注册协议。
- 任务状态机和业务幂等。
- AI/视频 provider 抽象和成本归因。
- usage ledger、积分流水、账单聚合。
- 用户可见错误码和后台排障字段。
- 平台后台的信息架构。

## 性能优化策略

- API、worker、realtime 进程保持 stateless，依赖 Postgres/Redis/Object Storage 保存状态。
- 所有长任务进入队列，HTTP 请求只创建任务并返回 task id。
- 按 `appId`、`tenantId`、`createdAt` 建组合索引。
- usage/audit 明细 append-only，后台报表使用增量聚合。
- 大文件直传对象存储，后端避免代理上传大文件。
- Realtime 只推送状态摘要，不推送大 payload。
- provider adapter 按 app 和 provider 做并发限制、熔断、重试和成本上限。
- 后台列表强制分页、字段投影和稳定排序。

## 协议入口

- `protocols/app-registry.md`
- `protocols/permissions.md`
- `protocols/storage.md`
- `protocols/jobs.md`
- `protocols/realtime-events.md`
- `protocols/usage-ledger.md`
- `protocols/runtime-settings.md`

## 当前迁移结果

- 前端代码已复制到 `apps/web`。
- 后端代码已复制到 `services/gateway`。
- 真实 `.env`、依赖目录、构建产物没有复制进仓库。
