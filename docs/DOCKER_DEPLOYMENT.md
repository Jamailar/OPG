# Docker 部署

OPG 支持同一份 Dockerfile 生成三种运行镜像：

| Target | 用途 | 运行内容 |
| --- | --- | --- |
| `opg-all` | 默认推荐，降低部署难度 | Gateway API + Web 静态资源，同一个容器和端口 |
| `gateway-runtime` | 分离部署后端 | Gateway API |
| `web-runtime` | 分离部署前端 | Vite 静态资源服务 |

PostgreSQL 和 Redis 不打包进应用镜像。单机部署推荐使用根目录 `docker-compose.yml` 编排 OPG 应用容器、PostgreSQL 和 Redis；生产规模化部署可以改用外部托管数据库/Redis，并通过环境变量连接。

## 单容器部署

这里的“单容器”指 OPG 应用自身是一个容器：Gateway API 和 Web 静态资源同进程同端口。数据库和 Redis 是基础设施依赖，仍由 Compose 或托管服务提供。

推荐单机启动：

```bash
docker compose up -d --build
```

默认会启动：

| Service | 镜像/Target | 用途 |
| --- | --- | --- |
| `opg` | 根 `Dockerfile` 的 `opg-all` target | Gateway API + Web 静态资源 |
| `postgres` | `postgres:17-alpine` | 平台主数据库 |
| `redis` | `redis:7-alpine` | AI 网关队列、限流、缓存等运行时依赖 |

访问：

```bash
open http://localhost:3000
```

生产上线前至少覆盖这些值：

```bash
JWT_SECRET_KEY='replace-with-long-random-secret' \
PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
POSTGRES_PASSWORD='replace-with-strong-password' \
docker compose up -d --build
```

如需修改宿主机端口：

```bash
OPG_PORT=8080 docker compose up -d --build
```

手动构建和连接外部数据库/Redis：

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
| `/healthz` | 存活检查 |
| `/readyz` | 就绪检查：数据库和平台观测表 |
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
| `OPG_REQUIRE_PRISMA_MIGRATIONS` | 可选 | 设置为 `true` 或 `1` 时，`prisma migrate deploy` 失败会阻止容器启动 |

## 数据库迁移

默认启动时会先尝试执行：

```bash
prisma migrate status
prisma migrate deploy
```

`prisma migrate deploy` 失败时，容器默认继续启动，让应用内 `DatabaseModule` 使用同一批 SQL migrations 做带锁迁移，并由 `/readyz` 暴露最终数据库状态。这样可以避免 Coolify/Dockerfile 部署因为 Prisma CLI 的预启动检查直接退出，导致拿不到应用层日志。

如果生产环境要求 Prisma CLI 迁移失败即阻止启动：

```bash
OPG_REQUIRE_PRISMA_MIGRATIONS=true
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
