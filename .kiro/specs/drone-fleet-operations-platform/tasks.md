# Implementation Plan: PAWAAC Drone Fleet Operations Platform

## Overview

This plan converts the design into a sequence of incremental, code-focused tasks for a code-generation LLM. Work proceeds in a strict dependency order: shared foundation first, then each of the seven services built one at a time, then cross-cutting finalization.

A core engineering discipline is **green-before-proceed**: for every service we install dependencies, implement the code, write its full test suite (unit + property-based + integration + E2E/load as applicable), run the suite, read failures, fix them, and re-run until fully green before advancing to the next service (Requirements 33.1–33.3).

Conventions used throughout:
- Backend services 1, 2, 5, 6 use **NestJS + TypeScript**; service 3 uses **plain Node + TypeScript**; service 4 uses **Python 3.11 + FastAPI**; service 7 uses **Next.js + TypeScript + Tailwind + Leaflet**.
- Property-based tests use **fast-check** (Node/TS) and **Hypothesis** (Python), MUST run **at least 100 iterations** per property, and MUST reference their design property number (Requirement 30.3).
- Tasks marked with `*` are optional test sub-tasks and may be skipped for a faster MVP; core implementation tasks are never optional.
- Each service ends in a checkpoint enforcing the green-before-proceed gate.

## Tasks

- [x] 1. Scaffold monorepo, shared types package, and orchestration
  - [x] 1.1 Initialize monorepo workspace and tooling
    - Create the workspace root with a package manager workspaces config (pnpm/npm workspaces) and a `services/` layout for the 7 services plus `packages/shared-types`
    - Add root-level lint/format config (ESLint + Prettier) and a root `tsconfig.base.json`
    - Add root scripts to lint, test, and build all workspaces
    - _Requirements: 27.1, 30.1_

  - [x] 1.2 Implement the `@pawaac/shared-types` package
    - Define TypeScript interfaces/enums for all cross-service DTOs and events: `Drone`, `DroneStatus`, `ComponentLifecycle`, `MaintenanceThresholds`, `Waypoint`, `Mission`, `Geofence`, `TelemetrySample`, `Anomaly`, `Detection`, `Track`, `SceneEvent`, `AlertRule`, `Alert`, `Condition`, `Channel`, `Role`, `DomainEvent`
    - Export an index barrel so all Node services consume one source of truth
    - Configure the package build (tsc) so consuming services type-check against it
    - _Requirements: 27.1, 27.2_

  - [x]* 1.3 Write unit tests for shared-types guards/validators
    - Test any runtime type-guards or enum validators exported from the package
    - _Requirements: 27.1_

  - [x] 1.4 Author Docker Compose for all services and datastores
    - Define services for Fleet Registry, Mission Planning, Telemetry Ingestion, Vision AI, Alert & Notification, API Gateway, Ops Dashboard
    - Define datastores: Postgres (with PostGIS for Mission Planning), TimescaleDB, Redis, following database-per-service (separate DB/schema and scoped user per service)
    - Wire healthchecks and `depends_on` so a failed service/datastore aborts bring-up rather than leaving a partial environment
    - Reference all secrets/config via environment variables only
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 31.3_

- [x] 2. Checkpoint - shared foundation
  - Ensure shared-types builds, lints, and tests pass, and `docker compose config` validates. Ask the user if questions arise.

