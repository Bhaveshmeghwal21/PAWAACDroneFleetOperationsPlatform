# Requirements Document

## Introduction

The PAWAAC Drone Fleet Operations Platform is a production-grade system for managing autonomous drone surveillance operations end to end: registering physical drone assets, planning geofenced missions, ingesting high-frequency MAVLink telemetry and onboard Vision-AI detections in real time, evaluating alert rules, dispatching multi-channel notifications, and surfacing everything through a single authenticated API gateway and a live operations dashboard.

The platform is decomposed into seven independently deployable services: five domain backend services (Fleet Registry, Mission Planning, Telemetry Ingestion, Vision AI Results, Alert & Notification), an API Gateway, and a Next.js Ops Dashboard. This document derives the functional and cross-cutting requirements from the approved design. Each requirement is expressed using EARS patterns and, where applicable, references the correctness properties (P1–P45) defined in the design so that requirements trace directly to testable invariants.

## Glossary

- **Fleet_Registry**: Service 1. System of record for drone assets and component lifecycle; emits status-change and maintenance-due events.
- **Mission_Planning**: Service 2. Authors, versions, and validates missions; detects geofence conflicts; exports PX4 MAVLink missions.
- **Telemetry_Ingestion**: Service 3. Accepts concurrent MAVLink streams, parses and persists samples, detects anomalies, serves historical queries.
- **Vision_AI**: Service 4. Ingests detections, maintains object tracks, classifies scene events, serves detection queries.
- **Alert_Service**: Service 5. Evaluates alert rules, dispatches multi-channel notifications, manages acknowledgement and escalation, provides analytics.
- **API_Gateway**: Service 6. Single authenticated entry point providing routing, JWT authentication, RBAC, rate limiting, and merged OpenAPI.
- **Ops_Dashboard**: Service 7. Operator-facing Next.js UI for live map, mission planning, telemetry panels, alert feed, and detection replay.
- **Platform**: The complete set of seven services and their shared infrastructure (Postgres, TimescaleDB, Redis) orchestrated together.
- **Drone**: A registered physical autonomous aircraft asset (PX4 / MAVLink) with a unique serial number.
- **Waypoint**: An ordered mission point with latitude, longitude, altitude, speed, gimbal angle, and loiter time.
- **Geofence**: A closed-polygon no-fly zone used for conflict detection.
- **Telemetry_Sample**: A normalized record of one drone state reading (GPS, altitude, velocity, attitude, battery, EKF2 health, RC signal, flight mode, armed).
- **Anomaly**: A detected threshold breach in telemetry (altitude drop, battery drain spike, EKF2 degradation, GPS accuracy loss).
- **Detection**: A YOLOv11x oriented-bounding-box (OBB) object detection with class, confidence, coordinates, frame timestamp, and drone id.
- **Track**: A time-ordered sequence of detections of a single object class sharing a track id.
- **Scene_Event**: A classified higher-level event (person entered zone, vehicle stopped, group gathering).
- **Alert_Rule**: A configurable rule matching domain events by kind, conditions, optional zone, and optional time window.
- **Alert**: An instance created when an Alert_Rule matches an event, carrying status and escalation level.
- **Escalation_Chain**: An ordered list of contact ids to notify successively when an Alert is not acknowledged.
- **Role**: One of Super Admin, Operator, Analyst, or Viewer used for RBAC.
- **MAVLink_Mission**: A PX4-compatible serialized mission (JSON or binary) consisting of MISSION_ITEM_INT entries.
- **Maintenance_Threshold**: A configured limit (max battery cycles, max motor hours, max propeller life hours) above which maintenance is due.

## Requirements

### Requirement 1: Drone Asset CRUD (Fleet Registry)

**User Story:** As a fleet administrator, I want to create, read, update, and decommission drone assets, so that the platform maintains an accurate system of record for every aircraft.

#### Acceptance Criteria

