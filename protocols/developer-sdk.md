# Developer SDK

Developer SDK 是 OPG 面向 AI 应用开发者和 coding agent 的接入层。它把当前 app 的认证、AI Gateway、Agent、上传、视频异步任务、用量日志、数据库工作台和 API 文档整理成稳定合同，让用户项目和 Codex 可以一次配置后直接调用。

## 1. 产品目标

- 用户在自己的项目里安装 `opg-sdk` 后，可以直接调用 OPG 后端。
- 用户可以先执行 `opg login` 做全局平台登录；即使还没有 app，也可以用 `opg app create` 创建 app。app 存在后，再执行 `opg login --app <slug>` 生成 app-scoped Developer Grant。
- 用户在 Codex 中安装 `@jamba/opg-cli` MCP server 后，可以让 agent 查询能力、生成调用代码、运行 Agent、提交视频任务、查看用量，并在受控命名空间内调整数据库结构。
- SDK 只暴露稳定 app 能力，不泄露平台级 provider 密钥和全局控制面。
- SDK 不暴露 `DATABASE_URL`，所有数据库操作都必须经由后端鉴权、命名空间校验和审计。
- 后端接口可以继续演进，但 `/sdk/manifest` 必须保持向后兼容。

## 2. 模块边界

```text
packages/sdk
  Runtime client for app code.

packages/cli
  global browser login / app create / app-scoped browser login / smoke / codex install / MCP stdio server.

services/gateway/src/modules/developer-sdk
  manifest / openapi / examples / smoke-test / install-profile / browser login / database workspace.

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
POST /:app/v1/sdk/auth/sessions
GET  /:app/v1/sdk/auth/sessions/:state
POST /:app/v1/sdk/auth/sessions/:state/authorize
POST /:app/v1/sdk/auth/token
POST /api/v1/sdk/auth/sessions
GET  /api/v1/sdk/auth/sessions/:state
POST /api/v1/sdk/auth/sessions/:state/authorize
POST /api/v1/sdk/auth/token
GET  /:app/v1/sdk/database/manifest
GET  /:app/v1/sdk/database/tables
GET  /:app/v1/sdk/database/tables/:table
POST /:app/v1/sdk/database/query
POST /:app/v1/sdk/database/execute
```

`manifest` 可按 app slug 公开读取，只返回路由、能力、安装命令和非密钥元数据。

`/api/v1/sdk/auth/*` 是平台 CLI 登录入口，返回平台 JWT + refresh token；`/:app/v1/sdk/auth/*` 是 app-scoped SDK 登录入口，返回 Developer Grant。`auth/sessions` 和 `auth/token` 是短期公开交换接口；`auth/sessions/:state/authorize`、`smoke-test` 和 `install-profile` 必须鉴权。数据库接口也必须鉴权，并额外要求 actor 是当前 app 的管理员或具备 app-scoped Developer Grant。

- `Authorization: Bearer <rbx_app_api_key>`
- `x-opg-api-key: <rbx_app_api_key>`
- `Authorization: Bearer <opg_dev_developer_grant>`
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
- `database` capability 和 `/sdk/database/*` 路由

SDK 和 MCP 只能依赖 manifest 中声明的稳定路由。新增能力先扩 manifest，再扩 SDK。

## 5. SDK 范围

第一版 SDK 覆盖：

- `sdk.manifest/openapi/examples/smokeTest`
- `ai.models/pricing/chat/responses/streamResponses/embeddings/image/speech`
- `agents.list/meta/run/stream`
- `upload.presignedUrl/imageBuffer/fileBuffer`
- `video.generate/generateAsync/queryTask/wait`
- `usage.aiLogs`
- `database.manifest/tables/describe/query/execute`

数据库 SDK 是后端代理的 app-scoped workspace，不是直连数据库客户端。它的边界是：

- 每个 app 只能操作自己的表名前缀：`app_<app_slug>__*`。
- `query` 只允许 `SELECT` / `WITH`，返回最多 500 行。
- `execute` 只允许 table/index DDL、table comment 和 table DML。
- `execute` 默认 dry-run，在事务中回滚；真正应用必须传 `confirm=apply:<app_slug>`。
- 禁止 `GRANT`、`REVOKE`、`COPY`、extension、function、procedure、trigger、role、transaction control、vacuum、notify 等平台级或运行时级 SQL。
- 所有数据库操作写入 `app_database_change_events` 审计表。
- 不暴露平台级模型源、provider 密钥、全局 runtime settings 和 OPG 内部业务表。

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
- `opg_database_manifest_get`
- `opg_database_tables_list`
- `opg_database_table_describe`
- `opg_database_query`
- `opg db smoke`（CLI 验收命令，依次检查 manifest、tables 和 dry-run DDL）

Execution:

- `opg_agents_run`
- `opg_ai_chat_completions`
- `opg_video_submit`
- `opg_database_execute`

执行类工具可能消耗模型 token、积分或 provider 额度，工具描述必须明确写出成本风险。
数据库执行类工具可能改变 schema 或数据，工具描述必须明确 dry-run 默认值和 apply confirm。
后端部署后，最小验收命令是 `opg db smoke`；它必须能返回数据库 manifest、当前命名空间表列表和一次已回滚的 dry-run DDL 结果。
本地开发主链路是 `opg init --base-url <url> --app <slug>` 后执行 `opg login`。CLI 会创建短期 SDK 登录会话、打开浏览器授权页、通过 localhost callback 收到一次性 code，再换取平台级 Developer Grant 并保存到 `.opg/credentials.json`。Grant 由平台后台“开发者授权”统一管理，可以按 app 和 scope 精细调整，不要求用户手动复制 API key。
仓库级 CI 验收命令仍然是 `npm run sdk:db:smoke`，读取 `OPG_BASE_URL`、`OPG_APP_SLUG`、`OPG_API_KEY`，用于部署后从源码仓库验证同一条 SDK 链路。`OPG_API_KEY` 推荐使用 `opg_dev_` Developer Grant。

## 7. UI

App 工作区新增 `开发者接入`，只展示：

- Base URL
- App slug
- API Base
- SDK/Codex 安装与 login 命令
- 平台开发者授权入口
- SDK smoke-test 结果

不新增解释型大页面，不把 provider 设置搬到开发者页。

## 8. 性能与安全

- Manifest 可缓存 30-300 秒；包含密钥状态时必须拆成鉴权接口。
- SDK 大文件上传默认走 presigned URL 或 multipart，不把视频文件转 base64 进 JSON。
- MCP 默认用本地 env、`.opg/opg.config.json` 或 `.opg/credentials.json`，真实 API key 不写入 manifest。
- `.opg/credentials.json` 只保存浏览器授权后的本机凭证，必须 gitignore。
- Developer grant 只保存 hash，明文只在创建时返回一次。
- Grant scope 必须覆盖 AI、视频、上传、usage 和数据库读写；高风险 scope 默认可见、可撤销、可收窄。
- 数据库工作台只返回 app namespace 和审计结果，不返回 `DATABASE_URL`。
- 数据库 query/execute 设 statement timeout，query 结果截断到上限，防止 coding agent 拉爆主库。
- 请求链路继续复用 AI Gateway 的 request events、provider health、usage ledger 和 audit events。
