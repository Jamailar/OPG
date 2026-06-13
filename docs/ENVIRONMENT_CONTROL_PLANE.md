# 环境变量控制面调研

## 目标

OPG 的目标态是：环境变量只用于进程冷启动和基础设施连接；业务账号、密钥、域名、开关、provider 参数都由管理员在 Web UI 中配置，并加密存入数据库。

现状参考：

- Gateway 完整清单：`services/gateway/docs/ENVIRONMENT.md`
- Gateway 精简方案：`services/gateway/docs/ENV_STREAMLINING_PLAN.md`
- 后端目标模板：`services/gateway/.env.example`
- 前端目标模板：`apps/web/.env.example`

## 核心原则

| 原则 | 结论 |
| --- | --- |
| Bootstrap vs Runtime | 连不上数据库前必须知道的配置留在 env；连上数据库后能读取的配置进 UI/DB |
| Secret 分层 | 根密钥留 env；业务密钥进 DB 加密字段 |
| 单一真相源 | 生产环境禁止同一配置同时依赖 env 和 UI |
| UI 管业务 | 支付、OAuth、AI、邮件、存储、消息、域名、CORS 都应由管理员配置 |
| Env 管基础设施 | 数据库、Redis、端口、运行环境、主密钥保留在 env |
| 可观测 | 启动日志必须打印配置来源摘要，不打印密钥值 |

## 目标态最小环境变量

### 后端标准生产

```bash
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET_KEY=<random>
PLATFORM_SECRETS_KEY=<random>
NODE_ENV=production
PORT=3000
```

冷启动可选：

```bash
CORS_ORIGINS=https://admin.example.com
PLATFORM_APP_SLUG=platform
```

说明：

- `PLATFORM_SECRETS_KEY` 用于加密 DB 中的 provider 密钥、支付私钥、OAuth secret、OSS AK/SK、SMTP 密码。
- 现有 `OUTBOUND_PROXY_ENCRYPTION_KEY` 可并入或改名为 `PLATFORM_SECRETS_KEY`；迁移期保留别名。
- `CORS_ORIGINS` 只用于首次进入管理后台。管理员在 UI 配置平台域名后，应以 DB 为准。

### 前端标准生产

```bash
VITE_API_BASE_URL=https://api.example.com
```

进一步精简目标：

- 前端部署在同域名反代时，`VITE_API_BASE_URL` 也可以不配，默认使用当前 origin。
- `VITE_PLATFORM_APP_SLUG`、`VITE_PLATFORM_ADMIN_DOMAIN`、`VITE_ADMIN_PORTAL_MODE` 应迁到 `/runtime-config` 返回。

## 保留在 env 的内容

| 配置 | 原因 | 是否可 UI 化 |
| --- | --- | --- |
| `DATABASE_URL` | 进程启动和 Prisma 连接数据库前必须知道 | 否 |
| `REDIS_URL` | 队列、缓存、实时事件基础设施连接 | 否 |
| `JWT_SECRET_KEY` | 认证签名根密钥，不应放业务数据库明文 | 否 |
| `PLATFORM_SECRETS_KEY` | 解密 DB 中业务密钥的主密钥 | 否 |
| `NODE_ENV` | 容器/PaaS 标准运行态 | 否 |
| `PORT` | 容器监听端口 | 否 |
| `CORS_ORIGINS` | 冷启动进入后台 | 可在 UI 配置后弃用 |
| `DB_AUTO_MIGRATE` | 镜像启动行为 | 可留给运维 |
| `HTTP_*_LIMIT` | 进程级请求体上限 | 可留给运维 |

## 必须迁入管理员 UI 的内容

| 能力 | UI 位置 | DB 真值 | 当前 env/fallback |
| --- | --- | --- | --- |
| AI provider / 模型 | AI 源与模型 | `ai_sources`、`ai_model_source_routes` | 大部分已不走 env |
| 支付方式 | 平台设置 / 支付方式 | `platform_payment_methods.config_json` | `ALIPAY_*`、`WECHAT_PAY_*` |
| 支付 URL | 平台设置 / 域名与回调 | `platform_runtime_settings` 或 `app_settings.extra_json` | `API_BASE_URL`、`USER_WEB_BASE_URL` |
| 对象存储 | 平台设置 / 对象存储 | `platform_storage_providers.config_json` + `secret_json_encrypted` | `ALIYUN_*`、`ALIYUN_OSS_*` |
| 邮件 | 平台设置 / 邮件服务 | `platform_smtp_providers.config_json` + `secret_json_encrypted` | `SMTP_*`、`SENDER_*` |
| OAuth | 平台设置 / 登录方式 | `platform_runtime_settings.oauth_settings_json`，后续可拆 `oauth_provider_clients` | `WECHAT_AUTH_*` 等 |
| 集成默认行为 | 平台设置 / 集成配置 | `platform_runtime_settings.integration_settings_json` | `FEEDBACK_ADMIN_API_ACTOR_USER_ID` |
| Apple IAP / Login | 平台设置 / Apple | `apple_login_credentials` + `platform_payment_methods.config_json` | `APPLE_ROOT_CERTIFICATES_PEM` |
| 反馈/集成 API key | 平台设置 / 集成密钥 | `platform_api_keys` | `FEEDBACK_ADMIN_API_KEY` |
| CORS | 平台设置 / 域名与安全 | `platform_runtime_settings.cors_origins` | `CORS_*` |
| AI 调优 | 平台设置 / AI 高级设置 | `ai_runtime_settings` | `AI_GATEWAY_*` |
| 支付调度 | 平台设置 / 支付任务 | `platform_runtime_settings` | `PAYMENTS_AUTO_DEDUCTION_*` |