1. WHEN a client submits a valid create-drone request, THE Fleet_Registry SHALL persist a new Drone with a unique identifier and return the created Drone.
2. IF a create-drone request contains an empty serial number, THEN THE Fleet_Registry SHALL reject the request with a validation error.
3. IF a create-drone request contains a serial number that already exists, THEN THE Fleet_Registry SHALL reject the request with a conflict error and SHALL NOT create a duplicate Drone. (Validates: P6)
4. WHEN a client requests a Drone by identifier, THE Fleet_Registry SHALL return the matching Drone record.
5. WHEN a client requests a list of Drones with an optional filter, THE Fleet_Registry SHALL return all Drones matching the filter.
6. WHEN a client submits a valid update to a Drone, THE Fleet_Registry SHALL persist the change and return the updated Drone.
7. WHEN a Drone status is updated to a new value, THE Fleet_Registry SHALL return a record whose queried status equals the requested status. (Validates: P1)
8. WHEN a Drone is successfully updated, THE Fleet_Registry SHALL assign a version strictly greater than the previous version. (Validates: P2)
9. IF an update request carries a stale version, THEN THE Fleet_Registry SHALL reject the request with an optimistic-lock conflict error.
10. WHEN a client decommissions a Drone, THE Fleet_Registry SHALL set the Drone status to decommissioned.

### Requirement 2: Component Lifecycle Tracking and Maintenance Alerts (Fleet Registry)

**User Story:** As a maintenance engineer, I want to track component usage and receive maintenance-due alerts, so that I can service drones before failures occur.

#### Acceptance Criteria

1. WHEN a client records component usage for a Drone, THE Fleet_Registry SHALL update the corresponding lifecycle counters (battery cycles, motor hours, propeller replacements).
2. THE Fleet_Registry SHALL keep every lifecycle counter greater than or equal to zero. (Validates: P3)
3. WHEN maintenance is evaluated for a Drone, THE Fleet_Registry SHALL return a maintenance-due alert for a component if and only if that component counter is greater than or equal to its configured Maintenance_Threshold. (Validates: P4)
4. THE Fleet_Registry evaluateMaintenance operation SHALL be a pure function that produces no side effects and returns identical results for identical inputs. (Validates: P4)
5. WHEN a maintenance-due transition is detected, THE Fleet_Registry SHALL emit a maintenance-due event for consumption by the Alert_Service.

### Requirement 3: Real-Time Status Events (Fleet Registry)

**User Story:** As an operator, I want live status-change events for drones, so that the dashboard reflects fleet state without manual refresh.

#### Acceptance Criteria

1. THE Fleet_Registry SHALL expose a REST API for drone and component operations.
2. WHEN a Drone status changes to a different value, THE Fleet_Registry SHALL emit a WebSocket status-change event. (Validates: P5)
3. IF an update does not change the persisted Drone status, THEN THE Fleet_Registry SHALL NOT emit a status-change event. (Validates: P5)
4. IF WebSocket delivery of a status-change event fails, THEN THE Fleet_Registry SHALL queue and retry the event until delivery succeeds.

### Requirement 4: Versioned Missions and Waypoint Authoring (Mission Planning)

**User Story:** As a mission planner, I want to author and version missions with validated waypoints, so that I can iterate on plans while preserving history.

#### Acceptance Criteria

1. WHEN a client submits a valid create-mission request, THE Mission_Planning SHALL persist a new Mission and return it.
2. THE Mission_Planning SHALL validate a Mission as valid if and only if every Waypoint satisfies all range constraints and waypoint sequence numbers are contiguous starting at zero. (Validates: P10)
3. IF a Waypoint violates a range constraint or sequence contiguity, THEN THE Mission_Planning SHALL reject the Mission with field-level validation errors.
4. THE Mission_Planning SHALL enforce Waypoint constraints of latitude in [-90, 90], longitude in [-180, 180], altitude greater than 0 and not exceeding the configured maximum altitude, speed greater than 0, gimbal angle in [-90, 90], and loiter time greater than or equal to 0.
5. WHEN a client edits an existing Mission and the edit passes validation, THE Mission_Planning SHALL create a new Mission version numbered one greater than the prior version. (Validates: P11)
6. IF an edit to a Mission fails validation, THEN THE Mission_Planning SHALL reject the edit and SHALL NOT create a new version.
7. WHEN a new Mission version is created, THE Mission_Planning SHALL leave all prior versions byte-identical to their original content. (Validates: P11)
8. WHEN a client requests a specific Mission version, THE Mission_Planning SHALL return the Mission content for that version.

