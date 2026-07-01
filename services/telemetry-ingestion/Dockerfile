# =============================================================================
# Service 3 — Telemetry Ingestion (Node + TypeScript + TimescaleDB)
# =============================================================================
# Multi-stage build. The build context is the MONOREPO ROOT (see
# docker-compose.yml: `context: .  dockerfile: services/telemetry-ingestion/Dockerfile`)
# so the build can resolve the `@pawaac/shared-types` workspace package and the
# shared pnpm lockfile.
#
# Container listens on the fixed port 3003.
# =============================================================================

# ---- Base: Node 20 + pnpm via corepack ---------------------------------------
FROM node:20-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- Build: install workspace deps, compile shared-types + this service ------
FROM base AS build

# Copy workspace-level manifests first to maximize Docker layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY services/telemetry-ingestion/package.json ./services/telemetry-ingestion/package.json

# Install all workspace dependencies against the frozen lockfile.
RUN pnpm install --frozen-lockfile

# Copy the sources needed to build this service.
COPY packages/shared-types ./packages/shared-types
COPY services/telemetry-ingestion ./services/telemetry-ingestion

# Build the shared types package first, then the service.
RUN pnpm --filter @pawaac/shared-types build \
 && pnpm --filter @pawaac/telemetry-ingestion build

# Produce a self-contained, production-only deployment (bundles the workspace
# dependency @pawaac/shared-types into a flat node_modules).
RUN pnpm --filter @pawaac/telemetry-ingestion deploy --prod /app/deploy

# ---- Runtime: minimal production image ---------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3003
WORKDIR /app

# Run as the unprivileged user that ships with the node image.
USER node

COPY --from=build --chown=node:node /app/deploy ./

EXPOSE 3003

# Liveness/readiness are served on /health and /ready (see docker-compose.yml).
CMD ["node", "dist/index.js"]