- [x] 3. Service 1 — Fleet Registry (NestJS + Postgres)
  - [x] 3.1 Bootstrap service and install dependencies
    - Create the NestJS app, add `@pawaac/shared-types`, TypeORM/Prisma, class-validator, WebSocket gateway deps, and Jest + fast-check + Supertest + Testcontainers
    - Add `/health` and `/ready` (with DB connectivity) endpoints and RFC 7807 problem+json error filter + `X-Trace-Id` propagation
    - _Requirements: 33.1, 34.1, 34.2, 34.3_

  - [x] 3.2 Define entities and versioned migrations
    - Implement `Drone` (with `version` optimistic-lock column, unique `serialNumber`, JSONB `hardwareConfig`, status enum) and `ComponentLifecycle` + `MaintenanceThresholds` entities
    - Create versioned migrations (no raw SQL DDL); fail fast on schema mismatch at startup
    - _Requirements: 1.1, 28.1, 28.3, 28.4_

  - [x] 3.3 Implement Drone CRUD with validation and optimistic locking
    - Implement create (reject empty/duplicate serial), get, list-with-filter, update, decommission
    - Enforce serial uniqueness and reject stale-version updates with 409
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 1.9, 1.10_

  - [x]* 3.4 Write property tests for Drone CRUD invariants
    - **Property P1: Status round-trip** — update status then get returns same status — **Validates: Requirements 1.7**
    - **Property P2: Version monotonicity** — every successful update yields strictly greater version — **Validates: Requirements 1.8**
    - **Property P6: Serial uniqueness** — no two drones share a serialNumber — **Validates: Requirements 1.3**
    - Run >=100 iterations each with fast-check
    - _Requirements: 1.3, 1.7, 1.8_

  - [x] 3.5 Implement component lifecycle and maintenance evaluation
    - Implement `recordComponentUsage` updating counters (clamped >= 0) and pure `evaluateMaintenance` deriving due/overdue alerts from thresholds
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x]* 3.6 Write property tests for lifecycle and maintenance
    - **Property P3: Counters non-negative** — all lifecycle counters remain >= 0 — **Validates: Requirements 2.2**
    - **Property P4: Maintenance soundness** — due alert iff counter >= threshold; pure/deterministic — **Validates: Requirements 2.3, 2.4**
    - Run >=100 iterations each
    - _Requirements: 2.2, 2.3, 2.4_

  - [x] 3.7 Implement WebSocket status-change and maintenance-due events
    - Emit a status-change WS event iff persisted status actually changed; emit maintenance-due events for the Alert Service; queue/retry on delivery failure
    - _Requirements: 2.5, 3.1, 3.2, 3.3, 3.4_

  - [x]* 3.8 Write property + unit tests for event fidelity
    - **Property P5: Status-change event fidelity** — WS event emitted iff status changed — **Validates: Requirements 3.2, 3.3**
    - Add unit tests for retry-on-failure queueing
    - Run >=100 iterations for P5
    - _Requirements: 3.2, 3.3, 3.4_

  - [x]* 3.9 Write integration tests against real Postgres
    - Test all REST endpoints against Postgres via Testcontainers (CRUD, lifecycle, optimistic-lock 409, validation errors)
    - _Requirements: 1.1, 1.4, 1.5, 1.9, 2.1_

  - [x]* 3.10 Write E2E WebSocket test for status events
    - Drive a status change and assert the WS status-change event is received end-to-end
    - _Requirements: 3.2_

- [x] 4. Checkpoint - Fleet Registry green-before-proceed
  - Install deps, run the full Fleet Registry suite (unit + property + integration + E2E), fix any failures, and re-run until fully green before proceeding. Ask the user if questions arise.
  - _Requirements: 33.1, 33.2, 33.3_