### Requirement 5: Geofence Definition and Conflict Detection (Mission Planning)

**User Story:** As a mission planner, I want to define no-fly geofences and detect route conflicts, so that I can prevent missions from entering restricted airspace.

#### Acceptance Criteria

1. WHEN a client submits a Geofence with a closed polygon ring of at least four points where the first point equals the last, THE Mission_Planning SHALL persist the Geofence.
2. IF a submitted polygon is not closed or is self-intersecting, THEN THE Mission_Planning SHALL reject the Geofence with a validation error.
3. WHEN conflict detection runs for a Mission, THE Mission_Planning SHALL return an empty conflict list if and only if no route segment enters or touches any no-fly polygon. (Validates: P7)
4. WHEN conflict detection runs, THE Mission_Planning SHALL return one conflict entry for each route-segment-and-zone pair where the segment intersects the polygon boundary or lies inside the polygon. (Validates: P7)
5. WHEN conflict detection is run repeatedly on identical inputs, THE Mission_Planning SHALL return identical results. (Validates: P8)
6. THE Mission_Planning in-process point-in-polygon test SHALL agree with the PostGIS spatial containment query for all evaluated points and polygons within boundary tolerance. (Validates: P9)
7. THE Mission_Planning conflict detection SHALL NOT mutate its input waypoints or zones.

### Requirement 6: Mission Template Library (Mission Planning)

**User Story:** As a mission planner, I want a reusable template library with parameter substitution, so that I can quickly instantiate standardized missions.

#### Acceptance Criteria

1. WHEN a client instantiates a template with valid parameters, THE Mission_Planning SHALL produce a Mission with all template placeholders resolved. (Validates: P14)
2. IF a template instantiation omits a required parameter, THEN THE Mission_Planning SHALL reject the request with a validation error identifying the missing parameter.
3. WHEN a template is instantiated, THE Mission_Planning SHALL leave no unresolved placeholder in the resulting Mission. (Validates: P14)

### Requirement 7: PX4 MAVLink Export (Mission Planning)

**User Story:** As an operator, I want to export validated missions to PX4-compatible MAVLink, so that I can upload them to drones in JSON or binary form.

#### Acceptance Criteria

1. WHERE a Mission is validated, THE Mission_Planning SHALL export it as a MAVLink_Mission in either JSON or binary format on request.
2. IF an export is requested for a Mission that is not validated, THEN THE Mission_Planning SHALL reject the export with an error.
3. WHEN a Mission is exported, THE Mission_Planning SHALL produce a MISSION_ITEM_INT sequence consisting of a home/takeoff item followed by one item per Waypoint in sequence order.
4. WHEN a Mission is exported, THE Mission_Planning SHALL encode latitude and longitude as int32 values equal to degrees multiplied by 1e7 and altitude in meters.
5. FOR ANY validated Mission, parsing the binary MAVLink export SHALL reconstruct the canonical waypoint geometry and parameters of that Mission. (Validates: P12)
6. WHEN the same validated Mission is exported to binary multiple times, THE Mission_Planning SHALL produce identical bytes on each run. (Validates: P13)
7. IF conflict detection returns a non-empty result for a Mission, THEN THE Mission_Planning SHALL block MAVLink export with a conflict error.

### Requirement 8: High-Throughput Telemetry Ingestion (Telemetry Ingestion)

**User Story:** As a platform operator, I want telemetry from many drones ingested and stored reliably, so that live and historical data are always available.

#### Acceptance Criteria

