# API Gateway (Service 6)

**Stack:** Node.js · NestJS · @nestjs/jwt · @nestjs/swagger · http-proxy-middleware · ioredis · axios · `@pawaac/shared-types`
**Datastore:** stateless (uses Redis only for rate-limit counters)
**Default port:** `3000`

The single authenticated entry point fronting the five domain backend services.
It verifies JWTs, enforces default-deny RBAC, applies per-role rate limits,
reverse-proxies requests to the owning upstream, and serves a single merged
OpenAPI/Swagger surface.

## Responsibilities

- **Authentication:** verify the inbound JWT (signed with `JWT_SECRET`) and
  extract `{ userId, role }`; reject missing/invalid/expired tokens with `401`
  before any upstream is reached.
- **Authorization:** default-deny RBAC over four roles (`viewer` < `analyst` <
  `operator` < `super_admin`); Super Admin inherits any route granted to a
  lower-privilege role.
- **Rate limiting:** per-role fixed-window quota backed by Redis (`429` on
  exhaustion).
- **Routing:** map each gateway path prefix to exactly one upstream; unknown
  paths `404`. Trace headers are injected downstream.
- **Merged OpenAPI:** aggregate upstream specs into one document, served with a
  single Swagger UI.

## Routing Table

Each path prefix is owned by exactly one upstream (prefixes are pairwise
disjoint):

| Prefix | Upstream | Base URL env var |
|--------|----------|------------------|
| `/fleet` | Fleet Registry | `FLEET_REGISTRY_URL` |
| `/missions` | Mission Planning | `MISSION_PLANNING_URL` |
| `/telemetry` | Telemetry Ingestion | `TELEMETRY_INGESTION_URL` |
| `/vision` | Vision AI Results | `VISION_AI_URL` |
| `/alerts` | Alert & Notification | `ALERT_NOTIFICATION_URL` |

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `ALL` | `/fleet/*`, `/missions/*`, `/telemetry/*`, `/vision/*`, `/alerts/*` | Authenticated, rate-limited reverse proxy to the owning upstream. |
| `GET` | `/docs` | Single merged Swagger UI (Requirement 20.4). |
| `GET` | `/openapi.json` | Merged OpenAPI 3.0 document. |
| `GET` | `/health`, `/ready` | Liveness / readiness (incl. Redis). |

## Datastore

Stateless apart from **Redis** (shared instance), used only for per-role
rate-limit counters on DB index `GATEWAY_REDIS_DB` (default `1`).

## Environment Variables

| Variable | Default | Secret | Description |
|----------|---------|:------:|-------------|
| `NODE_ENV` | `production` | | Runtime environment. |
| `PORT` | `3000` | | HTTP listen port (container). |
| `LOG_LEVEL` | `info` | | Log verbosity. |
| `TRACE_HEADER` | `X-Trace-Id` | | Distributed trace header name. |
| `JWT_SECRET` | `CHANGE_ME_...` | 🔑 | Secret for verifying JWTs. |
| `JWT_EXPIRES_IN` | `1h` | | JWT lifetime. |
| `REDIS_HOST` | `redis` | | Redis host. |
| `REDIS_PORT` | `6379` | | Redis port. |
| `REDIS_PASSWORD` | `CHANGE_ME_...` | 🔑 | Redis password. |
| `REDIS_DB` | `1` (`GATEWAY_REDIS_DB`) | | Redis DB index for rate-limit counters. |
| `FLEET_REGISTRY_URL` | `http://fleet-registry:3001` | | Fleet Registry base URL. |
| `MISSION_PLANNING_URL` | `http://mission-planning:3002` | | Mission Planning base URL. |
| `TELEMETRY_INGESTION_URL` | `http://telemetry-ingestion:3003` | | Telemetry Ingestion base URL. |
| `VISION_AI_URL` | `http://vision-ai:8000` | | Vision AI base URL. |
| `ALERT_NOTIFICATION_URL` | `http://alert-notification:3005` | | Alert & Notification base URL. |

**Optional rate-limit overrides** (sensible defaults applied if unset):
`RATE_LIMIT_WINDOW_SEC` (`60`), `RATE_LIMIT_VIEWER` (`60`),
`RATE_LIMIT_ANALYST` (`120`), `RATE_LIMIT_OPERATOR` (`240`),
`RATE_LIMIT_SUPER_ADMIN` (`600`).

See the root [Environment Variable Reference](../../README.md#environment-variable-reference).

## Run & Test Locally

```bash
pnpm install
pnpm --filter @pawaac/api-gateway run build
pnpm --filter @pawaac/api-gateway run test     # jest --runInBand
pnpm --filter @pawaac/api-gateway run lint
```

```bash
cd services/api-gateway
pnpm start     # node dist/main.js (needs Redis + reachable upstreams)
```

Or bring the whole stack up with Docker Compose from the repo root.
