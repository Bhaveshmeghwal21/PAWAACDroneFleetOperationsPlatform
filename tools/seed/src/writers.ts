/**
 * Thin, idempotent database writers for the seed dataset.
 *
 * Every write is an `INSERT ... ON CONFLICT (<stable key>) DO UPDATE` upsert, so
 * re-running the seed converges the datastore to exactly the generated dataset
 * (Requirement 29.2) without creating duplicates. Writers contain no data
 * generation logic — they only translate already-generated rows into SQL.
 *
 * Each writer owns a short-lived `pg.Pool`, runs all its upserts inside a single
 * transaction, and returns the number of rows applied per table.
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { connectionFor, type ServiceKey } from './config.js';
import type { SeedDataset } from './dataset.js';

/** A column in a bulk upsert: a name plus an optional SQL value expression. */
interface ColumnSpec {
  name: string;
  /** Wraps the bound placeholder, e.g. for `ST_GeomFromText`. Defaults to identity. */
  expr?: (placeholder: string) => string;
}

const CHUNK_SIZE = 500;

/**
 * Perform a chunked, parameterized, idempotent multi-row upsert.
 *
 * @returns the number of rows submitted.
 */
async function bulkUpsert(
  client: PoolClient,
  table: string,
  columns: ColumnSpec[],
  conflictCols: string[],
  updateCols: string[],
  rows: unknown[][],
): Promise<number> {
  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const chunk = rows.slice(start, start + CHUNK_SIZE);
    const params: unknown[] = [];
    const tuples: string[] = [];

    for (const row of chunk) {
      const placeholders = row.map((value, colIdx) => {
        params.push(value);
        const ph = `$${params.length}`;
        const expr = columns[colIdx]?.expr;
        return expr ? expr(ph) : ph;
      });
      tuples.push(`(${placeholders.join(', ')})`);
    }

    const names = columns.map((c) => `"${c.name}"`).join(', ');
    const conflict = conflictCols.map((c) => `"${c}"`).join(', ');
    const onConflict =
      updateCols.length === 0
        ? 'DO NOTHING'
        : `DO UPDATE SET ${updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}`;

    const sql = `INSERT INTO "${table}" (${names}) VALUES ${tuples.join(', ')} ON CONFLICT (${conflict}) ${onConflict}`;
    await client.query(sql, params);
  }

  return rows.length;
}