1. WHEN a Drone opens a WebSocket connection with a valid drone authentication token, THE Telemetry_Ingestion SHALL accept the connection and acknowledge the subscription.
2. WHEN a MAVLink frame is received, THE Telemetry_Ingestion SHALL parse it into a normalized Telemetry_Sample and persist the sample to TimescaleDB.
3. FOR ANY valid Telemetry_Sample, parsing the encoded frame SHALL reconstruct the original sample within numeric tolerance. (Validates: P15)
4. THE Telemetry_Ingestion SHALL persist every Telemetry_Sample with battery remaining percentage in [0, 100] and RC signal strength in [0, 100]. (Validates: P18)
5. THE Telemetry_Ingestion SHALL persist samples per Drone with strictly increasing timestamps. (Validates: P19)
6. IF a received MAVLink frame is malformed, THEN THE Telemetry_Ingestion SHALL drop the frame, increment a parse-error metric, and keep the socket open. 
7. THE Telemetry_Ingestion SHALL sustain at least 10 concurrent drone streams at 10 Hz each.

### Requirement 9: Real-Time Anomaly Detection (Telemetry Ingestion)

**User Story:** As an operator, I want telemetry anomalies detected in real time, so that I can respond to in-flight problems immediately.

#### Acceptance Criteria

1. WHEN a Telemetry_Sample is processed against recent history, THE Telemetry_Ingestion SHALL return an Anomaly for each threshold breach and an empty result when the sample is within all thresholds.
2. THE Telemetry_Ingestion anomaly detection SHALL be a pure function producing identical output for identical sample-and-history inputs. (Validates: P16)
3. WHEN the computed descent rate exceeds the altitude-drop threshold, THE Telemetry_Ingestion SHALL produce an Anomaly setting both the anomaly flag and an anomaly type of ALTITUDE_DROP, and SHALL produce one if and only if the threshold is exceeded. (Validates: P17)
4. WHEN the battery drain rate exceeds the configured maximum, THE Telemetry_Ingestion SHALL produce an Anomaly setting both the anomaly flag and an anomaly type of BATTERY_DRAIN_SPIKE.
5. WHEN EKF2 health transitions from healthy to unhealthy or reports non-zero unhealthy flags, THE Telemetry_Ingestion SHALL produce an Anomaly setting both the anomaly flag and an anomaly type of EKF2_DEGRADED.
6. WHEN GPS horizontal accuracy worsens beyond the threshold or the fix is lost, THE Telemetry_Ingestion SHALL produce an Anomaly setting both the anomaly flag and an anomaly type of GPS_ACCURACY_LOSS.
7. WHEN an Anomaly is detected, THE Telemetry_Ingestion SHALL emit an anomaly event to the Alert_Service and push the anomaly to the Ops_Dashboard.

### Requirement 10: Historical Telemetry Query (Telemetry Ingestion)

**User Story:** As an analyst, I want to query historical telemetry with time-range filtering and downsampling, so that I can analyze past flights efficiently.

#### Acceptance Criteria

1. WHERE a query specifies a time range with start less than or equal to end, THE Telemetry_Ingestion SHALL return samples within that range.
2. THE Telemetry_Ingestion SHALL return only samples whose timestamp satisfies from less than or equal to ts and ts less than or equal to to. (Validates: P21)
3. WHERE a query specifies a downsample bucket count, THE Telemetry_Ingestion SHALL return at most the requested number of buckets. (Validates: P20)
4. IF a query specifies a start time greater than its end time, THEN THE Telemetry_Ingestion SHALL reject the query with a validation error.

### Requirement 11: Detection Ingest and Track Stitching (Vision AI Results)

**User Story:** As an analyst, I want onboard detections ingested and stitched into object tracks, so that I can follow objects across frames.

#### Acceptance Criteria

1. WHEN a batch of YOLOv11x OBB detections is ingested, THE Vision_AI SHALL persist each Detection with its class, confidence, OBB coordinates, frame timestamp, and drone id.
2. IF a Detection has a confidence outside [0, 1] or an OBB that does not contain exactly five elements with positive width and height, THEN THE Vision_AI SHALL reject that Detection with a validation error.
3. WHEN track stitching processes a set of detections, THE Vision_AI SHALL assign exactly one track id to every detection. (Validates: P22)
4. THE Vision_AI SHALL ensure all detections within a single Track share the same object class. (Validates: P23)
5. WHEN track stitching runs, THE Vision_AI SHALL preserve each Detection's original confidence and class unchanged. (Validates: P25)
6. THE Vision_AI SHALL exclude from the active track set any Track unseen for longer than the configured maximum age. (Validates: P26)
7. FOR ANY OBB, transforming it and applying the inverse transform SHALL return the original OBB within tolerance. (Validates: P24)
8. IF a duplicate detection batch with a previously seen idempotency key is ingested, THEN THE Vision_AI SHALL return the prior ingest result without creating duplicates.

