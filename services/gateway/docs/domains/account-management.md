# 账号管理专题

> 覆盖模块：`auth`、`users`、`api-keys`

## 1. 路由前缀
- `/:app/v1/auth`、`/api/v1/auth`、`/auth`
- `/:app/v1/users`、`/api/v1/users`、`/users`

## 2. 用户认证主链路

### 2.1 手机号登录/注册
- `POST /auth/send-sms-code`
- `POST /auth/login/sms`
- `POST /auth/register/sms`（兼容别名，行为同短信登录）

### 2.2 微信登录
- `GET /auth/login/wechat/url`
- `GET /auth/login/wechat/status?session_id=...`
- `POST /auth/login/wechat`

### 2.3 账号密码与资料
- `POST /auth/login`
- `POST /auth/register`
- `PUT /users/me`
- `POST /users/change-password`
- `POST /users/me/change-password`

## 3. JWT 会话机制
- 登录成功返回：`access_token` + `refresh_token`。
- 刷新接口：`POST /auth/refresh`。
- 过期行为：`JwtAuthGuard` 返回 401，`errors.reason=token_expired`。
- 登出接口：`POST /auth/logout`（会使 `sessionToken` 失效）。

## 4. API Key 管理（用户侧）

### 4.1 接口
- `GET /users/me/api-keys`
- `POST /users/me/api-keys`
- `POST /users/me/api-keys/ensure-default`（幂等）
- `POST /users/me/api-keys/:key_id/revoke`

### 4.2 关键规则
- Key 前缀：`rbx_`。
- 明文只在创建当次返回一次。
- `ensure-default`：
  - 已存在激活 key：返回 `created=false` 和脱敏元信息；
  - 不存在：创建并返回 `created=true` 与明文 key（仅一次）。
- API Key 与租户 app 绑定，跨 app 不可用。

## 5. 安全边界
- API Key 鉴权与 JWT 鉴权都走租户一致性校验。
- 用户必须属于当前 app 且启用状态，才可签发/查看/撤销 key。
- 建议客户端将 key 仅展示一次后立即提示用户保存。