/** Run `fn` inside a transaction on a fresh pool, always closing the pool. */
async function withService<T>(
  service: ServiceKey,
  fn: (client: PoolClient) => Promise<T>,
  configOverride?: PoolConfig,
): Promise<T> {
  const pool = new Pool(configOverride ?? connectionFor(service));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

/** Counts of rows applied, keyed by table. */
export type WriteCounts = Record<string, number>;

export async function writeFleet(data: SeedDataset, configOverride?: PoolConfig): Promise<WriteCounts> {
  return withService(
    'fleet',
    async (client) => {
      const drones = await bulkUpsert(
        client,
        'drones',
        [
          { name: 'id' },
          { name: 'serialNumber' },
          { name: 'model' },
          { name: 'firmwareVersion' },
          { name: 'hardwareConfig' },
          { name: 'status' },
          { name: 'version' },
          { name: 'createdAt' },
          { name: 'updatedAt' },
        ],
        ['id'],
        ['serialNumber', 'model', 'firmwareVersion', 'hardwareConfig', 'status', 'version', 'updatedAt'],
        data.drones.map((d) => [
          d.id,
          d.serialNumber,
          d.model,
          d.firmwareVersion,
          JSON.stringify(d.hardwareConfig),
          d.status,
          d.version,
          d.createdAt,
          d.updatedAt,
        ]),
      );

      const lifecycle = await bulkUpsert(
        client,
        'component_lifecycle',
        [
          { name: 'droneId' },
          { name: 'batteryCycles' },
          { name: 'motorHours' },
          { name: 'propellerReplacements' },
          { name: 'thresholds' },
        ],
        ['droneId'],
        ['batteryCycles', 'motorHours', 'propellerReplacements', 'thresholds'],
        data.componentLifecycle.map((l) => [
          l.droneId,
          l.batteryCycles,
          l.motorHours,
          l.propellerReplacements,
          JSON.stringify(l.thresholds),
        ]),
      );

      return { drones, component_lifecycle: lifecycle };
    },
    configOverride,
  );
}

export async function writeMission(data: SeedDataset, configOverride?: PoolConfig): Promise<WriteCounts> {
  return withService(
    'mission',
    async (client) => {
      const missions = await bulkUpsert(
        client,
        'missions',
        [{ name: 'id' }, { name: 'version' }, { name: 'name' }, { name: 'status' }, { name: 'createdAt' }],
        ['id', 'version'],
        ['name', 'status'],
        data.missions.map((m) => [m.id, m.version, m.name, m.status, m.createdAt]),
      );

      const waypoints = await bulkUpsert(
        client,
        'waypoints',
        [
          { name: 'missionId' },
          { name: 'missionVersion' },
          { name: 'seq' },
          { name: 'lat' },
          { name: 'lon' },
          { name: 'altitude' },
          { name: 'speed' },
          { name: 'gimbalAngle' },
          { name: 'loiterTime' },
        ],
        ['missionId', 'missionVersion', 'seq'],
        ['lat', 'lon', 'altitude', 'speed', 'gimbalAngle', 'loiterTime'],
        data.waypoints.map((w) => [
          w.missionId,
          w.missionVersion,
          w.seq,
          w.lat,
          w.lon,
          w.altitude,
          w.speed,
          w.gimbalAngle,
          w.loiterTime,
        ]),
      );

      const geofences = await bulkUpsert(
        client,
        'geofences',
        [
          { name: 'id' },
          { name: 'name' },
          { name: 'kind' },
          { name: 'polygon', expr: (ph) => `ST_SetSRID(ST_GeomFromText(${ph}), 4326)` },
        ],
        ['id'],
        ['name', 'kind', 'polygon'],
        data.geofences.map((g) => [g.id, g.name, g.kind, ringToWkt(g.polygon)]),
      );

      return { missions, waypoints, geofences };
    },
    configOverride,
  );
}

/** Convert a closed `[lon, lat]` ring to a PostGIS `POLYGON(...)` WKT string. */
function ringToWkt(ring: Array<[number, number]>): string {
  const pts = ring.map(([lon, lat]) => `${lon} ${lat}`).join(', ');
  return `POLYGON((${pts}))`;
}

export async function writeTelemetry(data: SeedDataset, configOverride?: PoolConfig): Promise<WriteCounts> {
  return withService(
    'telemetry',
    async (client) => {
      const telemetry = await bulkUpsert(
        client,
        'telemetry_sample',
        [
          { name: 'drone_id' },
          { name: 'ts' },
          { name: 'lat' },
          { name: 'lon' },
          { name: 'altitude' },
          { name: 'vel_vx' },
          { name: 'vel_vy' },
          { name: 'vel_vz' },
          { name: 'att_roll' },
          { name: 'att_pitch' },
          { name: 'att_yaw' },
          { name: 'bat_voltage' },
          { name: 'bat_current' },
          { name: 'bat_remaining_pct' },
          { name: 'ekf2_healthy' },
          { name: 'ekf2_flags' },
          { name: 'rc_signal_strength' },
          { name: 'flight_mode' },
          { name: 'armed' },
        ],
        ['drone_id', 'ts'],
        [
          'lat',
          'lon',
          'altitude',
          'vel_vx',
          'vel_vy',
          'vel_vz',
          'att_roll',
          'att_pitch',
          'att_yaw',
          'bat_voltage',
          'bat_current',
          'bat_remaining_pct',
          'ekf2_healthy',
          'ekf2_flags',
          'rc_signal_strength',
          'flight_mode',
          'armed',
        ],
        data.telemetry.map((t) => [
          t.droneId,
          t.ts,
          t.lat,
          t.lon,
          t.altitude,
          t.velVx,
          t.velVy,
          t.velVz,
          t.attRoll,
          t.attPitch,
          t.attYaw,
          t.batVoltage,
          t.batCurrent,
          t.batRemainingPct,
          t.ekf2Healthy,
          t.ekf2Flags,
          t.rcSignalStrength,
          t.flightMode,
          t.armed,
        ]),
      );

      return { telemetry_sample: telemetry };
    },
    configOverride,
  );
}

export async function writeVision(data: SeedDataset, configOverride?: PoolConfig): Promise<WriteCounts> {
  return withService(
    'vision',
    async (client) => {
      // tracks before detections (detections.track_id -> tracks.track_id).
      const tracks = await bulkUpsert(
        client,
        'tracks',
        [{ name: 'track_id' }, { name: 'cls' }, { name: 'last_seen_ts' }],
        ['track_id'],
        ['cls', 'last_seen_ts'],
        data.tracks.map((t) => [t.trackId, t.cls, t.lastSeenTs]),
      );

      const detections = await bulkUpsert(
        client,
        'detections',
        [
          { name: 'id' },
          { name: 'drone_id' },
          { name: 'frame_ts' },
          { name: 'cls' },
          { name: 'confidence' },
          { name: 'obb' },
          { name: 'track_id' },
        ],
        ['id'],
        ['drone_id', 'frame_ts', 'cls', 'confidence', 'obb', 'track_id'],
        data.detections.map((d) => [
          d.id,
          d.droneId,
          d.frameTs,
          d.cls,
          d.confidence,
          JSON.stringify(d.obb),
          d.trackId,
        ]),
      );

      const sceneEvents = await bulkUpsert(
        client,
        'scene_events',
        [{ name: 'id' }, { name: 'kind' }, { name: 'zone_id' }, { name: 'track_ids' }, { name: 'ts' }],
        ['id'],
        ['kind', 'zone_id', 'track_ids', 'ts'],
        data.sceneEvents.map((s) => [s.id, s.kind, s.zoneId, JSON.stringify(s.trackIds), s.ts]),
      );

      return { tracks, detections, scene_events: sceneEvents };
    },
    configOverride,
  );
}

export async function writeAlert(data: SeedDataset, configOverride?: PoolConfig): Promise<WriteCounts> {
  return withService(
    'alert',
    async (client) => {
      // rules before conditions/alerts (both FK rules.id).
      const rules = await bulkUpsert(
        client,
        'alert_rules',
        [
          { name: 'id' },
          { name: 'name' },
          { name: 'enabled' },
          { name: 'eventKind' },
          { name: 'timeWindow' },
          { name: 'zoneId' },
          { name: 'severity' },
          { name: 'channels' },
          { name: 'escalationChain' },
          { name: 'escalationIntervalMin' },
          { name: 'createdAt' },
          { name: 'updatedAt' },
        ],
        ['id'],
        ['name', 'enabled', 'eventKind', 'timeWindow', 'zoneId', 'severity', 'channels', 'escalationChain', 'escalationIntervalMin', 'updatedAt'],
        data.alertRules.map((r) => [
          r.id,
          r.name,
          r.enabled,
          r.eventKind,
          r.timeWindow === null ? null : JSON.stringify(r.timeWindow),
          r.zoneId,
          r.severity,
          JSON.stringify(r.channels),
          JSON.stringify(r.escalationChain),
          r.escalationIntervalMin,
          r.createdAt,
          r.updatedAt,
        ]),
      );

      const conditions = await bulkUpsert(
        client,
        'alert_conditions',
        [
          { name: 'id' },
          { name: 'ruleId' },
          { name: 'position' },
          { name: 'field' },
          { name: 'operator' },
          { name: 'value' },
        ],
        ['id'],
        ['ruleId', 'position', 'field', 'operator', 'value'],
        data.alertConditions.map((c) => [
          c.id,
          c.ruleId,
          c.position,
          c.field,
          c.operator,
          JSON.stringify(c.value ?? null),
        ]),
      );

      const alerts = await bulkUpsert(
        client,
        'alerts',
        [
          { name: 'id' },
          { name: 'ruleId' },
          { name: 'severity' },
          { name: 'status' },
          { name: 'escalationLevel' },
          { name: 'createdAt' },
          { name: 'acknowledgedAt' },
          { name: 'acknowledgedBy' },
        ],
        ['id'],
        ['ruleId', 'severity', 'status', 'escalationLevel', 'acknowledgedAt', 'acknowledgedBy'],
        data.alerts.map((a) => [
          a.id,
          a.ruleId,
          a.severity,
          a.status,
          a.escalationLevel,
          a.createdAt,
          a.acknowledgedAt,
          a.acknowledgedBy,
        ]),
      );

      return { alert_rules: rules, alert_conditions: conditions, alerts };
    },
    configOverride,
  );
}
