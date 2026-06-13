# Runtime Settings 协议

## 目标

Runtime Settings 负责把原本散落在 `.env` 中的业务配置迁入管理员 UI 和数据库，让环境变量保持极简。

## 配置分层

```text
bootstrap env
  DATABASE_URL
  REDIS_URL
  JWT_SECRET_KEY
  PLATFORM_SECRETS_KEY
  NODE_ENV
  PORT

database runtime settings
  domains
  cors
  session policy
  payment scheduler
  ai gateway tuning
  oauth settings
  integration settings

provider settings
  payment
  storage
  email
  oauth
  messaging
  ai sources

code defaults
  only safe non-secret defaults
```

## 读取规则

1. 进程启动前必须知道的配置从 env 读取。
2. 进程连上 DB 后，业务配置必须从 DB 读取。
3. 生产环境中，DB 有配置时不得再读取同类 env fallback。
4. 本地开发可保留 env fallback，但必须打印 deprecated warning。
5. 模块不得直接读取 `process.env`，只能通过统一配置服务读取。

## Secret 规则

- 业务密钥不写 `.env`。
- 密钥入库前必须加密。
- 密钥创建后 UI 不回显明文。
- 密钥轮换必须写 audit event。
- 根加密密钥只允许存在 env 或外部 Secret Manager。

## UI 入口

统一入口：`平台设置`

- 基础：域名、API 根地址、CORS。
- 安全：session、集成 API key、密钥轮换。
- 登录方式：OAuth provider。
- 支付方式：支付 provider。
- 对象存储：bucket、endpoint、CDN。
- 邮件与消息：SMTP、Email provider、SMS、Push。
- AI 高级设置：并发、RPM、timeout、fallback。

## API 约定

```text
GET    /api/v1/platform-admin/runtime-settings
PATCH  /api/v1/platform-admin/runtime-settings
GET    /api/v1/platform-admin/provider-settings
POST   /api/v1/platform-admin/provider-settings
PATCH  /api/v1/platform-admin/provider-settings/:id
POST   /api/v1/platform-admin/provider-settings/:id/test
POST   /api/v1/platform-admin/provider-settings/:id/rotate-secret
GET    /api/v1/platform-admin/payments/methods
POST   /api/v1/platform-admin/payments/methods
PUT    /api/v1/platform-admin/payments/methods/:id
DELETE /api/v1/platform-admin/payments/methods/:id
POST   /api/v1/platform-admin/payments/methods/test
GET    /api/v1/platform-admin/storage/providers
POST   /api/v1/platform-admin/storage/providers
PATCH  /api/v1/platform-admin/storage/providers/:id
DELETE /api/v1/platform-admin/storage/providers/:id
POST   /api/v1/platform-admin/storage/providers/:id/test
GET    /api/v1/platform-admin/integration-api-keys
POST   /api/v1/platform-admin/integration-api-keys
POST   /api/v1/platform-admin/integration-api-keys/:id/revoke
GET    /api/v1/platform-admin/smtp/providers
POST   /api/v1/platform-admin/smtp/providers
PATCH  /api/v1/platform-admin/smtp/providers/:id
DELETE /api/v1/platform-admin/smtp/providers/:id
POST   /api/v1/platform-admin/smtp/providers/:id/test
GET    /runtime-config
```

所有写接口必须要求平台管理员权限，并写入 audit。

`payments_scheduler` 是支付运行时配置的 DB 真值。除自动扣款外，它也承载支付回调/回跳域名和测试开关：

```json
{
  "enabled": true,
  "interval_ms": 300000,
  "batch_size": 50,
  "api_base_url": "https://api.example.com",
  "user_web_base_url": "https://app.example.com",
  "payment_return_base_url": "https://app.example.com",
  "allow_local_return_url": false,
  "admin_test_disabled": false
}
```

`ai_gateway_tuning` 是 AI 网关调参的 DB 真值，覆盖节流、sticky、上游超时和队列参数：

```json
{
  "redis_limits_enabled": false,
  "redis_prefix": "ai-gateway",
  "max_source_concurrency": 128,
  "max_user_concurrency": 16,
  "max_api_key_concurrency": 0,
  "max_account_concurrency": 0,
  "source_rpm": 0,
  "user_rpm": 0,
  "api_key_rpm": 0,
  "account_rpm": 0,
  "cooldown_failure_threshold": 3,
  "cooldown_ms": 10000,
  "throttle_fail_open": false,
  "sticky_ttl_ms": 600000,
  "upstream_header_timeout_ms": 60000,
  "upstream_stream_header_timeout_ms": 30000,
  "request_body_max_bytes": 20971520,
  "response_text_max_bytes": 4194304,
  "usage_workers": 4,
  "usage_queue_size": 1000,
  "usage_queue_overflow": "sync",
  "image_upstream_timeout_ms": 600000,
  "video_upstream_timeout_ms": 1200000,
  "voice_clone_model_key": "minimax-voice-clone",
  "trace_log": false
}
```

`oauth_settings` 是登录回调类运行时配置的 DB 真值：

```json
{
  "wechat_auth_redirect_uri": "https://api.example.com/platform/v1/auth/login/wechat/callback",
  "wechat_auth_allowed_redirect_hosts": ["api.example.com", "admin.example.com"]
}
```

Apple 登录凭证由 `apple_login_credentials` 管理；Apple IAP 的支付凭证和 `root_certificates_pem` 由 `platform_payment_methods` 中的 `APPLE_IAP` provider 管理。

`integration_settings` 是外部集成运行时行为的 DB 真值：

```json
{
  "feedback_admin_actor_user_id": "00000000-0000-0000-0000-000000000000"
}
```

Feedback Admin API 的默认 actor 读取顺序为：请求体 `actor_user_id` -> `integration_settings.feedback_admin_actor_user_id` -> 迁移期 env fallback -> app 内首个管理员或超级管理员。

## 配置来源摘要

后端启动后必须输出不含密钥的摘要：

```json
{
  "database": "env",
  "redis": "env",
  "cors": "db",
  "payments": "db",
  "storage": "db",
  "email": "db",
  "oauth": "db",
  "integrations": "db",
  "aiTuning": "db"
}
```

## 验收标准

- 生产必填 env 不超过 6 个。
- 管理员能在 UI 中完成支付、存储、邮件、OAuth、AI 调优配置。
- 业务模块不直接读取 `process.env`。
- Deprecated env 仅允许本地开发 fallback。
