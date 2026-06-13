# Usage Ledger 协议

## 目标

Usage Ledger 记录所有可计费或需要成本归因的事件，包括 AI、视频、存储、消息、支付、代理请求和第三方 API。

## 事件原则

- append-only，不覆盖历史。
- 任务结果和计费流水分离。
- 即使上游失败，也要记录可排障的 attempt。
- 用户扣费、供应商成本、平台补贴分开记录。

## 核心对象

```text
usage_event
  id
  appId
  tenantId
  actorId
  sourceModule
  eventType
  jobId
  provider
  model
  quantity
  unit
  estimatedCost
  actualCost
  billableAmount
  currency
  status
  occurredAt
  metadata

ledger_entry
  id
  appId
  tenantId
  usageEventId
  accountType       # user_points / platform_cost / provider_cost
  direction         # debit / credit
  amount
  currency
  reason
```

## 常见事件类型

- `ai.text.generate`
- `ai.image.generate`
- `ai.video.generate`
- `storage.bytes.stored`
- `storage.bytes.transferred`
- `message.email.sent`
- `message.push.sent`
- `proxy.http.request`

## 聚合策略

- 明细表只追加。
- 后台列表读日聚合、月聚合或物化视图。
- provider 成本按 provider request id 或 upstream task id 对账。

## 必须自研

- usage event schema。
- ledger entry schema。
- 成本估算和实际成本对账。
- 积分或余额扣减策略。

## 必须用现成库

- Decimal 计算库。
- 数据库事务。
- provider 官方 billing/usage API client。
