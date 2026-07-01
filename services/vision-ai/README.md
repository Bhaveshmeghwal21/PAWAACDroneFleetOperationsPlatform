# Vision AI Results (Service 4)

**Stack:** Python 3.11+ · FastAPI · Uvicorn · SQLAlchemy 2 · Alembic · psycopg 3 · Pydantic · shapely
**Datastore:** PostgreSQL (`postgres-vision`)
**Default port:** `8000`

Ingests onboard YOLOv11x OBB detections, maintains object tracks across frames
(ByteTrack-style association), classifies scene events against mission-defined
zones, and serves filtered detection queries.

> This is the only Python service. It is **outside the pnpm toolchain** and is
> built from its own directory by Docker Compose.

## Responsibilities

- Ingest detection batches (class, confidence, OBB coords, frame timestamp,
  drone id), idempotent on an idempotency key.
- Pixel/OBB → world coordinate transforms.
- Track stitching: assign a single track id per detection, matching only tracks
  of the same object class within an IoU gate; retire tracks unseen beyond
  `TRACK_MAX_AGE`.
- Scene intelligence: `person_entered_zone`, `vehicle_stopped` (continuous
  stationary span), `group_gathering` (distinct person tracks in a zone), with
  scene events forwarded to Alert & Notification.
- Detection query API by time range, zone, class, and confidence threshold.

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/detections` | Ingest a detection batch. `201 Created` for a fresh batch; `200 OK` replaying a prior result for a duplicate idempotency key; `422` on validation failure. |
| `GET` | `/detections?from=&to=&cls=&min_confidence=&zone=` | Return detections matching every supplied filter (all optional, AND-combined). `zone` is a JSON polygon ring `[[x,y],...]`. |
| `GET` | `/health` | Liveness/readiness. |
| `GET` | `/docs`, `/openapi.json` | FastAPI Swagger UI and OpenAPI schema. |

Errors use RFC 7807 problem+json; `X-Trace-Id` is propagated.

## Datastore

A dedicated **PostgreSQL** database (`VISION_DB_NAME`, default `vision_ai`)
accessed via SQLAlchemy 2 + psycopg 3. Schema is managed with **Alembic**
(`alembic/`).

## Environment Variables

The service reads configuration via Pydantic settings (see `app/config.py`).

| Variable | Default | Secret | Description |
|----------|---------|:------:|-------------|
| `ENV` | `production` | | Runtime environment (compose sets it from `NODE_ENV`). |
| `PORT` | `8000` | | HTTP listen port (container). |
| `LOG_LEVEL` | `info` | | Log verbosity. |
| `TRACE_HEADER` | `X-Trace-Id` | | Distributed trace header name. |
| `DATABASE_URL` | derived | 🔑 | SQLAlchemy URL `postgresql+psycopg://user:pass@host:5432/db`. |
| `DB_HOST` | `postgres-vision` | | Database host. |
| `DB_PORT` | `5432` | | Database port. |
| `DB_USER` | `vision_ai` | | Scoped database user. |
| `DB_PASSWORD` | `CHANGE_ME_...` | 🔑 | Database password. |
| `DB_NAME` | `vision_ai` | | Database name. |
| `ALERT_NOTIFICATION_URL` | `http://alert-notification:3005` | | Target for scene events. |
| `MISSION_PLANNING_URL` | `http://mission-planning:3002` | | Source of mission-defined zones. |
| `TRACK_MAX_AGE` | `30` | | Seconds a track may go unseen before retirement. |
| `MOVE_EPS` | `2.0` | | Displacement treated as "not moving" for `vehicle_stopped`. |

See the root [Environment Variable Reference](../../README.md#environment-variable-reference).

## Run & Test Locally

Create a virtualenv and install with the `dev` extras:

```bash
cd services/vision-ai
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

alembic upgrade head        # apply migrations (needs a reachable Postgres)
uvicorn app.main:app --port 8000

pytest                      # run unit + Hypothesis property tests
ruff check .                # lint
```

Or bring the whole stack up with Docker Compose from the repo root.