### Requirement 12: Scene Event Classification (Vision AI Results)

**User Story:** As an analyst, I want detections classified into scene events against mission zones, so that I am notified of meaningful activity.

#### Acceptance Criteria

1. WHEN a person Track transitions from outside a zone to inside that zone, THE Vision_AI SHALL emit a person_entered_zone Scene_Event, and SHALL emit one if and only if that transition occurs. (Validates: P28)
2. WHEN a vehicle Track centroid displacement stays below the movement epsilon for a continuous span greater than 60 seconds, THE Vision_AI SHALL emit a vehicle_stopped Scene_Event.
3. WHEN more than 5 distinct person Tracks are simultaneously inside the same zone, THE Vision_AI SHALL emit a group_gathering Scene_Event based on global zone occupancy regardless of which Track is currently being processed, and SHALL emit one if and only if the count exceeds 5. (Validates: P27)
4. WHEN a Scene_Event is emitted, THE Vision_AI SHALL reference only existing track ids and a defined zone id.
5. WHEN a Scene_Event is emitted, THE Vision_AI SHALL forward it to the Alert_Service.

### Requirement 13: Detection Query API (Vision AI Results)

**User Story:** As an analyst, I want to query detections by time, zone, class, and confidence, so that I can retrieve relevant observations.

#### Acceptance Criteria

1. WHEN a detection query is submitted, THE Vision_AI SHALL return only detections matching all specified criteria of time range, zone, class, and confidence greater than or equal to the threshold. (Validates: P29)
2. THE Vision_AI SHALL expose the detection query as a REST API.

### Requirement 14: Configurable Rule Engine (Alert & Notification)

**User Story:** As an operator, I want a configurable rule engine, so that I control which events generate alerts.

#### Acceptance Criteria

1. WHEN a client upserts an Alert_Rule, THE Alert_Service SHALL persist the rule and return it.
2. WHEN an event is evaluated against rules, THE Alert_Service SHALL return a rule if and only if the rule is enabled, its event kind matches, its zone matches when specified, its time window holds when specified, and all of its conditions hold. (Validates: P30)
3. THE Alert_Service rule evaluation SHALL return identical matched sets regardless of the order of the input rules. (Validates: P31)
4. WHERE an Alert_Rule specifies a time window with start minute greater than end minute, THE Alert_Service SHALL include event times after the start minute or before the end minute. (Validates: P32)
5. THE Alert_Service rule evaluation SHALL be a pure, deterministic function of the event and rules.

### Requirement 15: Multi-Channel Dispatch (Alert & Notification)

**User Story:** As an operator, I want alerts dispatched across multiple channels, so that responders are notified through their preferred medium.

#### Acceptance Criteria

1. WHEN an Alert is dispatched, THE Alert_Service SHALL attempt delivery to exactly the channels configured on its rule, and SHALL treat the dispatch as successful even if some channels fail (partial delivery). (Validates: P37)
2. WHERE in-app WebSocket is configured, THE Alert_Service SHALL push the Alert to the Ops_Dashboard.
3. WHERE email is configured, THE Alert_Service SHALL send the Alert by email via Nodemailer.
4. WHERE WhatsApp is configured, THE Alert_Service SHALL send the Alert via the OpenWA REST client.
5. IF a channel delivery fails, THEN THE Alert_Service SHALL mark that channel delivery failed, retry with backoff, and fall back to in-app WebSocket while continuing other channels.
6. IF in-app WebSocket delivery has itself already failed, THEN THE Alert_Service SHALL skip the WebSocket fallback and retry only the originally configured channels.

