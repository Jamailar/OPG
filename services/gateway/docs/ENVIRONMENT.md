# OPG Gateway 环境变量完整清单

最后更新：2026-06-09

本文档是后端部署环境变量的**唯一权威清单**（共 **108** 个有效变量名，含别名）。按功能分组说明默认值与代码读取位置；附录提供字母序总表。

- 可复制模板：[`.env.example`](../.env.example)
- 精简与 Web 化方案：[ENV_STREAMLINING_PLAN.md](./ENV_STREAMLINING_PLAN.md)

快速上手：至少设置 `DATABASE_URL`、`JWT_SECRET_KEY`。

---

## 已在 Web 管理后台配置的内容（不必写进 .env）

以下凭据/账号**优先存数据库**，由 `apps/web` 平台后台维护。环境变量仅作历史 fallback，新部署应通过 Web 配置。

| 能力 | Web 页面 | 数据表 / 字段 | 对应环境变量（可废弃） |
| --- | --- | --- | --- |
| AI 模型与上游密钥 | AI 源 / 模型 | `ai_sources`、`ai_model_source_routes` 等 | —（从未走 env） |
| 微信 / Google / GitHub 登录 | 全局 OAuth + 租户工作区 | `wechat_open_apps`、`google_oauth_clients`、`github_oauth_apps`、`app_settings.extra_json` | `WECHAT_AUTH_*`（部分） |
| 支付（支付宝/微信/Stripe 等） | 支付方式 | `platform_payment_methods.config_json` | `ALIPAY_*`、`WECHAT_PAY_*` |
| 邮件（Cloudflare） | 邮件服务 | `email_cf_accounts`、`email_senders` | — |
| 短信 | 短信服务 | `sms_*` 相关表 | — |
| 出站代理 | 出站代理 | `outbound_proxies`（凭据加密存 DB） | 仅需 `OUTBOUND_PROXY_ENCRYPTION_KEY` |
| Apple 登录 / IAP | 登录凭据 + 支付方式 | `apple_login_credentials`、`platform_payment_methods` | `APPLE_ROOT_CERTIFICATES_PEM` |
| 租户 URL / 回调 | 租户工作区 | `app_settings.app_url`、`wechat_redirect_uri`、`alipay_notify_url`、`extra_json` | `API_BASE_URL`、`USER_WEB_BASE_URL` 等 |

---

## 部署档位

| 档位 | 用途 | 最少需要 |
| --- | --- | --- |
| **最小** | 本地开发 / CI 冒烟 | `DATABASE_URL`、`JWT_SECRET_KEY` |
| **标准** | 单实例生产 | 最小 + `REDIS_URL`、`CORS_*`、强随机 `JWT_SECRET_KEY`、`NODE_ENV=production` |
| **完整** | 支付 / 上传 / 邮件 | 标准 + 对应集成块（OSS、SMTP、Alipay/WeChat 等） |

> AI 模型密钥、OAuth Client、短信等**租户级配置**存在数据库，由平台管理后台维护，不在此列出。

---

## 1. 启动必填

进程在 `configuration.ts` 加载时校验，缺失则直接退出。

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串（Prisma） |
| `JWT_SECRET_KEY` | JWT 签名密钥；也被出站代理加密、邮件哈希等作为 fallback |

---

## 2. 核心运行时

**读取位置：** `src/config/configuration.ts`（NestJS `ConfigModule` 单一入口）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | 运行环境；影响日志默认级别、AI debug 等 |
| `PORT` | `3000` | HTTP 监听端口 |
| `DEFAULT_APP_SLUG` | `demo` | 无租户上下文时的默认 app slug |
| `PLATFORM_APP_SLUG` | `platform` | 平台管理租户 slug |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis 连接；AI 限流、缓存等 |
| `JWT_EXPIRES_IN` | `24h` | Access token 有效期 |
| `JWT_REFRESH_INACTIVITY_DAYS` | `30` | Refresh token 不活跃过期（天） |
| `JWT_REFRESH_ABSOLUTE_DAYS` | `180` | Refresh token 绝对上限（天，≥ 不活跃天数） |

