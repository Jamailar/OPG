# 一人集团系统

一人集团系统是一个前后端分离的 app 后端集群启动器，目标是让一人公司能快速搭建多 app、多租户、可计费、可运营、可接 AI 能力的后台系统。

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
│   ├── sdk/                 # @opg/sdk 应用运行时客户端
│   └── cli/                 # @opg/cli 初始化与 Codex MCP server
├── LICENSE
├── package.json
└── README.md
```

## 本地启动

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
npx -y @opg/cli init --base-url https://api.example.com --app your-app
npx -y @opg/cli codex install --base-url https://api.example.com --app your-app
```

真实密钥不进入仓库。需要环境变量时，从各子项目的 `.env.example` 复制成本地 `.env`。

## 产品边界

- 前端负责运营后台、应用配置、租户管理、AI 任务编排入口、账单和日志可视化。
- 后端负责认证、租户隔离、API 聚合、AI/视频任务代理、计费、审计、任务状态和业务模块注册。
- AI、视频处理、支付、存储等高变化能力通过后端服务层封装，前端不直接绑定第三方供应商。
- 系统吸收 Appwrite 的 Auth、Storage、Functions、Realtime、Messaging、自托管控制面思路，但定位不是通用 BaaS，而是面向一人公司的 app 后端集群控制平面。
- 环境变量只保留冷启动基础设施项；支付、存储、邮件、OAuth、AI 调优、域名和 CORS 等运行时配置由管理员在 UI 中维护。

## License

本项目使用 PolyForm Noncommercial License 1.0.0。源码可查看、修改和分发，但仅限非商业用途；商业使用需要单独授权。

## 工程约束

- Atomic Commits：一个提交只做一件事。
- UI 加法保持克制，优先复用现有页面和组件。
- 所有跨模块行为必须先落协议，再落实现。
- 密钥、构建产物、依赖目录不提交。
