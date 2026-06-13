# OPG Gateway 文档维护手册

## 1. 维护目标
- 保证 `src/modules` 下每个模块都有可维护文档。
- 路由、服务能力、依赖关系和数据表变更可以被快速检索。
- 降低新成员接手成本，减少“口口相传”。

## 2. 目录约定
- 文档入口：`docs/README.md`
- 模块总目录：`docs/modules/README.md`
- 模块文档：`docs/modules/<module>/README.md`

## 3. 自动化刷新
在 `services/gateway` 目录执行：

```bash
npm run docs:modules
```

脚本会自动：
- 扫描 `src/modules` 下模块目录
- 生成/刷新每个模块的 README
- 删除已移除模块的过时文档目录
- 刷新 `docs/modules/README.md` 总索引
- 刷新 `apps/web/src/config/generated-api-docs.ts`，供平台管理后台 API 文档页使用

脚本位置：
- `scripts/generate-module-docs.mjs`
- `scripts/generate-appadmin-api-docs.mjs`

## 4. 必须刷新文档的场景
- 新增/删除 Controller 路由
- 新增/删除 Service 对外方法
- 模块依赖关系变化（`*.module.ts` 的 imports 变化）
- 新增/调整 SQL 表和关键数据流

## 5. 人工补充建议（自动化之外）
自动生成解决“覆盖率”，人工补充负责“可读性”：
- 模块业务边界与职责说明
- 关键请求/响应样例
- 外部依赖（第三方 API、队列、对象存储）注意事项
