# Upload 模块文档

> 模块名称：`upload`  
> 最后更新：2026-06-10

## 1. 模块定位
- 负责 `upload` 业务域的路由、服务与数据处理。
- 本文档用于模块级维护、交接与变更审查。

## 2. 源码目录
- `src/modules/upload/upload.controller.ts`
- `src/modules/upload/upload.module.ts`
- `src/modules/upload/upload.service.ts`

## 3. Controller 与路由
### UploadController
- 控制器文件：`src/modules/upload/upload.controller.ts`
- 基础路由：`tenantControllerPaths('upload', true)`

| HTTP 方法 | 路径 | 处理函数 |
| --- | --- | --- |
| POST | `presigned-url` | `getPresignedUrl()` |
| POST | `audio` | `FileInterceptor()` |
| POST | `image` | `FileInterceptor()` |
| POST | `image-buffer` | `FileInterceptor()` |
| POST | `file-buffer` | `FileInterceptor()` |
| POST | `file` | `FileInterceptor()` |

## 4. Service 能力
### UploadService
- 服务文件：`src/modules/upload/upload.service.ts`
- 核心方法：
- `deleteByFileUrl()`
- `getManagedFileKey()`
- `isManagedFileReference()`
- `resolveReadableUrl()`
- `buildCdnReadableUrl()`
- `uploadAudio()`
- `uploadImage()`
- `uploadFile()`
- `buildFileUrl()`
- `resolveAppId()`
- `buildObjectKey()`
- `extractSafeExtension()`
- `extractSafeBasename()`
- `normalizeKeyPrefix()`
- `buildUploadUrl()`
- `normalizeEndpoint()`
- `extractManagedFileKey()`
- `isLikelyManagedObjectKey()`
- `buildOssClient()`
- `persistLocalFile()`
- `persistLocalStream()`

## 5. 数据库/存储依赖（自动扫描）
- （未检测到显式 SQL 表名，可能使用 Prisma ORM 查询）

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
