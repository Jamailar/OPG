# @jamba/opg-cli

CLI and Codex MCP bridge for OPG backend services.

Full usage guide: `docs/CLI_USAGE.md` in the OPG_system repository.

```bash
npm install -g @jamba/opg-cli
opg --help
opg init --base-url https://api.example.com
opg login
opg app create --kind website --name "Demo App" --slug demo
opg login --app demo
opg smoke
opg db smoke
opg db manifest
opg db query --sql "SELECT * FROM app_my_app__customers"
opg connector invoke crm lookup --json '{"input":{"customer_id":"123"}}'
opg codex install
```

Use `opg <command> --help` for command-specific help:

```bash
opg login --help
opg app --help
opg connector --help
opg db --help
opg platform --help
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
opg app create --kind website --name "Demo App" --slug demo
opg platform apps list
opg platform apps create --json '{"kind":"WEBSITE","name":"Demo App","slug":"demo"}'
opg platform runtime get
opg platform runtime update --json '{"api_base_url":"https://opg.example.com"}'
opg platform runtime overview
opg platform runtime templates
opg platform runtime refresh
opg platform runtime app-overview --app-id <app-id>
opg platform runtime apply-template --app-id <app-id> --template-key ai-video-app
opg platform feedbacks list --app-id <app-id> --status open
opg platform feedbacks get --app-id <app-id> --feedback-id <feedback-id>
opg platform feedbacks update --app-id <app-id> --feedback-id <feedback-id> --json '{"status":"triaged"}'
opg platform feedbacks comment --app-id <app-id> --feedback-id <feedback-id> --json '{"body":"已收到","is_internal":true}'
opg platform feedbacks review --app-id <app-id> --feedback-id <feedback-id> --json '{"action":"thanks"}'
opg platform analytics business --app-id <app-id> --days 30
opg platform analytics overview --app-id <app-id> --days 30
opg platform analytics growth --app-id <app-id> --days 30
opg platform analytics retention --app-id <app-id> --days 30
opg platform analytics profiles --app-id <app-id> --days 30
opg platform analytics conversion --app-id <app-id> --days 30
opg platform analytics users --app-id <app-id> --days 30
opg platform ai-usage summary --app-id <app-id> --days 7
opg platform ai-usage breakdown --app-id <app-id> --days 7
opg platform ai-usage logs --app-id <app-id> --days 7
opg platform payments products --app-id <app-id>
opg platform payments orders --app-id <app-id> --page 1
opg connector list --app-id <app-id>
opg connector create --app-id <app-id> --slug crm --base-url https://api.example.com
opg connector credential create crm --app-id <app-id> --json '{"slug":"default","auth_mode":"bearer","secrets":{"token":"..."}}'
opg connector action create crm --app-id <app-id> --json '{"slug":"lookup","method":"GET","path_template":"/customers/{{input.customer_id}}"}'
opg connector invoke crm lookup --json '{"input":{"customer_id":"123"}}'
opg platform request --path /storage/providers --method GET
```

The MCP server also exposes platform tools for app creation, runtime settings,
runtime registry/templates, storage providers, AI sources/models, app feedback,
app analytics, app AI usage, app payment orders, and a generic `opg_platform_request` escape hatch for other
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
- `opg_platform_runtime_overview`
- `opg_platform_runtime_refresh`
- `opg_platform_runtime_templates`
- `opg_platform_app_runtime_overview`
- `opg_platform_app_runtime_refresh`
- `opg_platform_app_runtime_apply_template`
- `opg_platform_app_connectors_list`
- `opg_platform_app_connector_create`
- `opg_platform_app_connector_credential_create`
- `opg_platform_app_connector_action_create`
- `opg_platform_app_connector_invoke`
- `opg_connector_invoke`

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

## Release Verification

Before publishing:

```bash
npm --prefix packages/cli run build
npm run cli:verify
```

The verifier creates a temporary app, submits a test feedback item, checks
app/platform/feedback/analytics/AI usage/payments/database/Codex/MCP commands,
marks the temporary app inactive, and restores local `.opg` config.
