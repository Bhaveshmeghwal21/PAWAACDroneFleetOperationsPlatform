/**
 * Unit tests for the pure anomaly detector (task 7.5, Requirement 9).
 *
 * Focused, example-based coverage of each detection branch plus purity; the
 * comprehensive property tests (P16 purity, P17 altitude-drop
 * soundness/completeness, >=100 iterations) are task 7.6.
 */
import type { TelemetrySample } from '@pawaac/shared-types';
import {
  DEFAULT_ALT_DROP_THRESHOLD,
  DEFAULT_BATTERY_DRAIN_THRESHOLD,
  GPS_FAULT_FLAG,
  detectAnomalies,
  type AnomalyThresholds,
} from './detector.js';

const DRONE_A = 'aaaaaaaa-0000-0000-0000-000000000001';

function sampleFixture(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    droneId: DRONE_A,
    ts: '2024-01-01T00:00:01.000Z',
    lat: 1,
    lon: 2,
    altitude: 100,
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

/** Build a (prev, sample) pair `dtSeconds` apart starting at a fixed epoch. */
function pair(
  prevOverrides: Partial<TelemetrySample>,
  sampleOverrides: Partial<TelemetrySample>,
  dtSeconds = 1,
): { prev: TelemetrySample; sample: TelemetrySample } {
  const prev = sampleFixture({ ts: '2024-01-01T00:00:00.000Z', ...prevOverrides });
  const sample = sampleFixture({
    ts: new Date(Date.parse(prev.ts) + dtSeconds * 1000).toISOString(),
    ...sampleOverrides,
  });
  return { prev, sample };
}

function kinds(sample: TelemetrySample, history: TelemetrySample[], thresholds?: AnomalyThresholds): string[] {
  return detectAnomalies(sample, history, thresholds).map((a) => a.kind);
}

describe('detectAnomalies — empty history', () => {
  it('returns no anomalies for a healthy first sample', () => {
    expect(detectAnomalies(sampleFixture(), [])).toEqual([]);
  });

  it('flags EKF2_DEGRADED when the first sample is unhealthy', () => {
    expect(kinds(sampleFixture({ ekf2: { healthy: false, flags: 0 } }), [])).toEqual([
      'EKF2_DEGRADED',
    ]);
  });

  it('flags EKF2_DEGRADED when the first sample reports non-zero flags', () => {
    expect(kinds(sampleFixture({ ekf2: { healthy: true, flags: 0b10 } }), [])).toEqual([
      'EKF2_DEGRADED',
    ]);
  });
});

describe('detectAnomalies — ALTITUDE_DROP (Req 9.3 / P17)', () => {
  it('flags a drop when descent rate exceeds the threshold', () => {
    // 100 -> 80 over 1s = 20 m/s descent > 10 m/s default.
    const { prev, sample } = pair({ altitude: 100 }, { altitude: 80 }, 1);
    expect(kinds(sample, [prev])).toContain('ALTITUDE_DROP');
  });

  it('does not flag at exactly the threshold (strict >)', () => {
    // Exactly 10 m/s over 1s.
    const { prev, sample } = pair({ altitude: 100 }, { altitude: 90 }, 1);
    expect(kinds(sample, [prev])).not.toContain('ALTITUDE_DROP');
  });

  it('does not flag a climb or gentle descent', () => {
    const climb = pair({ altitude: 100 }, { altitude: 120 }, 1);
    expect(kinds(climb.sample, [climb.prev])).not.toContain('ALTITUDE_DROP');
    const gentle = pair({ altitude: 100 }, { altitude: 95 }, 1);
    expect(kinds(gentle.sample, [gentle.prev])).not.toContain('ALTITUDE_DROP');
  });

  it('accounts for dt when computing the rate', () => {
    // 100 -> 80 over 4s = 5 m/s < 10 m/s: not an anomaly.
    const { prev, sample } = pair({ altitude: 100 }, { altitude: 80 }, 4);
    expect(kinds(sample, [prev])).not.toContain('ALTITUDE_DROP');
  });

  it('honours a custom threshold', () => {
    const thresholds: AnomalyThresholds = {
      altDropThreshold: 3,
      batteryDrainThreshold: DEFAULT_BATTERY_DRAIN_THRESHOLD,
    };
    // 5 m/s descent > 3 m/s custom threshold.
    const { prev, sample } = pair({ altitude: 100 }, { altitude: 95 }, 1);
    expect(kinds(sample, [prev], thresholds)).toContain('ALTITUDE_DROP');
  });
});

describe('detectAnomalies — BATTERY_DRAIN_SPIKE (Req 9.4)', () => {
  it('flags a drain faster than the threshold', () => {
    // 80% -> 75% over 1s = 5 %/s > 1 %/s default.
    const { prev, sample } = pair(
      { battery: { voltage: 12, current: 1, remainingPct: 80 } },
      { battery: { voltage: 12, current: 1, remainingPct: 75 } },
      1,
    );
    expect(kinds(sample, [prev])).toContain('BATTERY_DRAIN_SPIKE');
  });

  it('does not flag normal discharge', () => {
    // 0.1 %/s over 1s.
    const { prev, sample } = pair(
      { battery: { voltage: 12, current: 1, remainingPct: 80 } },
      { battery: { voltage: 12, current: 1, remainingPct: 79.9 } },
      1,
    );
    expect(kinds(sample, [prev])).not.toContain('BATTERY_DRAIN_SPIKE');
  });

  it('does not flag a rising percentage (charge/estimation jitter)', () => {
    const { prev, sample } = pair(
      { battery: { voltage: 12, current: 1, remainingPct: 80 } },
      { battery: { voltage: 12, current: 1, remainingPct: 82 } },
      1,
    );
    expect(kinds(sample, [prev])).not.toContain('BATTERY_DRAIN_SPIKE');
  });
});

describe('detectAnomalies — EKF2_DEGRADED (Req 9.5)', () => {
  it('flags a healthy -> unhealthy transition', () => {
    const { prev, sample } = pair(
      { ekf2: { healthy: true, flags: 0 } },
      { ekf2: { healthy: false, flags: 0 } },
    );
    expect(kinds(sample, [prev])).toContain('EKF2_DEGRADED');
  });

  it('flags non-zero unhealthy flags even while reported healthy', () => {
    const { prev, sample } = pair(
      { ekf2: { healthy: true, flags: 0 } },
      { ekf2: { healthy: true, flags: 0b100 } },
    );
    expect(kinds(sample, [prev])).toContain('EKF2_DEGRADED');
  });

  it('does not flag a steady healthy estimator', () => {
    const { prev, sample } = pair(
      { ekf2: { healthy: true, flags: 0 } },
      { ekf2: { healthy: true, flags: 0 } },
    );
    expect(kinds(sample, [prev])).not.toContain('EKF2_DEGRADED');
  });

  it('does not flag a sustained unhealthy state with no flags (no new transition)', () => {
    const { prev, sample } = pair(
      { ekf2: { healthy: false, flags: 0 } },
      { ekf2: { healthy: false, flags: 0 } },
    );
    expect(kinds(sample, [prev])).not.toContain('EKF2_DEGRADED');
  });
});

describe('detectAnomalies — GPS_ACCURACY_LOSS (Req 9.6)', () => {
  it('flags the worsening transition when the GPS-fault bit becomes set', () => {
    const { prev, sample } = pair(
      { ekf2: { healthy: true, flags: 0 } },
      { ekf2: { healthy: true, flags: GPS_FAULT_FLAG } },
    );
    const result = kinds(sample, [prev]);
    expect(result).toContain('GPS_ACCURACY_LOSS');
    // The GPS bit lives in ekf2.flags, so EKF2_DEGRADED co-fires by design.
    expect(result).toContain('EKF2_DEGRADED');
  });

  it('does not re-flag a sustained GPS fault (edge-triggered)', () => {
    const { prev, sample } = pair(
      { ekf2: { healthy: true, flags: GPS_FAULT_FLAG } },
      { ekf2: { healthy: true, flags: GPS_FAULT_FLAG } },
    );
    expect(kinds(sample, [prev])).not.toContain('GPS_ACCURACY_LOSS');
  });

  it('does not flag when the GPS bit clears (recovery)', () => {
    const { prev, sample } = pair(
      { ekf2: { healthy: true, flags: GPS_FAULT_FLAG } },
      { ekf2: { healthy: true, flags: 0 } },
    );
    expect(kinds(sample, [prev])).not.toContain('GPS_ACCURACY_LOSS');
  });
});

describe('detectAnomalies — multiple breaches & ordering (Req 9.1)', () => {
  it('returns one anomaly per simultaneous breach in a stable order', () => {
    const { prev, sample } = pair(
      { altitude: 100, battery: { voltage: 12, current: 1, remainingPct: 80 }, ekf2: { healthy: true, flags: 0 } },
      {
        altitude: 50, // 50 m/s descent
        battery: { voltage: 12, current: 1, remainingPct: 60 }, // 20 %/s drain
        ekf2: { healthy: false, flags: GPS_FAULT_FLAG }, // unhealthy + GPS fault
      },
    );
    expect(kinds(sample, [prev])).toEqual([
      'ALTITUDE_DROP',
      'BATTERY_DRAIN_SPIKE',
      'EKF2_DEGRADED',
      'GPS_ACCURACY_LOSS',
    ]);
  });

  it('returns an empty result when the sample is within all thresholds', () => {
    const { prev, sample } = pair({}, {});
    expect(detectAnomalies(sample, [prev])).toEqual([]);
  });
});

describe('detectAnomalies — anomaly record shape', () => {
  it('attributes each anomaly to the sample droneId and ts with a detail', () => {
    const { prev, sample } = pair({ altitude: 100 }, { altitude: 70 }, 1);
    const [anomaly] = detectAnomalies(sample, [prev]);
    expect(anomaly).toMatchObject({ kind: 'ALTITUDE_DROP', droneId: sample.droneId, ts: sample.ts });
    expect(typeof anomaly?.detail).toBe('string');
  });
});

describe('detectAnomalies — robustness', () => {
  it('skips rate-based detections when dt is non-positive', () => {
    // Equal timestamps => dt = 0; altitude/battery rates undefined and skipped,
    // but EKF2/GPS checks still run.
    const prev = sampleFixture({ ts: '2024-01-01T00:00:00.000Z', altitude: 100 });
    const sample = sampleFixture({
      ts: '2024-01-01T00:00:00.000Z',
      altitude: 0,
      battery: { voltage: 12, current: 1, remainingPct: 0 },
      ekf2: { healthy: false, flags: 0 },
    });
    const result = kinds(sample, [prev]);
    expect(result).not.toContain('ALTITUDE_DROP');
    expect(result).not.toContain('BATTERY_DRAIN_SPIKE');
    expect(result).toContain('EKF2_DEGRADED');
  });
});

describe('detectAnomalies — purity (Req 9.2 / P16)', () => {
  it('is deterministic for identical inputs', () => {
    const { prev, sample } = pair({ altitude: 100 }, { altitude: 60 }, 1);
    const first = detectAnomalies(sample, [prev]);
    const second = detectAnomalies(sample, [prev]);
    expect(second).toEqual(first);
  });

  it('does not mutate the sample or the history window', () => {
    const { prev, sample } = pair({ altitude: 100 }, { altitude: 60 }, 1);
    const sampleSnapshot = structuredClone(sample);
    const history = [prev];
    const historySnapshot = structuredClone(history);

    detectAnomalies(sample, history);

    expect(sample).toEqual(sampleSnapshot);
    expect(history).toEqual(historySnapshot);
    expect(history).toHaveLength(1);
  });

  it('uses default thresholds matching the design constants', () => {
    // 10 m/s descent is exactly the default threshold => no anomaly (strict >).
    const { prev, sample } = pair({ altitude: 100 }, { altitude: 100 - DEFAULT_ALT_DROP_THRESHOLD }, 1);
    expect(kinds(sample, [prev])).not.toContain('ALTITUDE_DROP');
  });
});
