/**
 * Property-based tests for the pure anomaly detector (task 7.6, Requirement 9).
 *
 * Uses fast-check with >=100 iterations per property and references the design
 * property numbers it validates. Example-based, per-branch coverage lives in
 * detector.test.ts (task 7.5); this file establishes the universal invariants:
 *
 *  - P16 — Anomaly purity (Req 9.2): detectAnomalies is a pure function —
 *    equal (sample, history, thresholds) inputs produce equal outputs, and the
 *    inputs are never mutated.
 *  - P17 — Altitude-drop soundness/completeness (Req 9.3): an ALTITUDE_DROP
 *    anomaly is produced IFF the computed descent rate
 *    (prev.altitude - sample.altitude) / dt strictly exceeds altDropThreshold,
 *    given a non-empty history and a positive dt.
 *
 * The generators mirror the detector's own dt derivation (ISO timestamps built
 * from integer epoch-ms so Date round-trips losslessly) so the expected oracle
 * computes byte-identically to the implementation under test.
 */
import type { TelemetrySample, Uuid } from '@pawaac/shared-types';
import fc from 'fast-check';

import {
  DEFAULT_BATTERY_DRAIN_THRESHOLD,
  detectAnomalies,
  type AnomalyThresholds,
} from './detector.js';

/** At least 100 iterations per property (Requirement 30.3); extra headroom. */
const NUM_RUNS = 300;

/** A fixed pool of drone identities shared across a sample's history. */
const DRONE_IDS: Uuid[] = [
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333',
];

/** Characters safe for the flightMode field: no NUL/control characters. */
const NAME_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('');

/** A finite double within [min, max]. */
function finiteDouble(min: number, max: number): fc.Arbitrary<number> {
  return fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
}

/** ISO timestamp built from integer epoch-ms so it round-trips through Date. */
function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * A fully-formed, finite telemetry sample. The `ts` is supplied by callers
 * (purity does not care; the altitude-drop property pins it precisely), so the
 * arbitrary fixes a neutral default that individual properties override.
 */
const sampleBodyArb = fc.record({
  droneId: fc.constantFrom(...DRONE_IDS),
  lat: finiteDouble(-90, 90),
  lon: finiteDouble(-180, 180),
  altitude: finiteDouble(-1000, 10_000),
  velocity: fc.record({
    vx: finiteDouble(-200, 200),
    vy: finiteDouble(-200, 200),
    vz: finiteDouble(-200, 200),
  }),
  attitude: fc.record({
    roll: finiteDouble(-Math.PI, Math.PI),
    pitch: finiteDouble(-Math.PI, Math.PI),
    yaw: finiteDouble(-Math.PI, Math.PI),
  }),
  battery: fc.record({
    voltage: finiteDouble(0, 60),
    current: finiteDouble(-100, 100),
    remainingPct: finiteDouble(0, 100),
  }),
  ekf2: fc.record({
    healthy: fc.boolean(),
    // Small bitmask range so the GPS-fault bit (bit 0) toggles frequently.
    flags: fc.integer({ min: 0, max: 0b1111 }),
  }),
  rcSignalStrength: finiteDouble(0, 100),
  flightMode: fc
    .array(fc.constantFrom(...NAME_ALPHABET), { maxLength: 12 })
    .map((chars) => chars.join('')),
  armed: fc.boolean(),
});

/** Build a TelemetrySample from a generated body and an explicit timestamp. */
function withTs(body: Omit<TelemetrySample, 'ts'>, ms: number): TelemetrySample {
  return { ...body, ts: isoFromMs(ms) };
}

/** Optional thresholds: sometimes omitted (defaults), sometimes generated. */
const thresholdsArb: fc.Arbitrary<AnomalyThresholds | undefined> = fc.oneof(
  fc.constant<AnomalyThresholds | undefined>(undefined),
  fc.record({
    altDropThreshold: finiteDouble(0, 50),
    batteryDrainThreshold: finiteDouble(0, 50),
  }),
);