## 管理员 UI 信息架构

只增加一个一级入口：`平台设置`。不要为每个 provider 增加散乱入口。

```text
平台设置
  基础
    平台域名
    API 根地址
    管理后台地址
    CORS 允许来源
  安全
    Session 时效
    集成 API key
    密钥轮换状态
  登录方式
    OAuth provider
    Apple / Google / GitHub / WeChat
  支付方式
    Alipay
    WeChat Pay
    Apple IAP
    Stripe
  对象存储
    Ali OSS
    S3 / R2
    CDN
  邮件与消息
    SMTP
    Cloudflare Email
    SMS
    Push
  AI 高级设置
    并发
    RPM
    Timeout
    Fallback
```

UI 规则：

- 表单只展示当前 provider 需要的字段。
- 密钥字段创建后默认不回显，只显示状态、后四位、更新时间。
- 每个 provider 都要有“测试连接”按钮。
- 高风险操作必须二次确认：禁用 provider、轮换密钥、删除配置。
- 页面不写长解释文案；用字段名、状态、错误码、测试结果指导操作。

## 数据模型建议

### platform_runtime_settings

```text
id
platformAppId
apiBaseUrl
adminFrontendUrl
corsOriginsJson
sessionPolicyJson
paymentsSchedulerJson
aiGatewayTuningJson
updatedBy
updatedAt
```

### platform_secret_values

```text
id
scopeType          # platform / app / tenant / provider
scopeId
secretType         # oauth_client_secret / payment_private_key / oss_secret / smtp_password
ciphertext
keyVersion
lastFour
rotatedAt
createdAt
updatedAt
```

### platform_storage_providers

```text
id
appId
environmentId
providerType       # ALIYUN_OSS / S3 / R2
name
isDefault
status
configJson
secretRefId
createdAt
updatedAt
```

### platform_api_keys

```text
id
appId
environmentId
name
prefix
keyHash
scopesJson
lastUsedAt
expiresAt
status
createdAt
revokedAt
```

### platform_smtp_providers

```text
id
name
isActive
isDefault
configJson          # host / port / secure / from_email / from_name
secretJsonEncrypted # username / password
createdBy
updatedBy
createdAt
updatedAt
```

## 后端实现要求

1. 所有模块禁止直接读取 `process.env`，只能读取统一配置服务。
2. 配置加载顺序：bootstrap env -> DB runtime settings -> provider config -> code default。
3. 生产环境中，如果 DB 已配置对应 provider，必须忽略同类 env fallback。
4. 启动时输出配置来源摘要：

```text
config.sources:
  database: env
  redis: env
  cors: db
  payments.alipay: db
  storage.default: db
  smtp.default: db
  ai.tuning: db
```

5. Deprecated env 出现时打印 warning，但不打印值。
6. 密钥存 DB 时必须加密，且写入审计日志。

## 当前已落地的基础链路

- 新增 `RuntimeSettingsService`，启动时确保 `platform_runtime_settings` 表存在。
- 新增平台管理接口：
  - `GET /api/v1/platform-admin/runtime-settings`
  - `PATCH /api/v1/platform-admin/runtime-settings`
  - 兼容 bare path：`/platform-admin/runtime-settings`
- 新增公开非密钥配置接口：
  - `GET /runtime-config`
