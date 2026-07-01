/**
 * Pure, deterministic generation of the seed dataset (Requirement 29.1, 29.2).
 *
 * `generateSeedData` is a pure function of its options: given the same options
 * it returns a deeply-equal `SeedDataset` every time. It performs NO I/O — the
 * thin DB writers in `writers.ts` are responsible for applying the dataset.
 * Keeping generation side-effect-free is what makes the determinism test
 * (task 17.2) runnable offline, with no live database.
 *
 * Required dataset shape (Requirement 29.1):
 *   - 5 drones
 *   - 3 missions
 *   - 72 hours of telemetry
 *   - 200 detections
 *   - 15 alerts
 */
import {
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  DRONE_STATUSES,
  SCENE_EVENT_KINDS,
} from '@pawaac/shared-types';
import type {
  AlertConditionRow,
  AlertRow,
  AlertRuleRow,
  ComponentLifecycleRow,
  DetectionRow,
  DroneRow,
  GeofenceRow,
  MissionRow,
  SceneEventRow,
  SeedDataset,
  TelemetryRow,
  TrackRow,
  WaypointRow,
} from './dataset.js';
import { deterministicUuid } from './ids.js';
import { Rng } from './prng.js';

// ---------------------------------------------------------------------------
// Fixed quantities (Requirement 29.1) and tunables.
// ---------------------------------------------------------------------------

const DRONE_COUNT = 5;
const MISSION_COUNT = 3;
const WAYPOINTS_PER_MISSION = 6;
const GEOFENCE_COUNT = 2;
const TELEMETRY_WINDOW_HOURS = 72;
const TRACK_COUNT = 24;
const DETECTION_COUNT = 200;
const SCENE_EVENT_COUNT = 12;
const ALERT_RULE_COUNT = 5;
const ALERT_COUNT = 15;

/**
 * Telemetry cadence. 72 hours of telemetry is generated at one sample per
 * drone every `DEFAULT_TELEMETRY_INTERVAL_SECONDS`. The default of 60 s is a
 * deliberate, documented downsample: it is representative of a steady cruise
 * stream yet bounded — 72h * 60min = 4 320 samples per drone, 21 600 rows
 * total across 5 drones — rather than the millions of rows a true 10 Hz stream
 * would yield. Override with the `SEED_TELEMETRY_INTERVAL_SECONDS` env var.
 */
export const DEFAULT_TELEMETRY_INTERVAL_SECONDS = 60;

/**
 * Fixed wall-clock anchor for every generated timestamp. Using a frozen anchor
 * (never `Date.now()`) keeps timestamps reproducible across runs.
 */
const EPOCH_START_MS = Date.parse('2026-01-01T00:00:00.000Z');

/** Frame-timestamp anchor for vision detections, in epoch seconds. */
const VISION_EPOCH_SECONDS = EPOCH_START_MS / 1000;

// Distinct per-domain seeds so each generator advances its own independent
// deterministic stream (robust to reordering between domains).
const SEED_DRONES = 0x0d_01;
const SEED_MISSIONS = 0x0d_02;
const SEED_TELEMETRY = 0x0d_03;
const SEED_VISION = 0x0d_04;
const SEED_ALERTS = 0x0d_05;

const DRONE_MODELS = ['PAWAAC-X1', 'PAWAAC-X2', 'Skyranger-700', 'Skyranger-900', 'Falcon-VTOL'] as const;
const FIRMWARE_VERSIONS = ['4.3.1', '4.4.0', '4.4.2', '5.0.0'] as const;
const FLIGHT_MODES = ['AUTO', 'GUIDED', 'LOITER', 'RTL', 'POSHOLD'] as const;
const DETECTION_CLASSES = ['person', 'vehicle', 'bicycle', 'truck', 'boat', 'animal'] as const;
const EVENT_KINDS_USED = ['anomaly', 'scene', 'maintenance'] as const;
const CHANNEL_TYPES_USED = ['in_app', 'email', 'whatsapp'] as const;

/** Options controlling generation; all default to the fixed canonical values. */
export interface GenerateOptions {
  /** Telemetry sample cadence in seconds (default 60). */
  telemetryIntervalSeconds?: number;
}

