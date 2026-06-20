<p align="center">
  <img src="https://raw.githubusercontent.com/Jamailar/OPG/main/docs/assets/opg-system-preview.png" alt="OPG System Preview" width="860">
</p>

# 一人集团系统

OPG System 是面向一人公司的 app 后端集群控制平面，把认证、租户、配置、AI、视频、支付、用量、审计和开发者接入收进同一套前后端分离 monorepo。

这个 Docker Hub 仓库发布的是单容器镜像：Gateway API 和 Web 管理后台打包在同一个镜像里，默认暴露 `3000` 端口。

## 快速拉取

```bash
docker pull jambahailar/opg-system:latest
```

也可以使用 GHCR 镜像：

```bash
docker pull ghcr.io/jamailar/opg-system:latest
```

## 最小运行

冷启动只需要少量环境变量。支付、对象存储、邮件、OAuth、AI 调优、域名、CORS 等业务配置优先走管理后台和数据库。

```bash
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL='postgresql://opg:password@postgres.example.com:5432/opg' \
  -e REDIS_URL='redis://redis.example.com:6379/0' \
  -e JWT_SECRET_KEY='replace-with-long-random-secret' \
  -e PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
  jambahailar/opg-system:latest
```

启动后访问：

```bash
open http://localhost:3000
```

## Docker Compose 部署

如果希望 OPG、PostgreSQL、Redis 一起由 Compose 编排：

```bash
git clone https://github.com/Jamailar/OPG.git
cd OPG

OPG_IMAGE=jambahailar/opg-system:latest \
JWT_SECRET_KEY='replace-with-long-random-secret' \
PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
POSTGRES_PASSWORD='replace-with-strong-password' \
docker compose -f docker-compose.release.yml up -d
```

## 源码构建

适合私有化部署、云平台构建或需要修改基座代码的场景：

```bash
git clone https://github.com/Jamailar/OPG.git
cd OPG

docker build --target opg-all -t opg-system:local .
```

运行本地构建镜像：

```bash
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL='postgresql://opg:password@postgres.example.com:5432/opg' \
  -e REDIS_URL='redis://redis.example.com:6379/0' \
  -e JWT_SECRET_KEY='replace-with-long-random-secret' \
  -e PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
  opg-system:local
```

## CLI 接入用户项目

```bash
npx -y @jamba/opg-cli init --base-url https://api.example.com
npx -y @jamba/opg-cli login
npx -y @jamba/opg-cli app create --name "Your App" --slug your-app
npx -y @jamba/opg-cli login --app your-app
npx -y @jamba/opg-cli codex install
```

## 版本和产物

完整 `opg-system/vX.Y.Z` 发布会同时生成：

- Docker Hub 单容器镜像：`jambahailar/opg-system:<version>`、`latest`、`<git-sha>`
- GHCR 单容器镜像：`ghcr.io/jamailar/opg-system:<version>`、`latest`、`<git-sha>`
- GitHub Release：更新日志、单镜像 `.tar.gz` 文件和 `.sha256` 校验文件

## 文档

- GitHub 仓库：https://github.com/Jamailar/OPG
- 产品架构：https://github.com/Jamailar/OPG/blob/main/docs/ARCHITECTURE.md
- Docker 部署：https://github.com/Jamailar/OPG/blob/main/docs/DOCKER_DEPLOYMENT.md
- CLI 使用：https://github.com/Jamailar/OPG/blob/main/docs/CLI_USAGE.md
- Release 规则：https://github.com/Jamailar/OPG/blob/main/docs/RELEASE.md
