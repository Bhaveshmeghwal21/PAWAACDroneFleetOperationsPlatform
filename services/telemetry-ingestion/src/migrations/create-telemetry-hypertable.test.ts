/**
 * Unit tests for the Telemetry Ingestion initial migration (task 7.2).
 *
 * No live TimescaleDB is required: the migration is driven against a recording
 * stub of node-pg-migrate's `MigrationBuilder`, so we can assert the structural
 * contract the migration promises — table shape, per-(drone_id, ts) uniqueness,
 * value bounds, hypertable promotion, and downsampling continuous aggregates
 * (Requirements 8.2, 28.1, 28.3) — without applying it to a database.
 */
import type {
  ColumnDefinitions,
  MigrationBuilder,
  TableOptions,
} from 'node-pg-migrate';
import { up, down } from './1700000000000_create-telemetry-hypertable.js';

interface CreateTableCall {
  tableName: string;
  columns: ColumnDefinitions;
  options: TableOptions | undefined;
}

interface CreateIndexCall {
  tableName: string;
  columns: unknown;
  options: unknown;
}

/**
 * Minimal recording stub implementing only the subset of the MigrationBuilder
 * surface the migration uses. Cast to MigrationBuilder for the call.
 */
function createRecorder() {
  const calls = {
    noTransaction: 0,
    extensions: [] as string[],
    tables: [] as CreateTableCall[],
    indexes: [] as CreateIndexCall[],
    sql: [] as string[],
    droppedTables: [] as string[],
  };

  const pgm = {
    noTransaction(): unknown {
      calls.noTransaction += 1;
      return pgm;
    },
    createExtension(name: string): void {
      calls.extensions.push(name);
    },
    createTable(
      tableName: string,
      columns: ColumnDefinitions,
      options?: TableOptions,
    ): void {
      calls.tables.push({ tableName, columns, options });
    },
    createIndex(tableName: string, columns: unknown, options?: unknown): void {
      calls.indexes.push({ tableName, columns, options });
    },
    sql(statement: string): void {
      calls.sql.push(statement);
    },
    dropTable(tableName: string): void {
      calls.droppedTables.push(tableName);
    },
  };

  return { pgm: pgm as unknown as MigrationBuilder, calls };
}

describe('create-telemetry-hypertable migration (Req 8.2, 28.1, 28.3)', () => {
  describe('up', () => {
    it('runs outside a transaction so continuous aggregates can be created', async () => {
      const { pgm, calls } = createRecorder();
      await up(pgm);
      expect(calls.noTransaction).toBeGreaterThanOrEqual(1);
    });

    it('enables the TimescaleDB extension', async () => {
      const { pgm, calls } = createRecorder();
      await up(pgm);
      expect(calls.extensions).toContain('timescaledb');
    });

    it('creates telemetry_sample with a composite (drone_id, ts) primary key enforcing uniqueness', async () => {
      const { pgm, calls } = createRecorder();
      await up(pgm);

      const table = calls.tables.find((t) => t.tableName === 'telemetry_sample');
      expect(table).toBeDefined();
      expect(table?.options?.constraints?.primaryKey).toEqual(['drone_id', 'ts']);
    });

    it('defines every TelemetrySample field as a not-null column', async () => {
      const { pgm, calls } = createRecorder();
      await up(pgm);

      const table = calls.tables.find((t) => t.tableName === 'telemetry_sample');
      const cols = table?.columns ?? {};
      const expected = [
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
      ];
      for (const name of expected) {
        const def = cols[name];
        expect(def).toBeDefined();
        // All columns are objects (not shorthand strings) and non-nullable.
        expect(typeof def).toBe('object');
        expect((def as { notNull?: boolean }).notNull).toBe(true);
      }
    });

    it('bounds bat_remaining_pct and rc_signal_strength to [0, 100]', async () => {
      const { pgm, calls } = createRecorder();
      await up(pgm);

      const table = calls.tables.find((t) => t.tableName === 'telemetry_sample');
      const cols = table?.columns ?? {};
      const battery = cols['bat_remaining_pct'] as { check?: string };
      const rc = cols['rc_signal_strength'] as { check?: string };

      expect(battery.check).toContain('bat_remaining_pct >= 0');
      expect(battery.check).toContain('bat_remaining_pct <= 100');
      expect(rc.check).toContain('rc_signal_strength >= 0');
      expect(rc.check).toContain('rc_signal_strength <= 100');
    });

    it('promotes the table to a hypertable on the ts time dimension', async () => {
      const { pgm, calls } = createRecorder();
      await up(pgm);

      const hypertable = calls.sql.find((s) => s.includes('create_hypertable'));
      expect(hypertable).toBeDefined();
      expect(hypertable).toContain("'telemetry_sample'");
      expect(hypertable).toContain("'ts'");
    });

    it('creates 1-minute and 1-hour continuous aggregates for downsampling', async () => {
      const { pgm, calls } = createRecorder();
      await up(pgm);

      const caggs = calls.sql.filter((s) =>
        s.includes('timescaledb.continuous'),
      );
      expect(caggs.length).toBeGreaterThanOrEqual(2);
      expect(calls.sql.some((s) => s.includes("INTERVAL '1 minute'"))).toBe(true);
      expect(calls.sql.some((s) => s.includes("INTERVAL '1 hour'"))).toBe(true);
    });
  });

  describe('down', () => {
    it('drops both continuous aggregates and the hypertable', async () => {
      const { pgm, calls } = createRecorder();
      await down(pgm);

      expect(
        calls.sql.some((s) => s.includes('DROP MATERIALIZED VIEW') && s.includes('telemetry_sample_1m')),
      ).toBe(true);
      expect(
        calls.sql.some((s) => s.includes('DROP MATERIALIZED VIEW') && s.includes('telemetry_sample_1h')),
      ).toBe(true);
      expect(calls.droppedTables).toContain('telemetry_sample');
    });
  });
});
