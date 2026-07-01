# Alert & Notification (Service 5)

**Stack:** Node.js · NestJS · TypeORM · ioredis · Nodemailer · axios (OpenWA) · Socket.IO · `@pawaac/shared-types`
**Datastore:** Redis + PostgreSQL (`redis`, `postgres-alert`)
**Default port:** `3005`

Evaluates configurable alert rules against incoming anomaly/scene/maintenance
events, dispatches multi-channel notifications, manages acknowledgement and
time-based escalation, and provides history and analytics.

## Responsibilities

- Configurable rule engine (AND-combined field predicates + optional time
  window + optional zone) with pure, order-independent matching.
- Multi-channel dispatch: in-app WebSocket, email (Nodemailer), WhatsApp (OpenWA
  REST); fan-out to exactly the channels configured on the matched rule.
- Acknowledgement workflow and time-based escalation chains backed by Redis
  timers (an acknowledged alert is never subsequently escalated).
- History and analytics: alert counts grouped by zone and hour, with
  conservation (per-zone/per-hour counts sum to the total in range).

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/rules` | Upsert an alert rule; returns the stored rule. |
| `GET` | `/alerts` | Queryable, paginated history of past alerts. |
| `GET` | `/alerts/analytics` | Alert counts grouped by zone and by hour for a time range. |
| `GET` | `/health`, `/ready` | Liveness / readiness (incl. Postgres + Redis). |
| `WS` | (gateway) | In-app push channel for dispatched alerts. |

Event sources (Telemetry, Vision, Fleet) post domain events to the service's
ingest endpoint; matching rules open alerts and start escalation timers.

## Datastore

- **PostgreSQL** (`ALERT_DB_NAME`, default `alert_notification`) for rules,
  alerts, and conditions — schema managed with **TypeORM migrations**
  (`src/migrations/`).
- **Redis** for escalation timers/state (sorted sets), on DB index
  `ALERT_REDIS_DB` (default `0`); the shared Redis instance partitions the
  gateway's rate-limit counters onto a different DB index.

## Environment Variables

| Variable | Default | Secret | Description |
|----------|---------|:------:|-------------|
| `NODE_ENV` | `production` | | Runtime environment. |
| `PORT` | `3005` | | HTTP/WS listen port (container). |
| `LOG_LEVEL` | `info` | | Log verbosity. |
| `TRACE_HEADER` | `X-Trace-Id` | | Distributed trace header name. |
| `DATABASE_URL` | derived | 🔑 | Full Postgres connection string. |
| `DB_HOST` | `postgres-alert` | | Database host. |
| `DB_PORT` | `5432` | | Database port. |
| `DB_USER` | `alert_notification` | | Scoped database user. |
| `DB_PASSWORD` | `CHANGE_ME_...` | 🔑 | Database password. |
| `DB_NAME` | `alert_notification` | | Database name. |
| `REDIS_HOST` | `redis` | | Redis host. |
| `REDIS_PORT` | `6379` | | Redis port. |
| `REDIS_PASSWORD` | `CHANGE_ME_...` | 🔑 | Redis password. |
| `REDIS_DB` | `0` (`ALERT_REDIS_DB`) | | Redis DB index for escalation timers/state. |
| `SMTP_HOST` | `smtp.example.com` | | SMTP server host. |
| `SMTP_PORT` | `587` | | SMTP server port. |
| `SMTP_USER` | `CHANGE_ME_...` | 🔑 | SMTP username. |
| `SMTP_PASSWORD` | `CHANGE_ME_...` | 🔑 | SMTP password. |
| `SMTP_FROM` | `alerts@pawaac.example.com` | | From address for alert emails. |
| `SMTP_SECURE` | `false` | | TLS-on-connect transport flag. |
| `OPENWA_API_URL` | `http://localhost:8002` | | OpenWA REST base URL. |
| `OPENWA_API_KEY` | `CHANGE_ME_...` | 🔑 | OpenWA API key. |
| `OPENWA_SESSION` | `default` | | OpenWA session name. |

See the root [Environment Variable Reference](../../README.md#environment-variable-reference).

## Run & Test Locally

```bash
pnpm install
pnpm --filter @pawaac/alert-notification run build
pnpm --filter @pawaac/alert-notification run test     # jest --runInBand
pnpm --filter @pawaac/alert-notification run lint
```

```bash
cd services/alert-notification
pnpm migration:run     # apply TypeORM migrations (needs Postgres)
pnpm start             # node dist/main.js (needs Postgres + Redis)
```

Or bring the whole stack up with Docker Compose from the repo root.
