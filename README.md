<p align="center">
  <img src="https://raw.githubusercontent.com/Jamailar/OPG/main/docs/assets/opg-system-preview.png" alt="OPG System Preview" width="860">
</p>

<h1 align="center">一人集团系统</h1>

<p align="center">
  面向一人公司的 app 后端集群控制平面，把认证、租户、配置、AI、视频、支付、用量、审计和开发者接入收进同一套前后端分离 monorepo。
</p>

<p align="center">
  <a href="docs/ARCHITECTURE.md">产品架构</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="protocols/README.md">协议</a> ·
  <a href="packages/cli/README.md">CLI</a> ·
  <a href="docs/DOCKER_DEPLOYMENT.md">Docker</a>
</p>

<p align="center">
  简体中文 · <a href="README.en.md">English</a>
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

一人集团系统是一个前后端分离的 app 后端集群控制平面，目标是让一人公司能快速搭建多个 app 的认证、租户、配置、AI、视频、消息、支付、用量、审计和开发者接入能力，少重复造后端。

OPG 不追求做通用后端平台。产品核心是面向一人公司的多 app 运营后台、AI/视频供应商治理、成本账本和 agent 友好的开发者接口。

## Contents

- [Quickstart](#quickstart)
- [核心定位](#核心定位)
- [系统架构](#系统架构)
- [功能模块](#功能模块)
- [目录结构](#目录结构)
- [本地启动与接入细节](#本地启动与接入细节)
- [发布与 Docker 镜像](#发布与-docker-镜像)
- [实现分工](#实现分工)
- [性能策略](#性能策略)
- [文档导航](#文档导航)

## Quickstart

优先选择 Docker 部署。源码启动主要用于开发 OPG 本身，不建议作为普通用户的第一种部署方式。

| 方式 | 推荐场景 | 构建来源 | 依赖 |
| --- | --- | --- | --- |
| 直接拉 Docker 镜像 | 试用、生产、交给用户部署 | GHCR 发布镜像 | 外部 PostgreSQL / Redis，或配合 `docker-compose.release.yml` 启动 |
| 克隆源码 + Docker Compose | 本机试用、私有化部署、需要一起启动 PostgreSQL/Redis | 本地 Dockerfile | Docker / Docker Compose |
| 克隆源码 + Dockerfile | 自己接外部数据库、云平台构建、Coolify/Render/Railway 等 | 本地 Dockerfile target | 外部 PostgreSQL / Redis |
| 源码 dev 启动 | 开发 OPG、调试前后端 | Node.js workspace | Node.js 22+、PostgreSQL、Redis |

### 方式一：直接拉 Docker 镜像（推荐）

如果已有 PostgreSQL 和 Redis，直接运行发布版单容器镜像。单容器镜像包含 Gateway API 和 Web 管理后台，统一暴露 `3000` 端口。

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

如果希望应用、PostgreSQL、Redis 一起由 Compose 编排，使用发布版 Compose 文件：

```bash
git clone https://github.com/Jamailar/OPG_system.git
cd OPG_system

OPG_IMAGE=ghcr.io/jamailar/opg-system:latest \
JWT_SECRET_KEY='replace-with-long-random-secret' \
PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
POSTGRES_PASSWORD='replace-with-strong-password' \
docker compose -f docker-compose.release.yml up -d
```

启动后访问：

```bash
open http://localhost:3000
```

### 方式二：克隆源码，用 Docker Compose 构建

适合本机完整试用或私有化部署。Compose 会从当前源码构建 `opg-all`，并同时启动 PostgreSQL 和 Redis。

```bash
git clone https://github.com/Jamailar/OPG_system.git
cd OPG_system

JWT_SECRET_KEY='replace-with-long-random-secret' \
PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
POSTGRES_PASSWORD='replace-with-strong-password' \
docker compose up -d --build
```

修改宿主机端口：

```bash
OPG_PORT=8080 docker compose up -d --build
```

### 方式三：克隆源码，用 Dockerfile 构建单镜像

适合云平台构建或接入外部数据库/Redis。默认推荐 `opg-all` target，它把 Gateway API 和 Web 静态资源打进同一个应用镜像。

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

需要前后端分离部署时，构建独立 target：

```bash
docker build --target gateway-runtime -t opg-gateway:local .
docker build --target web-runtime -t opg-web:local .
```

### 方式四：源码开发启动

适合开发 OPG 本身。启动前需要准备 PostgreSQL、Redis，并按 `services/gateway` 的环境变量约定提供连接信息。

```bash
git clone https://github.com/Jamailar/OPG_system.git
cd OPG_system
npm install

# Terminal 1
npm run gateway:dev

# Terminal 2
npm run web:dev
```

### 接入用户项目

```bash
npx -y @jamba/opg-cli init --base-url http://localhost:3000
npx -y @jamba/opg-cli login
npx -y @jamba/opg-cli app create --kind website --name "Your App" --slug your-app
npx -y @jamba/opg-cli login --app your-app
npx -y @jamba/opg-cli codex install
```

生产环境把 `--base-url` 换成你的 OPG Gateway 域名，例如 `https://api.example.com`。CLI 会把当前项目绑定到 OPG app，后续 Codex/MCP/SDK 都通过这个授权访问同一套后端能力。

冷启动只保留极少环境变量：`DATABASE_URL`、`REDIS_URL`、`JWT_SECRET_KEY`、`PLATFORM_SECRETS_KEY`、`NODE_ENV`、`PORT`。支付、对象存储、邮件、OAuth、AI 调优、域名、CORS 等业务配置优先走管理后台和数据库。

## 核心定位

OPG 要覆盖 app 后端的常用能力，让使用者把精力放在产品、内容、增长和业务规则上，而不是反复搭认证、上传、AI 代理、视频任务、支付回调、短信邮件、审计日志和管理后台。

接入方式以 CLI 为第一入口。用户和 AI agent 都可以直接通过 `@jamba/opg-cli` 操作后端：创建 app、登录授权、读取 manifest、跑 smoke test、查询数据库工作区、提交 AI/视频任务、查看用量和管理平台配置。Codex 可通过 `opg codex install` 生成 MCP 配置；Claude Code、Hermes、OpenClaw 等主流 agent 工具，以及任何支持命令行、stdio MCP、OpenAPI 或 TypeScript SDK 的 AI 工具，都可以接入同一套 OPG 后端能力，不绑定某一个 agent 客户端。

能力覆盖按完整 app 后端来设计：

| 后端能力 | OPG 覆盖范围 | 使用者少做什么 |
| --- | --- | --- |
| 🔐 账号与权限 | 用户、租户、平台管理员、app 管理员、API key、Developer Grant | 不重复搭登录、JWT、权限矩阵和租户隔离 |
| ⚙️ 配置与供应商 | Runtime Settings、OAuth、对象存储、AI、短信、邮件、支付、代理 IP | 不把业务配置散落在 env 和代码里 |
| 🤖 AI 与 Agent | OpenAI/Gemini 兼容 API、模型路由、provider 健康、成本账本、agent 运行入口 | 不重复封装多家 AI provider 和用量计费 |
| 🎬 视频与长任务 | 文生视频、图生视频、结果代理、异步任务查询 | 不在业务 API 里硬塞长耗时视频处理 |
| 🗂️ 存储与上传 | 文件上传、图片上传、对象存储 provider、presigned URL、站点资源 | 不重复做上传链路、文件归属和权限边界 |
| 💳 支付与权益 | 支付方式、订单、回调、Apple IAP、产品兑换、权益授予 | 不重复写支付状态机和服务端权益校验 |
| ✉️ 消息与通知 | 短信 provider、签名、模板、邮件 provider、发送事件 | 不重复接短信邮件供应商和失败追踪 |
| 📊 数据与运营 | 数据库工作区、行为分析、获客、发现、平台分析 | 不重复搭后台查询、运营指标和 app 数据入口 |
| 🔎 可观测与审计 | request events、audit events、readyz、AI request events、provider health | 不靠日志猜问题，有可查询的审计真值 |

## 系统架构

```mermaid
flowchart LR
  Apps["用户 app / 业务后台"]
  Agents["Codex / Claude Code / MCP 工具"]
  Web["apps/web<br/>平台管理后台"]
  CLI["packages/cli<br/>opg CLI / MCP server"]
  SDK["packages/sdk<br/>opg-sdk"]
  Gateway["services/gateway<br/>NestJS API 网关"]
  DB[("PostgreSQL<br/>账号 / 配置 / 任务 / 账本 / 审计")]
  Redis[("Redis<br/>队列 / 缓存 / 限流 / 实时事件")]
  Storage[("Object Storage<br/>素材 / 结果 / 公开资源")]
  Providers["Provider SDK/API<br/>AI / 视频 / 短信 / 邮件 / 支付 / OAuth"]

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
  平台管理后台
    平台概览
    租户应用
    租户工作区
    AI Playground / 供应商 / 模型 / 调用统计
    Agent
    登录凭证
    代理 IP
    支付方式
    短信服务
    邮件服务
    对象存储
    Jobs
    开发者授权
    可观测性
    共享 API 列表

services/gateway
  NestJS API 网关
    平台管理 API
    租户 app API
    OpenAI/Gemini 兼容 API
    SDK / Codex / MCP 接入 API
    healthz / readyz / observability

packages/sdk
  opg-sdk，给用户 app 和 agent 调用 OPG 能力

packages/cli
  @jamba/opg-cli，负责项目初始化、smoke test、平台操作、Codex MCP 安装和通用 stdio MCP server

Infrastructure
  PostgreSQL：账户、租户、配置、任务、账本、审计真值
  Redis：队列、缓存、限流、实时事件 fanout
  Object Storage：用户素材、AI 输入、视频结果、公开资源
  Provider SDK/API：AI、视频、短信、邮件、支付、OAuth、代理检测
```

推荐继续使用当前 monorepo 方案：

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| OPG 控制平面 monorepo | 贴合一人公司，多 app、AI、视频、计费、运维入口集中，发布成本低 | 需要严格定义模块协议和提交边界 | 推荐 |
| 多 repo 微服务 | 团队边界清楚 | 一人维护、部署和联调成本高 | 暂不推荐 |
| 单体全栈 | 启动快 | 多 app 隔离、长任务、供应商治理和审计容易混乱 | 不推荐 |

## 功能模块

### 1. 平台管理后台

面向超级管理员的运营控制台，入口在 `apps/web/src/pages/platform`。

主要页面：

- `平台概览`：展示 app 数量、启用状态、域名数量、可观测事件、失败请求、慢请求和最近错误。
- `租户应用`：管理平台内 app，进入单个 app 的租户工作区。
- `租户工作区`：管理 app 资料、租户信息、API 文档、AI 用量、产品/权益、支付和业务配置。
- `AI`：包含 Playground、供应商、模型和调用统计。
- `Agent`：管理平台级 agent 定义、运行入口和租户发布关系。
- `登录凭证`：统一维护微信、GitHub、Google 等 OAuth / Open Platform 凭证。
- `代理 IP`：管理出站代理、健康检测和业务绑定。
- `支付方式`：维护支付宝、微信等支付密钥和链路测试。
- `短信服务`：维护短信供应商、签名、模板和发送事件。
- `邮件服务`：维护 Cloudflare Email / SMTP 等发件配置和发送批次。
- `对象存储`：维护 OSS、S3、R2 供应商、默认 provider 和连接测试。
- `Jobs`：查看平台异步任务、状态和执行记录。
- `开发者授权`：管理 SDK、Codex 和本地开发工具的授权范围。
- `可观测性`：查看平台请求事件、审计事件、schema readiness 和错误分布。
- `共享 API 列表`：把后端端点、中文说明和联调入口集中展示。

实现边界：

- UI 使用 Vite + React + React Router，复用 `PlatformLayout` 和现有列表/详情/表单样式。
- UI 只负责运维入口和状态展示，不直接绑定第三方 provider 密钥。
- 高风险动作必须二次确认，例如删除 app、轮换 key、删除 provider、取消任务。
- UI 加法保持克制，优先把入口放进已有页面，不新增解释型大页面。

### 2. App / 租户 / 用户 / 权限

负责多 app、多租户、多管理员和终端用户身份边界。

后端模块：

- `auth`：登录、JWT、Apple 登录、邮箱验证、账号绑定、iOS App Attest。
- `users`：用户资料、用户列表、终端用户查询和管理。
- `platform-admin`：平台管理员 API、app 管理、租户工作区、平台分析和配置聚合。
- `api-keys` / `developer-sdk`：平台 developer grant、兼容 app API key、SDK 鉴权、agent 接入鉴权。

实现方式：

- 必须使用现成库：`@nestjs/jwt`、`passport-jwt`、`bcrypt`、`jose`。
- 自研部分：app/tenant/environment 上下文、平台管理员权限、app namespace 校验、资源 owner 校验。
- Developer grant 和 API key 只保存 hash，明文只在创建时返回一次。
- 平台管理员和 app 管理员分离；平台后台要求 `SUPER_ADMIN`，业务后台要求当前 app 管理员身份。

### 3. Runtime Settings / Provider 配置

负责把业务配置从环境变量迁入数据库和管理后台。

当前能力：

- 公开运行时配置：`/runtime-config` 给前端读取非密钥配置。
- 管理员运行时配置：session policy、支付调度、AI 调优、OAuth、集成配置。
- 存储 provider 配置：对象存储 provider、默认 provider、连通性测试。
- SMTP provider 配置：发件邮箱、默认 provider、连通性测试。
- 平台 API key：创建、列出、撤销和 scope 校验。

实现方式：

- 后端模块：`runtime-settings`。
- 业务密钥加密入库，依赖 `PLATFORM_SECRETS_KEY`。
- 冷启动必须保留的 env：`DATABASE_URL`、`REDIS_URL`、`JWT_SECRET_KEY`、`PLATFORM_SECRETS_KEY`、`NODE_ENV`、`PORT`。
- 支付、对象存储、邮件、OAuth、AI 调优、域名、CORS 等业务配置优先走 UI + DB。

### 4. AI Gateway

负责文本、图片、语音、视频等 AI 能力的统一入口。

当前能力：

- OpenAI 兼容 API：`/v1/chat/completions`、`/v1/responses`、`/v1/embeddings`、`/v1/images/*`、`/v1/audio/*`、`/v1/videos/*`。
- Gemini 兼容 API：`/v1beta/models`、`generateContent`、`streamGenerateContent`、`embedContent`。
- 租户 API：按 app slug 暴露模型列表、默认模型、价格、能力调用、历史记录。
- 平台管理：AI source、model、route、pricing、Playground、usage 统计。
- 路由治理：按 app、source、model、capability 选择 provider。
- 成本治理：usage queue、积分扣减、模型价格、调用日志。
- 健康治理：provider health、错误归因、限流、scheduler、fallback。
- 审计治理：source/model/route 配置变更写脱敏审计事件。

实现方式：

- 后端模块：`ai-chat`。
- 必须使用现成库或稳定 HTTP client：OpenAI、Anthropic、Google、DashScope、OpenRouter 等 provider API。
- 自研部分：provider adapter、模型路由、key 级健康状态、usage ledger、积分流水、错误码、审计事件、app-scoped model visibility。
- 请求链路必须持久化关键事件：route selected、upstream response/error、usage recorded、points charged。
- 日志只辅助排查，不能替代审计真值。
- 前端不得直接调用第三方 AI provider。

### 5. 视频生成与视频任务

视频能力当前收敛在 AI Gateway 内，统一使用 AI provider 或视频 provider 的异步任务协议。

当前能力：

- 文生视频 / 图生视频：`videos/generations`、`videos/generations/async`。
- 视频任务查询：`videos/generations/tasks/query`。
- 结果代理：`ai-video-result-proxy` 负责视频结果 URL 代理和归档边界。
- RunningHub / DashScope 等 provider 规则在 `runninghub.rules.ts`、`runninghub.utils.ts` 和 AI route 中维护。

实现方式：

- 必须使用现成库/服务：FFmpeg、Remotion、云媒体处理服务、provider 官方 API。
- 当前后端不应在 HTTP 请求内同步处理大视频；长任务必须异步提交，返回 task id。
- 自研部分：素材模型、任务状态机、幂等提交、provider 任务映射、失败恢复、用户可见错误码、结果归档、成本归因。
- 大文件输入应走对象存储 presigned URL，不把视频 base64 放进 JSON。
- 前端只展示任务状态、错误原因、结果地址和重试动作。

### 6. Agent / Developer SDK / CLI / MCP

负责把 OPG 能力暴露给用户项目、CLI、coding agent 和任意支持 MCP / OpenAPI / SDK 的 AI 工具。

当前能力：

- `opg-sdk`：运行时客户端，覆盖 manifest、AI、agents、upload、video、usage、database workspace。
- `@jamba/opg-cli`：初始化项目、浏览器授权登录、app 创建、平台配置、smoke test、数据库工作区、安装 Codex MCP、运行 stdio MCP server。
- 后端 SDK API：`/:app/v1/sdk/manifest`、`openapi.json`、examples、smoke-test、install-profile、database workspace。
- MCP 工具：manifest、AI models、agent run、video submit/query、usage recent、database query/execute。
- Agent 兼容：Codex 可直接安装本地 MCP；Claude Code、Hermes、OpenClaw 等工具可复用 `opg mcp`、`opg` CLI、OpenAPI 或 `opg-sdk`。
- 数据库工作台：只允许当前 app 命名空间，例如 `app_<app_slug>__*`；写操作默认 dry-run。

实现方式：

- 后端模块：`developer-sdk`、`ai-agents`。
- SDK、CLI 和 MCP 只依赖 `/sdk/manifest` 声明的稳定合同。
- CLI 是人和 agent 的共同操作面；新增后端能力应优先补 manifest、SDK 方法、CLI 命令和 MCP tool，而不是只补平台 UI。
- 数据库代理不暴露 `DATABASE_URL`。
- SQL query 限制为 `SELECT` / `WITH`，结果截断；execute 默认事务回滚，真正执行必须传 `confirm=apply:<app-slug>`。
- 所有数据库变更写入审计事件。

### 7. 支付 / 产品 / 权益

负责付费、产品兑换、IAP 校验和权益发放。

当前能力：

- 支付方式平台配置：支付宝、微信等 provider 密钥和链路测试。
- Apple IAP：票据校验和支付状态处理。
- 支付订单：创建、查询、回调、状态同步。
- 产品兑换：公开产品查询、兑换码/产品权益授予。
- 租户工作区：产品、套餐、权益和支付配置入口。

实现方式：

- 后端模块：`payments`、`redeem`。
- 必须使用现成库/官方 API：支付 provider SDK、Apple App Store Server API / receipt 校验相关库。
- 自研部分：订单状态机、权益授予链路、回调幂等、usage ledger、支付审计、产品与 app/tenant 的绑定关系。
- 权益必须服务端校验，不能只靠前端隐藏按钮。

### 8. 上传 / 存储 / 租户站点

负责文件上传、素材管理、公开站点配置和对象存储边界。

当前能力：

- 上传模块：文件上传、图片上传、业务附件入口。
- 存储 provider：对象存储页面维护供应商、默认 provider 和连接测试。
- 租户站点：公开站点配置、域名、页面资源和站点查询。
- AI/视频输入输出：通过对象存储保存用户素材、生成结果和公开访问资源。

实现方式：

- 后端模块：`upload`、`tenant-site`、`runtime-settings`。
- 必须使用现成库：S3/R2/OSS SDK、MIME 检测、图片处理库、multipart upload。
- 自研部分：bucket 权限、file metadata、quota、生命周期策略、站点资源归属和 app/tenant 隔离。
- 大文件直传对象存储，后端只签名和记录真值。

### 9. Messaging：短信 / 邮件 / 通知

负责平台级消息供应商配置、模板和发送事件。

当前能力：

- 短信 provider catalog：Aliyun、Tencent Cloud、Volcengine、Vonage、Generic HTTP。
- 短信签名、模板、provider 测试和发送事件。
- 邮件 provider：Cloudflare Email / SMTP 配置、发件测试和批次发送记录。

实现方式：

- 后端模块：`sms`、`email-delivery`。
- 必须使用现成库/官方 API：Nodemailer、Cloudflare Email API、短信 provider SDK 或签名 HTTP client。
- 自研部分：provider adapter、模板变量校验、签名/模板绑定、发送状态、失败重试、费用记录、审计。
- 发送动作应进入任务队列或批次状态，不在 UI 中做长阻塞请求。

### 10. Outbound Proxy / Acquisition / Discovery / Analytics

负责出站网络能力、获客链路、发现入口和运营分析。

当前能力：

- 出站代理：代理配置、检测、加密配置、健康状态。
- Acquisition：获客渠道、用户来源、邀请/注册链路和后台管理。
- Discovery：公开发现接口。
- Behavior analytics：行为事件聚合。
- Platform analytics：租户 app 指标、聚合缓存、schema health、source table 状态。

实现方式：

- 后端模块：`outbound-proxy`、`acquisition`、`discovery`、`behavior-analytics`、`platform-admin`。
- 必须使用现成库：HTTP client、代理 agent、加密库、数据库聚合能力。
- 自研部分：代理 provider 配置加密、检测结果、渠道归因、分析事实表、缓存策略和后台查询模型。
- 分析页面读取聚合表或缓存，不直接扫大明细表。

### 11. 可观测性 / 审计 / Readiness

负责系统级排障、审计真值和上线健康检查。

当前能力：

- `LoggingInterceptor` 统一记录请求上下文。
- `platform_request_events` 记录请求事件。
- `platform_audit_events` 记录写操作审计。
- AI 域独立记录 `ai_provider_health`、`ai_gateway_request_events`、`ai_audit_events`。
- `/healthz` 做 liveness。
- `/readyz` 和 `/api/v1/readyz` 做 DB/schema readiness。
- 平台后台可查看 observability runtime、错误事件、慢请求和模块分布。

实现方式：

- 后端模块：`observability`、`ai-chat`。
- 自研部分：request id / trace id、低信号路径过滤、模块归因、脱敏 metadata、before/after hash、保留策略。
- 日志可以采样，但写操作审计不能被采样跳过。
- 审计事件不保存密钥明文、大 payload 或直接个人敏感信息。

## 目录结构

```text
.
├── apps/
│   └── web/                 # 平台管理后台前端
├── services/
│   └── gateway/             # API 网关后端
├── docs/
│   ├── ARCHITECTURE.md      # 产品架构和实现边界
│   └── ENVIRONMENT_CONTROL_PLANE.md
├── protocols/
│   ├── README.md            # 协议、契约和工程约束
│   ├── app-registry.md      # app、环境、租户和 API key
│   ├── developer-sdk.md     # SDK、CLI 和 Codex MCP 接入合同
│   ├── permissions.md       # 用户、团队、角色和资源授权
│   ├── storage.md           # bucket、file、signed URL 和 quota
│   ├── jobs.md              # 长任务、触发器、重试和幂等
│   ├── realtime-events.md   # 实时事件和订阅鉴权
│   ├── usage-ledger.md      # 用量、成本和账本事件
│   └── runtime-settings.md  # 极简环境变量和管理员配置
├── packages/
│   ├── sdk/                 # opg-sdk 应用运行时客户端
│   └── cli/                 # @jamba/opg-cli 初始化、平台操作与 MCP server
├── LICENSE
├── package.json
├── README.md
└── README.en.md
```

## 本地启动与接入细节

前端：

```bash
npm install --prefix apps/web
npm run web:dev
```

后端：

```bash
npm install --prefix services/gateway
npm run gateway:dev
```

SDK / CLI：

```bash
npm run sdk:build
npm run cli:build
```

用户项目接入：

```bash
npm install opg-sdk
npx -y @jamba/opg-cli init --base-url https://api.example.com
npx -y @jamba/opg-cli login
npx -y @jamba/opg-cli app create --kind website --name "Your App" --slug your-app
npx -y @jamba/opg-cli login --app your-app
npx -y @jamba/opg-cli codex install
```

`opg login` 会打开浏览器授权页，先保存全局平台登录；用户可以在没有 app 的情况下创建 app。app 创建完成后再执行 `opg login --app your-app`，这一步才会创建 app-scoped Developer Grant，并把本机 SDK 凭证保存到 `.opg/credentials.json`。Grant 在平台后台“开发者授权”里按 app 和 scope 管理；本地凭证文件已加入 `.gitignore`，不要提交。

常用 CLI 操作：

```bash
npx -y @jamba/opg-cli manifest
npx -y @jamba/opg-cli smoke
npx -y @jamba/opg-cli db manifest
npx -y @jamba/opg-cli db tables
npx -y @jamba/opg-cli db query --sql "SELECT * FROM app_your_app__customers"
npx -y @jamba/opg-cli platform apps list
npx -y @jamba/opg-cli platform runtime get
```

Codex 使用 `.opg/codex-mcp.json`。其他 agent 工具可以直接调用 `opg` 命令；如果支持 MCP，把 MCP server 指向：

```bash
npx -y @jamba/opg-cli mcp
```

如果工具更适合代码内集成，使用 `opg-sdk`；如果工具更适合 HTTP 集成，读取后端 `openapi.json` 和 `/:app/v1/sdk/manifest`。

SDK 数据库能力通过后端受控代理执行，不暴露 `DATABASE_URL`。AI agent 只能操作当前 app 命名空间内的表，例如 `app_your_app__customers`，写操作默认 dry-run，真正执行需要 `confirm=apply:<app-slug>`。

后端部署后，也可以用显式环境变量在 CI 中验收 SDK 数据库链路。这里推荐使用 `opg_dev_` Developer Grant，旧 `rbx_` app key 仅作兼容：

```bash
OPG_BASE_URL=https://api.example.com OPG_APP_SLUG=your-app OPG_API_KEY=opg_dev_xxx npm run sdk:db:smoke
```

真实密钥不进入仓库。需要环境变量时，从各子项目的 `.env.example` 复制成本地 `.env`。

## 发布与 Docker 镜像

OPG 使用模块级 SemVer 和 tag-based release。发布版 Docker 镜像由 GitHub Actions 在 tag push 后自动构建。

| Tag | 版本来源 | 自动产物 |
| --- | --- | --- |
| `opg-system/vX.Y.Z` | 根 `package.json` | `ghcr.io/<owner>/opg-system`、`opg-system-gateway`、`opg-system-web` |
| `opg-gateway/vX.Y.Z` | `services/gateway/package.json` | `ghcr.io/<owner>/opg-system-gateway` |
| `opg-web/vX.Y.Z` | `apps/web/package.json` | `ghcr.io/<owner>/opg-system-web` |
| `opg-sdk/vX.Y.Z` | `packages/sdk/package.json` | `opg-sdk` npm package |
| `opg-cli/vX.Y.Z` | `packages/cli/package.json` | `@jamba/opg-cli` npm package |

准备版本号：

```bash
npm run release:bump -- system minor
git add package.json package-lock.json
git commit -m "chore(release): release 0.2.0"
git tag opg-system/v0.2.0
git push origin main opg-system/v0.2.0
```

用户可直接拉单容器镜像部署：

```bash
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://opg:password@postgres.example.com:5432/opg' \
  -e REDIS_URL='redis://redis.example.com:6379/0' \
  -e JWT_SECRET_KEY='replace-with-long-random-secret' \
  -e PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
  ghcr.io/<owner>/opg-system:0.2.0
```

完整发布流程见 [docs/RELEASE.md](docs/RELEASE.md)，Docker 部署说明见 [docs/DOCKER_DEPLOYMENT.md](docs/DOCKER_DEPLOYMENT.md)。

## 实现分工

必须用现成库或官方 SDK 的地方：

- JWT、OAuth、密码哈希、签名验证。
- Prisma / PostgreSQL migration。
- Redis、队列、缓存和限流。
- Object Storage SDK、multipart upload。
- AI provider SDK 或稳定 HTTP client。
- FFmpeg、Remotion、云媒体处理服务。
- 支付、短信、邮件、Push provider SDK。
- OpenTelemetry、日志采集、错误追踪。

必须自研的地方：

- app、tenant、environment 控制平面。
- 权限矩阵、租户上下文和 app namespace 校验。
- 模块注册协议和 SDK manifest 合同。
- AI/视频 provider adapter、路由、健康状态、成本归因。
- 长任务状态机、幂等提交、失败恢复和用户可见错误码。
- usage ledger、积分流水、账单聚合和权益授予。
- 平台级 request/audit events 和脱敏审计。
- 平台后台信息架构和运维工作流。

## 性能策略

- API、worker、realtime 进程保持 stateless，状态落到 PostgreSQL、Redis 和 Object Storage。
- 所有 AI、视频、消息、Webhook、批量同步长任务进入队列，HTTP 请求只创建任务并返回 task id。
- 按 `appId`、`tenantId`、`createdAt`、`status` 建组合索引。
- usage/audit/request events append-only，后台报表读取聚合表、物化视图或缓存。
- 大文件直传对象存储，后端避免代理上传大文件。
- Realtime 只推送状态摘要，不推送大 payload。
- provider adapter 按 app、provider、model 做并发限制、熔断、重试和成本上限。
- 后台列表强制分页、字段投影和稳定排序。
- SDK query/execute 设置 statement timeout、结果行数上限和 dry-run 默认值。
- AI 模型价格、provider catalog、公开 manifest 可以短缓存；密钥状态和审计结果不能公开缓存。

## 文档导航

- 产品架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Release 流程：[docs/RELEASE.md](docs/RELEASE.md)
- Docker 部署：[docs/DOCKER_DEPLOYMENT.md](docs/DOCKER_DEPLOYMENT.md)
- 环境变量控制面：[docs/ENVIRONMENT_CONTROL_PLANE.md](docs/ENVIRONMENT_CONTROL_PLANE.md)
- 协议索引：[protocols/README.md](protocols/README.md)
- Developer SDK：[protocols/developer-sdk.md](protocols/developer-sdk.md)
- 后端模块索引：[services/gateway/docs/modules/README.md](services/gateway/docs/modules/README.md)
- 网关说明：[services/gateway/README.md](services/gateway/README.md)
- 前端说明：[apps/web/README.md](apps/web/README.md)
- SDK 包说明：[packages/sdk/README.md](packages/sdk/README.md)
- CLI 包说明：[packages/cli/README.md](packages/cli/README.md)
- English README：[README.en.md](README.en.md)

## License

本项目使用 PolyForm Noncommercial License 1.0.0。源码可查看、修改和分发，但仅限非商业用途；商业使用需要单独授权。

## 工程约束

- Atomic Commits：一个提交只做一件事。
- UI 加法保持克制，优先复用现有页面和组件。
- 所有跨模块行为必须先落协议，再落实现。
- 密钥、构建产物、依赖目录不提交。

## 友情链接

- [LinuxDo](https://linux.do)
- [Jamailar](https://github.com/Jamailar)
- [taichuy/1flowbase](https://github.com/taichuy/1flowbase)