### Requirement 16: Acknowledgement and Escalation (Alert & Notification)

**User Story:** As a responder, I want to acknowledge alerts and have unacknowledged alerts escalate, so that critical events are never missed.

#### Acceptance Criteria

1. WHEN an Alert is created from a matched rule, THE Alert_Service SHALL persist it with status OPEN and start an escalation timer at level 0.
2. WHEN a user acknowledges an OPEN or ESCALATED Alert, THE Alert_Service SHALL set status to ACKNOWLEDGED and cancel the escalation timer.
3. IF an Alert is already acknowledged, THEN THE Alert_Service SHALL treat a further acknowledgement as a no-op returning the same state. (Validates: P36)
4. WHILE an Alert remains acknowledged or closed, THE Alert_Service SHALL NOT reschedule its escalation timer. (Validates: P33)
5. WHEN an escalation timer is due for an open unacknowledged Alert, THE Alert_Service SHALL increment the escalation level, dispatch to the next contact in the Escalation_Chain, and reschedule the next escalation further in the future. (Validates: P35)
6. THE Alert_Service SHALL keep the escalation level less than or equal to the length of the Escalation_Chain. (Validates: P34)
7. THE Alert_Service SHALL allow Alert status to follow only the transitions OPEN to ACKNOWLEDGED or ESCALATED, ESCALATED to ACKNOWLEDGED, and any active state to CLOSED, while permitting an Alert to remain in its current state. (Validates: P38)

### Requirement 17: Alert History and Analytics (Alert & Notification)

**User Story:** As an operator, I want alert history and analytics, so that I can review trends and false-positive rates.

#### Acceptance Criteria

1. WHEN an analytics query is submitted for a time range, THE Alert_Service SHALL return alert counts grouped by zone and by hour.
2. THE Alert_Service SHALL ensure the sum of per-zone and per-hour alert counts equals the total number of alerts in the queried range. (Validates: P39)
3. THE Alert_Service SHALL provide a queryable history of past alerts.

### Requirement 18: Authentication and Role-Based Authorization (API Gateway)

**User Story:** As a security administrator, I want all access authenticated and authorized by role, so that only permitted users reach platform services.

#### Acceptance Criteria

1. IF a request arrives without a valid JWT, THEN THE API_Gateway SHALL reject it before it reaches any upstream service. (Validates: P45)
2. WHEN a request carries a valid JWT, THE API_Gateway SHALL extract the user identifier and Role.
3. THE API_Gateway SHALL authorize a request if and only if the request Role is explicitly permitted for the target route, and SHALL deny by default otherwise. (Validates: P40)
4. WHERE a route is permitted to a lower-privilege Role, THE API_Gateway SHALL also permit that route to Super Admin, provided the Super Admin request passes all standard authentication and validation checks. (Validates: P41)
5. IF a JWT is expired or invalid, THEN THE API_Gateway SHALL respond with 401 Unauthorized.

### Requirement 19: Rate Limiting, Logging, and Tracing (API Gateway)

**User Story:** As a platform operator, I want per-role rate limiting and request tracing, so that the platform stays stable and auditable.

#### Acceptance Criteria

1. THE API_Gateway SHALL allow no more than the requesting Role's configured request limit within a rate-limit window. (Validates: P42)
2. IF a Role exceeds its rate limit, THEN THE API_Gateway SHALL respond with 429 and a Retry-After header.
3. WHEN the API_Gateway proxies a request, THE API_Gateway SHALL include a non-empty trace identifier in the downstream request. (Validates: P44)
4. WHEN the API_Gateway handles a request, THE API_Gateway SHALL log the request with its trace identifier.

### Requirement 20: Routing and Merged OpenAPI (API Gateway)

**User Story:** As an API consumer, I want a single entry point with a unified API surface, so that I can reach all services and explore their contracts in one place.

#### Acceptance Criteria

