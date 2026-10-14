# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
ENV PROJECT_ROOT=/app
ENV DATA_DIR=/app/data

FROM base AS builder
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN node scripts/build.ts

FROM base AS runner
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=builder /app /app
RUN mkdir -p /app/data/blobs && chown -R appuser:appgroup /app/data
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "apps/web/src/server.ts"]
