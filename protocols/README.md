# 协议与工程契约

本目录定义 OPG 的模块边界。新功能先补协议，再落实现；协议必须能直接指导表结构、API、权限、任务状态和 UI 入口。

## 协议索引

- [App Registry](./app-registry.md)：app、environment、tenant、API key、域名和功能开关。
- [Permissions](./permissions.md)：平台用户、app 用户、团队、角色、权限和资源授权。
- [Storage](./storage.md)：bucket、file、signed URL、metadata、quota 和生命周期。
- [Jobs](./jobs.md)：HTTP/event/cron/manual trigger、状态机、重试、日志和幂等。
- [Realtime Events](./realtime-events.md)：事件 envelope、channel 命名、订阅鉴权和推送策略。
- [Usage Ledger](./usage-ledger.md)：AI、视频、存储、消息等成本事件和账单聚合。
- [Runtime Settings](./runtime-settings.md)：环境变量极简化、管理员 UI 配置和密钥加密入库。
- [Developer SDK](./developer-sdk.md)：SDK、CLI、Codex MCP、manifest 和开发者接入合同。

## 1. 前后端 API 协议

- 后端 API 由 `services/gateway` 暴露，前端只通过 HTTP API 或事件流访问后端能力。
- 新接口必须包含：路由、请求体、响应体、错误码、鉴权要求、租户上下文。
- 前端不得直接访问数据库、AI provider、视频 provider、支付 provider。

## 2. 模块注册协议

每个业务模块需要声明：

- `moduleKey`：全局唯一模块标识。
- `routes`：后端路由前缀。
- `permissions`：后台权限点。
- `billingEvents`：可计费事件。
- `auditEvents`：审计事件。
- `uiEntry`：后台入口，仅在必要时增加。

## 3. AI 能力协议

AI 调用必须经过后端统一服务层：

- 统一记录请求摘要、provider、模型、输入大小、输出大小、成本估算、上游错误。
- 图片、视频、文本、语音使用不同任务类型，不在前端混用 payload。
- 供应商 SDK 用现成库；业务编排、计费、权限、审计自研。

## 4. 视频处理协议

- 编码、转码、抽帧、元数据读取必须用现成库或云服务，例如 FFmpeg、Remotion、云端媒体处理服务。
- 任务编排、素材归档、状态机、失败恢复、用户可见错误码由本系统自研。
- 长任务必须异步化，前端只订阅任务状态，不等待同步响应。

## 5. UI 协议

- UI 入口只在真实工作流需要时新增。
- 页面文案保持短，不使用解释性大段文字替代清晰交互。
- 表格、筛选、详情、状态流优先复用既有管理后台模式。

## 6. 提交协议

- 一个 commit 只包含一个明确意图。
- 复制源代码、初始化文档、功能变更、修复 bug 应拆成不同提交。
- 不提交 `.env`、`node_modules`、`dist`、临时数据库和日志。
