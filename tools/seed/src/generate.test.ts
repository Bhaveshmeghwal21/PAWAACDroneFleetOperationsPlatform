/**
 * Seed determinism test (task 17.2, Requirement 29.2).
 *
 * The data-generation layer is pure, so this asserts determinism without a live
 * database: generate the dataset twice and require the two results to be
 * byte-identical in both counts and content. It also pins the canonical counts
 * from Requirement 29.1.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TELEMETRY_INTERVAL_SECONDS, generateSeedData } from './generate.js';

describe('generateSeedData determinism (Requirement 29.2)', () => {
  it('produces an identical dataset across repeated runs (counts and content)', () => {
    const first = generateSeedData();
    const second = generateSeedData();

    // Deep structural equality across the entire dataset.
    expect(second).toEqual(first);
    // Stronger than toEqual: identical JSON serialization (ordering + values).
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('is deterministic for an explicit telemetry cadence option', () => {
    const a = generateSeedData({ telemetryIntervalSeconds: 120 });
    const b = generateSeedData({ telemetryIntervalSeconds: 120 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('creates the dataset shape required by Requirement 29.1', () => {
    const data = generateSeedData();

    expect(data.drones).toHaveLength(5);
    expect(data.missions).toHaveLength(3);
    expect(data.detections).toHaveLength(200);
    expect(data.alerts).toHaveLength(15);

    // 72 hours of telemetry at the default cadence, per drone.
    const samplesPerDrone = (72 * 3600) / DEFAULT_TELEMETRY_INTERVAL_SECONDS;
    expect(data.telemetry).toHaveLength(samplesPerDrone * data.drones.length);
  });

  it('references only existing foreign keys (alerts -> rules, detections -> tracks)', () => {
    const data = generateSeedData();

    const ruleIds = new Set(data.alertRules.map((r) => r.id));
    for (const alert of data.alerts) {
      expect(ruleIds.has(alert.ruleId)).toBe(true);
    }

    const trackIds = new Set(data.tracks.map((t) => t.trackId));
    for (const det of data.detections) {
      if (det.trackId !== null) {
        expect(trackIds.has(det.trackId)).toBe(true);
      }
    }
  });
});
