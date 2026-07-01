/**
 * Persistence boundary for normalized telemetry samples (Requirement 8.2).
 *
 * The ingest path depends only on the {@link TelemetryStore} interface, so the
 * batching/validation logic can be unit-tested against an in-memory fake while
 * production uses {@link PgTelemetryStore} backed by the TimescaleDB hypertable
 * defined in the `telemetry_sample` migration. Writes are batched (multi-row
 * INSERT) to sustain the high-throughput target (Req 8.7) and idempotent via
 * `ON CONFLICT (drone_id, ts) DO NOTHING`, which also reinforces per-(droneId,
 * ts) uniqueness.
 */
import type { TelemetrySample } from '@pawaac/shared-types';
import type pg from 'pg';

/** Minimal query surface needed for persistence (satisfied by `pg.Pool`). */
export interface Queryable {
  query(queryText: string, values: readonly unknown[]): Promise<unknown>;
}

/** Sink for validated telemetry samples. */
export interface TelemetryStore {
  /**
   * Persist a batch of already-validated samples. Implementations SHOULD be
   * idempotent w.r.t. the (droneId, ts) primary key. A no-op for an empty
   * batch.
   */
  insertBatch(samples: readonly TelemetrySample[]): Promise<void>;
}

/** Physical table and ordered column list for the multi-row INSERT. */
const TABLE = 'telemetry_sample';
const COLUMNS = [
  'drone_id',
  'ts',
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
] as const;

/** Flatten a sample into a positional value tuple matching {@link COLUMNS}. */
function toRow(sample: TelemetrySample): unknown[] {
  return [
    sample.droneId,
    sample.ts,
    sample.lat,
    sample.lon,
    sample.altitude,
    sample.velocity.vx,
    sample.velocity.vy,
    sample.velocity.vz,
    sample.attitude.roll,
    sample.attitude.pitch,
    sample.attitude.yaw,
    sample.battery.voltage,
    sample.battery.current,
    sample.battery.remainingPct,
    sample.ekf2.healthy,
    sample.ekf2.flags,
    sample.rcSignalStrength,
    sample.flightMode,
    sample.armed,
  ];
}

/**
 * Build a parameterized multi-row INSERT statement and its flat value array for
 * the given batch. Exported for unit testing of the generated SQL shape without
 * a live database.
 */
export function buildInsertBatch(samples: readonly TelemetrySample[]): {
  text: string;
  values: unknown[];
} {
  const colCount = COLUMNS.length;
  const values: unknown[] = [];
  const rowsSql = samples.map((sample, rowIdx) => {
    const placeholders = COLUMNS.map((_, colIdx) => `$${rowIdx * colCount + colIdx + 1}`);
    values.push(...toRow(sample));
    return `(${placeholders.join(', ')})`;
  });

  const text =
    `INSERT INTO ${TABLE} (${COLUMNS.join(', ')}) VALUES ${rowsSql.join(', ')} ` +
    `ON CONFLICT (drone_id, ts) DO NOTHING`;
  return { text, values };
}

/** TimescaleDB-backed {@link TelemetryStore} using batched multi-row inserts. */
export class PgTelemetryStore implements TelemetryStore {
  constructor(private readonly db: Queryable) {}

  async insertBatch(samples: readonly TelemetrySample[]): Promise<void> {
    if (samples.length === 0) {
      return;
    }
    const { text, values } = buildInsertBatch(samples);
    await this.db.query(text, values);
  }
}

/** Adapt a `pg.Pool` (or pooled client) to the {@link TelemetryStore}. */
export function createPgTelemetryStore(pool: pg.Pool): TelemetryStore {
  return new PgTelemetryStore(pool);
}
