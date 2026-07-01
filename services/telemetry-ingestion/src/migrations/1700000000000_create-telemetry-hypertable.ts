/**
 * Initial Telemetry Ingestion schema (Requirements 8.2, 28.1, 28.3).
 *
 * This is a versioned migration managed by `node-pg-migrate` — schema changes
 * are applied through the migration tool, never as hand-run ad-hoc DDL
 * (Requirement 28.3). Where the migration tool exposes a structured builder
 * API (tables, columns, checks, primary keys) we use it; the TimescaleDB
 * specifics — enabling the extension, promoting the table to a hypertable, and
 * defining continuous aggregates for downsampling — are expressed via
 * `pgm.sql`, which is the accepted migration-tool path for engine-specific
 * functions that have no structured builder equivalent.
 *
 * Scope (task 7.2 only): define the `telemetry_sample` hypertable, its bounds
 * checks, the per-`(drone_id, ts)` uniqueness, and downsampling continuous
 * aggregates. Parsing/persistence/anomaly/query logic arrive in tasks 7.3+.
 */
import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/** Physical table name for the normalized telemetry samples hypertable. */
const TABLE = 'telemetry_sample';

/** 1-minute continuous aggregate (fine-grained downsampling view). */
const CAGG_1M = 'telemetry_sample_1m';

/** 1-hour continuous aggregate (coarse downsampling view). */
const CAGG_1H = 'telemetry_sample_1h';

/**
 * Column definitions for the `telemetry_sample` hypertable. Mirrors the
 * `TelemetrySample` shared type (droneId, ts, lat, lon, altitude, velocity,
 * attitude, battery, ekf2, rcSignalStrength, flightMode, armed), flattened
 * into scalar columns so TimescaleDB continuous aggregates can compute simple
 * numeric rollups for downsampling.
 */
const columns: ColumnDefinitions = {
  drone_id: { type: 'uuid', notNull: true },
  // Hypertable time dimension; strictly increasing per drone (enforced later).
  ts: { type: 'timestamptz', notNull: true },

  lat: { type: 'double precision', notNull: true },
  lon: { type: 'double precision', notNull: true },
  altitude: { type: 'double precision', notNull: true },

  // velocity { vx, vy, vz }
  vel_vx: { type: 'double precision', notNull: true },
  vel_vy: { type: 'double precision', notNull: true },
  vel_vz: { type: 'double precision', notNull: true },

  // attitude { roll, pitch, yaw }
  att_roll: { type: 'double precision', notNull: true },
  att_pitch: { type: 'double precision', notNull: true },
  att_yaw: { type: 'double precision', notNull: true },

  // battery { voltage, current, remainingPct }
  bat_voltage: { type: 'double precision', notNull: true },
  bat_current: { type: 'double precision', notNull: true },
  bat_remaining_pct: {
    type: 'double precision',
    notNull: true,
    // remainingPct constrained to [0, 100] (design validation rule).
    check: 'bat_remaining_pct >= 0 AND bat_remaining_pct <= 100',
  },

  // ekf2 { healthy, flags }
  ekf2_healthy: { type: 'boolean', notNull: true },
  ekf2_flags: { type: 'integer', notNull: true, default: 0 },

  // rcSignalStrength constrained to [0, 100] (design validation rule).
  rc_signal_strength: {
    type: 'double precision',
    notNull: true,
    check: 'rc_signal_strength >= 0 AND rc_signal_strength <= 100',
  },

  flight_mode: { type: 'text', notNull: true },
  armed: { type: 'boolean', notNull: true },
};

