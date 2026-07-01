# syntax=docker/dockerfile:1
# =============================================================================
# Service 2 — Mission Planning (NestJS + Postgres/PostGIS)
# Multi-stage build. The build context is the MONOREPO ROOT (see
# docker-compose.yml: build.context = .) so the pnpm workspace, lockfile and the
# @pawaac/shared-types package are all resolvable.
# =============================================================================

# ----- Base: pnpm-enabled Node ------------------------------------------------
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# ----- Builder: install deps, build shared-types + the service ----------------
FROM base AS builder

# Workspace manifests first for better layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY services/mission-planning/package.json ./services/mission-planning/

RUN pnpm install --frozen-lockfile

# Now the sources.
COPY packages/shared-types ./packages/shared-types
COPY services/mission-planning ./services/mission-planning

RUN pnpm --filter @pawaac/shared-types build \
  && pnpm --filter @pawaac/mission-planning build

# Produce a self-contained production deployment (prunes dev deps, injects the
# built workspace dependency).
RUN pnpm --filter @pawaac/mission-planning deploy --legacy --prod /app

# ----- Runtime: minimal production image --------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

EXPOSE 3002
CMD ["node", "dist/main.js"]