1. THE API_Gateway SHALL map every known path to exactly one upstream service target. (Validates: P43)
2. IF a request path is unknown, THEN THE API_Gateway SHALL respond with 404. (Validates: P43)
3. THE API_Gateway SHALL serve a merged OpenAPI 3.0 document aggregating the specifications of all upstream services.
4. THE API_Gateway SHALL serve a single Swagger UI for the merged OpenAPI document.

### Requirement 21: Real-Time Fleet Map (Ops Dashboard)

**User Story:** As an operator, I want a live Leaflet map of the fleet, so that I can monitor drone positions and state at a glance.

#### Acceptance Criteria

1. WHEN live telemetry is received, THE Ops_Dashboard SHALL display each Drone's current position on a Leaflet map.
2. WHEN live telemetry updates, THE Ops_Dashboard SHALL display each Drone's battery level and flight mode.
3. WHEN a status-change event is received, THE Ops_Dashboard SHALL update the affected Drone's map representation.

### Requirement 22: Drag-and-Drop Mission Planner (Ops Dashboard)

**User Story:** As a mission planner, I want a drag-and-drop planner with geofence drawing, so that I can author missions visually.

#### Acceptance Criteria

1. WHEN a planner drags waypoints on the map, THE Ops_Dashboard SHALL build an ordered waypoint list reflecting the placements.
2. WHEN a planner draws a polygon, THE Ops_Dashboard SHALL submit it as a Geofence definition.
3. WHEN a planner submits a mission, THE Ops_Dashboard SHALL send it through the API_Gateway to Mission_Planning.
4. IF submission transmission fails, THEN THE Ops_Dashboard SHALL allow continued work using local storage and retry transmission.
5. IF Mission_Planning reports geofence conflicts, THEN THE Ops_Dashboard SHALL display the conflicting segments to the planner.

### Requirement 23: Live Telemetry Panels (Ops Dashboard)

**User Story:** As an operator, I want live telemetry panels, so that I can monitor flight health in real time.

#### Acceptance Criteria

1. WHEN live telemetry is received, THE Ops_Dashboard SHALL display attitude, battery, EKF2 health, and altitude panels for the selected Drone.
2. IF a telemetry panel fails to render, THEN THE Ops_Dashboard SHALL display an error indicator or fallback content for that panel.
3. WHEN underlying telemetry state changes, THE Ops_Dashboard SHALL update the displayed panels to reflect the latest values.

### Requirement 24: Alert Feed with Acknowledge Workflow (Ops Dashboard)

**User Story:** As a responder, I want a live alert feed with acknowledge actions, so that I can triage alerts from the dashboard.

#### Acceptance Criteria

1. WHEN an Alert is pushed over WebSocket, THE Ops_Dashboard SHALL display it in the alert feed.
2. IF displaying a pushed Alert fails, THEN THE Ops_Dashboard SHALL retry the display or log the failure for manual intervention.
3. WHEN a responder acknowledges an Alert in the feed, THE Ops_Dashboard SHALL send an acknowledgement through the API_Gateway to the Alert_Service.
4. WHEN an Alert is acknowledged, THE Ops_Dashboard SHALL update the alert feed to reflect the acknowledged status.

### Requirement 25: Detection Replay Timeline (Ops Dashboard)

**User Story:** As an analyst, I want a detection replay timeline, so that I can review past detections overlaid on the map.

#### Acceptance Criteria

1. WHEN an analyst scrubs the replay timeline, THE Ops_Dashboard SHALL display detections for the selected time overlaid on the map.
2. WHEN an analyst selects a time range, THE Ops_Dashboard SHALL query detections through the API_Gateway from Vision_AI for that range.

### Requirement 26: Container Orchestration

**User Story:** As a developer, I want one-command local orchestration, so that I can bring up the entire platform reproducibly.

#### Acceptance Criteria

1. THE Platform SHALL provide a Docker Compose configuration that starts all 7 services plus Postgres, TimescaleDB, and Redis.
2. WHEN Docker Compose is started, THE Platform SHALL bring up every service and datastore with its required configuration.
3. IF any service or datastore fails to start, THEN THE Platform SHALL shut down all components rather than leaving a partial environment running.
4. THE Platform SHALL follow the database-per-service pattern so that each backend service owns its own datastore.

