# @jamba/opg-cli

CLI and Codex MCP bridge for OPG backend services.

```bash
npm install -g @jamba/opg-cli
opg init --base-url https://api.example.com
opg login
opg app create --name "Demo App" --slug demo
opg login --app demo
opg smoke
opg db smoke
opg db manifest
opg db query --sql "SELECT * FROM app_my_app__customers"
opg codex install
```

## Environment

The CLI reads `.opg/credentials.json`, `.env.local`, and `.opg/opg.config.json`.

- `OPG_BASE_URL`: Gateway base URL
- `OPG_APP_SLUG`: App slug owned by the current tenant
- `OPG_API_KEY`: Optional explicit Developer Grant (`opg_dev_...`) for CI or non-interactive runs
- `OPG_PLATFORM_TOKEN`: Platform admin JWT for global control-plane tools

`opg login` opens a browser authorization URL and stores a global platform login in `.opg/credentials.json`. After an app exists, `opg login --app <slug>` creates an app-scoped Developer Grant for SDK, database, AI, upload, and video operations. `opg codex install` writes a Codex MCP config template without embedding secret values.

## Platform Control Plane

App SDK operations stay app-scoped. Global operations use the platform token:

```bash
opg app list
opg app create --name "Demo App" --slug demo
opg platform apps list
opg platform apps create --json '{"name":"Demo App","slug":"demo"}'
opg platform runtime get
opg platform runtime update --json '{"api_base_url":"https://opg.example.com"}'
opg platform feedbacks list --app-id <app-id> --status open
opg platform feedbacks get --app-id <app-id> --feedback-id <feedback-id>
opg platform analytics users --app-id <app-id> --days 30
opg platform ai-usage logs --app-id <app-id> --days 7
opg platform payments orders --app-id <app-id> --page 1
opg platform request --path /storage/providers --method GET
```

The MCP server also exposes platform tools for app creation, runtime settings,
storage providers, AI sources/models, app feedback, app analytics, app AI usage,
app payment orders, and a generic `opg_platform_request` escape hatch for other
`/api/v1/platform-admin/*` endpoints.

Common app-data MCP tools:

- `opg_platform_app_feedbacks_list`
- `opg_platform_app_feedback_get`
- `opg_platform_app_feedback_update`
- `opg_platform_app_feedback_comment`
- `opg_platform_app_feedback_review`
- `opg_platform_app_analytics_overview`
- `opg_platform_app_analytics_users`
- `opg_platform_app_ai_usage_logs`
- `opg_platform_app_payment_orders`

## Codex Database Tools

The MCP server exposes app-scoped database tools:

- `opg_database_manifest_get`
- `opg_database_tables_list`
- `opg_database_table_describe`
- `opg_database_query`
- `opg_database_execute`

Database SQL is limited to app-owned tables such as `app_my_app__customers`.
`opg_database_execute` defaults to dry-run. Applying changes requires
`confirm=apply:<app-slug>`.

The same database operations are also available from the terminal:

```bash
opg db manifest
opg db smoke
opg db tables
opg db describe app_my_app__customers
opg db query --sql "SELECT * FROM app_my_app__customers"
opg db execute --sql "CREATE TABLE app_my_app__customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid())" --dry-run true
```
