import { describe, expect, it } from 'vitest';
import type { TelemetrySample } from '@pawaac/shared-types';

import {
  applyPanelSample,
  buildSparkline,
  emptyPanelState,
  getDronePanel,
  latestAttitude,
  latestBattery,
  latestEkf2,
  listPanelDroneIds,
  radiansToDegrees,
  seedPanelSamples,
  type SeriesPoint,
  type TelemetryPanelState,
} from './telemetry-panel-state';

const DRONE_A = '11111111-1111-1111-1111-111111111111';
const DRONE_B = '22222222-2222-2222-2222-222222222222';

function makeSample(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    droneId: DRONE_A,
    ts: '2024-01-01T00:00:10.000Z',
    lat: 12.34,
    lon: 56.78,
    altitude: 120,
    velocity: { vx: 1, vy: 0, vz: 0 },
    attitude: { roll: 0.1, pitch: -0.2, yaw: 1.5 },
    battery: { voltage: 22.2, current: 5, remainingPct: 87 },
    ekf2: { healthy: true, flags: 0 },
    rcSignalStrength: 95,
    flightMode: 'AUTO',
    armed: true,
    ...overrides,
  };
}

describe('applyPanelSample (Requirements 23.1, 23.3)', () => {
  it('creates a panel entry and seeds both series from the first sample', () => {
    const next = applyPanelSample(emptyPanelState(), makeSample());
    const panel = next[DRONE_A];

    expect(panel?.latest).toMatchObject({ altitude: 120, flightMode: 'AUTO' });
    expect(panel?.batterySeries).toEqual([{ ts: '2024-01-01T00:00:10.000Z', value: 87 }]);
    expect(panel?.altitudeSeries).toEqual([{ ts: '2024-01-01T00:00:10.000Z', value: 120 }]);
    expect(panel?.lastTs).toBe('2024-01-01T00:00:10.000Z');
  });

  it('appends to the rolling series as newer samples arrive', () => {
    let state = applyPanelSample(emptyPanelState(), makeSample({ ts: '2024-01-01T00:00:10.000Z' }));
    state = applyPanelSample(
      state,
      makeSample({ ts: '2024-01-01T00:00:11.000Z', altitude: 130, battery: { voltage: 22, current: 5, remainingPct: 85 } }),
    );

    const panel = state[DRONE_A];
    expect(panel?.altitudeSeries.map((p) => p.value)).toEqual([120, 130]);
    expect(panel?.batterySeries.map((p) => p.value)).toEqual([87, 85]);
    expect(panel?.latest?.altitude).toBe(130);
  });

  it('does not mutate the input state (purity)', () => {
    const seeded = applyPanelSample(emptyPanelState(), makeSample());
    const snapshot = structuredClone(seeded);

    applyPanelSample(seeded, makeSample({ ts: '2024-01-01T00:00:11.000Z', altitude: 200 }));

    expect(seeded).toEqual(snapshot);
  });

  it('ignores a stale (out-of-order) sample and returns the same reference', () => {
    const current = applyPanelSample(emptyPanelState(), makeSample({ ts: '2024-01-01T00:00:20.000Z' }));
    const stale = applyPanelSample(current, makeSample({ ts: '2024-01-01T00:00:05.000Z', altitude: 999 }));

    expect(stale).toBe(current);
    expect(stale[DRONE_A]?.latest?.altitude).toBe(120);
    expect(stale[DRONE_A]?.altitudeSeries).toHaveLength(1);
  });

  it('bounds each rolling series to the configured capacity', () => {
    let state: TelemetryPanelState = emptyPanelState();
    for (let i = 0; i < 10; i += 1) {
      const ts = `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`;
      state = applyPanelSample(state, makeSample({ ts, altitude: i }), 3);
    }

    const panel = state[DRONE_A];
    expect(panel?.altitudeSeries).toHaveLength(3);
    expect(panel?.altitudeSeries.map((p) => p.value)).toEqual([7, 8, 9]);
  });

  it('tracks multiple drones independently', () => {
    let state = applyPanelSample(emptyPanelState(), makeSample({ droneId: DRONE_A }));
    state = applyPanelSample(state, makeSample({ droneId: DRONE_B, altitude: 50 }));

    expect(listPanelDroneIds(state)).toEqual([DRONE_A, DRONE_B]);
    expect(state[DRONE_B]?.latest?.altitude).toBe(50);
    expect(state[DRONE_A]?.latest?.altitude).toBe(120);
  });
});

