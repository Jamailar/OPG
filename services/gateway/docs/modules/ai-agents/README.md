# Ai Agents 模块文档

> 模块名称：`ai-agents`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `ai-agents` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/ai-agents/ai-agent-observability-retention.service.ts`
- `src/modules/ai-agents/ai-agent-runtime.service.ts`
- `src/modules/ai-agents/ai-agents-app.controller.ts`
- `src/modules/ai-agents/ai-agents-platform.controller.ts`
- `src/modules/ai-agents/ai-agents.module.ts`
- `src/modules/ai-agents/ai-agents.service.ts`
- `src/modules/ai-agents/ai-agents.types.ts`

## 3. Controller 与路由
### AiAgentsAppController
- 控制器文件：`src/modules/ai-agents/ai-agents-app.controller.ts`
- 基础路由：`tenantControllerPaths('agent', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `(root)` | `listAppAgents()` |
| GET | `:slug/meta` | `getAgentMeta()` |
| POST | `:slug/run` | `runAgent()` |
| POST | `:slug/stream` | `runAgentStream()` |

### AiAgentsPlatformController
- 控制器文件：`src/modules/ai-agents/ai-agents-platform.controller.ts`
- 基础路由：`'/api/v1/platform-admin'`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| GET | `agents` | `listAgents()` |
| GET | `agents/:agent_id` | `getAgent()` |
| POST | `agents` | `createAgent()` |
| PUT | `agents/:agent_id` | `updateAgent()` |
| POST | `agents/:agent_id/publish` | `publishAgent()` |
| POST | `agents/:agent_id/archive` | `archiveAgent()` |
| DELETE | `agents/:agent_id` | `deleteAgent()` |
| POST | `agents/:agent_id/test` | `testAgent()` |
| GET | `agent-tools` | `listTools()` |
| GET | `agent-runs` | `listRuns()` |
| GET | `agent-runs/:run_id` | `getRun()` |
| GET | `apps/:app_id/agents` | `listAppBindings()` |
| PUT | `apps/:app_id/agents/:agent_id/binding` | `upsertAppBinding()` |
| DELETE | `apps/:app_id/agents/:agent_id/binding` | `deleteAppBinding()` |

## 4. Service 能力
### AiAgentObservabilityRetentionService
- 服务文件：`src/modules/ai-agents/ai-agent-observability-retention.service.ts`
- 核心方法：
- `pruneExpiredAgentLogs()`

### AiAgentRuntimeService
- 服务文件：`src/modules/ai-agents/ai-agent-runtime.service.ts`
- 核心方法：
- `listToolCatalog()`
- `hasTool()`
- `getToolDefinitions()`
- `listToolBindingsByVersionId()`
- `normalizeToolPacks()`
- `normalizeOptionalString()`
- `parseJsonObject()`
- `tryParseJsonObject()`
- `extractAssistantMessage()`
- `extractAssistantContent()`
- `extractUsage()`
- `interpolateTemplate()`
- `assertWithinDeadline()`
- `validateSchema()`
- `matchesJsonSchemaType()`
- `isPlainObject()`
- `finiteNumber()`

### AiAgentsService
- 服务文件：`src/modules/ai-agents/ai-agents.service.ts`
- 核心方法：
- `onModuleInit()`
- `listPlatformAgents()`
- `getPlatformAgent()`
- `createPlatformAgent()`
- `updatePlatformAgent()`
- `publishPlatformAgent()`
- `archivePlatformAgent()`
- `deletePlatformAgent()`
- `listToolCatalog()`
- `listAppAgentBindings()`
- `upsertAppAgentBinding()`
- `deleteAppAgentBinding()`
- `listPublishedAgentsForApp()`
- `getAgentMetaForApp()`
- `runAgentForApp()`
- `runAgentForAppStream()`
- `runPlatformAgentTest()`
- `getAgentRunDetail()`
- `resolvePublishedAgentForApp()`
- `getBindingByAppAndAgent()`
- `resolveRequestActor()`
- `serializeAppAgentMeta()`
- `serializeAgentSummary()`
- `serializeAgentDetail()`
- `serializeVersion()`
- `normalizeVersionInput()`
- `normalizeToolBindingInput()`
- `normalizeToolPacks()`
- `listToolBindingsByVersionId()`
- `resolveRunModelKey()`
- `resolveRequestId()`
- `serializeRunError()`
- `getAgentRow()`
- `getVersionRow()`
- `getAppById()`
- `getAppBySlug()`
- `normalizeSlug()`
- `normalizeRequiredString()`
- `normalizeOptionalString()`
- `normalizeVisibility()`
- `normalizeScope()`
- `normalizeStatus()`
- `normalizeOutputMode()`
- `normalizeAuthPolicy()`
- `normalizeInteger()`
- `normalizeNonNegativeDecimal()`
- `parseJsonObject()`
- `toFiniteDecimal2()`
- `buildSseEvent()`
- `ensureSchema()`
- `verifySchemaReady()`

## 5. 数据库/存储依赖（自动扫描）
- `ai_agent_app_bindings`
- `ai_agent_run_steps`
- `ai_agent_runs`
- `ai_agent_tool_bindings`
- `ai_agent_versions`
- `ai_agents`
- `apps`
- `deleted`
- `information_schema`
- `users`

## 6. 模块依赖（自动扫描）
- `..`
- `ai-chat`
- `auth`

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-06-10：自动生成/刷新模块文档结构与清单。
