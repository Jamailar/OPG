# Permissions 协议

## 目标

权限系统要同时支持平台后台用户、app 终端用户、团队成员和 service account。默认拒绝访问，所有授权必须落到 app、tenant、resource、action。

## Actor 类型

- `platform_user`：OPG 平台后台用户。
- `app_user`：某个 app 的终端用户。
- `service_account`：server-to-server 调用身份。
- `system_worker`：队列和定时任务执行身份。

## 权限模型

```text
permission = resource + action

resource:
  app
  tenant
  user
  storage.bucket
  storage.file
  job
  ai.task
  video.task
  message
  billing
  audit

action:
  read
  create
  update
  delete
  execute
  retry
  cancel
  export
```

## 授权检查

每个需要授权的 service 方法必须检查：

- actor 是否存在。
- actor 是否属于目标 app 或 tenant。
- actor 是否拥有 resource/action。
- resource owner 或 tenant 边界是否匹配。
- 高风险操作是否需要二次确认或 elevated scope。

## 不做的事

第一版不做通用数据库行级权限编辑器。权限先落在业务资源层，避免把系统复杂度推到 UI 和动态查询层。

## 必须自研

- 权限矩阵。
- tenant 上下文校验。
- service account scope。
- 高风险操作策略。

## 必须用现成库

- JWT/session 校验。
- 密码 hash。
- OAuth provider SDK。

