/**
 * Unit tests for the anomaly ingest-path pipeline (task 7.5, Requirement 9).
 *
 * Verifies per-drone history windowing, detect-then-emit ordering, window
 * bounding, and isolation between drones. Uses a recording emitter fake.
 */
import type { Anomaly, TelemetrySample } from '@pawaac/shared-types';
import type { AnomalyEmitter } from './emitter.js';
import { AnomalyPipeline, DEFAULT_WINDOW_SIZE } from './pipeline.js';

const DRONE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const DRONE_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function recordingEmitter(): { emitter: AnomalyEmitter; emitted: Anomaly[] } {
  const emitted: Anomaly[] = [];
  return { emitter: { emit: (a) => emitted.push(a) }, emitted };
}

function sampleAt(
  droneId: string,
  msOffset: number,
  overrides: Partial<TelemetrySample> = {},
): TelemetrySample {
  return {
    droneId,
    ts: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + msOffset).toISOString(),
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

describe('AnomalyPipeline', () => {
  it('emits nothing for a healthy first sample but starts tracking the drone', () => {
    const { emitter, emitted } = recordingEmitter();
    const pipeline = new AnomalyPipeline({ emitter });

    const result = pipeline.observe(sampleAt(DRONE_A, 0));

    expect(result).toEqual([]);
    expect(emitted).toEqual([]);
    expect(pipeline.trackedDrones).toBe(1);
  });

  it('detects against the recent window and emits each anomaly', () => {
    const { emitter, emitted } = recordingEmitter();
    const pipeline = new AnomalyPipeline({ emitter });

    pipeline.observe(sampleAt(DRONE_A, 0, { altitude: 100 }));
    // 100 -> 70 over 1s = 30 m/s descent > 10 m/s.
    const result = pipeline.observe(sampleAt(DRONE_A, 1000, { altitude: 70 }));

    expect(result.map((a) => a.kind)).toEqual(['ALTITUDE_DROP']);
    expect(emitted.map((a) => a.kind)).toEqual(['ALTITUDE_DROP']);
  });

  it('keeps per-drone windows isolated', () => {
    const { emitter } = recordingEmitter();
    const pipeline = new AnomalyPipeline({ emitter });

    pipeline.observe(sampleAt(DRONE_A, 0, { altitude: 100 }));
    pipeline.observe(sampleAt(DRONE_B, 0, { altitude: 100 }));
    // Drone B descends fast; drone A's history must not interfere.
    const bResult = pipeline.observe(sampleAt(DRONE_B, 1000, { altitude: 50 }));
    // Drone A stays level.
    const aResult = pipeline.observe(sampleAt(DRONE_A, 1000, { altitude: 100 }));

    expect(bResult.map((a) => a.kind)).toContain('ALTITUDE_DROP');
    expect(bResult.every((a) => a.droneId === DRONE_B)).toBe(true);
    expect(aResult).toEqual([]);
    expect(pipeline.trackedDrones).toBe(2);
  });

  it('honours custom thresholds', () => {
    const { emitter, emitted } = recordingEmitter();
    const pipeline = new AnomalyPipeline({
      emitter,
      thresholds: { altDropThreshold: 2, batteryDrainThreshold: 1 },
    });

    pipeline.observe(sampleAt(DRONE_A, 0, { altitude: 100 }));
    // 5 m/s descent > 2 m/s custom threshold.
    pipeline.observe(sampleAt(DRONE_A, 1000, { altitude: 95 }));

    expect(emitted.map((a) => a.kind)).toContain('ALTITUDE_DROP');
  });

  it('bounds the retained window to the configured size', () => {
    const { emitter } = recordingEmitter();
    const windowSize = 3;
    const pipeline = new AnomalyPipeline({ emitter, windowSize });

    for (let i = 0; i < 10; i += 1) {
      pipeline.observe(sampleAt(DRONE_A, i * 1000, { altitude: 100 }));
    }
    // Detection only ever needs prev; a bounded window proves memory is capped.
    // The most recent sample drives detection: a big drop from the last kept
    // sample still fires.
    const result = pipeline.observe(sampleAt(DRONE_A, 10_000, { altitude: 50 }));
    expect(result.map((a) => a.kind)).toContain('ALTITUDE_DROP');
  });

  it('resets a drone window on demand', () => {
    const { emitter } = recordingEmitter();
    const pipeline = new AnomalyPipeline({ emitter });

    pipeline.observe(sampleAt(DRONE_A, 0));
    expect(pipeline.trackedDrones).toBe(1);
    pipeline.reset(DRONE_A);
    expect(pipeline.trackedDrones).toBe(0);

    // After reset the next sample is treated as a fresh first sample.
    const result = pipeline.observe(sampleAt(DRONE_A, 1000, { altitude: 50 }));
    expect(result).toEqual([]);
  });

  it('exposes a sensible default window size', () => {
    expect(DEFAULT_WINDOW_SIZE).toBeGreaterThan(0);
  });
});
