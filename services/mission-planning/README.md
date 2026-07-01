# Mission Planning (Service 2)

**Stack:** Node.js · NestJS · TypeORM · Turf.js · node-mavlink · `@pawaac/shared-types`
**Datastore:** PostgreSQL + PostGIS (`postgres-mission`)
**Default port:** `3002`

Authors, versions, and validates missions; detects geofence conflicts between a
planned route and no-fly polygons; and exports PX4-compatible MAVLink missions.

## Responsibilities

- Versioned, **immutable** mission records — editing produces a new version and
  leaves prior versions byte-identical.
- Waypoint validation (altitude/speed/gimbal/loiter ranges; contiguous `seq`
  from 0).
- Geofence definition and route-vs-polygon conflict detection (PostGIS-backed,
  with an in-process geometry algorithm for parity/testing).
- Mission template library with parameter substitution.
- Deterministic MAVLink mission serialization (JSON and binary).

## Key Endpoints

Operational `/health` & `/ready` endpoints plus the following REST surfaces:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/missions` | Create a mission (`201 Created`). |
| `PUT` | `/missions/:id` | Update a mission → creates a new immutable version. |
| `GET` | `/missions/:id` | Fetch the latest mission version. |
| `GET` | `/missions/:id/versions/:version` | Fetch a specific mission version. |
| `GET` | `/missions/:id/export?format=json\|binary` | Export the mission as MAVLink (JSON or `application/octet-stream`). `422` if not validated, `409` on geofence conflict. |
| `POST` | `/geofences` | Define a no-fly polygon geofence. |
| `GET` | `/geofences` / `/geofences/:id` | List / fetch geofences. |
| `POST` | `/geofences/detect-conflicts` | Detect conflicts for a route (by `missionId` or explicit `waypoints`). |
| `GET` | `/templates` / `/templates/:id` | List / fetch mission templates. |
| `POST` | `/templates/:id/instantiate` | Instantiate a template into a validated mission. |

## Datastore

A dedicated **PostGIS-enabled PostgreSQL** database (`MISSION_DB_NAME`, default
`mission_planning`). The `postgis/postgis` image auto-enables the PostGIS
extension, giving native polygon geometry and spatial indexes for geofence
conflict queries. Schema is managed with **TypeORM migrations**
(`src/migrations/`); entities (`Mission`, `Waypoint`, `Geofence`) live under the
respective feature folders.

## Environment Variables

| Variable | Default | Secret | Description |
|----------|---------|:------:|-------------|
| `NODE_ENV` | `production` | | Runtime environment. |
| `PORT` | `3002` | | HTTP listen port (container). |
| `LOG_LEVEL` | `info` | | Log verbosity. |
| `TRACE_HEADER` | `X-Trace-Id` | | Distributed trace header name. |
| `DATABASE_URL` | derived | 🔑 | Full Postgres/PostGIS connection string. |
| `DB_HOST` | `postgres-mission` | | Database host. |
| `DB_PORT` | `5432` | | Database port. |
| `DB_USER` | `mission_planning` | | Scoped database user. |
| `DB_PASSWORD` | `CHANGE_ME_...` | 🔑 | Database password. |
| `DB_NAME` | `mission_planning` | | Database name. |

See the root [Environment Variable Reference](../../README.md#environment-variable-reference).

## Run & Test Locally

```bash
pnpm install
pnpm --filter @pawaac/mission-planning run build
pnpm --filter @pawaac/mission-planning run test     # jest --runInBand
pnpm --filter @pawaac/mission-planning run lint
```

```bash
cd services/mission-planning
pnpm typeorm migration:run -d src/data-source.ts    # apply migrations (needs PostGIS Postgres)
pnpm start                                           # node dist/main.js
```

Or bring the whole stack up with Docker Compose from the repo root.
