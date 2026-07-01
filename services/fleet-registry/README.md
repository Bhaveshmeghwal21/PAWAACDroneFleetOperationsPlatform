# Fleet Registry (Service 1)

**Stack:** Node.js · NestJS · TypeORM · `@pawaac/shared-types`
**Datastore:** PostgreSQL (`postgres-fleet`)
**Default port:** `3001`

System of record for drone assets and their component lifecycle. Owns drone CRUD
with optimistic concurrency, tracks component usage counters, derives
maintenance-due/overdue alerts from configurable thresholds, and broadcasts
WebSocket events on status changes and maintenance transitions.

## Responsibilities

- CRUD over drones with optimistic concurrency (monotonic `version` field).
- Track component usage counters (battery cycles, motor hours, propeller
  replacements), enforcing non-negative invariants and unique serial numbers.
- Derive maintenance-due/overdue alerts from per-drone thresholds (a component
  is due **iff** its counter meets/exceeds its threshold).
- Broadcast status-change and maintenance-transition events over WebSocket; a
  resilient publisher also emits maintenance-due events toward Alert &
  Notification.

## Key Endpoints

Base path `/drones` (REST), plus `/health` & `/ready` operational endpoints and
a WebSocket gateway for status-change events.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/drones` | Create a drone (`201 Created`). |
| `GET` | `/drones` | List drones (optional filter query). |
| `GET` | `/drones/:id` | Fetch a drone by id. |
| `PATCH` | `/drones/:id` | Update a drone; emits a status-change WS event when status differs. |
| `POST` | `/drones/:id/decommission` | Decommission a drone. |
| `POST` | `/drones/:id/component-usage` | Record component usage, returning updated lifecycle counters. |
| `GET` | `/drones/:id/maintenance` | Evaluate and return maintenance alerts. |
| `GET` | `/health`, `/ready` | Liveness / readiness (incl. datastore connectivity). |

## Datastore

A dedicated PostgreSQL database (`FLEET_DB_NAME`, default `fleet_registry`)
accessed by a scoped user. Schema is managed with **TypeORM migrations** (see
`src/migrations/`); the `Drone` and `ComponentLifecycle` entities live under
`src/drones/entities/`.

## Environment Variables

Set in `docker-compose.yml` from the root `.env`; see the root
[Environment Variable Reference](../../README.md#environment-variable-reference).

| Variable | Default | Secret | Description |
|----------|---------|:------:|-------------|
| `NODE_ENV` | `production` | | Runtime environment. |
| `PORT` | `3001` | | HTTP listen port (container). |
| `LOG_LEVEL` | `info` | | Log verbosity. |
| `TRACE_HEADER` | `X-Trace-Id` | | Distributed trace header name. |
| `DATABASE_URL` | derived | 🔑 | Full Postgres connection string (contains credentials). |
| `DB_HOST` | `postgres-fleet` | | Database host. |
| `DB_PORT` | `5432` | | Database port. |
| `DB_USER` | `fleet_registry` | | Scoped database user. |
| `DB_PASSWORD` | `CHANGE_ME_...` | 🔑 | Database password. |
| `DB_NAME` | `fleet_registry` | | Database name. |
| `ALERT_NOTIFICATION_URL` | `http://alert-notification:3005` | | Target for maintenance-due events. |

## Run & Test Locally

From the repository root (preferred, so the workspace `@pawaac/shared-types`
dependency resolves):

```bash
pnpm install
pnpm --filter @pawaac/fleet-registry run build
pnpm --filter @pawaac/fleet-registry run test     # jest --runInBand
pnpm --filter @pawaac/fleet-registry run lint
```

Run the service (expects a reachable Postgres and the `DB_*`/`DATABASE_URL`
variables set):

```bash
cd services/fleet-registry
pnpm typeorm migration:run -d src/data-source.ts   # apply migrations
pnpm start                                          # node dist/main.js
```

Or run the whole platform with Docker Compose from the repo root (see the
[root README](../../README.md#quick-start-docker-compose)).