### 数据库连接池（写入 `DATABASE_URL` 查询参数）

| 变量 | 别名 | 说明 |
| --- | --- | --- |
| `DATABASE_CONNECTION_LIMIT` | `PRISMA_CONNECTION_LIMIT` | `connection_limit` |
| `DATABASE_POOL_TIMEOUT_SECONDS` | `PRISMA_POOL_TIMEOUT_SECONDS` | `pool_timeout` |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `PRISMA_CONNECT_TIMEOUT_SECONDS` | `connect_timeout` |
| `PRISMA_QUERY_LOG` | — | `true` 时打印 Prisma SQL |

### 自动迁移（启动脚本 / database module）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_AUTO_MIGRATE` | `true` | 与 `DATABASE_AUTO_MIGRATE` 等价；控制运行时是否自动 migrate |

### CORS（逗号分隔，多变量合并）

任一非空即可；全部为空时默认 `http://localhost:3000`。

| 变量 | 备注 |
| --- | --- |
| `CORS_ORIGINS` | 推荐统一使用 |
| `CORS_ALLOW_ORIGINS` | 别名 |
| `CORS_ALLOWED_ORIGINS` | 别名 |
| `ALLOWED_ORIGINS` | 别名 |
| `APPADMIN_URL` | **遗留名**，建议改为 `ADMIN_FRONTEND_URL` |
| `ADMIN_FRONTEND_URL` | 平台管理前端 URL |
| `FRONTEND_URL` | 通用前端 URL |

---

## 3. HTTP 与访问日志

| 变量 | 默认 | 读取位置 | 说明 |
| --- | --- | --- | --- |
| `HTTP_JSON_LIMIT` | `20mb` | `main.ts` | 普通 JSON body 上限 |
| `HTTP_MEDIA_JSON_LIMIT` | `45mb`（或 `HTTP_JSON_LIMIT`） | `main.ts` | 含媒体字段的 JSON 上限 |
| `GATEWAY_ACCESS_LOG` | 生产 `error`，其他 `all` | `logging.interceptor.ts` | 模式：`off` / `error` / `slow` / `sample` / `all` |
| `AI_GATEWAY_ACCESS_LOG` | — | 同上 | `GATEWAY_ACCESS_LOG` 别名 |
| `GATEWAY_ACCESS_LOG_SAMPLE_RATE` | `0` | 同上 | `sample` 模式采样率 0–1 |
| `AI_GATEWAY_ACCESS_LOG_SAMPLE_RATE` | — | 同上 | 别名 |
| `GATEWAY_SLOW_REQUEST_MS` | `3000` | 同上 | 慢请求阈值（毫秒） |
| `AI_GATEWAY_SLOW_REQUEST_MS` | — | 同上 | 别名 |

---

