# Storage 协议

## 目标

Storage 提供 bucket、file、signed URL、metadata、quota 和生命周期策略，承载用户上传、AI 输入素材、视频结果、公开静态资源。

## 核心对象

```text
storage_bucket
  id
  appId
  environmentId
  name
  visibility        # private / public / signed
  quotaBytes
  allowedMimeTypes
  lifecyclePolicy

storage_file
  id
  appId
  tenantId
  bucketId
  objectKey
  filename
  mimeType
  byteSize
  checksum
  visibility
  status            # pending / uploaded / processing / ready / failed / deleted
  metadata
```

## 上传流程

1. 前端请求创建 upload session。
2. 后端校验权限、quota、mime 限制。
3. 后端返回 signed upload URL。
4. 客户端直传对象存储。
5. 客户端或存储回调通知后端 finalize。
6. 后端记录 metadata、usage event、audit event。

## 下载流程

- private 文件必须走 signed URL。
- public 文件可以走 CDN URL。
- AI/视频中间素材默认 private。

## 必须自研

- bucket 权限。
- file metadata。
- quota 和 usage 记录。
- 上传 session 和 finalize 协议。
- 生命周期策略。
- provider 配置 UI、密钥加密入库和默认 provider 选择。

## 必须用现成库

- Ali OSS/S3/R2 SDK。
- MIME 检测库。
- 图片尺寸/压缩库。
- 文件 checksum。

## 当前实现

- `platform_storage_providers` 保存平台对象存储 provider。
- `ALIYUN_OSS` provider 已支持由管理员配置 endpoint、bucket、CDN、AK/SK。
- `UploadService` 优先使用 DB 默认 provider，未配置时回退 env。
