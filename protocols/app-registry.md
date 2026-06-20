# App Registry 协议

## 目标

App Registry 是 OPG 的控制平面入口，用来管理一人公司旗下多个 app 的环境、租户、密钥、域名、功能开关和资源配额。

## 核心对象

```text
app
  id
  slug
  name
  kind              # DESKTOP / WEBSITE / MOBILE
  status
  ownerUserId

app_environment
  id
  appId
  name              # development / staging / production
  apiBaseUrl
  publicBaseUrl
  status

tenant
  id
  appId
  environmentId
  slug
  name
  status

app_api_key
  id
  appId
  environmentId
  keyHash
  prefix
  scopes
  lastUsedAt
  expiresAt

app_domain
  id
  appId
  environmentId
  hostname
  verificationStatus
```

## 请求上下文

所有后端请求必须解析出：

- `appId`
- `environmentId`
- `tenantId`
- `actorId`
- `actorType`
- `scopes`

无法解析 app 或 tenant 的请求不得进入业务 service。

## API 约定

- 平台后台路由：`/api/platform/apps/*`
- app 公开路由：`/api/apps/:appSlug/*`
- app server-to-server 路由：`/api/app-admin/:appId/*`

## 必须自研

- app/environment/tenant 模型。
- API key hash、scope、轮换和失效。
- 请求上下文 guard/interceptor。
- app 级功能开关和 quota。

## 必须用现成库

- 密钥 hash：`bcrypt` 或 Node crypto。
- JWT/JWS：`jose`。
- 数据持久化：Prisma/PostgreSQL。
