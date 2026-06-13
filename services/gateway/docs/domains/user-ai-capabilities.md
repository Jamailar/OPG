# 用户 AI 能力专题（OpenAI 兼容）

> 覆盖模块：`ai-chat`、`api-keys`

## 1. 鉴权方式
- 模型价格表：公开读取，不需要 `Authorization`。
- 其他 AI 调用接口：`Authorization: Bearer rbx_...`（推荐 API Key）
- 其他 AI 调用接口：`Authorization: Bearer <access_token>`（JWT 也支持）

## 2. OpenAI 兼容路由前缀
- `/:app/v1/...`
- `/api/v1/...`
- `/v1/...`

说明：
- 面向租户站点的业务文档，默认应优先写 `/{slug}/v1/...`
- 如果下文写 `POST /v1/chat/completions`，在租户上下文里可等价理解为 `POST /{slug}/v1/chat/completions`

## 3. 能力覆盖
- 语言模型：`POST /v1/chat/completions`、`POST /v1/completions`、`POST /v1/responses`
- 模型列表：`GET /v1/models`、`GET /v1/models/:model`
- 模型价格：`GET /v1/models/pricing`（公开读取；使用 `/api/v1` 或 `/v1` 时可通过 `?app={slug}` 指定租户）
- 嵌入：`POST /v1/embeddings`
- 语音生成（TTS）：`POST /v1/audio/speech`
- 语音转录/翻译（STT）：
  - `POST /v1/audio/transcriptions`
  - `POST /v1/audio/translations`
- 图片生成：`POST /v1/images/generations`

## 4. STT 请求说明
- 支持 multipart：`file` 字段上传文件。
- 也支持 JSON：`file_base64` + `file_name` + `file_mime_type`。

## 5. 错误格式
统一返回 OpenAI 风格错误：
```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error|authentication_error|rate_limit_error|api_error",
    "param": null,
    "code": null
  }
}
```

## 6. 与积分系统的关系
- 每次 AI 调用记录使用日志并进行积分扣减。
- 扣减规则按租户 app 的积分设置生效。
- 用户可通过 `GET /users/me/points` 实时查看余额与汇率。
- 用户可通过 `GET /users/me/ai-usage-logs` 查看自己的调用记录。
- 当前计费口径：
  - 文字生成：按输出 token
  - 嵌入：按 token
  - 音频 / 视频：按分钟
  - 图片：按张