/** ISO-8601 timestamp for `EPOCH_START_MS + offsetSeconds`. */
function isoAt(offsetSeconds: number): string {
  return new Date(EPOCH_START_MS + offsetSeconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Per-domain generators.
// ---------------------------------------------------------------------------

function generateDrones(rng: Rng): { drones: DroneRow[]; lifecycle: ComponentLifecycleRow[] } {
  const drones: DroneRow[] = [];
  const lifecycle: ComponentLifecycleRow[] = [];

  for (let i = 0; i < DRONE_COUNT; i++) {
    const id = deterministicUuid(`drone:${i}`);
    // Keep most drones active; vary the last couple for a realistic fleet.
    const status = i < DRONE_COUNT - 2 ? DRONE_STATUSES[0] : rng.pick(DRONE_STATUSES);
    const createdAt = isoAt(-rng.int(30, 365) * 86_400);

    drones.push({
      id,
      serialNumber: `PAWAAC-DR-${String(i + 1).padStart(4, '0')}`,
      model: rng.pick(DRONE_MODELS),
      firmwareVersion: rng.pick(FIRMWARE_VERSIONS),
      hardwareConfig: {
        gps: 'RTK',
        camera: rng.pick(['EO/IR', 'EO', 'multispectral']),
        payloadKg: rng.floatFixed(0.5, 5, 1),
      },
      status,
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });

    lifecycle.push({
      droneId: id,
      batteryCycles: rng.int(0, 480),
      motorHours: rng.floatFixed(0, 900, 1),
      propellerReplacements: rng.int(0, 12),
      thresholds: {
        maxBatteryCycles: 500,
        maxMotorHours: 1000,
        maxPropellerLifeHours: 200,
      },
    });
  }

  return { drones, lifecycle };
}

function generateMissions(rng: Rng): {
  missions: MissionRow[];
  waypoints: WaypointRow[];
  geofences: GeofenceRow[];
} {
  const missions: MissionRow[] = [];
  const waypoints: WaypointRow[] = [];

  // Base location (central reference point); each mission drifts from here.
  const baseLat = 37.7749;
  const baseLon = -122.4194;

  for (let i = 0; i < MISSION_COUNT; i++) {
    const id = deterministicUuid(`mission:${i}`);
    const version = 1;
    missions.push({
      id,
      version,
      name: `Mission ${String.fromCharCode(65 + i)} — survey route`,
      status: 'validated',
      createdAt: isoAt(-rng.int(1, 60) * 86_400),
    });

    const originLat = baseLat + rng.floatFixed(-0.05, 0.05, 5);
    const originLon = baseLon + rng.floatFixed(-0.05, 0.05, 5);

    for (let seq = 0; seq < WAYPOINTS_PER_MISSION; seq++) {
      waypoints.push({
        missionId: id,
        missionVersion: version,
        seq,
        lat: Number((originLat + seq * 0.002 + rng.floatFixed(-0.001, 0.001, 6)).toFixed(6)),
        lon: Number((originLon + seq * 0.002 + rng.floatFixed(-0.001, 0.001, 6)).toFixed(6)),
        altitude: rng.floatFixed(40, 120, 1),
        speed: rng.floatFixed(5, 18, 1),
        gimbalAngle: rng.floatFixed(-90, 0, 1),
        loiterTime: rng.pick([0, 0, 5, 10, 15]),
      });
    }
  }

  // A couple of no-fly geofences near the base location, as closed rings.
  const geofences: GeofenceRow[] = [];
  for (let i = 0; i < GEOFENCE_COUNT; i++) {
    const cLat = baseLat + rng.floatFixed(-0.03, 0.03, 5);
    const cLon = baseLon + rng.floatFixed(-0.03, 0.03, 5);
    const d = rng.floatFixed(0.004, 0.01, 5);
    const ring: Array<[number, number]> = [
      [Number((cLon - d).toFixed(6)), Number((cLat - d).toFixed(6))],
      [Number((cLon + d).toFixed(6)), Number((cLat - d).toFixed(6))],
      [Number((cLon + d).toFixed(6)), Number((cLat + d).toFixed(6))],
      [Number((cLon - d).toFixed(6)), Number((cLat + d).toFixed(6))],
      [Number((cLon - d).toFixed(6)), Number((cLat - d).toFixed(6))],
    ];
    geofences.push({
      id: deterministicUuid(`geofence:${i}`),
      name: `No-Fly Zone ${i + 1}`,
      kind: 'no_fly',
      polygon: ring,
    });
  }

  return { missions, waypoints, geofences };
}

function generateTelemetry(rng: Rng, drones: DroneRow[], intervalSeconds: number): TelemetryRow[] {
  const rows: TelemetryRow[] = [];
  const totalSamples = Math.floor((TELEMETRY_WINDOW_HOURS * 3600) / intervalSeconds);

  for (const drone of drones) {
    // Per-drone starting state; the stream then walks deterministically.
    let lat = 37.77 + rng.floatFixed(-0.02, 0.02, 5);
    let lon = -122.42 + rng.floatFixed(-0.02, 0.02, 5);
    let altitude = rng.floatFixed(60, 100, 1);
    let battery = 100;

    for (let s = 0; s < totalSamples; s++) {
      const offset = s * intervalSeconds;
      // Smooth deterministic walk.
      lat = Number((lat + rng.floatFixed(-0.0002, 0.0002, 6)).toFixed(6));
      lon = Number((lon + rng.floatFixed(-0.0002, 0.0002, 6)).toFixed(6));
      altitude = Math.max(0, Number((altitude + rng.floatFixed(-2, 2, 2)).toFixed(2)));
      // Battery drains over the window and recharges on wrap-around.
      battery = Number(Math.max(0, battery - rng.floatFixed(0, 0.05, 3)).toFixed(3));
      if (battery <= 5) {
        battery = 100;
      }

      rows.push({
        droneId: drone.id,
        ts: isoAt(offset),
        lat,
        lon,
        altitude,
        velVx: rng.floatFixed(-15, 15, 2),
        velVy: rng.floatFixed(-15, 15, 2),
        velVz: rng.floatFixed(-3, 3, 2),
        attRoll: rng.floatFixed(-0.3, 0.3, 3),
        attPitch: rng.floatFixed(-0.3, 0.3, 3),
        attYaw: rng.floatFixed(-Math.PI, Math.PI, 3),
        batVoltage: rng.floatFixed(21, 25.2, 2),
        batCurrent: rng.floatFixed(5, 40, 2),
        batRemainingPct: battery,
        ekf2Healthy: rng.bool(0.97),
        ekf2Flags: rng.bool(0.97) ? 0 : rng.int(1, 255),
        rcSignalStrength: rng.floatFixed(40, 100, 1),
        flightMode: rng.pick(FLIGHT_MODES),
        armed: rng.bool(0.9),
      });
    }
  }

  return rows;
}

function generateVision(
  rng: Rng,
  drones: DroneRow[],
  geofences: GeofenceRow[],
): { tracks: TrackRow[]; detections: DetectionRow[]; sceneEvents: SceneEventRow[] } {
  const tracks: TrackRow[] = [];
  for (let i = 0; i < TRACK_COUNT; i++) {
    tracks.push({
      trackId: deterministicUuid(`track:${i}`),
      cls: rng.pick(DETECTION_CLASSES),
      lastSeenTs: Number((VISION_EPOCH_SECONDS + rng.int(0, TELEMETRY_WINDOW_HOURS * 3600)).toFixed(2)),
    });
  }

  const detections: DetectionRow[] = [];
  for (let i = 0; i < DETECTION_COUNT; i++) {
    // ~85% of detections are stitched onto a track; the rest are unassigned.
    const track = rng.bool(0.85) ? rng.pick(tracks) : null;
    const cls = track ? track.cls : rng.pick(DETECTION_CLASSES);
    detections.push({
      id: deterministicUuid(`detection:${i}`),
      droneId: rng.pick(drones).id,
      frameTs: Number((VISION_EPOCH_SECONDS + rng.int(0, TELEMETRY_WINDOW_HOURS * 3600)).toFixed(2)),
      cls,
      confidence: rng.floatFixed(0.5, 0.99, 3),
      obb: [
        rng.floatFixed(0, 1920, 1),
        rng.floatFixed(0, 1080, 1),
        rng.floatFixed(10, 240, 1),
        rng.floatFixed(10, 240, 1),
        rng.floatFixed(-Math.PI, Math.PI, 3),
      ],
      trackId: track ? track.trackId : null,
    });
  }

  const sceneEvents: SceneEventRow[] = [];
  for (let i = 0; i < SCENE_EVENT_COUNT; i++) {
    const participantCount = rng.int(1, 3);
    const trackIds: string[] = [];
    for (let j = 0; j < participantCount; j++) {
      trackIds.push(rng.pick(tracks).trackId);
    }
    sceneEvents.push({
      id: deterministicUuid(`scene-event:${i}`),
      kind: rng.pick(SCENE_EVENT_KINDS),
      zoneId: rng.pick(geofences).id,
      trackIds,
      ts: Number((VISION_EPOCH_SECONDS + rng.int(0, TELEMETRY_WINDOW_HOURS * 3600)).toFixed(2)),
    });
  }

  return { tracks, detections, sceneEvents };
}

function generateAlerts(
  rng: Rng,
  drones: DroneRow[],
  geofences: GeofenceRow[],
): { rules: AlertRuleRow[]; conditions: AlertConditionRow[]; alerts: AlertRow[] } {
  const rules: AlertRuleRow[] = [];
  const conditions: AlertConditionRow[] = [];

  // Escalation contacts are stable derived ids (the seed does not own a users
  // table; the chain only needs deterministic uuids).
  const contacts = [0, 1, 2].map((n) => deterministicUuid(`contact:${n}`));

  for (let i = 0; i < ALERT_RULE_COUNT; i++) {
    const id = deterministicUuid(`alert-rule:${i}`);
    const eventKind = EVENT_KINDS_USED[i % EVENT_KINDS_USED.length]!;
    const createdAt = isoAt(-rng.int(1, 90) * 86_400);
    rules.push({
      id,
      name: `Rule ${i + 1} — ${eventKind}`,
      enabled: rng.bool(0.9),
      eventKind,
      timeWindow: rng.bool(0.4) ? { startMin: rng.int(0, 720), endMin: rng.int(721, 1439) } : null,
      zoneId: rng.bool(0.5) ? rng.pick(geofences).id : null,
      severity: rng.pick(ALERT_SEVERITIES),
      channels: [
        { type: 'in_app' },
        ...(rng.bool(0.5) ? [{ type: rng.pick(CHANNEL_TYPES_USED.slice(1)), target: 'ops@pawaac.example.com' }] : []),
      ],
      escalationChain: contacts.slice(0, rng.int(1, contacts.length)),
      escalationIntervalMin: rng.pick([5, 10, 15, 30]),
      createdAt,
      updatedAt: createdAt,
    });

    // One or two AND-combined conditions per rule.
    const condCount = rng.int(1, 2);
    for (let c = 0; c < condCount; c++) {
      conditions.push({
        id: deterministicUuid(`alert-condition:${i}:${c}`),
        ruleId: id,
        position: c,
        field: rng.pick(['payload.kind', 'payload.severity', 'payload.droneId', 'payload.confidence']),
        operator: rng.pick(['eq', 'gt', 'gte', 'in']),
        value: rng.bool(0.5) ? rng.pick(drones).id : rng.floatFixed(0, 1, 2),
      });
    }
  }

  const alerts: AlertRow[] = [];
  for (let i = 0; i < ALERT_COUNT; i++) {
    const rule = rules[i % rules.length]!;
    const status = rng.pick(ALERT_STATUSES);
    const createdAt = isoAt(-rng.int(0, 30) * 3600);
    const acknowledged = status === 'ACKNOWLEDGED' || status === 'CLOSED';
    alerts.push({
      id: deterministicUuid(`alert:${i}`),
      ruleId: rule.id,
      severity: rule.severity,
      status,
      escalationLevel: status === 'ESCALATED' ? rng.int(1, rule.escalationChain.length) : 0,
      createdAt,
      acknowledgedAt: acknowledged ? isoAt(rng.int(1, 120) * 60) : null,
      acknowledgedBy: acknowledged ? rng.pick(contacts) : null,
    });
  }

  return { rules, conditions, alerts };
}

/**
 * Generate the full deterministic seed dataset. Pure: equal options always
 * produce a deeply-equal result.
 */
export function generateSeedData(options: GenerateOptions = {}): SeedDataset {
  const telemetryIntervalSeconds =
    options.telemetryIntervalSeconds ?? DEFAULT_TELEMETRY_INTERVAL_SECONDS;

  const { drones, lifecycle } = generateDrones(new Rng(SEED_DRONES));
  const { missions, waypoints, geofences } = generateMissions(new Rng(SEED_MISSIONS));
  const telemetry = generateTelemetry(new Rng(SEED_TELEMETRY), drones, telemetryIntervalSeconds);
  const { tracks, detections, sceneEvents } = generateVision(new Rng(SEED_VISION), drones, geofences);
  const { rules, conditions, alerts } = generateAlerts(new Rng(SEED_ALERTS), drones, geofences);

  return {
    drones,
    componentLifecycle: lifecycle,
    missions,
    waypoints,
    geofences,
    telemetry,
    tracks,
    detections,
    sceneEvents,
    alertRules: rules,
    alertConditions: conditions,
    alerts,
  };
}