### Requirement 27: Shared TypeScript Types Package

**User Story:** As a developer, I want a shared types package, so that DTOs and events are consistent across Node services.

#### Acceptance Criteria

1. THE Platform SHALL provide a shared TypeScript types package consumed by all Node services as the single source of truth for DTOs and events.
2. WHEN a shared DTO or event type changes, THE Platform SHALL surface the change to all consuming Node services through the shared package.

### Requirement 28: Versioned Schema Migrations

**User Story:** As a developer, I want versioned migrations with no raw SQL DDL, so that schema changes are repeatable and reviewable.

#### Acceptance Criteria

1. THE Platform SHALL manage all relational schema changes through versioned migrations, using TypeORM/Prisma for Node services and SQLAlchemy/Alembic for the Python service.
2. THE Platform SHALL allow a service to start with any migration tool provided the tool applies versioned migrations.
3. THE Platform SHALL NOT use raw SQL data-definition statements for schema changes.
4. IF a schema mismatch is detected at service startup, THEN THE service SHALL fail fast on its startup health check.

### Requirement 29: Deterministic Seed Data

**User Story:** As a developer, I want a deterministic seed script, so that demos and tests start from a known dataset.

#### Acceptance Criteria

1. WHEN the seed script runs, THE Platform SHALL create 5 drones, 3 missions, 72 hours of telemetry, 200 detections, and 15 alerts.
2. WHEN the seed script runs repeatedly, THE Platform SHALL produce a deterministic dataset.

### Requirement 30: Continuous Integration Pipeline

**User Story:** As a developer, I want a CI pipeline enforcing quality gates, so that every change is validated before merge.

#### Acceptance Criteria

1. THE Platform SHALL provide a GitHub Actions CI pipeline that runs the stages lint, unit, integration, E2E, and Docker build in that order for each service.
2. IF any CI stage fails, THEN THE Platform SHALL fail the pipeline and SHALL NOT proceed to subsequent stages for that service.
3. THE Platform property-based tests SHALL run a minimum of 100 iterations per property and SHALL reference their corresponding design property.

### Requirement 31: Documentation

**User Story:** As a new contributor, I want comprehensive documentation, so that I can set up and understand the platform quickly.

#### Acceptance Criteria

1. THE Platform SHALL provide a README for each service and a root README.
2. THE root README SHALL include a Mermaid architecture diagram, setup instructions, and an environment-variable reference.
3. THE Platform SHALL document all required secrets and configuration as environment variables and SHALL NOT commit credentials.

### Requirement 32: Performance Benchmarking

**User Story:** As a platform operator, I want documented performance benchmarks, so that I can verify telemetry throughput targets.

#### Acceptance Criteria

1. WHEN the telemetry load test runs, THE Platform SHALL simulate at least 10 concurrent drone streams at 10 Hz sustained.
2. THE Platform SHALL record throughput, p50, p95, and p99 ingest latency, and dropped-frame rate in BENCHMARKS.md.

### Requirement 33: Green-Before-Proceed Testing Discipline

**User Story:** As an engineering lead, I want a mandatory green-before-proceed gate, so that no service advances with failing tests.

#### Acceptance Criteria

1. WHEN work begins on a service, THE Platform development process SHALL install dependencies and run the service's full test suite.
2. IF any test in a service suite fails, THEN THE development process SHALL diagnose and fix the failure and re-run the suite until it is fully green.
3. THE development process SHALL NOT advance to the next service until the current service's test suite passes fully.

### Requirement 34: Operational Health and Error Reporting

**User Story:** As a platform operator, I want consistent health endpoints and error formats, so that I can monitor and troubleshoot the platform uniformly.

#### Acceptance Criteria

1. THE Platform SHALL expose a liveness health endpoint and a readiness endpoint for every service, WHERE the readiness endpoint MAY include datastore connectivity checks.
2. WHEN a service returns an error, THE service SHALL return an RFC 7807 problem+json error body.
3. WHEN a service handles a request, THE service SHALL propagate the trace identifier header.
