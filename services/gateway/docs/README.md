# OPG Gateway 文档中心

最后更新：2026-06-10

## 快速导航
- [环境变量完整清单](./ENVIRONMENT.md)
- [环境变量精简方案](./ENV_STREAMLINING_PLAN.md)
- [专题文档总览](./domains/README.md)
- [账号管理专题](./domains/account-management.md)
- [积分充值专题](./domains/points-recharge.md)
- [用户 AI 能力专题](./domains/user-ai-capabilities.md)
- [模块文档总览](./modules/README.md)
- [文档维护手册](./DOCS_MAINTENANCE.md)

## 文档维护目标
- 覆盖 `src/modules` 下每一个模块
- 提供可检索的路由、服务方法、依赖与数据表清单
- 支持自动刷新，减少手工维护成本

## 如何刷新模块文档
在 `services/gateway` 目录执行：

```bash
npm run docs:modules
```

## 文档分层
- **模块级**：`docs/modules/<module>/README.md`
- **全局索引**：`docs/modules/README.md`
- **项目级入口**：`docs/README.md`（本文件）
- **维护规范**：`docs/DOCS_MAINTENANCE.md`
