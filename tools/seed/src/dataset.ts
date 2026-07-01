/**
 * Row-shaped representation of the deterministic seed dataset.
 *
 * Each interface mirrors the physical columns of the owning service's table so
 * the DB writers can map a row to an `INSERT ... ON CONFLICT` statement with no
 * further transformation. Field domains follow the `@pawaac/shared-types` DTOs
 * (drone status, mission status, alert severity, ...).
 */
import type {
  AlertSeverity,
  AlertStatus,
  ConditionOperator,
  DroneStatus,
  EventKind,
  GeofenceKind,
  MissionStatus,
} from '@pawaac/shared-types';

/** A `drones` row (Fleet Registry / Postgres). */
export interface DroneRow {
  id: string;
  serialNumber: string;
  model: string;
  firmwareVersion: string;
  hardwareConfig: Record<string, unknown>;
  status: DroneStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** A `component_lifecycle` row (Fleet Registry / Postgres). */
export interface ComponentLifecycleRow {
  droneId: string;
  batteryCycles: number;
  motorHours: number;
  propellerReplacements: number;
  thresholds: {
    maxBatteryCycles: number;
    maxMotorHours: number;
    maxPropellerLifeHours: number;
  };
}

/** A `missions` row (Mission Planning / Postgres+PostGIS). */
export interface MissionRow {
  id: string;
  version: number;
  name: string;
  status: MissionStatus;
  createdAt: string;
}

/** A `waypoints` row (Mission Planning). */
export interface WaypointRow {
  missionId: string;
  missionVersion: number;
  seq: number;
  lat: number;
  lon: number;
  altitude: number;
  speed: number;
  gimbalAngle: number;
  loiterTime: number;
}

/** A `geofences` row (Mission Planning); polygon is a closed lon/lat ring. */
export interface GeofenceRow {
  id: string;
  name: string;
  kind: GeofenceKind;
  /** Closed ring of `[lon, lat]` points (first == last). */
  polygon: Array<[number, number]>;
}

/** A `telemetry_sample` row (Telemetry Ingestion / TimescaleDB). */
export interface TelemetryRow {
  droneId: string;
  ts: string;
  lat: number;
  lon: number;
  altitude: number;
  velVx: number;
  velVy: number;
  velVz: number;
  attRoll: number;
  attPitch: number;
  attYaw: number;
  batVoltage: number;
  batCurrent: number;
  batRemainingPct: number;
  ekf2Healthy: boolean;
  ekf2Flags: number;
  rcSignalStrength: number;
  flightMode: string;
  armed: boolean;
}

/** A `tracks` row (Vision AI / Postgres). */
export interface TrackRow {
  trackId: string;
  cls: string;
  lastSeenTs: number;
}

/** A `detections` row (Vision AI). */
export interface DetectionRow {
  id: string;
  droneId: string;
  frameTs: number;
  cls: string;
  confidence: number;
  /** Oriented bounding box `[cx, cy, w, h, angle]`. */
  obb: [number, number, number, number, number];
  trackId: string | null;
}

/** A `scene_events` row (Vision AI). */
export interface SceneEventRow {
  id: string;
  kind: string;
  zoneId: string;
  trackIds: string[];
  ts: number;
}

/** An `alert_rules` row (Alert & Notification / Postgres). */
export interface AlertRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  eventKind: EventKind;
  timeWindow: { startMin: number; endMin: number } | null;
  zoneId: string | null;
  severity: AlertSeverity;
  channels: Array<{ type: string; target?: string }>;
  escalationChain: string[];
  escalationIntervalMin: number;
  createdAt: string;
  updatedAt: string;
}

/** An `alert_conditions` row (Alert & Notification). */
export interface AlertConditionRow {
  id: string;
  ruleId: string;
  position: number;
  field: string;
  operator: ConditionOperator;
  value: unknown;
}

/** An `alerts` row (Alert & Notification). */
export interface AlertRow {
  id: string;
  ruleId: string;
  severity: AlertSeverity;
  status: AlertStatus;
  escalationLevel: number;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

/**
 * The complete deterministic dataset produced by `generateSeedData`. The DB
 * writers consume this structure; the determinism test compares two instances
 * of it for byte-equality.
 */
export interface SeedDataset {
  drones: DroneRow[];
  componentLifecycle: ComponentLifecycleRow[];
  missions: MissionRow[];
  waypoints: WaypointRow[];
  geofences: GeofenceRow[];
  telemetry: TelemetryRow[];
  tracks: TrackRow[];
  detections: DetectionRow[];
  sceneEvents: SceneEventRow[];
  alertRules: AlertRuleRow[];
  alertConditions: AlertConditionRow[];
  alerts: AlertRow[];
}
