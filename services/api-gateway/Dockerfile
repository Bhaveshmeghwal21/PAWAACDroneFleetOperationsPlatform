# =============================================================================
# API Gateway (Service 6) — multi-stage image.
#
# IMPORTANT: the build context is the MONOREPO ROOT (see docker-compose.yml:
#   build: { context: ., dockerfile: services/api-gateway/Dockerfile })
# so that the pnpm workspace and the `@pawaac/shared-types` package resolve.
# =============================================================================

# ---- Stage 1: build -------------------------------------------------------
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /repo

# Workspace manifests first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY services/api-gateway/package.json services/api-gateway/

# Install all workspace deps (needed to build shared-types + the service).
RUN pnpm install --frozen-lockfile

# Source.
COPY packages/shared-types/ packages/shared-types/
COPY services/api-gateway/ services/api-gateway/

# Build the shared types, then the service.
RUN pnpm --filter @pawaac/shared-types run build \
  && pnpm --filter @pawaac/api-gateway run build

# Prune dev dependencies for a lean runtime node_modules.
RUN pnpm --filter @pawaac/api-gateway --prod deploy /app

# ---- Stage 2: runtime -----------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# `pnpm deploy` produced a self-contained app dir (node_modules + package.json).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /repo/services/api-gateway/dist ./dist

EXPOSE 3000
CMD ["node", "dist/main.js"]