## 4. 邮件

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SMTP_SERVER` | `smtp.qiye.aliyun.com` | SMTP 主机（全局 fallback） |
| `SMTP_PORT` | `465` | SMTP 端口 |
| `SENDER_EMAIL` | — | SMTP 用户名 |
| `SENDER_PASSWORD` | — | SMTP 密码 |
| `EMAIL_SECRET_KEY` | fallback `JWT_SECRET_KEY` | 邮件链接/令牌哈希盐（`email-delivery.service.ts`） |

租户可在 DB 配置独立邮件服务；环境变量为未配置时的兜底。

---

## 5. 对象存储（Aliyun OSS）

| 变量 | 说明 |
| --- | --- |
| `ALIYUN_ACCESS_KEY_ID` | 可与 `ALIYUN_OSS_ACCESS_KEY_ID` 互换 |
| `ALIYUN_ACCESS_KEY_SECRET` | 可与 `ALIYUN_OSS_ACCESS_KEY_SECRET` 互换 |
| `ALIYUN_OSS_ENDPOINT` | OSS endpoint |
| `ALIYUN_OSS_BUCKET` | Bucket 名 |
| `ALIYUN_OSS_TIMEOUT_MS` | 默认 `300000`，范围 30s–15min |
| `ALIYUN_OSS_CDN_BASE_URL` | CDN 根 URL |
| `ALIYUN_OSS_CDN_AUTH_ENABLED` | `true` 启用 CDN 鉴权 |
| `ALIYUN_OSS_CDN_AUTH_KEY` | CDN 鉴权密钥 |
| `ALIYUN_OSS_CDN_AUTH_WINDOW_SECONDS` | 默认 `120`，范围 30–3600 |

---

## 6. 支付

全局开关与密钥见 `configuration.ts`；回调 URL 拼装见 `payments.service.ts`。详细说明：[PAYMENTS_REAL_GATEWAYS.md](../PAYMENTS_REAL_GATEWAYS.md)

### Alipay

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ALIPAY_ENABLED` | `false` | 须显式 `true` |
| `ALIPAY_SANDBOX_DEBUG` | `false` | 沙箱调试 |
| `ALIPAY_GATEWAY_URL` | `''` | 生产：`https://openapi.alipay.com/gateway.do` |
| `ALIPAY_APP_ID` | — | 应用 ID |
| `ALIPAY_APP_PRIVATE_KEY` | — | 商户私钥（PEM，`\n` 转义） |
| `ALIPAY_ALIPAY_PUBLIC_KEY` | — | 支付宝公钥 |
| `ALIPAY_SIGN_TYPE` | `RSA2` | 签名算法 |
| `ALIPAY_NOTIFY_URL` | — | 异步通知（API 域名） |
| `ALIPAY_RETURN_URL` | — | 同步跳转（前端域名，可留空走中转） |
| `ALIPAY_AGREEMENT_NOTIFY_URL` | — | 代扣协议通知 |
| `ALIPAY_AGREEMENT_RETURN_URL` | — | 代扣签约返回 |

### WeChat Pay

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WECHAT_PAY_ENABLED` | `false` | 须显式 `true` |
| `WECHAT_PAY_GATEWAY_URL` | `https://api.mch.weixin.qq.com` | API 根地址 |
| `WECHAT_PAY_APP_ID` | — | 公众号/小程序 AppID |
| `WECHAT_PAY_MCH_ID` | — | 商户号 |
| `WECHAT_PAY_API_KEY` | — | API v2 密钥 |
| `WECHAT_PAY_NOTIFY_URL` | — | 支付结果通知 |

### 支付 URL 与调度

| 变量 | 说明 |
| --- | --- |
| `API_BASE_URL` | 对外 API 根 URL（回调、notify 拼装） |
| `USER_WEB_BASE_URL` | 用户 Web 根 URL |
| `PAYMENT_RETURN_BASE_URL` | 支付完成跳转基址 |
| `WEB_APP_URL` | 同上类用途的别名 |
| `ALLOW_LOCAL_RETURN_URL` | 非生产允许 `localhost` 支付回跳 |
| `PAYMENTS_ADMIN_TEST_DISABLED` | 禁用管理端支付测试接口 |
| `PAYMENTS_AUTO_DEDUCTION_ENABLED` | 默认关闭；`true` 启用支付宝周期扣款调度 |
| `PAYMENTS_AUTO_DEDUCTION_INTERVAL_MS` | 默认 `300000`，范围 60s–24h |
| `PAYMENTS_AUTO_DEDUCTION_BATCH_SIZE` | 默认 `50`，范围 1–500 |

### Apple IAP

| 变量 | 说明 |
| --- | --- |
| `APPLE_ROOT_CERTIFICATES_PEM` | Apple 根证书 PEM（验签收据） |

---

## 7. 微信 OAuth

