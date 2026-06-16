# Developer SDK

Developer SDK 是 OPG 面向 AI 应用开发者和 coding agent 的接入层。它把当前 app 的认证、AI Gateway、Agent、上传、视频异步任务、用量日志和 API 文档整理成稳定合同，让用户项目和 Codex 可以一次配置后直接调用。

## 1. 产品目标

- 用户在自己的项目里安装 `@opg/sdk` 后，可以直接调用 OPG 后端。
- 用户在 Codex 中安装 `@opg/cli` MCP server 后，可以让 agent 查询能力、生成调用代码、运行 Agent、提交视频任务和查看用量。
- SDK 只暴露稳定 app 能力，不泄露平台级 provider 密钥和全局控制面。
- 后端接口可以继续演进，但 `/sdk/manifest` 必须保持向后兼容。

## 2. 模块边界

```text
packages/sdk
  Runtime client for app code.

packages/cli
  init / smoke / codex install / MCP stdio server.

services/gateway/src/modules/developer-sdk
  manifest / openapi / examples / smoke-test / install-profile.

apps/web
  App workspace developer access panel.
```

## 3. 后端 API

```http
GET  /:app/v1/sdk/manifest
GET  /:app/v1/sdk/openapi.json
GET  /:app/v1/sdk/examples?target=node|react|codex
POST /:app/v1/sdk/smoke-test
POST /:app/v1/sdk/install-profile
```

`manifest` 可按 app slug 公开读取，只返回路由、能力、安装命令和非密钥元数据。

`smoke-test` 和 `install-profile` 必须鉴权，支持：

- `Authorization: Bearer <rbx_app_api_key>`
- `x-opg-api-key: <rbx_app_api_key>`
- `Authorization: Bearer <jwt>`

## 4. Manifest 合同

Manifest 必须包含：

- `manifest_version`
- `sdk.package`
- `sdk.cli_package`
- `app.id`
- `app.slug`
- `app.api_base_url`
- `auth.supported`
- `capabilities`
- `routes`
- `codex.install_command`
- `codex.mcp_server_command`
- `codex.environment`

SDK 和 MCP 只能依赖 manifest 中声明的稳定路由。新增能力先扩 manifest，再扩 SDK。

## 5. SDK 范围

第一版 SDK 覆盖：

- `sdk.manifest/openapi/examples/smokeTest`
- `ai.models/pricing/chat/responses/streamResponses/embeddings/image/speech`
- `agents.list/meta/run/stream`
- `upload.presignedUrl/imageBuffer/fileBuffer`
- `video.generate/generateAsync/queryTask/wait`
- `usage.aiLogs`

第一版不做通用数据库 SDK，不暴露平台级模型源、provider 密钥、全局 runtime settings。

## 6. Codex / MCP 工具

MCP server 使用 stdio transport，工具命名统一 `opg_*`。

Read-only:

- `opg_manifest_get`
- `opg_sdk_smoke_test`
- `opg_agents_list`
- `opg_ai_models_list`
- `opg_video_query`
- `opg_usage_recent`
- `opg_generate_client_code`

Execution:

- `opg_agents_run`
- `opg_ai_chat_completions`
- `opg_video_submit`

执行类工具可能消耗模型 token、积分或 provider 额度，工具描述必须明确写出成本风险。

## 7. UI

App 工作区新增 `开发者接入`，只展示：

- Base URL
- App slug
- API Base
- SDK/Codex 安装命令
- 当前用户 app API keys
- SDK smoke-test 结果

不新增解释型大页面，不把 provider 设置搬到开发者页。

## 8. 性能与安全

- Manifest 可缓存 30-300 秒；包含密钥状态时必须拆成鉴权接口。
- SDK 大文件上传默认走 presigned URL 或 multipart，不把视频文件转 base64 进 JSON。
- MCP 默认用本地 env 或 `.opg/opg.config.json`，真实 API key 不写入 manifest。
- API key 只保存 hash，明文只在创建时返回一次。
- 请求链路继续复用 AI Gateway 的 request events、provider health、usage ledger 和 audit events。