- 后端 CORS 启动逻辑已优先读取 DB 中的 `cors_origins_json`，没有 DB 配置时回退到 env。
- 前端启动时会优先请求 `/runtime-config`，再回退到 `env.js` / `VITE_*`。
- 管理后台已新增 `平台设置` 页面，用于维护 Runtime Settings。
- `PLATFORM_SECRETS_KEY` 已成为新目标态主密钥名；旧 `OUTBOUND_PROXY_ENCRYPTION_KEY` 作为迁移兼容别名。
- 新增 `platform_storage_providers` 表和对象存储 UI。Aliyun OSS 的 endpoint、bucket、CDN、AK/SK 已可由管理员配置；AK/SK 和 CDN auth key 使用 `PLATFORM_SECRETS_KEY` 加密入库。
- `UploadService` 已优先读取 DB 默认对象存储 provider；没有 DB 配置时才回退旧 `ALIYUN_*` / `ALIYUN_OSS_*` env。
- 新增 `platform_api_keys` 表和集成密钥 UI。Feedback Admin API 已优先校验 DB 中带 `feedback:admin` scope 的 key；`FEEDBACK_ADMIN_API_KEY` 仅作为迁移 fallback。
- 新增 `platform_smtp_providers` 表和 SMTP UI。邮箱验证码 SMTP 发送已优先读取 DB 默认 SMTP provider；没有 DB 配置时才回退旧 `SMTP_*` / `SENDER_*` env。
- 支付服务已优先读取 `platform_payment_methods` 中的 Alipay / WeChat Pay 默认 provider；`ALIPAY_*`、`WECHAT_PAY_*` 仅作为迁移 fallback。支付 API 根地址、用户回跳地址、自动扣款调度和支付测试禁用开关已可通过 `platform_runtime_settings.payments_scheduler_json` 配置。
- AI Gateway 节流、候选 sticky、上游超时、请求/响应体限制、用量队列和 trace log 已优先读取 `platform_runtime_settings.ai_gateway_tuning_json`；`AI_GATEWAY_*` 仅作为迁移 fallback。
- AI 语音克隆默认模型已优先读取 `platform_runtime_settings.ai_gateway_tuning_json.voice_clone_model_key`；`AI_VOICE_CLONE_MODEL_KEY` 仅作为迁移 fallback。
- WeChat OAuth redirect URI / allowed hosts 已可通过 `platform_runtime_settings.oauth_settings_json` 配置；`WECHAT_AUTH_*` 仅作为迁移 fallback。
- Apple IAP 已可从 `platform_payment_methods` 的 `APPLE_IAP` provider 读取 root certificates PEM；`APPLE_ROOT_CERTIFICATES_PEM` 仅作为迁移 fallback。
- Feedback Admin API 默认 actor 已可通过 `platform_runtime_settings.integration_settings_json` 配置；`FEEDBACK_ADMIN_API_ACTOR_USER_ID` 仅作为迁移 fallback。
- Email Delivery 加密和退订签名已优先使用 `PLATFORM_SECRETS_KEY` 派生；`EMAIL_SECRET_KEY` 仅作为迁移 fallback，不进入新环境模板。

`payments_scheduler_json` 支持字段：

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

`ai_gateway_tuning_json` 支持字段：

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

`oauth_settings_json` 支持字段：

```json
{
  "wechat_auth_redirect_uri": "https://api.example.com/platform/v1/auth/login/wechat/callback",
  "wechat_auth_allowed_redirect_hosts": ["api.example.com", "admin.example.com"]
}
```

`integration_settings_json` 支持字段：

```json
{
  "feedback_admin_actor_user_id": "00000000-0000-0000-0000-000000000000"
}
```

## 前端实现要求

1. 新增 `/runtime-config`，返回非密钥运行时配置。
2. `apps/web` 启动时优先读取 `/runtime-config`，再回退到 `window.__APPADMIN_RUNTIME_CONFIG__`。
3. `VITE_*` 只作为构建和本地开发 fallback。
4. 线上文案不得要求管理员改 `.env` 来修业务配置；应该指向平台设置页。

## 迁移顺序

| 顺序 | 动作 | 收益 |
| --- | --- | --- |
| 1 | 新建 `platform_runtime_settings` 和统一 RuntimeConfigService | 先建立 DB 真值入口 |
| 2 | 支付 URL、CORS、后台域名迁入 UI | 解决部署最常错配置 |
| 3 | 对象存储 provider Web 化 | 删除 `ALIYUN_*` 大块 env |
| 4 | Feedback API key Web 化 | 删除 `FEEDBACK_ADMIN_API_KEY` |
| 5 | SMTP provider Web 化 | 删除 `SMTP_*`、`SENDER_*` |
| 6 | 支付 provider 完全以 DB 为准 | 已 DB 优先读取；下一步删除 `ALIPAY_*`、`WECHAT_PAY_*` fallback |
| 7 | OAuth/Apple Web 化收口 | WeChat redirect 和 Apple IAP root cert 已 DB 优先读取 |
| 8 | AI 调优从 env 迁到高级设置 | 已 DB 优先读取；下一步删除 `AI_GATEWAY_*` fallback |
| 9 | 集成默认行为 Web 化 | Feedback Admin 默认 actor 已 DB 优先读取；下一步删除 `FEEDBACK_ADMIN_API_ACTOR_USER_ID` fallback |
| 10 | CI 禁止新增散落 `process.env` | 防止回退 |

## 验收标准

- 标准生产 `.env` 不超过 6 个必填变量。
- 支付、OSS、SMTP、OAuth、AI provider 密钥均可在 UI 配置。
- 生产日志没有业务密钥 env fallback warning。
- `rg "process.env" services/gateway/src` 只允许出现在 bootstrap 配置目录和明确豁免文件。
- 管理员完成一次新 app 配置，不需要登录服务器改 `.env`。