- [x] 5. Service 2 — Mission Planning (NestJS + Postgres/PostGIS)
  - [x] 5.1 Bootstrap service and install dependencies
    - Create the NestJS app with `@pawaac/shared-types`, TypeORM (PostGIS geometry mapping), class-validator, an in-process geometry helper, a MAVLink mission library, and Jest + fast-check + Supertest + Testcontainers
    - Add `/health`, `/ready`, RFC 7807 errors, and `X-Trace-Id`
    - _Requirements: 33.1, 34.1, 34.2, 34.3_

  - [x] 5.2 Define mission/geofence entities and migrations
    - Implement `Mission` (immutable versioned records), `Waypoint`, and `Geofence` (PostGIS polygon) entities with versioned migrations (no raw SQL DDL)
    - _Requirements: 4.1, 28.1, 28.3_

  - [x] 5.3 Implement waypoint validation and versioned mission authoring
    - Implement create-mission, version-on-edit (new version = prior+1, prior versions byte-identical), and get-specific-version
    - Enforce waypoint ranges (lat/lon/altitude/speed/gimbal/loiter) and contiguous seq from 0; reject invalid edits without creating a version
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x]* 5.4 Write property tests for validation and versioning
    - **Property P10: Waypoint validation** — validates iff all waypoints in range and seq contiguous from 0 — **Validates: Requirements 4.2**
    - **Property P11: Immutable versioning** — edit creates v+1 and leaves v byte-identical — **Validates: Requirements 4.5, 4.7**
    - Run >=100 iterations each
    - _Requirements: 4.2, 4.5, 4.7_

  - [x] 5.5 Implement geofence definition and conflict detection
    - Implement `defineGeofence` (reject non-closed/self-intersecting polygons) and `detectConflicts` (in-process ray-casting + segment-intersection, with PostGIS `ST_Intersects` production path); no input mutation; deterministic
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x]* 5.6 Write property tests for conflict detection
    - **Property P7: Conflict completeness** — empty iff no segment enters/touches any polygon; one conflict per (segment, zone) — **Validates: Requirements 5.3, 5.4**
    - **Property P8: Conflict determinism** — identical inputs give identical results — **Validates: Requirements 5.5**
    - **Property P9: Point-in-polygon parity** — in-process agrees with PostGIS within tolerance — **Validates: Requirements 5.6**
    - Run >=100 iterations each
    - _Requirements: 5.3, 5.4, 5.5, 5.6_

  - [x] 5.7 Implement mission template library
    - Implement `instantiateTemplate` with parameter substitution; reject missing required params; leave no unresolved placeholders
    - _Requirements: 6.1, 6.2, 6.3_

  - [x]* 5.8 Write property test for template substitution
    - **Property P14: Template substitution totality** — valid params leave no unresolved placeholder — **Validates: Requirements 6.1, 6.3**
    - Run >=100 iterations
    - _Requirements: 6.1, 6.3_

  - [x] 5.9 Implement MAVLink export (JSON + binary)
    - Implement `exportMavlink`: require validated mission, build home/takeoff item + one MISSION_ITEM_INT per waypoint in seq order, encode lat/lon as int32 degrees*1e7 and altitude in meters; block export when conflicts exist; deterministic bytes
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 7.7_

  - [x]* 5.10 Write property tests for MAVLink export
    - **Property P12: MAVLink round-trip** — parse(export(m,'binary')) equals canonical geometry/params — **Validates: Requirements 7.5**
    - **Property P13: Export determinism** — identical bytes across runs — **Validates: Requirements 7.6**
    - Run >=100 iterations each
    - _Requirements: 7.5, 7.6_

  - [x]* 5.11 Write integration tests against Postgres/PostGIS
    - Test all CRUD endpoints, geofence persistence, PostGIS-backed conflict queries, version retrieval, and export 409-on-conflict via Testcontainers
    - _Requirements: 4.1, 4.8, 5.1, 5.2, 7.2, 7.7_

- [x] 6. Checkpoint - Mission Planning green-before-proceed
  - Install deps, run the full Mission Planning suite, fix failures, re-run until fully green. Ask the user if questions arise.
  - _Requirements: 33.1, 33.2, 33.3_

