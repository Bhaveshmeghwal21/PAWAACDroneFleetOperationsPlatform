# =============================================================================
# Ops Dashboard (Service 7) — Next.js standalone multi-stage image.
#
# IMPORTANT: the build context is the MONOREPO ROOT (see docker-compose.yml:
#   build: { context: ., dockerfile: services/ops-dashboard/Dockerfile })
# so the pnpm workspace and the `@pawaac/shared-types` package resolve.
#
# The runtime container listens on port 3006 (matching docker-compose and
# .env.example: OPS_DASHBOARD_PORT / container PORT=3006).
# =============================================================================

# ---- Stage 1: build -------------------------------------------------------
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /repo

# Workspace manifests first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY services/ops-dashboard/package.json services/ops-dashboard/

# Install all workspace deps (needed to build shared-types + the dashboard).
RUN pnpm install --frozen-lockfile

# Source.
COPY packages/shared-types/ packages/shared-types/
COPY services/ops-dashboard/ services/ops-dashboard/

# Build the shared types first, then the Next.js app (emits .next/standalone).
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @pawaac/shared-types run build \
  && pnpm --filter @pawaac/ops-dashboard run build

# ---- Stage 2: runtime -----------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3006
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# `output: 'standalone'` with outputFileTracingRoot=<repo root> preserves the
# monorepo path layout, so the server entrypoint lives at
# services/ops-dashboard/server.js and node_modules sit at /app.
COPY --from=builder /repo/services/ops-dashboard/.next/standalone ./
COPY --from=builder /repo/services/ops-dashboard/.next/static ./services/ops-dashboard/.next/static
COPY --from=builder /repo/services/ops-dashboard/public ./services/ops-dashboard/public

EXPOSE 3006
CMD ["node", "services/ops-dashboard/server.js"]
