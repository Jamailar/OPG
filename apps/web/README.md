# OPG 平台管理后台（`apps/web`）

独立的平台级后台，负责租户应用管理、AI 配置、支付与运营能力。

## 运行

```bash
cd apps/web
npm install
npm run dev -- --port 3002
```

默认开发地址：`http://localhost:3002`

## 环境变量

参考 `.env.example`：

- `VITE_API_BASE_URL`：网关地址（线上必填）
- `VITE_PLATFORM_APP_SLUG`：平台租户 slug（默认 `platform`）
- `VITE_ADMIN_PORTAL_MODE`：默认 `platform`

本地开发时 API 默认回退 `http://localhost:8000`。生产镜像通过 `/env.js` 注入运行时配置。

## 模块边界

- 仅连接平台租户 API：`/{platform}/v1/platform-admin/*`
- 不包含各业务 app 的专属前台/后台页面

## API 文档数据

由 `services/gateway/scripts/generate-appadmin-api-docs.mjs` 生成，输出到 `src/config/generated-api-docs.ts`。

在 gateway 目录执行：

```bash
npm run docs:modules
```