| 变量 | 说明 |
| --- | --- |
| `WECHAT_AUTH_REDIRECT_URI` | 授权回调 URI（优先） |
| `WECHAT_REDIRECT_URI` | 别名 |
| `WECHAT_AUTH_ALLOWED_REDIRECT_HOSTS` | 允许的 redirect host，逗号分隔 |
| `WECHAT_AUTH_ALLOWED_CALLBACK_HOSTS` | 同上别名 |

AppID/Secret 在 DB 按租户配置。

---

## 8. 出站代理

| 变量 | 说明 |
| --- | --- |
| `OUTBOUND_PROXY_ENCRYPTION_KEY` | 加密存储的代理凭据；未设置时 fallback `JWT_SECRET_KEY` |

---

## 9. 反馈工单管理 API

| 变量 | 说明 |
| --- | --- |
| `FEEDBACK_ADMIN_API_KEY` | Bearer / `X-Admin-Key` 管理员密钥 |
| `FEEDBACK_ADMIN_API_ACTOR_USER_ID` | 写操作审计用户 ID（可选） |

---

## 10. AI 网关调优

以下变量**未**进入 `configuration.ts`，由各 AI 模块直接读取 `process.env`。

### 限流与熔断（`ai-gateway-throttle.service.ts`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_GATEWAY_REDIS_LIMITS` | `0` | `1` 时用 Redis 分布式限流 |
| `AI_GATEWAY_REDIS_PREFIX` | `ai-gateway` | Redis key 前缀 |
| `AI_GATEWAY_THROTTLE_FAIL_OPEN` | `0` | `1` 时限流失败时放行 |
| `AI_GATEWAY_MAX_SOURCE_CONCURRENCY` | `128` | 单 source 并发上限 |
| `AI_GATEWAY_MAX_USER_CONCURRENCY` | `16` | 单用户并发上限 |
| `AI_GATEWAY_MAX_API_KEY_CONCURRENCY` | `0` | 0=不限制 |
| `AI_GATEWAY_MAX_ACCOUNT_CONCURRENCY` | `0` | 0=不限制 |
| `AI_GATEWAY_SOURCE_RPM` | `0` | 0=不限制 |
| `AI_GATEWAY_USER_RPM` | `0` | 0=不限制 |
| `AI_GATEWAY_API_KEY_RPM` | `0` | 0=不限制 |
| `AI_GATEWAY_ACCOUNT_RPM` | `0` | 0=不限制 |
| `AI_GATEWAY_COOLDOWN_FAILURE_THRESHOLD` | `3` | 触发 source 冷却的连续失败次数 |
| `AI_GATEWAY_COOLDOWN_MS` | `10000` | 冷却时长 |

### 路由粘性（`ai-gateway-scheduler.service.ts`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_GATEWAY_STICKY_TTL_MS` | `600000` | 路由粘性 TTL |

### 上游 HTTP（`ai-upstream-client.service.ts`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_GATEWAY_UPSTREAM_HEADER_TIMEOUT_MS` | `60000` | 非流式首包超时 |
| `AI_GATEWAY_UPSTREAM_STREAM_HEADER_TIMEOUT_MS` | `30000` | 流式首包超时 |
| `AI_GATEWAY_REQUEST_BODY_MAX_BYTES` | `20971520` | 请求体上限 |
| `AI_GATEWAY_RESPONSE_TEXT_MAX_BYTES` | `4194304` | 响应文本上限 |

