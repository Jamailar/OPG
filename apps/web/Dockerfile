# 构建阶段
FROM node:20-alpine AS builder

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm ci --prefer-offline --no-audit

# 复制源代码
COPY . .

# 构建应用（环境变量在构建时注入）
ARG VITE_API_BASE_URL
ARG VITE_PLATFORM_APP_SLUG
ARG VITE_PLATFORM_ADMIN_DOMAIN
ARG VITE_ADMIN_PORTAL_MODE
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_PLATFORM_APP_SLUG=$VITE_PLATFORM_APP_SLUG
ENV VITE_PLATFORM_ADMIN_DOMAIN=$VITE_PLATFORM_ADMIN_DOMAIN
ENV VITE_ADMIN_PORTAL_MODE=$VITE_ADMIN_PORTAL_MODE

RUN npm run build

# 生产阶段
FROM node:20-alpine

WORKDIR /app

# 安装 serve
RUN npm install -g serve

# 复制构建产物
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# 暴露端口
EXPOSE 3000

# 启动时根据环境变量生成运行时配置
CMD ["./docker-entrypoint.sh"]
