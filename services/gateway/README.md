# opg-gateway

NestJS 版网关服务（多租户 + 用户认证 + 积分充值 + OpenAI 兼容 AI 转发）。

## 文档导航
- [文档中心](./docs/README.md)
- [业务专题目录](./docs/domains/README.md)
- [账号管理专题](./docs/domains/account-management.md)
- [积分充值专题](./docs/domains/points-recharge.md)
- [用户 AI 能力专题](./docs/domains/user-ai-capabilities.md)
- [模块文档总览](./docs/modules/README.md)
- [文档维护手册](./docs/DOCS_MAINTENANCE.md)

## 常用命令
```bash
npm run build
npm run start:dev
npm run docs:modules
```

## Healthcheck

部署平台可以使用 `GET /health` 或 `GET /healthz`，返回 `200 OK` 和纯文本 `OK`。需要带 API 前缀的环境也可以使用 `GET /api/v1/health`。

## 环境变量

完整清单、分组说明与部署档位见 [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md)。本地可复制 [`.env.example`](./.env.example) 起步。

**启动必填：** `DATABASE_URL`、`JWT_SECRET_KEY`

## 生产日志控制

`opg-gateway` 生产环境默认只输出 5xx 和慢请求日志，避免高频轮询、探活或 Socket.IO fallback 把容器 stdout 写爆。日志相关变量见 [ENVIRONMENT.md §3](./docs/ENVIRONMENT.md#3-http-与访问日志)。

容器运行时仍需要配置日志轮转，例如 Docker `json-file`：

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "20m",
    "max-file": "3"
  }
}
```
