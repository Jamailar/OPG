# opg-sdk

TypeScript SDK for OPG backend services.

```ts
import { createOpgClient } from "opg-sdk";

const opg = createOpgClient({
  baseUrl: process.env.OPG_BASE_URL!,
  app: process.env.OPG_APP_SLUG!,
  apiKey: process.env.OPG_API_KEY!,
});

const models = await opg.ai.models();
```

## Configuration

- `OPG_BASE_URL`: Gateway base URL, for example `https://api.example.com`
- `OPG_APP_SLUG`: App slug owned by the current tenant
- `OPG_API_KEY`: App API key created in the OPG developer console
- `OPG_PLATFORM_TOKEN`: Platform admin JWT for global control-plane operations

## Codex

Use `opg-dev-cli` to generate local config and install the Codex MCP bridge.

## Global Platform Control Plane

App API keys are intentionally app-scoped. To create apps or manage global
providers, pass a platform admin token and use the platform client:

```ts
import { createOpgPlatformClient } from "opg-sdk";

const platform = createOpgPlatformClient({
  baseUrl: process.env.OPG_BASE_URL!,
  platformToken: process.env.OPG_PLATFORM_TOKEN!,
});

await platform.apps.create({
  name: "Demo App",
  slug: "demo",
});

await platform.runtimeSettings.update({
  api_base_url: "https://opg.example.com",
  cors_origins: ["https://opg.example.com"],
});

await platform.storageProviders.create({
  name: "Default OSS",
  provider_type: "s3",
  is_default: true,
  config: {
    endpoint: "https://s3.example.com",
    bucket: "opg-assets",
  },
});
```

`createOpgClient()` also exposes `opg.platform` for processes that need both
app-scoped API calls and platform administration.

## Database Workspace

Database operations are routed through the OPG backend. The SDK never exposes
`DATABASE_URL`, and SQL is limited to the app-owned namespace returned by:

```ts
const db = await opg.database.manifest();
console.log(db.namespace);

await opg.database.execute({
  sql: `CREATE TABLE ${db.namespace}customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL)`,
  dryRun: true,
});
```