export const up = async (pgm: MigrationBuilder): Promise<void> => {
  // Continuous-aggregate creation and policy registration cannot run inside the
  // single wrapping transaction node-pg-migrate uses by default, so opt this
  // migration out of transactional execution.
  pgm.noTransaction();

  // Enable TimescaleDB (no-op if already enabled on the database).
  pgm.createExtension('timescaledb', { ifNotExists: true });

  // Base relation. The composite primary key (drone_id, ts) both enforces
  // uniqueness per (droneId, ts) (Requirement 8.x design rule) and satisfies
  // TimescaleDB's requirement that any unique constraint include the time
  // partitioning column.
  pgm.createTable(
    TABLE,
    columns,
    {
      ifNotExists: true,
      constraints: {
        primaryKey: ['drone_id', 'ts'],
      },
      comment:
        'Normalized MAVLink telemetry samples; TimescaleDB hypertable partitioned on ts.',
    },
  );

  // Secondary index to accelerate per-drone time-range scans (newest-first),
  // the dominant access pattern for live views and historical queries.
  pgm.createIndex(TABLE, [{ name: 'drone_id' }, { name: 'ts', sort: 'DESC' }], {
    name: 'idx_telemetry_sample_drone_ts',
    ifNotExists: true,
  });

  // Promote to a hypertable on the ts dimension. TimescaleDB-specific function
  // with no structured builder equivalent, so expressed via pgm.sql.
  pgm.sql(
    `SELECT create_hypertable('${TABLE}', 'ts', if_not_exists => TRUE, migrate_data => TRUE);`,
  );

  // 1-minute downsampling continuous aggregate.
  pgm.sql(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS ${CAGG_1M}
    WITH (timescaledb.continuous) AS
      SELECT
        drone_id,
        time_bucket(INTERVAL '1 minute', ts) AS bucket,
        count(*)                       AS sample_count,
        avg(altitude)                  AS avg_altitude,
        min(altitude)                  AS min_altitude,
        max(altitude)                  AS max_altitude,
        avg(bat_remaining_pct)         AS avg_bat_remaining_pct,
        min(bat_remaining_pct)         AS min_bat_remaining_pct,
        avg(rc_signal_strength)        AS avg_rc_signal_strength,
        min(rc_signal_strength)        AS min_rc_signal_strength
      FROM ${TABLE}
      GROUP BY drone_id, bucket
    WITH NO DATA;
  `);

  // 1-hour downsampling continuous aggregate for coarser time ranges.
  pgm.sql(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS ${CAGG_1H}
    WITH (timescaledb.continuous) AS
      SELECT
        drone_id,
        time_bucket(INTERVAL '1 hour', ts) AS bucket,
        count(*)                       AS sample_count,
        avg(altitude)                  AS avg_altitude,
        min(altitude)                  AS min_altitude,
        max(altitude)                  AS max_altitude,
        avg(bat_remaining_pct)         AS avg_bat_remaining_pct,
        min(bat_remaining_pct)         AS min_bat_remaining_pct,
        avg(rc_signal_strength)        AS avg_rc_signal_strength,
        min(rc_signal_strength)        AS min_rc_signal_strength
      FROM ${TABLE}
      GROUP BY drone_id, bucket
    WITH NO DATA;
  `);

  // Automatic refresh policies keep the aggregates current as new samples land.
  // Guarded so re-running the migration on an environment without background
  // workers (or where the policy already exists) does not abort the migration.
  pgm.sql(`
    DO $$
    BEGIN
      PERFORM add_continuous_aggregate_policy('${CAGG_1M}',
        start_offset => INTERVAL '3 hours',
        end_offset   => INTERVAL '1 minute',
        schedule_interval => INTERVAL '1 minute');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'skipped continuous aggregate policy for ${CAGG_1M}: %', SQLERRM;
    END $$;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      PERFORM add_continuous_aggregate_policy('${CAGG_1H}',
        start_offset => INTERVAL '7 days',
        end_offset   => INTERVAL '1 hour',
        schedule_interval => INTERVAL '1 hour');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'skipped continuous aggregate policy for ${CAGG_1H}: %', SQLERRM;
    END $$;
  `);
};

export const down = async (pgm: MigrationBuilder): Promise<void> => {
  // Mirror the non-transactional execution used in `up`.
  pgm.noTransaction();

  // Continuous aggregates must be dropped before the underlying hypertable.
  pgm.sql(`DROP MATERIALIZED VIEW IF EXISTS ${CAGG_1H};`);
  pgm.sql(`DROP MATERIALIZED VIEW IF EXISTS ${CAGG_1M};`);

  // Dropping the table also removes the hypertable and its chunks.
  pgm.dropTable(TABLE, { ifExists: true, cascade: true });
};