- [x] 7. Service 3 — Telemetry Ingestion (Node + TimescaleDB)
  - [x] 7.1 Bootstrap service and install dependencies
    - Create the Node + TypeScript service with `@pawaac/shared-types`, a WS server, a MAVLink parser lib, a TimescaleDB client + migrations tool, and Jest + fast-check + k6/Artillery
    - Add `/health`, `/ready` (DB connectivity), RFC 7807 errors, and `X-Trace-Id`
    - _Requirements: 33.1, 34.1, 34.2, 34.3_

  - [x] 7.2 Define TimescaleDB hypertable and migrations
    - Create the `TelemetrySample` hypertable (time dimension `ts`) and continuous aggregates for downsampling via versioned migrations (no raw SQL DDL)
    - Enforce uniqueness per (droneId, ts)
    - _Requirements: 8.2, 28.1, 28.3_

  - [x] 7.3 Implement WS ingest and MAVLink parsing/persistence
    - Implement `handleConnection` (accept valid drone token, ack subscription), `parseFrame` (normalized sample, reject malformed → drop + increment parse-error metric + keep socket open), and batched `persist` to TimescaleDB
    - Enforce bounds on persisted samples (remainingPct, rcSignalStrength in [0,100]) and strictly increasing per-drone timestamps
    - _Requirements: 8.1, 8.2, 8.4, 8.5, 8.6_

  - [x]* 7.4 Write property tests for parsing and persistence invariants
    - **Property P15: Parse/serialize round-trip** — parseFrame(encode(s)) reconstructs s within tolerance — **Validates: Requirements 8.3**
    - **Property P18: Bounds invariants** — persisted samples have remainingPct, rcSignalStrength in [0,100] — **Validates: Requirements 8.4**
    - **Property P19: Monotonic timestamps** — per drone, persisted samples strictly increasing in ts — **Validates: Requirements 8.5**
    - Run >=100 iterations each
    - _Requirements: 8.3, 8.4, 8.5_

  - [x] 7.5 Implement real-time anomaly detection
    - Implement pure `detectAnomalies` covering ALTITUDE_DROP, BATTERY_DRAIN_SPIKE, EKF2_DEGRADED, GPS_ACCURACY_LOSS; emit anomaly events to the Alert Service and push to the dashboard
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x]* 7.6 Write property tests for anomaly detection
    - **Property P16: Anomaly purity** — equal (sample, history) ⇒ equal output — **Validates: Requirements 9.2**
    - **Property P17: Altitude-drop soundness/completeness** — ALTITUDE_DROP iff descent rate > threshold — **Validates: Requirements 9.3**
    - Run >=100 iterations each; add unit tests for battery/EKF2/GPS branches
    - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.6_

  - [x] 7.7 Implement historical query with downsampling
    - Implement `queryHistory` with time-range filtering and downsample bucket cap; reject from > to with a validation error
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x]* 7.8 Write property tests for historical query
    - **Property P20: Downsampling bound** — returns at most the requested bucket count — **Validates: Requirements 10.3**
    - **Property P21: Query time-range soundness** — every returned sample has from <= ts <= to — **Validates: Requirements 10.2**
    - Run >=100 iterations each
    - _Requirements: 10.2, 10.3_

  - [x]* 7.9 Write integration tests against TimescaleDB
    - Test historical query endpoints (range filtering, downsampling, from>to rejection) via Testcontainers
    - _Requirements: 10.1, 10.4_

  - [x] 7.10 Implement load test harness for sustained ingest
    - Build a k6/Artillery harness simulating 10 concurrent drone streams at 10 Hz sustained, recording throughput and p50/p95/p99 ingest latency and dropped-frame rate
    - _Requirements: 8.7, 32.1, 32.2_

- [x] 8. Checkpoint - Telemetry Ingestion green-before-proceed
  - Install deps, run the full Telemetry suite (unit + property + integration + load), fix failures, re-run until fully green. Ask the user if questions arise.
  - _Requirements: 32.1, 33.1, 33.2, 33.3_

