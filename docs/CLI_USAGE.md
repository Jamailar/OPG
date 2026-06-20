# OPG CLI 使用指南

`@jamba/opg-cli` 是 OPG 后端服务给开发者和 Codex 使用的本地工具。它负责三件事：

- 平台级登录：用于创建 app、读取指定 app 数据、处理反馈、查看 analytics / AI usage / payments。
- app 级授权：用于 SDK、数据库、AI、上传、视频等 app 内能力。
- Codex MCP：让 Codex 通过 MCP 工具直接操作当前 OPG 服务端。

## 安装

```bash
npm install -g @jamba/opg-cli@latest --registry=https://registry.npmjs.org/
opg --help
```

如果 npm 指向了镜像源，先切回官方 registry：

```bash
npm config set registry https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

## 配置和登录

首次在项目目录初始化平台配置：

```bash
opg init --base-url https://opg.ziz.hk
opg login
```

`opg login` 默认是全平台授权，不需要 app。成功后会把平台 token 存到 `.opg/credentials.json`，用于全局控制面命令。

创建 app 后，再做 app 级 SDK 授权：

```bash
opg app create --kind website --name "Demo App" --slug demo
opg login --app demo
```

app 级授权会生成 Developer Grant，用于 `opg manifest`、`opg smoke`、`opg db ...` 和 MCP 的 app-scoped 工具。

## App 构建面

```bash
opg schema table create --name customers --columns email:text,name:text --apply
opg data create customers --json '{"email":"a@example.com","name":"Alice"}'
opg function create --app-id demo --slug sync_customer --source '{"kind":"echo"}'
opg function deploy --app-id demo sync_customer
opg function invoke sync_customer --json '{"input":{"email":"a@example.com"}}'
opg workflow create --app-id demo --slug onboard --steps '[{"id":"noop","type":"noop"}]'
opg workflow run onboard --json '{"input":{"email":"a@example.com"}}'
opg block ai upsert --app-id demo --json '{"slug":"copy","prompt_template":"Write {{topic}}"}'
```

端到端校验脚本：

```bash
OPG_BASE_URL=https://opg.example.com \
OPG_APP_SLUG=demo \
OPG_API_KEY=opg_dev_xxx \
OPG_PLATFORM_TOKEN=eyJ... \
node scripts/verify-app-construction-plane.mjs
```

## 常用流程

```bash
opg init --base-url https://opg.ziz.hk
opg login
opg app list
opg app create --kind website --name "Demo App" --slug demo
opg login --app demo
opg smoke
opg db smoke
opg codex install
```

## App 管理

```bash
opg app list
opg app create --kind website --name "Demo App" --slug demo
opg app create --json '{"kind":"WEBSITE","name":"Demo App","slug":"demo"}'
opg app use demo
```

`opg app create` 会创建 app，并把当前项目的 `.opg/opg.config.json` 切到这个 app。之后需要执行：

```bash
opg login --app demo
```

## 指定 App 的平台数据

先拿到 app id：

```bash
opg platform apps list
opg platform apps get --app-id <app-id>
```

读取指定 app 的反馈：

```bash
opg platform feedbacks list --app-id <app-id>
opg platform feedbacks get --app-id <app-id> --feedback-id <feedback-id>
```

处理反馈：

```bash
opg platform feedbacks update \
  --app-id <app-id> \
  --feedback-id <feedback-id> \
  --json '{"status":"triaged","priority":"high","admin_note":"已确认"}'

opg platform feedbacks comment \
  --app-id <app-id> \
  --feedback-id <feedback-id> \
  --json '{"body":"已收到，正在处理","is_internal":true}'

opg platform feedbacks review \
  --app-id <app-id> \
  --feedback-id <feedback-id> \
  --json '{"action":"thanks","note":"有效反馈"}'
```

读取指定 app 的运营数据：

```bash
opg platform analytics business --app-id <app-id> --days 30
opg platform analytics overview --app-id <app-id> --days 30
opg platform analytics growth --app-id <app-id> --days 30
opg platform analytics retention --app-id <app-id> --days 30
opg platform analytics profiles --app-id <app-id> --days 30
opg platform analytics conversion --app-id <app-id> --days 30
opg platform analytics users --app-id <app-id> --days 30
```

读取指定 app 的 AI 和支付数据：

```bash
opg platform ai-usage summary --app-id <app-id> --days 7
opg platform ai-usage breakdown --app-id <app-id> --days 7
opg platform ai-usage logs --app-id <app-id> --days 7

