# Release 流程

OPG 使用模块级 SemVer 和 tag-based release。版本号只表示对应可发布模块的运行合同，不把所有包强行绑成同一个版本。

## 版本真值

| 模块 | 版本文件 | Tag | 发布产物 | 触发方式 |
| --- | --- | --- | --- | --- |
| Distribution | `package.json` | `opg-system/vX.Y.Z` | `ghcr.io/<owner>/opg-system`、`opg-system-gateway`、`opg-system-web`、`docker.io/<dockerhub-namespace>/opg-system` | GitHub Actions 构建 Docker |
| Gateway | `services/gateway/package.json` | `opg-gateway/vX.Y.Z` | `ghcr.io/<owner>/opg-system-gateway` | GitHub Actions 构建 Docker |
| Web | `apps/web/package.json` | `opg-web/vX.Y.Z` | `ghcr.io/<owner>/opg-system-web` | GitHub Actions 构建 Docker |
| SDK | `packages/sdk/package.json` | `opg-sdk/vX.Y.Z` | `opg-sdk` npm package | 手动 `npm publish` |
| CLI | `packages/cli/package.json` | `opg-cli/vX.Y.Z` | `@jamba/opg-cli` npm package | 手动 `npm publish` |

推荐优先发布 `opg-system/vX.Y.Z`。它会一次构建单容器镜像和分离部署镜像，方便其他用户直接拉 Docker 镜像部署。只有后端或前端独立修复时，再发布 `opg-gateway/vX.Y.Z` 或 `opg-web/vX.Y.Z`。

## 版本号规则

| 变更类型 | bump | 示例 |
| --- | --- | --- |
| 修复 bug、文档不影响运行合同、镜像构建修复 | patch | `1.0.118` -> `1.0.119` |
| 新增兼容能力、CLI 新命令、后台新运营面板 | minor | `1.0.118` -> `1.1.0` |
| 破坏 API、迁移要求人工处理、配置合同不兼容 | major | `1.0.118` -> `2.0.0` |

数据库 migration 可以出现在 patch/minor/major 任意版本里。只要启动迁移可自动完成且旧配置仍可启动，通常不需要 major。

## 准备版本

发布版本前，先完成并提交功能或修复提交。版本 bump 必须是单独 atomic commit。

```bash
git status --short
npm run release:bump -- system patch
```

脚本会更新对应 `package.json`、lockfile，并运行该模块的 build 验证。可选模块：

```bash
npm run release:bump -- system patch
npm run release:bump -- gateway patch
npm run release:bump -- web patch
npm run release:bump -- sdk patch
npm run release:bump -- cli patch
```

如果要指定版本号：

```bash
npm run release:bump -- system 0.2.0
```

Distribution 完整发布示例：

```bash
npm run release:bump -- system minor
git status --short
git add package.json package-lock.json
git commit -m "chore(release): release 0.2.0"
git tag opg-system/v0.2.0
git push origin main opg-system/v0.2.0
```

Gateway 独立发布示例：

```bash
npm run release:bump -- gateway patch
git add services/gateway/package.json services/gateway/package-lock.json package-lock.json
git commit -m "chore(gateway): release 1.0.119"
git tag opg-gateway/v1.0.119
git push origin main opg-gateway/v1.0.119
```

Web 独立发布示例：

```bash
npm run release:bump -- web patch
git add apps/web/package.json apps/web/package-lock.json package-lock.json
git commit -m "chore(web): release 0.1.53"
git tag opg-web/v0.1.53
git push origin main opg-web/v0.1.53
```

## Docker 自动构建

`.github/workflows/docker-release.yml` 监听这些 tag：

| Tag | 构建 target | 镜像 |
| --- | --- | --- |
| `opg-system/vX.Y.Z` | `opg-all`、`gateway-runtime`、`web-runtime` | `opg-system`、`opg-system-gateway`、`opg-system-web` |
| `opg-gateway/vX.Y.Z` | `gateway-runtime` | `opg-system-gateway` |
| `opg-web/vX.Y.Z` | `web-runtime` | `opg-system-web` |

镜像会推送到 GHCR，并写入三个 tag：

```text
ghcr.io/<owner>/opg-system:<version>
ghcr.io/<owner>/opg-system:latest
ghcr.io/<owner>/opg-system:<git-sha>
```

分离镜像同理：

```text
ghcr.io/<owner>/opg-system-gateway:<version>
ghcr.io/<owner>/opg-system-web:<version>
```

`opg-system/vX.Y.Z` 完整发布还会把单容器镜像同步推送到 Docker Hub：

```text
docker.io/<dockerhub-namespace>/opg-system:<version>
docker.io/<dockerhub-namespace>/opg-system:latest
docker.io/<dockerhub-namespace>/opg-system:<git-sha>
```

Docker Hub 使用这些 GitHub Actions 配置：

