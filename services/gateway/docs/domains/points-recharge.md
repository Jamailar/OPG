# 积分充值与计费专题

> 覆盖模块：`users`、`payments`、`ai-chat(ai-points)`、`platform-admin`

## 1. 业务目标
- 用户可查询积分余额。
- 用户可充值积分（支付宝/微信）。
- AI 调用自动扣积分。
- 每个 app 独立配置积分汇率（`1 元 = N 积分`）。

## 2. 用户侧接口

- 本节接口默认省略租户前缀，实际用户请求应写成 `/{slug}/v1/...`
- 例如：`GET /users/me/points` 的完整路径应为 `GET /{app}/v1/users/me/points`

### 2.1 查询积分
- `GET /users/me/points`
- 返回钱包余额和计费规则，含：`pricing.points_per_yuan`。

### 2.2 查询我的 AI 调用记录
- `GET /users/me/ai-usage-logs`
- 查询参数：
  - `page`
  - `limit`
- 返回字段：
  - `time`
  - `id`
  - `model`
  - `token`
  - `points_cost`

### 2.3 充值下单
- `POST /payments/orders/page-pay`（支付宝）
- `POST /payments/orders/wechat/native`（微信）
- 推荐金额直充：传 `amount`，无需依赖预先创建商品。

### 2.4 订单查询
- `GET /payments/orders/:out_trade_no`
- 关注字段：`status`、`trade_status`、`points_topup_points`、`points_topup_status`。

## 3. 支付回调（服务端）
- `POST /payments/callbacks/trade-notify`
- `GET /payments/callbacks/trade-return`
- `POST /payments/callbacks/agreement-notify`
- `POST /payments/callbacks/wechat-notify`

## 4. 租户汇率配置（管理端）
- `GET /api/v1/platform-admin/apps/:app_id/ai/points-settings`
- `PUT /api/v1/platform-admin/apps/:app_id/ai/points-settings`

`PUT` 示例：
```json
{
  "points_per_yuan": 100
}
```

## 5. 核心规则
- 默认汇率：`points_per_yuan=100`。
- 充值积分计算：`充值金额 * points_per_yuan`。
- AI 计费扣分：先按模型计费单位计算人民币成本，再按 app 汇率折算积分扣减。
- 文字模型：按输出 token 计费。
- 嵌入模型：按 token 计费。
- 音频 / 视频模型：按分钟计费。
- 图片模型：按张计费。
- 全链路按 app 隔离：订单、钱包、积分账本均以 `app_id` 作用域处理。
