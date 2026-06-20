<p align="center">
  <img src="https://raw.githubusercontent.com/Jamailar/OPG/main/docs/assets/opg-system-preview.png" alt="OPG System Preview" width="860">
</p>

<h1 align="center">One-Person Group System</h1>

<p align="center">
  An app backend cluster control plane for one-person companies. OPG brings auth, tenants, runtime settings, AI, video, payments, usage, audit, and developer access into one frontend-backend monorepo.
</p>

<p align="center">
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="protocols/README.md">Protocols</a> ·
  <a href="packages/cli/README.md">CLI</a> ·
  <a href="docs/DOCKER_DEPLOYMENT.md">Docker</a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> · English
</p>

<p align="center">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/Web-React%20%2B%20Vite-61DAFB?logo=react&logoColor=111111">
  <img alt="NestJS" src="https://img.shields.io/badge/API-NestJS-E0234E?logo=nestjs&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/Truth-PostgreSQL-4169E1?logo=postgresql&logoColor=white">
  <img alt="Redis" src="https://img.shields.io/badge/Queue%20%2F%20Cache-Redis-DC382D?logo=redis&logoColor=white">
  <img alt="Docker release" src="https://github.com/Jamailar/OPG_system/actions/workflows/docker-release.yml/badge.svg">
  <img alt="License: PolyForm Noncommercial" src="https://img.shields.io/badge/License-PolyForm%20Noncommercial-0F172A">
</p>

<p align="center">
  <img alt="AI Gateway" src="https://img.shields.io/badge/AI-Gateway-7C3AED">
  <img alt="Video Tasks" src="https://img.shields.io/badge/Video-Async%20Tasks-F97316">
  <img alt="SDK CLI MCP" src="https://img.shields.io/badge/Developer-SDK%20%7C%20CLI%20%7C%20MCP-2563EB">
  <img alt="Observability" src="https://img.shields.io/badge/Ops-Observability%20%2B%20Audit-059669">
</p>

OPG is a frontend-backend separated app backend control plane. It helps a one-person company build multiple apps without repeatedly rebuilding authentication, tenant boundaries, runtime configuration, AI agents, video tasks, payment callbacks, messaging, audit logs, and admin consoles.

OPG is not trying to be a generic backend platform. Its core product surface is a multi-app operations console, AI/video provider governance, a cost ledger, and developer interfaces that are friendly to coding agents.

## Contents