describe('seedPanelSamples', () => {
  it('builds a sorted, capacity-bounded history and latest snapshot', () => {
    const samples = [
      makeSample({ ts: '2024-01-01T00:00:03.000Z', altitude: 30 }),
      makeSample({ ts: '2024-01-01T00:00:01.000Z', altitude: 10 }),
      makeSample({ ts: '2024-01-01T00:00:02.000Z', altitude: 20 }),
    ];

    const state = seedPanelSamples(emptyPanelState(), DRONE_A, samples, 2);
    const panel = state[DRONE_A];

    // Sorted ascending then trimmed to the 2 most recent.
    expect(panel?.altitudeSeries.map((p) => p.value)).toEqual([20, 30]);
    expect(panel?.latest?.altitude).toBe(30);
    expect(panel?.lastTs).toBe('2024-01-01T00:00:03.000Z');
  });

  it('leaves state unchanged for an empty batch', () => {
    const state = emptyPanelState();
    expect(seedPanelSamples(state, DRONE_A, [])).toBe(state);
  });
});

describe('buildSparkline', () => {
  it('returns an empty geometry for an empty series', () => {
    expect(buildSparkline([], 100, 40)).toEqual({ points: [], polyline: '', min: 0, max: 0 });
  });

  it('maps values into the box with the newest point on the right edge', () => {
    const series: SeriesPoint[] = [
      { ts: 't1', value: 0 },
      { ts: 't2', value: 10 },
    ];
    const spark = buildSparkline(series, 100, 40, 0);

    expect(spark.min).toBe(0);
    expect(spark.max).toBe(10);
    expect(spark.points[0]).toEqual({ x: 0, y: 40 }); // lowest value → bottom
    expect(spark.points[1]).toEqual({ x: 100, y: 0 }); // highest value → top, right edge
    expect(spark.polyline).toBe('0,40 100,0');
  });

  it('draws a flat series along the vertical midline', () => {
    const series: SeriesPoint[] = [
      { ts: 't1', value: 50 },
      { ts: 't2', value: 50 },
      { ts: 't3', value: 50 },
    ];
    const spark = buildSparkline(series, 100, 40, 0);

    expect(spark.points.every((p) => p.y === 20)).toBe(true);
  });

  it('places a single point on the right edge at the midline', () => {
    const spark = buildSparkline([{ ts: 't1', value: 5 }], 80, 20, 0);
    expect(spark.points).toEqual([{ x: 80, y: 10 }]);
  });
});

describe('selectors', () => {
  it('getDronePanel returns undefined for unknown or undefined ids', () => {
    const state = applyPanelSample(emptyPanelState(), makeSample());
    expect(getDronePanel(state, undefined)).toBeUndefined();
    expect(getDronePanel(state, DRONE_B)).toBeUndefined();
    expect(getDronePanel(state, DRONE_A)?.droneId).toBe(DRONE_A);
  });

  it('latest* selectors expose the freshest attitude/battery/EKF2', () => {
    const state = applyPanelSample(emptyPanelState(), makeSample());
    const panel = getDronePanel(state, DRONE_A);

    expect(latestAttitude(panel)).toEqual({ roll: 0.1, pitch: -0.2, yaw: 1.5 });
    expect(latestBattery(panel)).toEqual({ voltage: 22.2, current: 5, remainingPct: 87 });
    expect(latestEkf2(panel)).toEqual({ healthy: true, flags: 0 });
    expect(latestAttitude(undefined)).toBeUndefined();
  });
});

describe('radiansToDegrees', () => {
  it('converts radians to degrees', () => {
    expect(radiansToDegrees(Math.PI)).toBeCloseTo(180);
    expect(radiansToDegrees(0)).toBe(0);
    expect(radiansToDegrees(-Math.PI / 2)).toBeCloseTo(-90);
  });
});
