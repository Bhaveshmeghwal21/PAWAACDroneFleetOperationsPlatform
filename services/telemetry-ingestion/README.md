# Telemetry Ingestion (Service 3)

**Stack:** Node.js (plain, ESM) · `ws` WebSocket server · node-mavlink · `pg` · node-pg-migrate · `@pawaac/shared-types`
**Datastore:** TimescaleDB (`timescaledb-telemetry`)
**Default port:** `3003`

Accepts many concurrent MAVLink WebSocket streams from drones, parses frames
into normalized samples, persists them to a TimescaleDB hypertable, runs
real-time anomaly detection, and serves downsampled historical queries.

## Responsibilities

- High-throughput WebSocket ingest server (target ≥10 drones × 10Hz), with
  per-drone token authentication.
- MAVLink parsing into normalized samples (GPS, altitude, velocity, attitude,
  battery, EKF2 health, RC, flight mode, armed).
- Real-time anomaly detection (altitude drop, battery drain spike, EKF2
  degradation, GPS accuracy loss); anomalies are pushed to the Alert service and
  live to the dashboard.
- Batched persistence to a TimescaleDB hypertable with bounds enforcement
  (`remainingPct`/`rcSignalStrength` in `[0,100]`, strictly increasing
  timestamps per drone).
- Historical query API with time-range filtering and downsampling.

## Key Endpoints

This service exposes a minimal Node `http` server plus a WebSocket endpoint:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness probe. |
| `GET` | `/ready` | Readiness incl. datastore connectivity. |
| `GET` | `/telemetry/:droneId/history?from=&to=&buckets=` | Historical samples in `[from,to]`, downsampled to at most `buckets`. `400` on invalid range. |
| `WS` | `/` (upgrade) | Drone telemetry stream; authenticated with `DRONE_AUTH_TOKEN`. |

Errors use RFC 7807 problem+json; `X-Trace-Id` is propagated.

## Datastore

A dedicated **TimescaleDB** instance (`TELEMETRY_DB_NAME`, default `telemetry`).
Samples are stored in a hypertable for high-rate ingest and efficient
time-range/downsampled queries. Schema is managed with **node-pg-migrate**
(`src/migrations/`).

## Environment Variables

| Variable | Default | Secret | Description |
|----------|---------|:------:|-------------|
| `NODE_ENV` | `production` | | Runtime environment. |
| `PORT` | `3003` | | HTTP/WS listen port (container). |
| `LOG_LEVEL` | `info` | | Log verbosity. |
| `TRACE_HEADER` | `X-Trace-Id` | | Distributed trace header name. |
| `DATABASE_URL` | derived | 🔑 | Full TimescaleDB connection string. |
| `DB_HOST` | `timescaledb-telemetry` | | Database host. |
| `DB_PORT` | `5432` | | Database port. |
| `DB_USER` | `telemetry` | | Scoped database user. |
| `DB_PASSWORD` | `CHANGE_ME_...` | 🔑 | Database password. |
| `DB_NAME` | `telemetry` | | Database name. |
| `DRONE_AUTH_TOKEN` | `CHANGE_ME_...` | 🔑 | Per-drone token required to open the telemetry WebSocket. |
| `ALERT_NOTIFICATION_URL` | `http://alert-notification:3005` | | Target for anomaly events. |
| `ALT_DROP_THRESHOLD` | `10` | | Descent rate (m/s) flagging `ALTITUDE_DROP`. |
| `BATTERY_DRAIN_THRESHOLD` | `1` | | Drain rate (%/s) flagging `BATTERY_DRAIN_SPIKE`. |

See the root [Environment Variable Reference](../../README.md#environment-variable-reference).

## Run & Test Locally

```bash
pnpm install
pnpm --filter @pawaac/telemetry-ingestion run build
pnpm --filter @pawaac/telemetry-ingestion run test     # jest (experimental VM modules)
pnpm --filter @pawaac/telemetry-ingestion run lint
```

```bash
cd services/telemetry-ingestion
pnpm migrate:up        # apply migrations (creates the hypertable)
pnpm start             # node dist/index.js
pnpm loadtest          # run the 10×10Hz load harness (see BENCHMARKS.md)
```

Or bring the whole stack up with Docker Compose from the repo root.
