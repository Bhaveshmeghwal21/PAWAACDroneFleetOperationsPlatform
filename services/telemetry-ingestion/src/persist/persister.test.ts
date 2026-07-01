/**
 * Unit tests for the batching persistence pipeline (task 7.3).
 *
 * Verifies that the persister enforces bounds (Req 8.4 / P18) and strictly
 * increasing per-drone timestamps (Req 8.5 / P19) before buffering, flushes in
 * batches to the store (Req 8.2), and records the corresponding metrics. The
 * store is an in-memory fake so the logic is exercised without a live
 * TimescaleDB (DB-backed SQL shape is covered separately in store.test.ts).
 */
import type { TelemetrySample } from '@pawaac/shared-types';
import { createMetrics } from '../metrics.js';
import { BatchingPersister } from './persister.js';
import { buildInsertBatch, type TelemetryStore } from './store.js';

const DRONE_A = 'aaaaaaaa-0000-0000-0000-000000000001';

class FakeStore implements TelemetryStore {
  readonly batches: TelemetrySample[][] = [];
  insertBatch(samples: readonly TelemetrySample[]): Promise<void> {
    this.batches.push([...samples]);
    return Promise.resolve();
  }
  get all(): TelemetrySample[] {
    return this.batches.flat();
  }
}

let seq = 0;
function sampleFixture(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  seq += 1;
  return {
    droneId: DRONE_A,
    ts: new Date(Date.UTC(2024, 0, 1, 0, 0, 0, seq)).toISOString(),
    lat: 1,
    lon: 2,
    altitude: 3,
    velocity: { vx: 0, vy: 0, vz: 0 },
    attitude: { roll: 0, pitch: 0, yaw: 0 },
    battery: { voltage: 12, current: 1, remainingPct: 80 },
    ekf2: { healthy: true, flags: 0 },
    rcSignalStrength: 70,
    flightMode: 'AUTO',
    armed: true,
    ...overrides,
  };
}

describe('BatchingPersister', () => {
  it('buffers accepted samples and flushes them to the store', async () => {
    const store = new FakeStore();
    const metrics = createMetrics();
    const persister = new BatchingPersister({ store, metrics, batchSize: 100 });

    expect(persister.offer(sampleFixture())).toBe('accepted');
    expect(persister.offer(sampleFixture())).toBe('accepted');
    expect(persister.pendingCount).toBe(2);
    expect(store.batches).toHaveLength(0);

    await persister.flush();

    expect(store.all).toHaveLength(2);
    expect(metrics.snapshot().samplesPersisted).toBe(2);
    expect(persister.pendingCount).toBe(0);
  });

  it('auto-flushes once the batch size is reached', async () => {
    const store = new FakeStore();
    const metrics = createMetrics();
    const persister = new BatchingPersister({ store, metrics, batchSize: 3 });

    persister.offer(sampleFixture());
    persister.offer(sampleFixture());
    persister.offer(sampleFixture()); // triggers auto-flush
    await persister.flush();

    expect(store.all).toHaveLength(3);
    expect(metrics.snapshot().samplesPersisted).toBe(3);
  });

  it('rejects out-of-bounds samples and counts them (P18)', async () => {
    const store = new FakeStore();
    const metrics = createMetrics();
    const persister = new BatchingPersister({ store, metrics, batchSize: 100 });

    expect(
      persister.offer(sampleFixture({ battery: { voltage: 12, current: 1, remainingPct: 200 } })),
    ).toBe('rejected-bounds');
    expect(persister.offer(sampleFixture({ rcSignalStrength: -1 }))).toBe('rejected-bounds');

    await persister.flush();
    expect(store.all).toHaveLength(0);
    expect(metrics.snapshot().samplesRejectedBounds).toBe(2);
    expect(metrics.snapshot().samplesPersisted).toBe(0);
  });

  it('rejects non-increasing per-drone timestamps and counts them (P19)', async () => {
    const store = new FakeStore();
    const metrics = createMetrics();
    const persister = new BatchingPersister({ store, metrics, batchSize: 100 });

    expect(persister.offer(sampleFixture({ ts: '2024-01-01T00:00:02.000Z' }))).toBe('accepted');
    expect(persister.offer(sampleFixture({ ts: '2024-01-01T00:00:02.000Z' }))).toBe(
      'rejected-non-monotonic',
    );
    expect(persister.offer(sampleFixture({ ts: '2024-01-01T00:00:01.000Z' }))).toBe(
      'rejected-non-monotonic',
    );
    expect(persister.offer(sampleFixture({ ts: '2024-01-01T00:00:03.000Z' }))).toBe('accepted');

    await persister.flush();
    expect(store.all).toHaveLength(2);
    expect(metrics.snapshot().samplesRejectedNonMonotonic).toBe(2);
  });

  it('all persisted samples satisfy the bounds invariant (P18)', async () => {
    const store = new FakeStore();
    const metrics = createMetrics();
    const persister = new BatchingPersister({ store, metrics, batchSize: 100 });

    persister.offer(sampleFixture({ battery: { voltage: 12, current: 1, remainingPct: 0 } }));
    persister.offer(sampleFixture({ rcSignalStrength: 100 }));
    persister.offer(sampleFixture({ rcSignalStrength: 101 })); // rejected
    await persister.flush();

    for (const s of store.all) {
      expect(s.battery.remainingPct).toBeGreaterThanOrEqual(0);
      expect(s.battery.remainingPct).toBeLessThanOrEqual(100);
      expect(s.rcSignalStrength).toBeGreaterThanOrEqual(0);
      expect(s.rcSignalStrength).toBeLessThanOrEqual(100);
    }
  });

  it('persisted samples are strictly increasing per drone (P19)', async () => {
    const store = new FakeStore();
    const metrics = createMetrics();
    const persister = new BatchingPersister({ store, metrics, batchSize: 100 });

    for (const ms of [0, 100, 100, 50, 200, 300]) {
      persister.offer(sampleFixture({ ts: new Date(Date.UTC(2024, 0, 1, 0, 0, 1, ms)).toISOString() }));
    }
    await persister.flush();

    const times = store.all.map((s) => Date.parse(s.ts));
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
  });

  it('stop() flushes remaining samples', async () => {
    const store = new FakeStore();
    const metrics = createMetrics();
    const persister = new BatchingPersister({ store, metrics, batchSize: 100 });
    persister.offer(sampleFixture());
    await persister.stop();
    expect(store.all).toHaveLength(1);
  });
});

describe('buildInsertBatch', () => {
  it('produces one placeholder group per row with 19 columns each', () => {
    const samples = [sampleFixture(), sampleFixture()];
    const { text, values } = buildInsertBatch(samples);
    expect(values).toHaveLength(19 * 2);
    expect(text).toContain('INSERT INTO telemetry_sample');
    expect(text).toContain('ON CONFLICT (drone_id, ts) DO NOTHING');
    expect(text).toContain('$1,');
    expect(text).toContain('$20,'); // first column of the second row
  });

  it('flattens nested sample fields in column order', () => {
    const { values } = buildInsertBatch([sampleFixture({ lat: 11, lon: 22, altitude: 33 })]);
    // [drone_id, ts, lat, lon, altitude, ...]
    expect(values[2]).toBe(11);
    expect(values[3]).toBe(22);
    expect(values[4]).toBe(33);
  });
});