- [x] 9. Service 4 — Vision AI Results (FastAPI + Postgres)
  - [x] 9.1 Bootstrap service and install dependencies
    - Create the FastAPI app, add SQLAlchemy + Alembic, Pydantic, shapely, and Pytest + Hypothesis
    - Add `/health`, `/ready` (DB connectivity), RFC 7807 problem+json errors, and `X-Trace-Id`
    - _Requirements: 33.1, 34.1, 34.2, 34.3_

  - [x] 9.2 Define detection/track models and migrations
    - Implement `Detection`, `Track`, `SceneEvent` models with Alembic versioned migrations (no raw SQL DDL)
    - _Requirements: 11.1, 28.1, 28.3_

  - [x] 9.3 Implement detection ingest with validation and idempotency
    - Implement `ingest_detections`: persist each detection (class, confidence, OBB, frame_ts, drone_id); reject confidence outside [0,1] or OBB not exactly 5 elements with positive w/h; return prior result on duplicate idempotency key
    - _Requirements: 11.1, 11.2, 11.8_

  - [x] 9.4 Implement OBB transforms and track stitching
    - Implement `transform_obb` (and inverse) and ByteTrack-style `stitch_tracks`: total assignment, same-class matching, confidence/class preserved, stale-track retirement beyond MAX_AGE
    - _Requirements: 11.3, 11.4, 11.5, 11.6, 11.7_

  - [x]* 9.5 Write Hypothesis property tests for ingest and stitching
    - **Property P22: Total assignment** — every detection gets exactly one track_id — **Validates: Requirements 11.3**
    - **Property P23: Class consistency** — all detections in a track share one class — **Validates: Requirements 11.4**
    - **Property P24: OBB transform invertibility** — transform then inverse returns original within tolerance — **Validates: Requirements 11.7**
    - **Property P25: Confidence preservation** — stitching never alters confidence or class — **Validates: Requirements 11.5**
    - **Property P26: Stale retirement** — tracks unseen > MAX_AGE absent from active set — **Validates: Requirements 11.6**
    - Run >=100 iterations each with Hypothesis
    - _Requirements: 11.3, 11.4, 11.5, 11.6, 11.7_

  - [x] 9.6 Implement scene event classification
    - Implement `classify_scene_events`: person_entered_zone (outside→inside transition), vehicle_stopped (>60s below MOVE_EPS), group_gathering (>5 distinct person tracks in a zone by global occupancy); reference only existing track ids and defined zones; forward events to the Alert Service
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x]* 9.7 Write Hypothesis property tests for scene classification
    - **Property P27: Group-gathering threshold** — fires iff > 5 distinct person tracks simultaneously in same zone — **Validates: Requirements 12.3**
    - **Property P28: Zone-entry edge** — person_entered_zone iff outside→inside transition — **Validates: Requirements 12.1**
    - Run >=100 iterations each
    - _Requirements: 12.1, 12.3_

  - [x] 9.8 Implement detection query API
    - Implement `query_detections` REST endpoint filtering by time range, zone, class, and confidence >= threshold
    - _Requirements: 13.1, 13.2_

  - [x]* 9.9 Write Hypothesis property test + integration tests for query
    - **Property P29: Query filter soundness** — returns only detections matching all of (time range, zone, class, confidence >= threshold) — **Validates: Requirements 13.1**
    - Add integration tests for ingest + query endpoints against Postgres (Testcontainers), including idempotent duplicate-batch behavior
    - Run >=100 iterations for P29
    - _Requirements: 11.8, 13.1, 13.2_

- [x] 10. Checkpoint - Vision AI green-before-proceed
  - Install deps, run the full Vision AI suite (unit + Hypothesis property + integration), fix failures, re-run until fully green. Ask the user if questions arise.
  - _Requirements: 33.1, 33.2, 33.3_

