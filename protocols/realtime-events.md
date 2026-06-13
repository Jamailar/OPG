# Realtime Events 协议

## 目标

Realtime 用于推送任务状态、文件状态、账单变化、系统事件，减少后台轮询。

## Channel 命名

```text
apps.{appId}.jobs.{jobId}
apps.{appId}.tenants.{tenantId}.jobs
apps.{appId}.storage.files.{fileId}
apps.{appId}.billing.usage
apps.{appId}.audit
```

## Event Envelope

```json
{
  "eventId": "evt_...",
  "appId": "app_...",
  "tenantId": "tenant_...",
  "resource": "job",
  "resourceId": "job_...",
  "type": "job.status_changed",
  "occurredAt": "2026-06-12T00:00:00.000Z",
  "payload": {
    "status": "running"
  }
}
```

## 订阅鉴权

订阅前必须检查：

- actor 是否属于 app。
- actor 是否属于 tenant。
- actor 是否有读取 resource 的权限。
- channel 是否允许当前 actor 类型订阅。

## 推送策略

- 只推送状态摘要，不推送大 payload。
- 高频任务进度需要节流。
- 客户端断线后通过 REST API 拉取最终真值。

## 必须自研

- channel 命名。
- 订阅权限。
- event envelope。
- 事件去重。

## 必须用现成库

- Socket.IO。
- Socket.IO Redis adapter。
- Redis pub/sub。