### 图片 / 视频 / 用量队列（`ai-chat.service.ts`、`ai-gateway-usage-queue.service.ts`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_GATEWAY_IMAGE_UPSTREAM_TIMEOUT_MS` | `600000` | 图片生成上游超时 |
| `AI_GATEWAY_VIDEO_UPSTREAM_TIMEOUT_MS` | `3600000` | 视频生成上游超时 |
| `AI_GATEWAY_USAGE_WORKERS` | `4` | 用量写入 worker 数 |
| `AI_GATEWAY_USAGE_QUEUE_SIZE` | `1000` | 用量队列容量 |
| `AI_GATEWAY_USAGE_QUEUE_OVERFLOW` | `sync` | 队列满时：`sync` 或 `drop` |
| `AI_GATEWAY_TRACE_LOG` | — | `1` 输出逐请求 AI trace |
| `AI_DISABLE_VERCEL_SDK_FORWARD` | — | `1` 禁用 Vercel AI SDK 转发路径 |
| `AI_VOICE_CLONE_MODEL_KEY` | — | 默认语音克隆模型 key |
| `MINIMAX_VOICE_CATALOG_PATH` | — | MiniMax 音色表 JSON 路径 |

### 观测、健康与审计

AI 网关稳定性数据不依赖额外环境变量，服务启动时会确保以下持久化结构存在：

| 表 | 用途 |
| --- | --- |
| `ai_provider_health` | 记录 source / model / route / capability / api key 维度的健康状态、连续失败、冷却时间和平均延迟 |
| `ai_gateway_request_events` | 记录一次转发请求的关键阶段：`selected`、`upstream_response`、`upstream_error`、`usage_recorded`、`points_charged` 等 |
| `ai_audit_events` | 记录 AI source、model、tenant route、默认模型等配置变更的审计哈希和元数据 |

管理端查询接口：

| 接口 | 说明 |
| --- | --- |
| `GET /api/v1/:app_slug/platform-admin/ai/gateway/provider-health` | 查看供应商和 key 粒度健康状态 |
| `GET /api/v1/:app_slug/platform-admin/ai/gateway/request-events` | 按 `request_id` / `usage_reference_id` 追踪请求事件 |
| `GET /api/v1/:app_slug/platform-admin/ai/audit-events` | 查看 AI 配置审计事件 |

### 开发调试（生产忽略）

| 变量 | 说明 |
| --- | --- |
| `API_NODE_AI_DEBUG_AUTH_ENABLED` | `true` 启用 AI 基础设施调试 Bearer |
| `API_NODE_AI_DEBUG_AUTH_TOKEN` | 调试 token |
| `API_NODE_AI_DEBUG_AUTH_USER_ID` | 映射的真实用户 ID |
| `API_NODE_AI_DEBUG_AUTH_APP_SLUG` | 默认租户 slug |
| `APP_ENV` | 与 `NODE_ENV` 一起判断是否非生产 |

---