- [x] 11. Service 5 — Alert & Notification (NestJS + Redis + Postgres)
  - [x] 11.1 Bootstrap service and install dependencies
    - Create the NestJS app with `@pawaac/shared-types`, TypeORM/Prisma (Postgres), Redis client (sorted sets + Lua), Nodemailer, an OpenWA REST client, a WS gateway, and Jest + fast-check + Supertest + Testcontainers
    - Add `/health`, `/ready`, RFC 7807 errors, and `X-Trace-Id`
    - _Requirements: 33.1, 34.1, 34.2, 34.3_

  - [x] 11.2 Define rule/alert models and migrations
    - Implement `AlertRule`, `Alert`, and `Condition` persistence with versioned migrations (no raw SQL DDL); Redis structures for escalation timers and state
    - _Requirements: 14.1, 28.1, 28.3_

  - [x] 11.3 Implement configurable rule engine
    - Implement `upsertRule` and pure, order-independent `evaluateRules` (enabled + kind + zone + time-window + AND conditions), supporting wrap-around time windows
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [x]* 11.4 Write property tests for rule engine
    - **Property P30: Rule match soundness** — match iff enabled, kind, zone (if set), time window (if set), all conditions hold — **Validates: Requirements 14.2**
    - **Property P31: Rule order independence** — permuting rules yields same matched set — **Validates: Requirements 14.3**
    - **Property P32: Time-window wrap-around** — startMin > endMin includes after-start or before-end times — **Validates: Requirements 14.4**
    - Run >=100 iterations each
    - _Requirements: 14.2, 14.3, 14.4_

  - [x] 11.5 Implement multi-channel dispatch
    - Implement `dispatch` to exactly the rule's configured channels (in-app WS, email via Nodemailer, WhatsApp via OpenWA); treat partial delivery as success; on failure mark channel failed, retry with backoff, fall back to in-app WS (skip WS fallback if WS already failed)
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [x]* 11.6 Write property + unit tests for dispatch
    - **Property P37: Dispatch fan-out** — dispatched to exactly the channels configured on its rule — **Validates: Requirements 15.1**
    - Add unit tests with mocked OpenWA and Nodemailer test transport for failure/backoff/fallback paths
    - Run >=100 iterations for P37
    - _Requirements: 15.1, 15.5, 15.6_

  - [x] 11.7 Implement acknowledgement and escalation
    - Persist alerts OPEN at level 0; implement `acknowledge` (OPEN/ESCALATED → ACKNOWLEDGED, cancel timer, idempotent) and `tickEscalations` (increment level, dispatch next contact, reschedule; never escalate acknowledged/closed; cap level at chain length; enforce legal status transitions)
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7_

  - [x]* 11.8 Write property tests for escalation workflow
    - **Property P33: Ack cancels escalation** — acknowledged alert is never subsequently escalated — **Validates: Requirements 16.4**
    - **Property P34: Escalation bound** — escalationLevel never exceeds chain length — **Validates: Requirements 16.6**
    - **Property P35: Escalation monotonicity** — each escalating tick strictly increases level and reschedules further out — **Validates: Requirements 16.5**
    - **Property P36: Ack idempotency** — acking an acknowledged alert is a no-op returning same state — **Validates: Requirements 16.3**
    - **Property P38: Status transition legality** — status follows only OPEN→(ACK|ESCALATED)→CLOSED — **Validates: Requirements 16.7**
    - Run >=100 iterations each
    - _Requirements: 16.3, 16.4, 16.5, 16.6, 16.7_

  - [x] 11.9 Implement history and analytics
    - Implement `getAnalytics` returning counts grouped by zone and hour, and a queryable alert history; ensure conservation (per-zone/per-hour counts sum to total)
    - _Requirements: 17.1, 17.2, 17.3_

  - [x]* 11.10 Write property + integration tests for analytics and channels
    - **Property P39: Analytics conservation** — sum of per-zone/per-hour counts equals total in range — **Validates: Requirements 17.2**
    - Add integration tests for each channel (mocked OpenWA, Nodemailer test transport) and rule/alert persistence against Postgres + Redis (Testcontainers)
    - Run >=100 iterations for P39
    - _Requirements: 15.2, 15.3, 15.4, 17.1, 17.3_

- [x] 12. Checkpoint - Alert & Notification green-before-proceed
  - Install deps, run the full Alert suite (unit + property + integration), fix failures, re-run until fully green. Ask the user if questions arise.
  - _Requirements: 33.1, 33.2, 33.3_

