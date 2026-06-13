# Outbound Proxy 模块文档

> 模块名称：`outbound-proxy`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `outbound-proxy` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/outbound-proxy/outbound-http-client.service.ts`
- `src/modules/outbound-proxy/outbound-proxy.crypto.ts`
- `src/modules/outbound-proxy/outbound-proxy.module.ts`
- `src/modules/outbound-proxy/outbound-proxy.service.ts`
- `src/modules/outbound-proxy/outbound-proxy.types.ts`

## 3. Controller 与路由
当前模块没有 Controller 文件。

## 4. Service 能力
### OutboundHttpClientService
- 服务文件：`src/modules/outbound-proxy/outbound-http-client.service.ts`
- 核心方法：
- `onModuleInit()`
- `clearProxyCache()`
- `directFetch()`
- `resolveProxy()`
- `assertProxyUsable()`
- `buildProxyUrl()`
- `resolveAgent()`
- `resolveUndiciAgent()`
- `prepareNodeFetchInput()`
- `convertFormDataBody()`
- `withTimeout()`
- `toWebResponse()`

### OutboundProxyService
- 服务文件：`src/modules/outbound-proxy/outbound-proxy.service.ts`
- 核心方法：
- `listProxies()`
- `createProxy()`
- `updateProxy()`
- `deleteProxy()`
- `getProxy()`
- `testProxy()`
- `batchTest()`
- `importProxies()`
- `exportProxies()`
- `listCheckLogs()`
- `runSingleCheck()`
- `parseImportPayload()`
- `parseProxyUrl()`
- `defaultPort()`
- `normalizeProxyInput()`
- `normalizeProtocol()`
- `normalizeStatus()`
- `getProxyRow()`
- `countReferences()`
- `serializeProxy()`
- `tryParseJson()`
- `extractIp()`
- `truncate()`

## 5. 数据库/存储依赖（自动扫描）
- `ai_global_sources`
- `google_oauth_clients`
- `lateral`
- `outbound_proxies`
- `outbound_proxy_check_logs`

## 6. 模块依赖（自动扫描）
- （未检测到模块级依赖导入）

## 7. 维护清单
- [ ] 路由变更后已同步更新本文档（含请求/响应变化）
- [ ] Service 新增公开方法已补充用途说明
- [ ] 数据表变更已补充影响说明与迁移步骤
- [ ] 已确认与上游模块依赖关系未破坏
- [ ] 已补充联调示例（如涉及外部调用）

## 8. 变更记录
- 2026-06-10：自动生成/刷新模块文档结构与清单。