| 配置 | 类型 | 说明 |
| --- | --- | --- |
| `DOCKERHUB_USERNAME` | Secret | Docker Hub 登录用户名 |
| `DOCKERHUB_TOKEN` | Secret | Docker Hub access token |
| `DOCKERHUB_NAMESPACE` | Variable，可选 | Docker Hub 命名空间；不设置时默认使用 `DOCKERHUB_USERNAME` |

完整发布成功后，workflow 会把 `.github/dockerhub/README.md` 同步到 Docker Hub `opg-system` 仓库说明。这个文件必须保持在 Docker Hub 25KB README 限制内，并且用于 Docker Hub 渲染的图片必须使用公开绝对 URL。Docker Hub 普通镜像仓库没有公开稳定的 per-repository avatar/logo API；镜像页头像不作为自动发布项，必要时通过 Docker Hub 账号/组织头像、Verified Publisher，或 README 顶部图片呈现品牌。

每次 Docker tag 发布都必须同时完成 GitHub Release：

1. 对应 tag 必须创建或更新为 GitHub latest release。
2. Release notes 必须写入更新日志，至少列出本次 tag 相对同模块上一版本 tag 的提交，不能只放 source code 链接。
3. Release assets 必须包含可离线导入的单镜像文件：`<image-name>-<version>.tar.gz`。
4. 每个单镜像文件必须同时上传 `.sha256` 校验文件。

GitHub Actions 会自动执行这些规则。`opg-system/vX.Y.Z` 会上传三个镜像归档，分别对应单容器、Gateway、Web；`opg-gateway/vX.Y.Z` 和 `opg-web/vX.Y.Z` 各上传一个镜像归档。

如果 tag 已经存在但 Release 资产缺失，可以手动补跑 workflow：

```bash
gh workflow run docker-release.yml -f release_tag=opg-gateway/v1.0.119
gh run watch
gh release view opg-gateway/v1.0.119 --json isLatest,assets,url
```

下载单镜像文件后可以离线导入：

```bash
docker load -i opg-system-gateway-1.0.119.tar.gz
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL='postgresql://opg:password@postgres.example.com:5432/opg' \
  -e REDIS_URL='redis://redis.example.com:6379/0' \
  -e JWT_SECRET_KEY='replace-with-long-random-secret' \
  -e PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
  ghcr.io/<owner>/opg-system-gateway:1.0.119
```

首次公开发布后，需要在 GitHub Packages 把对应 package visibility 调成 public，否则外部用户无法匿名拉取。

## 用户 Docker 部署

推荐单容器镜像：

```bash
docker pull ghcr.io/<owner>/opg-system:0.2.0
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL='postgresql://opg:password@postgres.example.com:5432/opg' \
  -e REDIS_URL='redis://redis.example.com:6379/0' \
  -e JWT_SECRET_KEY='replace-with-long-random-secret' \
  -e PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
  ghcr.io/<owner>/opg-system:0.2.0
```

使用随仓库提供的 Compose 文件：

```bash
OPG_IMAGE=ghcr.io/<owner>/opg-system:0.2.0 \
JWT_SECRET_KEY='replace-with-long-random-secret' \
PLATFORM_SECRETS_KEY='replace-with-long-random-secret' \
POSTGRES_PASSWORD='replace-with-strong-password' \
docker compose -f docker-compose.release.yml up -d
```

分离部署时分别拉：

```bash
docker pull ghcr.io/<owner>/opg-system-gateway:1.0.119
docker pull ghcr.io/<owner>/opg-system-web:0.1.53
```

## SDK / CLI 发布

SDK 发布：

```bash
npm run release:bump -- sdk patch
git add packages/sdk/package.json package-lock.json
git commit -m "chore(sdk): release 0.2.5"
git tag opg-sdk/v0.2.5
git push origin main opg-sdk/v0.2.5
npm publish --workspace packages/sdk --access public --registry=https://registry.npmjs.org/
npm view opg-sdk@latest version --registry=https://registry.npmjs.org/
```

CLI 发布前确认 `packages/cli/package.json` 依赖的 `opg-sdk` 版本已经是目标版本：

```bash
npm run release:bump -- cli patch
git add packages/cli/package.json package-lock.json
git commit -m "chore(cli): release 0.1.7"
git tag opg-cli/v0.1.7
git push origin main opg-cli/v0.1.7
npm publish --workspace packages/cli --access public --registry=https://registry.npmjs.org/
npm view @jamba/opg-cli@latest version --registry=https://registry.npmjs.org/
```

CLI 发布后做端到端验证：

```bash
npm run cli:verify
```

## 回滚

Docker 回滚优先使用旧版本镜像，不删除新 tag：

```bash
docker pull ghcr.io/<owner>/opg-system:0.1.9
```

如果错误 tag 尚未被外部使用，可以删除远端 tag 后重发正确版本：

```bash
git tag -d opg-system/v0.2.0
git push origin :refs/tags/opg-system/v0.2.0
```

已公开使用的版本不要重写 tag。修复后发布新的 patch 版本。