- [x] 13. Service 6 — API Gateway (NestJS)
  - [x] 13.1 Bootstrap service and install dependencies
    - Create the NestJS gateway with `@pawaac/shared-types`, JWT lib, Redis client (rate-limit counters), a reverse-proxy/routing layer, OpenAPI aggregation, and Jest + fast-check + Supertest
    - Add `/health`, `/ready`, RFC 7807 errors
    - _Requirements: 33.1, 34.1, 34.2_

  - [x] 13.2 Implement authentication and RBAC authorization
    - Implement `authenticate` (reject missing/expired/invalid JWT before upstream, 401), role extraction, and `authorize` (default-deny; permit iff role explicitly allowed; Super Admin inherits lower-privilege routes)
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_

  - [x]* 13.3 Write property tests for auth/RBAC
    - **Property P40: Default deny** — authorize false for any (role, route) not explicitly permitted — **Validates: Requirements 18.3**
    - **Property P41: Role monotonicity** — any route permitted to a lower role is permitted to Super Admin — **Validates: Requirements 18.4**
    - **Property P45: Auth required** — requests without valid JWT rejected before any upstream — **Validates: Requirements 18.1**
    - Run >=100 iterations each
    - _Requirements: 18.1, 18.3, 18.4_

  - [x] 13.4 Implement rate limiting, logging, and tracing
    - Implement per-role token-bucket rate limiting (Redis) returning 429 + Retry-After on exceed; inject a non-empty trace id into downstream requests; log requests with trace id
    - _Requirements: 19.1, 19.2, 19.3, 19.4_

  - [x]* 13.5 Write property tests for rate limiting and tracing
    - **Property P42: Rate-limit safety** — allowed requests in a window never exceed the role's configured limit — **Validates: Requirements 19.1**
    - **Property P44: Trace propagation** — every proxied request carries a non-empty trace id downstream — **Validates: Requirements 19.3**
    - Run >=100 iterations each
    - _Requirements: 19.1, 19.3_

  - [x] 13.6 Implement routing and merged OpenAPI
    - Implement `route` mapping every known path to exactly one upstream (404 on unknown) and a merged OpenAPI 3.0 document + single Swagger UI aggregating upstream specs
    - _Requirements: 20.1, 20.2, 20.3, 20.4_

  - [x]* 13.7 Write property + integration tests for routing
    - **Property P43: Routing totality & disjointness** — every known path maps to exactly one upstream; unknown paths 404 — **Validates: Requirements 20.1, 20.2**
    - Add integration tests for auth flows, rate-limit 429, routing to upstreams, and merged OpenAPI/Swagger serving
    - Run >=100 iterations for P43
    - _Requirements: 18.5, 19.2, 20.1, 20.2, 20.3, 20.4_

- [x] 14. Checkpoint - API Gateway green-before-proceed
  - Install deps, run the full Gateway suite (unit + property + integration), fix failures, re-run until fully green. Ask the user if questions arise.
  - _Requirements: 33.1, 33.2, 33.3_

- [x] 15. Service 7 — Ops Dashboard (Next.js + TS + Tailwind + Leaflet)
  - [x] 15.1 Bootstrap dashboard and install dependencies
    - Create the Next.js + TypeScript + Tailwind app, add Leaflet, a typed Gateway API client (consuming `@pawaac/shared-types`), WS clients, and Playwright
    - _Requirements: 33.1_

  - [x] 15.2 Implement real-time fleet map
    - Render live drone positions, battery, and flight mode on a Leaflet map; update on status-change events
    - _Requirements: 21.1, 21.2, 21.3_

  - [x] 15.3 Implement drag-and-drop mission planner
    - Build the waypoint drag editor, geofence polygon drawing, submission through the Gateway to Mission Planning, local-storage retry on transmission failure, and display of geofence conflict segments
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5_

  - [x] 15.4 Implement live telemetry panels
    - Build attitude, battery, EKF2 health, and altitude panels for the selected drone with per-panel error fallback and live updates
    - _Requirements: 23.1, 23.2, 23.3_

  - [x] 15.5 Implement alert feed with acknowledge workflow
    - Display WS-pushed alerts with display-retry/log-on-failure; send acknowledgement through the Gateway and update feed status on ack
    - _Requirements: 24.1, 24.2, 24.3, 24.4_

  - [x] 15.6 Implement detection replay timeline
    - Build a timeline scrubber overlaying detections on the map and querying Vision AI through the Gateway for selected ranges
    - _Requirements: 25.1, 25.2_

  - [x]* 15.7 Write Playwright E2E tests against a seeded environment
    - Cover login, create mission, view telemetry, and acknowledge alert against the seeded Docker Compose environment
    - _Requirements: 21.1, 22.3, 23.1, 24.3_

