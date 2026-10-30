FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable

ARG NEXT_PUBLIC_APP_TIMEZONE=America/Sao_Paulo
ENV NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_APP_TIMEZONE=$NEXT_PUBLIC_APP_TIMEZONE

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/queue/package.json packages/queue/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm db:generate \
  && pnpm --filter './packages/**' build \
  && pnpm --filter @confirma/api build \
  && pnpm --filter @confirma/worker build \
  && pnpm --filter @confirma/web build

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV API_PORT=3001

RUN apk add --no-cache tini \
  && addgroup -S confirma \
  && adduser -S confirma -G confirma

COPY --from=build --chown=confirma:confirma /app/apps/web/.next/standalone ./
COPY --from=build --chown=confirma:confirma /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=confirma:confirma /app/apps/web/public ./apps/web/public
COPY --from=build --chown=confirma:confirma /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=confirma:confirma /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=confirma:confirma /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=confirma:confirma /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=confirma:confirma /app/packages ./packages
COPY --from=build --chown=confirma:confirma /app/node_modules ./node_modules
COPY --from=build --chown=confirma:confirma /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=confirma:confirma /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build --chown=confirma:confirma /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --chown=confirma:confirma docker/start-all.sh ./docker/start-all.sh
RUN chmod +x ./docker/start-all.sh \
  && cd /app/apps/api \
  && node -e "Promise.all([import('reflect-metadata'), import('@confirma/database')])" \
  && cd /app/apps/worker \
  && node -e "Promise.all([import('@confirma/database'), import('bullmq')])"

USER confirma
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${WEB_PORT:-${PORT:-3000}}/login" \
  && wget -q -O /dev/null http://127.0.0.1:3001/api/health \
  || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./docker/start-all.sh"]
