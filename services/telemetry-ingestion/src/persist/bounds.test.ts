/**
 * Unit tests for the pure persistence validation rules (task 7.3):
 * bounds on percentage fields (Req 8.4 / P18) and strictly increasing
 * per-drone timestamps (Req 8.5 / P19).
 */
import type { TelemetrySample } from '@pawaac/shared-types';
import { isPercentInRange, isWithinBounds, MonotonicTimestampGate } from './bounds.js';

const DRONE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const DRONE_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function sampleFixture(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    droneId: DRONE_A,
    ts: '2024-01-01T00:00:00.000Z',
    lat: 0,
    lon: 0,
    altitude: 0,
    velocity: { vx: 0, vy: 0, vz: 0 },
    attitude: { roll: 0, pitch: 0, yaw: 0 },
    battery: { voltage: 12, current: 1, remainingPct: 50 },
    ekf2: { healthy: true, flags: 0 },
    rcSignalStrength: 50,
    flightMode: 'AUTO',
    armed: false,
    ...overrides,
  };
}

describe('isPercentInRange', () => {
  it.each([0, 50, 100])('accepts in-range value %p', (v) => {
    expect(isPercentInRange(v)).toBe(true);
  });

  it.each([-0.01, 100.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects out-of-range/non-finite value %p',
    (v) => {
      expect(isPercentInRange(v)).toBe(false);
    },
  );
});

describe('isWithinBounds (Req 8.4 / P18)', () => {
  it('accepts a sample with both percentages in [0,100]', () => {
    expect(isWithinBounds(sampleFixture())).toBe(true);
  });

  it('rejects an out-of-range battery remainingPct', () => {
    expect(isWithinBounds(sampleFixture({ battery: { voltage: 12, current: 1, remainingPct: 150 } }))).toBe(
      false,
    );
  });

  it('rejects an out-of-range rcSignalStrength', () => {
    expect(isWithinBounds(sampleFixture({ rcSignalStrength: -5 }))).toBe(false);
  });
});

describe('MonotonicTimestampGate (Req 8.5 / P19)', () => {
  it('accepts the first sample for a drone', () => {
    const gate = new MonotonicTimestampGate();
    expect(gate.accept(sampleFixture({ ts: '2024-01-01T00:00:00.000Z' }))).toBe(true);
  });

  it('accepts strictly increasing timestamps', () => {
    const gate = new MonotonicTimestampGate();
    expect(gate.accept(sampleFixture({ ts: '2024-01-01T00:00:00.000Z' }))).toBe(true);
    expect(gate.accept(sampleFixture({ ts: '2024-01-01T00:00:00.100Z' }))).toBe(true);
    expect(gate.accept(sampleFixture({ ts: '2024-01-01T00:00:00.200Z' }))).toBe(true);
  });

  it('rejects an equal timestamp', () => {
    const gate = new MonotonicTimestampGate();
    expect(gate.accept(sampleFixture({ ts: '2024-01-01T00:00:00.000Z' }))).toBe(true);
    expect(gate.accept(sampleFixture({ ts: '2024-01-01T00:00:00.000Z' }))).toBe(false);
  });

  it('rejects an earlier timestamp', () => {
    const gate = new MonotonicTimestampGate();
    expect(gate.accept(sampleFixture({ ts: '2024-01-01T00:00:01.000Z' }))).toBe(true);
    expect(gate.accept(sampleFixture({ ts: '2024-01-01T00:00:00.000Z' }))).toBe(false);
  });

  it('tracks each drone independently', () => {
    const gate = new MonotonicTimestampGate();
    expect(gate.accept(sampleFixture({ droneId: DRONE_A, ts: '2024-01-01T00:00:05.000Z' }))).toBe(true);
    // A later-arriving but earlier-than-A timestamp is fine for a different drone.
    expect(gate.accept(sampleFixture({ droneId: DRONE_B, ts: '2024-01-01T00:00:01.000Z' }))).toBe(true);
    expect(gate.accept(sampleFixture({ droneId: DRONE_B, ts: '2024-01-01T00:00:02.000Z' }))).toBe(true);
  });

  it('rejects an unparseable timestamp', () => {
    const gate = new MonotonicTimestampGate();
    expect(gate.accept(sampleFixture({ ts: 'nonsense' }))).toBe(false);
  });

  it('wouldAccept does not mutate state', () => {
    const gate = new MonotonicTimestampGate();
    const s = sampleFixture({ ts: '2024-01-01T00:00:00.000Z' });
    expect(gate.wouldAccept(s)).toBe(true);
    expect(gate.wouldAccept(s)).toBe(true);
    expect(gate.lastAccepted(DRONE_A)).toBeUndefined();
  });
});
