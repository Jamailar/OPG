# Jobs 协议

## 目标

Jobs 是 OPG 的长任务和 Functions 基础。AI、视频、消息、Webhook、定时任务、数据同步都必须通过统一任务协议执行。

## Trigger 类型

- `http`：由 API 请求创建。
- `event`：由系统事件触发。
- `cron`：由定时规则触发。
- `manual`：由平台后台手动执行。

## 状态机

```text
queued -> running -> succeeded
queued -> running -> retrying -> running -> succeeded
queued -> running -> failed
queued -> cancelled
running -> cancelling -> cancelled
```

## 核心字段

```text
job
  id
  appId
  tenantId
  type
  triggerType
  status
  idempotencyKey
  priority
  attempts
  maxAttempts
  timeoutMs
  inputSummary
  resultSummary
  userVisibleErrorCode
  internalError
  createdBy
```

## 执行约束

- HTTP 请求只创建 job，不同步等待长任务完成。
- job input 保存摘要，不保存大 payload。
- 大 payload 放 Storage，通过 file id 引用。
- 每个 job 必须有幂等键策略。
- 失败必须同时记录用户可见错误码和内部排障字段。

## 必须自研

- job 类型协议。
- 状态机。
- 幂等策略。
- 日志脱敏。
- 任务和 usage ledger 绑定。

## 必须用现成库

- BullMQ + Redis。
- Cron parser。
- Provider SDK。
- Docker/Cloudflare/Vercel runtime adapter。