describe('Anomaly detector property tests (task 7.6)', () => {
  it('P16 — detectAnomalies is pure: equal inputs ⇒ equal outputs, no mutation (Req 9.2)', () => {
    // A sample plus a 0..5 entry history (the detector only consults the last
    // entry, but the full window is generated to exercise the contract).
    const inputArb = fc.record({
      base: sampleBodyArb,
      // Distinct epoch-ms per slot keeps timestamps well-formed; values may be
      // out of order — purity must hold regardless of ordering.
      sampleMs: fc.integer({ min: 0, max: 4_000_000_000_000 }),
      historyMs: fc.array(fc.integer({ min: 0, max: 4_000_000_000_000 }), {
        maxLength: 5,
      }),
      historyBodies: fc.array(sampleBodyArb, { maxLength: 5 }),
      thresholds: thresholdsArb,
    });

    fc.assert(
      fc.property(inputArb, ({ base, sampleMs, historyMs, historyBodies, thresholds }) => {
        const sample = withTs(base, sampleMs);
        const n = Math.min(historyMs.length, historyBodies.length);
        const history: TelemetrySample[] = [];
        for (let i = 0; i < n; i += 1) {
          history.push(withTs(historyBodies[i], historyMs[i]));
        }

        // Snapshot inputs to detect any mutation.
        const sampleSnapshot = structuredClone(sample);
        const historySnapshot = structuredClone(history);

        // Two independent, structurally-equal input instances.
        const sampleCopy = structuredClone(sample);
        const historyCopy = structuredClone(history);

        const first = detectAnomalies(sample, history, thresholds);
        const second = detectAnomalies(sampleCopy, historyCopy, thresholds);

        // Determinism: equal inputs produce equal outputs.
        expect(second).toEqual(first);
        // Idempotent re-run on the same instances also agrees.
        expect(detectAnomalies(sample, history, thresholds)).toEqual(first);

        // No mutation of either input.
        expect(sample).toEqual(sampleSnapshot);
        expect(history).toEqual(historySnapshot);
        expect(history).toHaveLength(n);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P17 — ALTITUDE_DROP is produced IFF descent rate > altDropThreshold (Req 9.3)', () => {
    // Construct (prev, sample) pairs whose descent rate straddles the
    // threshold: target a rate within ±5 m/s of it, then derive the sample
    // altitude from prev altitude, the target rate and dt. We also widen the
    // space with fully-random altitude pairs.
    const pairArb = fc.record({
      droneId: fc.constantFrom(...DRONE_IDS),
      prevBody: sampleBodyArb,
      sampleBody: sampleBodyArb,
      prevMs: fc.integer({ min: 0, max: 4_000_000_000_000 }),
      // Strictly positive dt (1 ms .. 10 min) ⇒ dt > 0 precondition holds.
      dtMs: fc.integer({ min: 1, max: 600_000 }),
      prevAltitude: finiteDouble(-1000, 10_000),
      altDropThreshold: finiteDouble(0, 50),
      // How the sample altitude is chosen relative to the threshold.
      shape: fc.oneof(
        // Near-threshold: pick a target rate close to the threshold.
        fc.record({
          tag: fc.constant<'near'>('near'),
          rateOffset: finiteDouble(-5, 5),
        }),
        // Wide: an arbitrary sample altitude (rate can be far either side).
        fc.record({
          tag: fc.constant<'wide'>('wide'),
          sampleAltitude: finiteDouble(-1000, 10_000),
        }),
      ),
    });

    fc.assert(
      fc.property(pairArb, (g) => {
        const dtSeconds = g.dtMs / 1000;
        const sampleAltitude =
          g.shape.tag === 'near'
            ? g.prevAltitude - (g.altDropThreshold + g.shape.rateOffset) * dtSeconds
            : g.shape.sampleAltitude;

        const prev = withTs(
          { ...g.prevBody, droneId: g.droneId, altitude: g.prevAltitude },
          g.prevMs,
        );
        const sample = withTs(
          { ...g.sampleBody, droneId: g.droneId, altitude: sampleAltitude },
          g.prevMs + g.dtMs,
        );

        const thresholds: AnomalyThresholds = {
          altDropThreshold: g.altDropThreshold,
          batteryDrainThreshold: DEFAULT_BATTERY_DRAIN_THRESHOLD,
        };

        // Oracle: recompute the descent rate exactly as the detector does,
        // deriving dt from the same ISO timestamps.
        const prevMs = Date.parse(prev.ts);
        const sampleMs = Date.parse(sample.ts);
        const dt = (sampleMs - prevMs) / 1000;
        const descentRate = (prev.altitude - sample.altitude) / dt;
        const expected = dt > 0 && descentRate > g.altDropThreshold;

        const produced = detectAnomalies(sample, [prev], thresholds).some(
          (a) => a.kind === 'ALTITUDE_DROP',
        );

        expect(produced).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P17 — non-empty history with positive dt: ALTITUDE_DROP only from the last history entry (Req 9.3)', () => {
    // Reinforces that the rate is computed against prev = last(history): a
    // multi-entry window whose final entry sits just above/below threshold.
    const arb = fc.record({
      droneId: fc.constantFrom(...DRONE_IDS),
      olderBodies: fc.array(sampleBodyArb, { maxLength: 3 }),
      prevBody: sampleBodyArb,
      sampleBody: sampleBodyArb,
      baseMs: fc.integer({ min: 0, max: 4_000_000_000_000 }),
      dtMs: fc.integer({ min: 1, max: 600_000 }),
      prevAltitude: finiteDouble(-500, 5000),
      altDropThreshold: finiteDouble(1, 40),
      rateOffset: finiteDouble(-3, 3),
    });

    fc.assert(
      fc.property(arb, (g) => {
        const dtSeconds = g.dtMs / 1000;
        const sampleAltitude = g.prevAltitude - (g.altDropThreshold + g.rateOffset) * dtSeconds;

        // Older entries strictly precede prev; prev strictly precedes sample.
        const olderCount = g.olderBodies.length;
        const history: TelemetrySample[] = [];
        for (let i = 0; i < olderCount; i += 1) {
          // Place older entries before baseMs, each 1s apart, ascending.
          const ms = g.baseMs - (olderCount - i) * 1000 - 1000;
          history.push(withTs({ ...g.olderBodies[i], droneId: g.droneId }, Math.max(ms, 0)));
        }
        const prev = withTs(
          { ...g.prevBody, droneId: g.droneId, altitude: g.prevAltitude },
          g.baseMs,
        );
        history.push(prev);

        const sample = withTs(
          { ...g.sampleBody, droneId: g.droneId, altitude: sampleAltitude },
          g.baseMs + g.dtMs,
        );

        const thresholds: AnomalyThresholds = {
          altDropThreshold: g.altDropThreshold,
          batteryDrainThreshold: DEFAULT_BATTERY_DRAIN_THRESHOLD,
        };

        const dt = (Date.parse(sample.ts) - Date.parse(prev.ts)) / 1000;
        const descentRate = (prev.altitude - sample.altitude) / dt;
        const expected = dt > 0 && descentRate > g.altDropThreshold;

        const produced = detectAnomalies(sample, history, thresholds).some(
          (a) => a.kind === 'ALTITUDE_DROP',
        );

        expect(produced).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