- [Quickstart](#quickstart)
- [Product Positioning](#product-positioning)
- [System Architecture](#system-architecture)
- [Feature Modules](#feature-modules)
- [Project Structure](#project-structure)
- [Local Development And Integration](#local-development-and-integration)
- [Release And Docker Images](#release-and-docker-images)
- [Build Vs Buy Boundaries](#build-vs-buy-boundaries)
- [Performance Strategy](#performance-strategy)
- [Documentation](#documentation)

## Quickstart

Prefer Docker for deployment. Running from source is mainly for developing OPG itself and should not be the first deployment path for normal users.

| Method | Best for | Build source | Dependencies |
| --- | --- | --- | --- |
| Pull the Docker image directly | Trials, production, user-managed deployment | GHCR release image | External PostgreSQL / Redis, or `docker-compose.release.yml` |
| Clone source + Docker Compose | Local trial, private deployment, bundled PostgreSQL/Redis | Local Dockerfile | Docker / Docker Compose |
| Clone source + Dockerfile | Cloud builds, external database/Redis, Coolify/Render/Railway style deployment | Local Dockerfile target | External PostgreSQL / Redis |
| Source dev server | Developing OPG and debugging frontend/backend code | Node.js workspace | Node.js 22+, PostgreSQL, Redis |

### Method 1: Pull The Docker Image Directly (Recommended)

If PostgreSQL and Redis already exist, run the published single-container image directly. The single-container image includes both the Gateway API and the Web admin console on port `3000`.

```bash
docker pull ghcr.io/jamailar/opg-system:latest

docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL='postgresql://opg:password@postgres.example.com:5432/opg' \
  -e REDIS_URL='redis://redis.example.com:6379/0' \
  -e JWT_SECRET_KEY='replace-with-long-random-secret' \
  -e PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
  ghcr.io/jamailar/opg-system:latest
```

If you want the app, PostgreSQL, and Redis managed together by Compose, use the release Compose file:

```bash
git clone https://github.com/Jamailar/OPG_system.git
cd OPG_system

OPG_IMAGE=ghcr.io/jamailar/opg-system:latest \
JWT_SECRET_KEY='replace-with-long-random-secret' \
PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
POSTGRES_PASSWORD='replace-with-strong-password' \
docker compose -f docker-compose.release.yml up -d
```

Open the admin console:

```bash
open http://localhost:3000
```

### Method 2: Clone Source And Build With Docker Compose

Use this for a full local trial or private deployment. Compose builds the `opg-all` target from the current source and starts PostgreSQL and Redis.

```bash
git clone https://github.com/Jamailar/OPG_system.git
cd OPG_system

JWT_SECRET_KEY='replace-with-long-random-secret' \
PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
POSTGRES_PASSWORD='replace-with-strong-password' \
docker compose up -d --build
```

Change the host port:

```bash
OPG_PORT=8080 docker compose up -d --build
```

### Method 3: Clone Source And Build A Single Image With Dockerfile

Use this for cloud builders or external PostgreSQL/Redis. The recommended target is `opg-all`, which packages the Gateway API and Web static assets into one app image.

```bash
git clone https://github.com/Jamailar/OPG_system.git
cd OPG_system

docker build --target opg-all -t opg-system:local .

docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL='postgresql://opg:password@postgres.example.com:5432/opg' \
  -e REDIS_URL='redis://redis.example.com:6379/0' \
  -e JWT_SECRET_KEY='replace-with-long-random-secret' \
  -e PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
  opg-system:local
```

For split frontend/backend deployment, build separate targets:

```bash
docker build --target gateway-runtime -t opg-gateway:local .
docker build --target web-runtime -t opg-web:local .
```

### Method 4: Source Development Server

Use this when developing OPG itself. Prepare PostgreSQL and Redis first, then provide connection settings following the `services/gateway` environment contract.

```bash
git clone https://github.com/Jamailar/OPG_system.git
cd OPG_system
npm install

# Terminal 1
npm run gateway:dev

# Terminal 2
npm run web:dev
```

### Connect A User Project

```bash
npx -y @jamba/opg-cli init --base-url http://localhost:3000
npx -y @jamba/opg-cli login
npx -y @jamba/opg-cli app create --kind website --name "Your App" --slug your-app
npx -y @jamba/opg-cli login --app your-app
npx -y @jamba/opg-cli codex install
```

In production, replace `--base-url` with your OPG Gateway domain, for example `https://api.example.com`. The CLI binds the current project to an OPG app, then Codex/MCP/SDK access the same backend capabilities through that authorization.

Cold start keeps environment variables intentionally small: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET_KEY`, `PLATFORM_SECRETS_KEY`, `NODE_ENV`, and `PORT`. Business configuration such as payments, object storage, email, OAuth, AI tuning, domains, and CORS should be configured through the admin UI and database-backed runtime settings.

## Product Positioning

OPG covers the common backend capabilities needed by an app so the operator can spend time on product, content, growth, and business rules instead of repeatedly building auth, uploads, AI routing, video jobs, payment callbacks, SMS/email, audit logs, and admin tooling.

The CLI is the first integration surface. Human users and AI agents can use `@jamba/opg-cli` to create apps, log in, read manifests, run smoke tests, query database workspaces, submit AI/video jobs, inspect usage, and manage platform settings. Codex can install an MCP profile through `opg codex install`. Claude Code, Hermes, OpenClaw, and any tool that supports command-line execution, stdio MCP, OpenAPI, or the TypeScript SDK can connect to the same OPG backend without being tied to one agent client.

Core backend coverage:

| Backend capability | OPG coverage | What users avoid rebuilding |
| --- | --- | --- |
| 🔐 Accounts and permissions | Users, tenants, platform admins, app admins, API keys, Developer Grants | Login, JWT, permission matrices, and tenant isolation |
| ⚙️ Runtime settings and providers | Runtime Settings, OAuth, object storage, AI, SMS, email, payments, outbound proxy IPs | Business config scattered across env files and code |
| 🤖 AI and agents | OpenAI/Gemini-compatible APIs, model routing, provider health, cost ledger, agent run entrypoints | Provider wrappers and usage billing for every app |
| 🎬 Video and long-running jobs | Text-to-video, image-to-video, result proxying, async task queries | Long video work inside synchronous business APIs |
| 🗂️ Storage and uploads | File/image upload, object storage providers, presigned URLs, site assets | Upload pipelines, ownership, and permission boundaries |
| 💳 Payments and entitlements | Payment methods, orders, callbacks, Apple IAP, product redemption, entitlement grants | Payment state machines and server-side entitlement checks |
| ✉️ Messaging and notifications | SMS providers, signatures, templates, email providers, delivery events | Provider integration and failure tracking |
| 📊 Data and operations | Database workspace, behavior analytics, acquisition, discovery, platform analytics | Admin queries, operating metrics, and app data entrypoints |
| 🔎 Observability and audit | Request events, audit events, readiness, AI request events, provider health | Guessing from logs instead of querying audit truth |

## System Architecture

```mermaid
flowchart LR
  Apps["User apps / business admins"]
  Agents["Codex / Claude Code / MCP tools"]
  Web["apps/web<br/>Platform admin console"]
  CLI["packages/cli<br/>opg CLI / MCP server"]
  SDK["packages/sdk<br/>opg-sdk"]
  Gateway["services/gateway<br/>NestJS API gateway"]
  DB[("PostgreSQL<br/>accounts / config / jobs / ledger / audit")]
  Redis[("Redis<br/>queues / cache / rate limits / realtime")]
  Storage[("Object Storage<br/>assets / results / public resources")]
  Providers["Provider SDK/API<br/>AI / video / SMS / email / payments / OAuth"]

  Apps --> SDK
  Agents --> CLI
  Web --> Gateway
  CLI --> Gateway
  SDK --> Gateway
  Gateway --> DB
  Gateway --> Redis
  Gateway --> Storage
  Gateway --> Providers
```

```text
apps/web
  Platform admin console
    Overview
    Tenant apps
    Tenant workspace
    AI Playground / providers / models / usage statistics
    Agents
    Login credentials
    Outbound proxy IPs
    Payment methods
    SMS services
    Email services
    Object storage
    Jobs
    Developer grants
    Observability
    Shared API list

services/gateway
  NestJS API gateway
    Platform admin APIs
    Tenant app APIs
    OpenAI/Gemini-compatible APIs
    SDK / Codex / MCP integration APIs
    healthz / readyz / observability

packages/sdk
  opg-sdk for user apps and agents

packages/cli
  @jamba/opg-cli for project init, smoke tests, platform operations, Codex MCP install, and stdio MCP server

Infrastructure
  PostgreSQL: accounts, tenants, settings, jobs, ledgers, audit truth
  Redis: queues, cache, rate limits, realtime event fanout
  Object Storage: user assets, AI inputs, video results, public resources
  Provider SDK/API: AI, video, SMS, email, payments, OAuth, proxy checks
```

Recommended system shape:

| Option | Strength | Cost | Decision |
| --- | --- | --- | --- |
| OPG control-plane monorepo | Fits a one-person company; multi-app operations, AI, video, billing, and ops are in one place; release overhead stays low | Requires strict module contracts and commit boundaries | Recommended |
| Multi-repo microservices | Clear team ownership boundaries | Expensive to maintain, deploy, and debug alone | Not recommended yet |
| Single full-stack app | Fast initial bootstrapping | Multi-app isolation, long jobs, provider governance, and audit become messy | Not recommended |

## Feature Modules

### 1. Platform Admin Console

The super-admin operations console lives under `apps/web/src/pages/platform`.

Main pages:

- `Overview`: app count, enabled status, domain count, observability events, failed requests, slow requests, and recent errors.
- `Tenant Apps`: manage platform apps and enter a tenant workspace.
- `Tenant Workspace`: app profile, tenant details, API docs, AI usage, products/entitlements, payments, and business settings.
- `AI`: Playground, providers, models, and usage statistics.
- `Agents`: platform-level agent definitions, run entrypoints, and tenant publishing relationships.
- `Login Credentials`: WeChat, GitHub, Google, and other OAuth/Open Platform credentials.
- `Outbound Proxy IPs`: proxy config, health checks, and business bindings.
- `Payment Methods`: Alipay, WeChat Pay, and other provider keys and test flows.
- `SMS Services`: SMS providers, signatures, templates, and delivery events.
- `Email Services`: Cloudflare Email/SMTP provider config and delivery batches.
- `Object Storage`: OSS, S3, R2 providers, default provider, and connection tests.
- `Jobs`: platform async jobs, status, and execution records.
- `Developer Grants`: SDK, Codex, and local developer authorization scopes.
- `Observability`: request events, audit events, schema readiness, and error distribution.
- `Shared API List`: backend endpoints, descriptions, and integration entrypoints.

Implementation:

- UI uses Vite, React, and React Router, reusing `PlatformLayout` and existing list/detail/form styles.
- UI is an operations surface, not the place where third-party provider secrets are directly bound.
- High-risk actions need confirmation, such as deleting an app, rotating keys, deleting a provider, or cancelling a job.
- UI additions should stay conservative and live inside existing pages when possible.

### 2. Apps, Tenants, Users, And Permissions

This module owns multi-app, multi-tenant, multi-admin, and end-user identity boundaries.

Backend modules:

- `auth`: login, JWT, Apple login, email verification, account binding, iOS App Attest.
- `users`: user profiles, user lists, end-user queries, and management.
- `platform-admin`: platform admin APIs, app management, tenant workspaces, platform analytics, and config aggregation.
- `api-keys` / `developer-sdk`: platform Developer Grants, compatible app API keys, SDK auth, and agent access auth.

Implementation:

- Use existing libraries: `@nestjs/jwt`, `passport-jwt`, `bcrypt`, `jose`.
- Build in-house: app/tenant/environment context, platform admin permissions, app namespace validation, resource ownership validation.
- Developer Grants and API keys only store hashes; plaintext is returned only once during creation.
- Platform admins and app admins are separate. Platform admin APIs require `SUPER_ADMIN`; business admin APIs require the current app admin identity.

### 3. Runtime Settings And Provider Configuration

This module moves business configuration out of environment variables and into the database-backed admin control plane.

Current capabilities:

- Public runtime config: `/runtime-config` exposes non-secret frontend config.
- Admin runtime config: session policy, payment scheduler, AI tuning, OAuth, and integration settings.
- Storage provider config: object storage providers, default provider, and connectivity tests.
- SMTP provider config: sender mailbox, default provider, and connectivity tests.
- Platform API keys: create, list, revoke, and scope checks.

Implementation:

- Backend module: `runtime-settings`.
- Business secrets are encrypted in the database and depend on `PLATFORM_SECRETS_KEY`.
- Required cold-start env: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET_KEY`, `PLATFORM_SECRETS_KEY`, `NODE_ENV`, `PORT`.
- Payments, object storage, email, OAuth, AI tuning, domains, and CORS should be UI + DB driven.

### 4. AI Gateway

The AI Gateway is the unified entrypoint for text, image, audio, video, and agent-oriented AI capabilities.

Current capabilities:

- OpenAI-compatible APIs: `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/images/*`, `/v1/audio/*`, `/v1/videos/*`.
- Gemini-compatible APIs: `/v1beta/models`, `generateContent`, `streamGenerateContent`, `embedContent`.
- Tenant APIs: model list, default model, pricing, capability calls, and history by app slug.
- Platform admin: AI sources, models, routes, pricing, Playground, usage statistics.
- Routing governance: choose providers by app, source, model, and capability.
- Cost governance: usage queue, point deduction, model pricing, call logs.
- Health governance: provider health, error attribution, rate limits, scheduler, fallback.
- Audit governance: source/model/route changes write redacted audit events.

Implementation:

- Backend module: `ai-chat`.
- Use existing libraries or stable HTTP clients for provider APIs such as OpenAI, Anthropic, Google, DashScope, and OpenRouter.
- Build in-house: provider adapters, model routing, key-level health state, usage ledger, point ledger, error codes, audit events, app-scoped model visibility.
- Persist key request events: route selected, upstream response/error, usage recorded, points charged.
- Logs help debugging but cannot replace audit truth.
- Frontend code must not call third-party AI providers directly.

### 5. Video Generation And Video Jobs

Video capabilities are currently contained inside the AI Gateway and use async task protocols from AI/video providers.

Current capabilities:

- Text-to-video / image-to-video: `videos/generations`, `videos/generations/async`.
- Video task queries: `videos/generations/tasks/query`.
- Result proxy: `ai-video-result-proxy` handles result URL proxying and archive boundaries.
- RunningHub / DashScope provider rules live in `runninghub.rules.ts`, `runninghub.utils.ts`, and AI routes.

Implementation:

- Use existing libraries/services: FFmpeg, Remotion, cloud media processing services, official provider APIs.
- Do not synchronously process large videos inside HTTP requests; long-running work must return a task id.
- Build in-house: asset model, task state machine, idempotent submission, provider task mapping, failure recovery, user-facing error codes, result archival, cost attribution.
- Large file inputs should use object storage presigned URLs, not video base64 inside JSON.
- Frontend should only show task status, error reason, result URL, and retry actions.

### 6. Agents, Developer SDK, CLI, And MCP

This layer exposes OPG capabilities to user projects, the CLI, coding agents, and any tool that supports MCP, OpenAPI, or SDK integration.

Current capabilities:

- `opg-sdk`: runtime client for manifest, AI, agents, upload, video, usage, and database workspace.
- `@jamba/opg-cli`: project init, browser login, app creation, platform config, smoke tests, database workspace, Codex MCP install, stdio MCP server.
- Backend SDK APIs: `/:app/v1/sdk/manifest`, `openapi.json`, examples, smoke-test, install-profile, database workspace.
- MCP tools: manifest, AI models, agent run, video submit/query, recent usage, database query/execute.
- Agent compatibility: Codex can install local MCP; Claude Code, Hermes, OpenClaw, and other tools can reuse `opg mcp`, `opg` CLI, OpenAPI, or `opg-sdk`.
- Database workspace: only the current app namespace is allowed, for example `app_<app_slug>__*`; writes default to dry-run.

Implementation:

- Backend modules: `developer-sdk`, `ai-agents`.
- SDK, CLI, and MCP depend only on the stable contract exposed by `/sdk/manifest`.
- The CLI is the shared operating surface for humans and agents. New backend capabilities should usually update the manifest, SDK methods, CLI commands, and MCP tools before adding only a platform UI.
- The database proxy never exposes `DATABASE_URL`.
- SQL query is limited to `SELECT` / `WITH` and results are truncated. Execute defaults to transaction rollback; real writes require `confirm=apply:<app-slug>`.
- All database mutations write audit events.

### 7. Payments, Products, And Entitlements

This module owns payment flows, product redemption, IAP verification, and entitlement grants.

Current capabilities:

- Platform payment method config for Alipay, WeChat Pay, and other providers.
- Apple IAP receipt verification and payment status handling.
- Payment orders: create, query, callback, state sync.
- Product redemption: public product query, redemption code/product entitlement grants.
- Tenant workspace pages for products, plans, entitlements, and payment config.

Implementation:

- Backend modules: `payments`, `redeem`.
- Use existing libraries/official APIs: payment provider SDKs and Apple App Store Server API / receipt verification libraries.
- Build in-house: order state machine, entitlement grant flow, callback idempotency, usage ledger, payment audit, product-to-app/tenant binding.
- Entitlements must be enforced server-side, not by hiding buttons in the frontend.

### 8. Uploads, Storage, And Tenant Sites

This module owns file uploads, asset management, public site settings, and object storage boundaries.

Current capabilities:

- Upload module: file upload, image upload, business attachment entrypoints.
- Storage providers: provider management, default provider, and connection tests.
- Tenant sites: public site config, domains, page assets, and site queries.
- AI/video I/O: user assets, generated results, and public resources are saved through object storage.

Implementation:

- Backend modules: `upload`, `tenant-site`, `runtime-settings`.
- Use existing libraries: S3/R2/OSS SDKs, MIME detection, image processing libraries, multipart upload.
- Build in-house: bucket permissions, file metadata, quota, lifecycle strategy, site asset ownership, app/tenant isolation.
- Large files should upload directly to object storage; backend signs requests and records source-of-truth metadata.

### 9. Messaging: SMS, Email, And Notifications

This module owns platform-level messaging provider config, templates, and delivery events.

Current capabilities:

- SMS provider catalog: Aliyun, Tencent Cloud, Volcengine, Vonage, Generic HTTP.
- SMS signatures, templates, provider tests, and delivery events.
- Email providers: Cloudflare Email / SMTP config, test sends, and batch delivery records.

Implementation:

- Backend modules: `sms`, `email-delivery`.
- Use existing libraries/official APIs: Nodemailer, Cloudflare Email API, SMS provider SDKs, or signed HTTP clients.
- Build in-house: provider adapters, template variable validation, signature/template binding, send status, retry, cost records, audit.
- Sends should enter a queue or batch state instead of blocking the UI for long requests.

### 10. Outbound Proxy, Acquisition, Discovery, And Analytics

This module owns outbound network capability, acquisition flows, discovery entrypoints, and operating analytics.

Current capabilities:

- Outbound proxy: proxy config, checks, encrypted config, health status.
- Acquisition: channels, user source, invite/register flows, admin management.
- Discovery: public discovery APIs.
- Behavior analytics: behavior event aggregation.
- Platform analytics: tenant app metrics, aggregate cache, schema health, source table status.

Implementation:

- Backend modules: `outbound-proxy`, `acquisition`, `discovery`, `behavior-analytics`, `platform-admin`.
- Use existing libraries: HTTP clients, proxy agents, encryption libraries, database aggregation.
- Build in-house: encrypted proxy provider config, check results, attribution, analytics fact tables, cache strategy, admin query models.
- Analytics pages read aggregate tables or cache, not large raw event tables directly.

### 11. Observability, Audit, And Readiness

This module owns system-level debugging, audit truth, and deployment health checks.

Current capabilities:

- `LoggingInterceptor` records request context.
- `platform_request_events` stores request events.
- `platform_audit_events` stores write-operation audit events.
- AI domain stores `ai_provider_health`, `ai_gateway_request_events`, and `ai_audit_events`.
- `/healthz` provides liveness.
- `/readyz` and `/api/v1/readyz` provide DB/schema readiness.
- Platform admin can inspect observability runtime, error events, slow requests, and module distribution.

Implementation:

- Backend modules: `observability`, `ai-chat`.
- Build in-house: request id / trace id, low-signal path filtering, module attribution, redacted metadata, before/after hashes, retention strategy.
- Logs may be sampled, but write-operation audit events must not be skipped by sampling.
- Audit events must not store plaintext secrets, large payloads, or direct sensitive personal information.

## Project Structure

```text
.
├── apps/
│   └── web/                 # Platform admin frontend
├── services/
│   └── gateway/             # API gateway backend
├── docs/
│   ├── ARCHITECTURE.md      # Product architecture and implementation boundaries
│   └── ENVIRONMENT_CONTROL_PLANE.md
├── protocols/
│   ├── README.md            # Protocols, contracts, and engineering constraints
│   ├── app-registry.md      # Apps, environments, tenants, and API keys
│   ├── developer-sdk.md     # SDK, CLI, and Codex MCP integration contract
│   ├── permissions.md       # Users, teams, roles, and resource authorization
│   ├── storage.md           # Buckets, files, signed URLs, and quota
│   ├── jobs.md              # Long jobs, triggers, retries, and idempotency
│   ├── realtime-events.md   # Realtime events and subscription auth
│   ├── usage-ledger.md      # Usage, cost, and ledger events
│   └── runtime-settings.md  # Minimal env and admin-managed config
├── packages/
│   ├── sdk/                 # opg-sdk runtime client
│   └── cli/                 # @jamba/opg-cli project init, platform operations, MCP server
├── LICENSE
├── package.json
├── README.md
└── README.en.md
```

## Local Development And Integration

Frontend:

```bash
npm install --prefix apps/web
npm run web:dev
```

Backend:

```bash
npm install --prefix services/gateway
npm run gateway:dev
```

SDK / CLI:

```bash
npm run sdk:build
npm run cli:build
```

User project integration:

```bash
npm install opg-sdk
npx -y @jamba/opg-cli init --base-url https://api.example.com
npx -y @jamba/opg-cli login
npx -y @jamba/opg-cli app create --kind website --name "Your App" --slug your-app
npx -y @jamba/opg-cli login --app your-app
npx -y @jamba/opg-cli codex install
```

`opg login` opens the browser authorization page and first saves a global platform login. Users can create an app before they have an app-scoped credential. After the app is created, `opg login --app your-app` creates an app-scoped Developer Grant and saves local SDK credentials to `.opg/credentials.json`. Grants are managed in the platform admin under Developer Grants by app and scope. The local credential file is ignored by git and must not be committed.

Common CLI operations:

```bash
npx -y @jamba/opg-cli manifest
npx -y @jamba/opg-cli smoke
npx -y @jamba/opg-cli db manifest
npx -y @jamba/opg-cli db tables
npx -y @jamba/opg-cli db query --sql "SELECT * FROM app_your_app__customers"
npx -y @jamba/opg-cli platform apps list
npx -y @jamba/opg-cli platform runtime get
```

Codex uses `.opg/codex-mcp.json`. Other agent tools can call the `opg` command directly. If the tool supports MCP, point its MCP server to:

```bash
npx -y @jamba/opg-cli mcp
```

If a tool is better suited for code integration, use `opg-sdk`. If it is better suited for HTTP integration, read the backend `openapi.json` and `/:app/v1/sdk/manifest`.

SDK database capabilities go through a controlled backend proxy and never expose `DATABASE_URL`. AI agents can only operate on tables under the current app namespace, for example `app_your_app__customers`. Writes default to dry-run and require `confirm=apply:<app-slug>` for real execution.

After the backend is deployed, CI can validate the SDK database path with explicit env values. Prefer `opg_dev_` Developer Grants; old `rbx_` app keys remain compatibility-only:

```bash
OPG_BASE_URL=https://api.example.com OPG_APP_SLUG=your-app OPG_API_KEY=opg_dev_xxx npm run sdk:db:smoke
```

Real secrets do not belong in the repository. When env values are needed, copy each subproject's `.env.example` to a local `.env`.

## Release And Docker Images

OPG uses module-level SemVer and tag-based releases. Release Docker images are built by GitHub Actions after a tag push.

| Tag | Version source | Artifacts |
| --- | --- | --- |
| `opg-system/vX.Y.Z` | Root `package.json` | `ghcr.io/<owner>/opg-system`, `opg-system-gateway`, `opg-system-web` |
| `opg-gateway/vX.Y.Z` | `services/gateway/package.json` | `ghcr.io/<owner>/opg-system-gateway` |
| `opg-web/vX.Y.Z` | `apps/web/package.json` | `ghcr.io/<owner>/opg-system-web` |
| `opg-sdk/vX.Y.Z` | `packages/sdk/package.json` | `opg-sdk` npm package |
| `opg-cli/vX.Y.Z` | `packages/cli/package.json` | `@jamba/opg-cli` npm package |

Prepare a version:

```bash
npm run release:bump -- system minor
git add package.json package-lock.json
git commit -m "chore(release): release 0.2.0"
git tag opg-system/v0.2.0
git push origin main opg-system/v0.2.0
```

Run a single-container image:

```bash
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://opg:password@postgres.example.com:5432/opg' \
  -e REDIS_URL='redis://redis.example.com:6379/0' \
  -e JWT_SECRET_KEY='replace-with-long-random-secret' \
  -e PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
  ghcr.io/<owner>/opg-system:0.2.0
```

See [docs/RELEASE.md](docs/RELEASE.md) for the full release flow and [docs/DOCKER_DEPLOYMENT.md](docs/DOCKER_DEPLOYMENT.md) for Docker deployment.

## Build Vs Buy Boundaries

Use existing libraries or official SDKs for:

- JWT, OAuth, password hashing, signature verification.
- Prisma / PostgreSQL migrations.
- Redis, queues, cache, and rate limits.
- Object Storage SDKs and multipart upload.
- AI provider SDKs or stable HTTP clients.
- FFmpeg, Remotion, and cloud media processing.
- Payment, SMS, email, and push provider SDKs.
- OpenTelemetry, log collection, and error tracking.

Build in-house:

- App, tenant, and environment control plane.
- Permission matrix, tenant context, and app namespace validation.
- Module registry protocol and SDK manifest contract.
- AI/video provider adapters, routing, health state, and cost attribution.
- Long-running task state machine, idempotent submission, failure recovery, and user-facing error codes.
- Usage ledger, point ledger, billing aggregation, and entitlement grants.
- Platform request/audit events and redacted audit metadata.
- Platform admin information architecture and operations workflows.

## Performance Strategy

- Keep API, worker, and realtime processes stateless. Persist state in PostgreSQL, Redis, and Object Storage.
- Put all AI, video, messaging, webhooks, and bulk sync work into queues. HTTP requests should create jobs and return task ids.
- Add composite indexes by `appId`, `tenantId`, `createdAt`, and `status`.
- Keep usage, audit, and request events append-only. Admin reports should read aggregate tables, materialized views, or cache.
- Upload large files directly to object storage. Avoid proxying large uploads through the backend.
- Realtime events should push status summaries, not large payloads.
- Provider adapters should enforce concurrency limits, circuit breakers, retries, and cost caps by app, provider, and model.
- Admin lists must enforce pagination, field projection, and stable sorting.
- SDK query/execute should set statement timeouts, row limits, and dry-run defaults.
- AI model pricing, provider catalog, and public manifests can use short-lived cache. Secret status and audit results must not be publicly cached.

## Documentation

- Product architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Release flow: [docs/RELEASE.md](docs/RELEASE.md)
- Docker deployment: [docs/DOCKER_DEPLOYMENT.md](docs/DOCKER_DEPLOYMENT.md)
- Environment control plane: [docs/ENVIRONMENT_CONTROL_PLANE.md](docs/ENVIRONMENT_CONTROL_PLANE.md)
- Protocol index: [protocols/README.md](protocols/README.md)
- Developer SDK: [protocols/developer-sdk.md](protocols/developer-sdk.md)
- Backend module index: [services/gateway/docs/modules/README.md](services/gateway/docs/modules/README.md)
- Gateway guide: [services/gateway/README.md](services/gateway/README.md)
- Frontend guide: [apps/web/README.md](apps/web/README.md)
- SDK package guide: [packages/sdk/README.md](packages/sdk/README.md)
- CLI package guide: [packages/cli/README.md](packages/cli/README.md)

## License

This project uses the PolyForm Noncommercial License 1.0.0. The source can be viewed, modified, and redistributed for noncommercial use only. Commercial use requires separate authorization.

## Engineering Constraints

- Atomic Commits: one commit does one thing.
- UI additions should stay conservative and reuse existing pages/components first.
- Cross-module behavior must be captured in protocols before implementation.
- Secrets, build artifacts, and dependency directories must not be committed.

## Links

- [LinuxDo](https://linux.do)
- [Jamailar](https://github.com/Jamailar)
- [taichuy/1flowbase](https://github.com/taichuy/1flowbase)
