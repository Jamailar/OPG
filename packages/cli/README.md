# opg-dev-cli

CLI and Codex MCP bridge for OPG backend services.

```bash
npm install -g opg-dev-cli
opg init --base-url https://api.example.com --app my-app
opg smoke
opg db smoke
opg db manifest
opg db query --sql "SELECT * FROM app_my_app__customers"
opg codex install
```

## Environment

The CLI reads `.env.local` and `.opg/opg.config.json`.

- `OPG_BASE_URL`: Gateway base URL
- `OPG_APP_SLUG`: App slug owned by the current tenant
- `OPG_API_KEY`: App API key created in the OPG developer console
- `OPG_PLATFORM_TOKEN`: Platform admin JWT for global control-plane tools

`opg codex install` writes a Codex MCP config template that references `${OPG_API_KEY}` and `${OPG_PLATFORM_TOKEN}` instead of writing secret values.

## Platform Control Plane

App SDK operations stay app-scoped. Global operations use the platform token:

```bash
opg platform apps list
opg platform apps create --json '{"name":"Demo App","slug":"demo"}'
opg platform runtime get
opg platform runtime update --json '{"api_base_url":"https://opg.example.com"}'
opg platform request --path /storage/providers --method GET
```

The MCP server also exposes platform tools for app creation, runtime settings,
storage providers, AI sources/models, and a generic `opg_platform_request`
escape hatch for other `/api/v1/platform-admin/*` endpoints.

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
