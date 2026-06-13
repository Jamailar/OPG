# Acquisition 模块文档

> 模块名称：`acquisition`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `acquisition` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/acquisition/acquisition-admin.controller.ts`
- `src/modules/acquisition/acquisition-users.controller.ts`
- `src/modules/acquisition/acquisition.controller.ts`
- `src/modules/acquisition/acquisition.module.ts`
- `src/modules/acquisition/acquisition.service.ts`

## 3. Controller 与路由
### AcquisitionAdminController
- 控制器文件：`src/modules/acquisition/acquisition-admin.controller.ts`
- 基础路由：`'/api/v1/platform-admin/apps/:app_id/acquisition'`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `source-options` | `listSourceOptions()` |
| POST | `source-options` | `createSourceOption()` |
| PATCH | `source-options/:option_id` | `updateSourceOption()` |
| DELETE | `source-options/:option_id` | `deleteSourceOption()` |
| GET | `summary` | `getSummary()` |
| GET | `users` | `listUserSources()` |

### AcquisitionUsersController
- 控制器文件：`src/modules/acquisition/acquisition-users.controller.ts`
- 基础路由：`tenantControllerPaths('users', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `me/acquisition-source` | `getMyAcquisitionSource()` |
| POST | `me/acquisition-source` | `submitMyAcquisitionSource()` |

### AcquisitionController
- 控制器文件：`src/modules/acquisition/acquisition.controller.ts`
- 基础路由：`tenantControllerPaths('acquisition', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `source-options` | `listSourceOptions()` |

## 4. Service 能力
### AcquisitionService
- 服务文件：`src/modules/acquisition/acquisition.service.ts`
- 核心方法：
- `listSourceOptionsByAppSlug()`
- `listSourceOptionsByAppId()`
- `createSourceOption()`
- `updateSourceOption()`
- `deleteSourceOption()`
- `getMySourceByAppSlug()`
- `submitMySourceByAppSlug()`
- `getSummaryByAppId()`
- `resolveAppBySlug()`
- `ensureAppExists()`
- `ensureUserInApp()`
- `getSourceOptionById()`
- `getSourceOptionByKey()`
- `resolveRange()`
- `parseDate()`
- `normalizeKey()`
- `cleanText()`
- `normalizeBoolean()`
- `normalizeInteger()`
- `normalizeMetadata()`
- `pickIpAddress()`
- `hashIp()`
- `toNumber()`
- `serializeOption()`
- `serializeUserSource()`

## 5. 数据库/存储依赖（自动扫描）
- `app_acquisition_source_options`
- `user_acquisition_source_events`
- `user_acquisition_sources`
- `users`

## 6. 模块依赖（自动扫描）
- `..`
- `auth`

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-06-10：自动生成/刷新模块文档结构与清单。