- [x] 16. Checkpoint - Ops Dashboard green-before-proceed
  - Install deps, run lint/build and the Playwright E2E suite against the seeded environment, fix failures, re-run until fully green. Ask the user if questions arise.
  - _Requirements: 33.1, 33.2, 33.3_

- [x] 17. Cross-cutting finalization
  - [x] 17.1 Implement deterministic seed script
    - Create a seed script producing 5 drones, 3 missions, 72h of telemetry, 200 detections, and 15 alerts, deterministic across repeated runs (fixed RNG seed)
    - _Requirements: 29.1, 29.2_

  - [x]* 17.2 Write a test asserting seed determinism
    - Run the seed twice and assert identical datasets (counts and content)
    - _Requirements: 29.2_

  - [x] 17.3 Implement GitHub Actions CI pipeline
    - Add a per-service matrix workflow running lint → unit → integration → E2E → docker build in order, failing the pipeline and stopping subsequent stages on any failure
    - _Requirements: 30.1, 30.2_

  - [x] 17.4 Write per-service and root README documentation
    - Add a README per service and a root README with a Mermaid architecture diagram, setup instructions, and a complete environment-variable reference; ensure no credentials are committed
    - _Requirements: 31.1, 31.2, 31.3_

  - [x] 17.5 Produce BENCHMARKS.md from the telemetry load test
    - Run the load harness (10 streams @10Hz) and record throughput, p50/p95/p99 ingest latency, and dropped-frame rate in BENCHMARKS.md
    - _Requirements: 32.1, 32.2_

- [x] 18. Final checkpoint - full platform green
  - Bring up Docker Compose, run the full CI sequence locally (lint → unit → integration → E2E → docker build) across all services, fix any failures, and re-run until fully green. Ask the user if questions arise.
  - _Requirements: 26.2, 30.1, 33.1, 33.2, 33.3_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Every property-based test (fast-check / Hypothesis) MUST run at least 100 iterations and reference its design property number (Requirement 30.3).
- Each service follows the green-before-proceed discipline: install deps → run full suite → diagnose → fix → re-run until fully green before advancing (Requirements 33.1–33.3).
- Each task references the specific requirement clauses it implements; property test tasks additionally reference the design property (P#) they validate.
- Checkpoints are top-level tasks and are not part of the dependency graph; only leaf sub-tasks are scheduled.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.4"] },
    { "id": 2, "tasks": ["1.3", "3.1", "5.1", "7.1", "9.1", "11.1", "13.1", "15.1"] },
    { "id": 3, "tasks": ["3.2", "5.2", "7.2", "9.2", "11.2"] },
    { "id": 4, "tasks": ["3.3", "3.5", "5.3", "5.5", "5.7", "7.3", "7.5", "7.7", "9.3", "9.4", "9.6", "9.8", "11.3", "11.5", "11.7", "11.9", "13.2", "13.4", "13.6", "15.2", "15.3", "15.4", "15.5", "15.6"] },
    { "id": 5, "tasks": ["3.4", "3.6", "3.7", "5.4", "5.6", "5.8", "5.9", "7.4", "7.6", "7.8", "7.10", "9.5", "9.7", "9.9", "11.4", "11.6", "11.8", "11.10", "13.3", "13.5", "13.7", "15.7", "17.1", "17.3", "17.4"] },
    { "id": 6, "tasks": ["3.8", "3.9", "3.10", "5.10", "5.11", "7.9", "17.2", "17.5"] }
  ]
}
```

The workflow for creating the planning artifacts is complete. This spec now has requirements, design, and tasks. You can begin executing tasks by opening `tasks.md` and clicking "Start task" next to any task item.