opg platform payments products --app-id <app-id>
opg platform payments orders --app-id <app-id> --page 1
```

通用平台 API 调用：

```bash
opg platform request --path /apps --method GET
opg platform request --path /storage/providers --method GET
opg platform request --path /apps/<app-id>/admins --method GET
```

`--path` 是 `/api/v1/platform-admin` 下面的路径，不要重复写 `/api/v1/platform-admin`。

## SDK 和数据库

app 级授权后：

```bash
opg manifest
opg smoke
opg db manifest
opg db smoke
opg db tables
```

查询 app 自己的表：

```bash
opg db query --sql "SELECT * FROM app_demo__customers ORDER BY created_at DESC" --limit 20
```

DDL / DML 默认建议先 dry-run：

```bash
opg db execute \
  --sql "CREATE TABLE app_demo__customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL)" \
  --dry-run true
```

真正执行需要使用 `opg db manifest` 返回的确认 token：

```bash
opg db execute \
  --sql "CREATE TABLE app_demo__customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL)" \
  --dry-run false \
  --confirm apply:demo
```

数据库网关只允许访问当前 app namespace，例如 `app_demo__` 前缀的表。

## Codex MCP

写入 Codex MCP 配置：

```bash
opg codex install
```

生成文件：

```text
.opg/codex-mcp.json
```

MCP server 命令：

```bash
opg mcp
```

常用 MCP 工具包括：

- `opg_platform_apps_list`
- `opg_platform_app_create`
- `opg_platform_app_feedbacks_list`
- `opg_platform_app_feedback_get`
- `opg_platform_app_analytics_users`
- `opg_platform_app_ai_usage_logs`
- `opg_platform_app_payment_orders`
- `opg_database_manifest_get`
- `opg_database_query`
- `opg_database_execute`

## 本地文件和优先级

CLI 会读取：

- `.opg/opg.config.json`：当前 base URL、app、profile。
- `.opg/credentials.json`：平台 token 和 app Developer Grant。
- `.env.local`：可选环境变量。

常用环境变量：

```bash
OPG_BASE_URL=https://opg.ziz.hk
OPG_APP_SLUG=demo
OPG_API_KEY=opg_dev_xxx
OPG_PLATFORM_TOKEN=eyJ...
```

命令行参数优先级最高，其次是环境变量、本地 `.env.local`、`.opg/opg.config.json` 和 `.opg/credentials.json`。

## 发版前验收

发布 CLI 前先构建并跑完整验收：

```bash
npm --prefix packages/cli run build
npm run cli:verify
```

`npm run cli:verify` 会执行：

- help 菜单检查
- `opg init`
- app 创建、列表、切换
- platform app get/update/request/runtime
- 指定 app 的 feedback list/get/update/comment/review
- 指定 app 的 analytics、AI usage、payments
- app 级 SDK 登录
- `manifest`、`smoke`
- `db manifest/tables/smoke/query/describe/execute`
- `codex install`
- `mcp` 初始化和 `tools/list`

脚本会创建临时测试 app 和测试用户，结束时把测试 app 改成 `INACTIVE`，并恢复运行前的 `.opg` 本地配置。

## 常见问题

### `Cannot POST /api/v1/sdk/auth/sessions`

服务端还没有部署 SDK 登录接口，或者 `--base-url` 指到了旧服务。先确认：

```bash
opg init --base-url https://opg.ziz.hk
opg login
```

### `Missing OPG app slug`

这是 app-scoped 命令需要 app。平台登录、创建 app 不需要 app；数据库和 SDK 命令需要：

```bash
opg app use demo
opg login --app demo
```

### `SDK login session not found`

通常是登录链接过期、服务端不是最新版本，或者打开了旧的授权链接。重新执行：

```bash
opg login
```

或：

```bash
opg login --app demo
```

### 全局命令还是旧版本

重新安装官方 npm 包：

```bash
npm install -g @jamba/opg-cli@latest --registry=https://registry.npmjs.org/
opg --help
```