## 11. 容器启动脚本

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PRISMA_SCHEMA_PATH` | `./prisma/schema.prisma` | `start-with-migrations.sh` 用的 schema 路径 |

---

## 已知问题与遗留项

### 变量分散

| 问题 | 现状 |
| --- | --- |
| 配置入口不统一 | 约 60% 在 `configuration.ts`，AI/日志/支付 URL 分散在模块内 |
| 同名别名过多 | CORS 6 个、DB pool 各 2 个、JWT/Redis 在 compose 中又有一套错误名 |
| Secret fallback | `OUTBOUND_PROXY_ENCRYPTION_KEY`、`EMAIL_SECRET_KEY` 可回落到 `JWT_SECRET_KEY`，易造成密钥复用 |
| 已删除功能文档残留 | README 中 Forvo 相关变量已无任何代码引用 |

### 已废弃（勿再配置）

以下变量在源码中**零引用**，仅为历史文档残留：

`FORVO_API_*`、`FORVO_COMMERCIAL_REHOST_ALLOWED`、`FORVO_COUNTRY_PREFERENCES_JSON` 等。

---

## 附录 A：字母序总表（108）

| 变量 | 必填 | 默认 | 归类 | Web 可替代 |
| --- | --- | --- | --- | --- |
| `ADMIN_FRONTEND_URL` | | — | CORS | 部分 |
| `AI_DISABLE_VERCEL_SDK_FORWARD` | | — | AI 调优 | |
| `AI_GATEWAY_ACCESS_LOG` | | — | 日志别名 | |
| `AI_GATEWAY_ACCOUNT_RPM` | | `0` | AI 限流 | |
| `AI_GATEWAY_API_KEY_RPM` | | `0` | AI 限流 | |
| `AI_GATEWAY_COOLDOWN_FAILURE_THRESHOLD` | | `3` | AI 限流 | |
| `AI_GATEWAY_COOLDOWN_MS` | | `10000` | AI 限流 | |
| `AI_GATEWAY_IMAGE_UPSTREAM_TIMEOUT_MS` | | `600000` | AI 超时 | |
| `AI_GATEWAY_MAX_ACCOUNT_CONCURRENCY` | | `0` | AI 限流 | |
| `AI_GATEWAY_MAX_API_KEY_CONCURRENCY` | | `0` | AI 限流 | |
| `AI_GATEWAY_MAX_SOURCE_CONCURRENCY` | | `128` | AI 限流 | |
| `AI_GATEWAY_MAX_USER_CONCURRENCY` | | `16` | AI 限流 | |
| `AI_GATEWAY_REDIS_LIMITS` | | `0` | AI 限流 | |
| `AI_GATEWAY_REDIS_PREFIX` | | `ai-gateway` | AI 限流 | |
| `AI_GATEWAY_REQUEST_BODY_MAX_BYTES` | | `20971520` | AI 上游 | |
| `AI_GATEWAY_RESPONSE_TEXT_MAX_BYTES` | | `4194304` | AI 上游 | |
| `AI_GATEWAY_SOURCE_RPM` | | `0` | AI 限流 | |
| `AI_GATEWAY_STICKY_TTL_MS` | | `600000` | AI 路由 | |
| `AI_GATEWAY_THROTTLE_FAIL_OPEN` | | `0` | AI 限流 | |
| `AI_GATEWAY_TRACE_LOG` | | — | AI 日志 | |
| `AI_GATEWAY_UPSTREAM_HEADER_TIMEOUT_MS` | | `60000` | AI 上游 | |
| `AI_GATEWAY_UPSTREAM_STREAM_HEADER_TIMEOUT_MS` | | `30000` | AI 上游 | |
| `AI_GATEWAY_USAGE_QUEUE_OVERFLOW` | | `sync` | AI 用量 | |
| `AI_GATEWAY_USAGE_QUEUE_SIZE` | | `1000` | AI 用量 | |
| `AI_GATEWAY_USAGE_WORKERS` | | `4` | AI 用量 | |
| `AI_GATEWAY_USER_RPM` | | `0` | AI 限流 | |
| `AI_GATEWAY_VIDEO_UPSTREAM_TIMEOUT_MS` | | `3600000` | AI 超时 | |
| `AI_VOICE_CLONE_MODEL_KEY` | | — | AI 语音 | 可 |
| `ALIPAY_AGREEMENT_NOTIFY_URL` | | — | 支付 | ✅ |
| `ALIPAY_AGREEMENT_RETURN_URL` | | — | 支付 | ✅ |
| `ALIPAY_ALIPAY_PUBLIC_KEY` | | — | 支付 | ✅ |
| `ALIPAY_APP_ID` | | — | 支付 | ✅ |
| `ALIPAY_APP_PRIVATE_KEY` | | — | 支付 | ✅ |
| `ALIPAY_ENABLED` | | `false` | 支付 | ✅ |
| `ALIPAY_GATEWAY_URL` | | `''` | 支付 | ✅ |
| `ALIPAY_NOTIFY_URL` | | — | 支付 | ✅ |
| `ALIPAY_RETURN_URL` | | — | 支付 | ✅ |
| `ALIPAY_SANDBOX_DEBUG` | | `false` | 支付 | ✅ |
| `ALIPAY_SIGN_TYPE` | | `RSA2` | 支付 | ✅ |
| `ALIYUN_ACCESS_KEY_ID` | | — | OSS | 待 |
| `ALIYUN_ACCESS_KEY_SECRET` | | — | OSS | 待 |
| `ALIYUN_OSS_ACCESS_KEY_ID` | | — | OSS 别名 | 待 |
| `ALIYUN_OSS_ACCESS_KEY_SECRET` | | — | OSS 别名 | 待 |
| `ALIYUN_OSS_BUCKET` | | — | OSS | 待 |
| `ALIYUN_OSS_CDN_AUTH_ENABLED` | | `false` | OSS | 待 |
| `ALIYUN_OSS_CDN_AUTH_KEY` | | — | OSS | 待 |
| `ALIYUN_OSS_CDN_AUTH_WINDOW_SECONDS` | | `120` | OSS | 待 |
| `ALIYUN_OSS_CDN_BASE_URL` | | — | OSS | 待 |
| `ALIYUN_OSS_ENDPOINT` | | — | OSS | 待 |
| `ALIYUN_OSS_TIMEOUT_MS` | | `300000` | OSS | 待 |
| `ALLOWED_ORIGINS` | | — | CORS 别名 | 部分 |
| `ALLOW_LOCAL_RETURN_URL` | | — | 支付 dev | |
| `API_BASE_URL` | | — | 支付 URL | ✅ |
| `API_NODE_AI_DEBUG_AUTH_APP_SLUG` | | — | 开发 | |
| `API_NODE_AI_DEBUG_AUTH_ENABLED` | | — | 开发 | |
| `API_NODE_AI_DEBUG_AUTH_TOKEN` | | — | 开发 | |
| `API_NODE_AI_DEBUG_AUTH_USER_ID` | | — | 开发 | |
| `APPADMIN_URL` | | — | CORS 遗留 | 部分 |
| `APPLE_ROOT_CERTIFICATES_PEM` | | `''` | Apple IAP | ✅ |
| `APP_ENV` | | — | 开发 | |
| `CORS_ALLOWED_ORIGINS` | | — | CORS 别名 | 部分 |
| `CORS_ALLOW_ORIGINS` | | — | CORS 别名 | 部分 |
| `CORS_ORIGINS` | | localhost 默认 | CORS | 部分 |
| `DATABASE_AUTO_MIGRATE` | | — | DB 别名 | |
| `DATABASE_CONNECTION_LIMIT` | | — | DB 池 | |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | | — | DB 池 | |
| `DATABASE_POOL_TIMEOUT_SECONDS` | | — | DB 池 | |
| `DATABASE_URL` | **是** | — | 基础设施 | 否 |
| `DB_AUTO_MIGRATE` | | `true` | DB | |
| `DEFAULT_APP_SLUG` | | `demo` | 租户 | 可 |
| `EMAIL_SECRET_KEY` | | JWT fallback | 邮件 | 可 |
| `FEEDBACK_ADMIN_API_ACTOR_USER_ID` | | — | 反馈 API | ✅ |
| `FEEDBACK_ADMIN_API_KEY` | | — | 反馈 API | ✅ |
| `FRONTEND_URL` | | — | CORS | 部分 |
| `GATEWAY_ACCESS_LOG` | | 生产 `error` | 日志 | |
| `GATEWAY_ACCESS_LOG_SAMPLE_RATE` | | `0` | 日志 | |
| `GATEWAY_SLOW_REQUEST_MS` | | `3000` | 日志 | |
| `HTTP_JSON_LIMIT` | | `20mb` | HTTP | |
| `HTTP_MEDIA_JSON_LIMIT` | | `45mb` | HTTP | |
| `JWT_EXPIRES_IN` | | `24h` | 认证 | 可 |
| `JWT_REFRESH_ABSOLUTE_DAYS` | | `180` | 认证 | 可 |
| `JWT_REFRESH_INACTIVITY_DAYS` | | `30` | 认证 | 可 |
| `JWT_SECRET_KEY` | **是** | — | 基础设施 | 否 |
| `MINIMAX_VOICE_CATALOG_PATH` | | — | AI 语音 | 可 |
| `NODE_ENV` | | `development` | 基础设施 | 否 |
| `OUTBOUND_PROXY_ENCRYPTION_KEY` | | JWT fallback | 出站代理 | 否* |
| `PAYMENTS_ADMIN_TEST_DISABLED` | | — | 支付 | ✅ |
| `PAYMENTS_AUTO_DEDUCTION_BATCH_SIZE` | | `50` | 支付 | ✅ |
| `PAYMENTS_AUTO_DEDUCTION_ENABLED` | | `false` | 支付 | ✅ |
| `PAYMENTS_AUTO_DEDUCTION_INTERVAL_MS` | | `300000` | 支付 | ✅ |
| `PAYMENT_RETURN_BASE_URL` | | — | 支付 URL | ✅ |
| `PLATFORM_APP_SLUG` | | `platform` | 租户 | 可 |
| `PORT` | | `3000` | 基础设施 | 否 |
| `PRISMA_CONNECTION_LIMIT` | | — | DB 别名 | |
| `PRISMA_CONNECT_TIMEOUT_SECONDS` | | — | DB 别名 | |
| `PRISMA_POOL_TIMEOUT_SECONDS` | | — | DB 别名 | |
| `PRISMA_QUERY_LOG` | | `false` | DB | |
| `PRISMA_SCHEMA_PATH` | | `./prisma/...` | 启动脚本 | |
| `REDIS_URL` | | `redis://localhost:6379/0` | 基础设施 | 否 |
| `SENDER_EMAIL` | | — | SMTP fallback | ✅ |
| `SENDER_PASSWORD` | | — | SMTP fallback | ✅ |
| `SMTP_PORT` | | `465` | SMTP fallback | ✅ |
| `SMTP_SERVER` | | 阿里云企业邮 | SMTP fallback | ✅ |
| `USER_WEB_BASE_URL` | | — | 支付 URL | ✅ |
| `WEB_APP_URL` | | — | 支付 URL | ✅ |
| `WECHAT_AUTH_ALLOWED_CALLBACK_HOSTS` | | — | 微信 OAuth | ✅ |
| `WECHAT_AUTH_ALLOWED_REDIRECT_HOSTS` | | — | 微信 OAuth | ✅ |
| `WECHAT_AUTH_REDIRECT_URI` | | — | 微信 OAuth | ✅ |
| `WECHAT_PAY_API_KEY` | | — | 支付 | ✅ |
| `WECHAT_PAY_APP_ID` | | — | 支付 | ✅ |
| `WECHAT_PAY_ENABLED` | | `false` | 支付 | ✅ |
| `WECHAT_PAY_GATEWAY_URL` | | 微信官方 | 支付 | ✅ |
| `WECHAT_PAY_MCH_ID` | | — | 支付 | ✅ |
| `WECHAT_PAY_NOTIFY_URL` | | — | 支付 | ✅ |
| `WECHAT_REDIRECT_URI` | | — | 微信 OAuth 别名 | ✅ |

\* `OUTBOUND_PROXY_ENCRYPTION_KEY` 必须保留为**启动级主密钥**（用于解密 DB 中的代理密码），不可迁入 Web；但应独立于 `JWT_SECRET_KEY`。

「Web 可替代」列：✅ = 后台已有或接近已有能力；待 = 需新建页面/表；空白 = 建议保留环境变量（运维/性能调优）。

---

## 相关文档

- [ENV_STREAMLINING_PLAN.md](./ENV_STREAMLINING_PLAN.md) — 环境变量精简与 Web 化方案
- [`.env.example`](../.env.example) — 可复制模板
- [PAYMENTS_REAL_GATEWAYS.md](../PAYMENTS_REAL_GATEWAYS.md) — 支付接入
- [README.md](../README.md) — 日志与运维片段
