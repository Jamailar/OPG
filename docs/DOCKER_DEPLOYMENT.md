# Docker 部署

OPG 支持同一份 Dockerfile 生成三种运行镜像：

| Target | 用途 | 运行内容 |
| --- | --- | --- |
| `opg-all` | 默认推荐，降低部署难度 | Gateway API + Web 静态资源，同一个容器和端口 |
| `gateway-runtime` | 分离部署后端 | Gateway API |
| `web-runtime` | 分离部署前端 | Vite 静态资源服务 |

PostgreSQL 和 Redis 不打包进应用镜像。生产环境应使用外部托管服务或独立容器，并通过环境变量连接。

## 单容器部署

构建：

```bash
docker build --target opg-all -t opg-system:latest .
```

运行：

```bash
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL='postgresql://opg:password@postgres.example.com:5432/opg' \
  -e REDIS_URL='redis://redis.example.com:6379/0' \
  -e JWT_SECRET_KEY='replace-with-long-random-secret' \
  -e PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
  opg-system:latest
```

访问路径：

| Path | 说明 |
| --- | --- |
| `/` | 平台管理后台 |
| `/auth/login` | 平台登录页 |
| `/runtime-config` | 前端公开运行时配置 |
| `/api/v1/*` | 平台 API |
| `/{app}/v1/*` | App API |
| `/healthz` | 健康检查 |
| `/api/docs` | Swagger 文档 |

单容器模式下，前端会优先读取同源 `/runtime-config`。如果数据库里没有配置 `api_base_url`，前端默认使用当前 origin 作为 API 根地址，因此不需要设置 `VITE_API_BASE_URL`。

## 分离部署

后端镜像：

```bash
docker build --target gateway-runtime -t opg-gateway:latest .
```

前端镜像：

```bash
docker build --target web-runtime -t opg-web:latest .
```

后端运行：

```bash
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL='postgresql://opg:password@postgres.example.com:5432/opg' \
  -e REDIS_URL='redis://redis.example.com:6379/0' \
  -e JWT_SECRET_KEY='replace-with-long-random-secret' \
  -e PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
  opg-gateway:latest
```

前端运行：

```bash
docker run --rm -p 8080:3000 \
  -e VITE_API_BASE_URL='https://api.example.com' \
  -e VITE_ADMIN_PORTAL_MODE='platform' \
  opg-web:latest
```

分离部署时，`VITE_API_BASE_URL` 应指向后端 Gateway 域名。CORS 首次冷启动可以用 `CORS_ORIGINS`，之后应在平台设置里维护域名和 CORS。

## 必要环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | PostgreSQL 连接 |
| `REDIS_URL` | 是 | Redis 连接 |
| `JWT_SECRET_KEY` | 是 | JWT 签名根密钥 |
| `PLATFORM_SECRETS_KEY` | 是 | 平台业务密钥加密根密钥 |
| `NODE_ENV` | 建议 | 生产使用 `production` |
| `PORT` | 建议 | Gateway 监听端口，默认 `3000` |
| `CORS_ORIGINS` | 冷启动可选 | 首次进入后台前的 CORS fallback |
| `OPG_RUN_MIGRATIONS` | 可选 | 设置为 `false` 或 `0` 时跳过启动迁移 |

## 数据库迁移

默认启动时会执行：

```bash
prisma migrate status
prisma migrate deploy
```

单实例部署保持默认即可。多副本部署时，建议只让一个 migration job 执行迁移，其它应用副本设置：

```bash
OPG_RUN_MIGRATIONS=false
```

## 性能策略

- 单容器模式只合并 Web 静态资源和 Gateway 进程，不把 PostgreSQL、Redis、视频 worker 打进同一个容器。
- 静态资源 `/assets/*` 使用 immutable 长缓存；`index.html` 和 `env.js` 使用 `no-store`，保证运行时配置可更新。
- 视频和 AI 长任务继续走异步任务状态机；Gateway 只做提交、轮询、结果代理、计费和审计，不在 HTTP 请求里做长时间本地渲染。
- 大文件上传应走对象存储签名直传；Gateway 只记录元数据和权限真值。
- 多副本部署时关闭非 migration 副本的启动迁移，避免迁移锁竞争。

## 选择建议

| 方案 | 推荐场景 | 取舍 |
| --- | --- | --- |
| `opg-all` | 个人部署、试用、小团队生产 | 最少域名和端口配置，静态资源能力弱于 CDN |
| `gateway-runtime` + `web-runtime` | 需要 CDN、独立扩缩容、独立发布前端 | 配置更多，需要处理 API 域名和 CORS |
| 自定义 worker runtime | AI/video 高并发、长任务重 | 需要额外队列和运维，但隔离性最好 |
