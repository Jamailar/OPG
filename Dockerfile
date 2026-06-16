ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS web-build

WORKDIR /app/apps/web

COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

COPY apps/web ./
RUN npm run build

FROM node:${NODE_VERSION} AS gateway-build

WORKDIR /app/services/gateway

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY services/gateway/package.json services/gateway/package-lock.json ./
RUN npm ci

COPY services/gateway ./
RUN npx prisma generate
RUN npm run build

FROM node:${NODE_VERSION} AS gateway-base

WORKDIR /app/services/gateway
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates wget gnupg ffmpeg \
  && echo "deb http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add - \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && apt-get purge -y --auto-remove wget gnupg \
  && rm -rf /var/lib/apt/lists/*

COPY services/gateway/package.json services/gateway/package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=gateway-build /app/services/gateway/dist ./dist
COPY --from=gateway-build /app/services/gateway/prisma ./prisma
COPY --from=gateway-build /app/services/gateway/scripts ./scripts
COPY --from=gateway-build /app/services/gateway/node_modules/.prisma ./node_modules/.prisma
COPY --from=gateway-build /app/services/gateway/node_modules/@prisma ./node_modules/@prisma
COPY --from=gateway-build /app/services/gateway/node_modules/prisma ./node_modules/prisma
COPY --from=gateway-build /app/services/gateway/node_modules/.bin/prisma ./node_modules/.bin/prisma

RUN chmod +x ./scripts/start-with-migrations.sh \
  && chmod +x ./scripts/db/backup-full-to-target.sh

EXPOSE 3000

FROM gateway-base AS gateway-runtime

CMD ["./scripts/start-with-migrations.sh"]

FROM node:${NODE_VERSION} AS web-runtime

WORKDIR /app
ENV NODE_ENV=production

RUN npm install -g serve \
  && npm cache clean --force

COPY --from=web-build /app/apps/web/dist ./dist
COPY apps/web/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000
CMD ["./docker-entrypoint.sh"]

FROM gateway-base AS opg-all

ENV OPG_SERVE_WEB=true
ENV OPG_WEB_DIST=/app/public
COPY --from=web-build /app/apps/web/dist /app/public

CMD ["./scripts/start-with-migrations.sh"]
