/**
 * Property-based tests for the Telemetry Ingestion parsing and persistence
 * invariants (task 7.4). Uses fast-check with >=100 iterations per property and
 * references the design property numbers it validates.
 *
 * Covered properties:
 *  - P15 — Parse/serialize round-trip (Req 8.3): parseFrame(encode(s),
 *    { droneId: s.droneId }) reconstructs s within float32 tolerance.
 *  - P18 — Bounds invariants (Req 8.4): isWithinBounds accepts iff both
 *    remainingPct and rcSignalStrength are within [0, 100].
 *  - P19 — Monotonic timestamps (Req 8.5): MonotonicTimestampGate accepts a
 *    per-drone sample iff its ts strictly exceeds the last accepted ts for that
 *    drone.
 *
 * The codec author's round-trip note is honoured: the round-trip is exercised
 * as parseFrame(encode(s), { droneId: s.droneId }); flightMode is constrained to
 * <= MAX_FLIGHT_MODE_LENGTH characters; and numeric fields are compared within
 * float32 tolerance.
 */
import type { TelemetrySample, Uuid } from '@pawaac/shared-types';
import fc from 'fast-check';

import { encode, MAX_FLIGHT_MODE_LENGTH, parseFrame } from './mavlink/codec.js';
import { isPercentInRange, isWithinBounds, MonotonicTimestampGate } from './persist/bounds.js';

/** At least 100 iterations per property (Requirement 30.3); we use more headroom. */
const NUM_RUNS = 200;

/** A pool of fixed drone identities so the monotonic gate sees repeated drones. */
const DRONE_IDS: Uuid[] = [
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333',
];

/** Characters safe for the carrier `name` (flightMode) field: no NUL/control. */
const NAME_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'.split('');

/** A bounded float32 value within [min, max] that is always finite. */
function boundedFloat(min: number, max: number): fc.Arbitrary<number> {
  return fc.float({ min: Math.fround(min), max: Math.fround(max), noNaN: true });
}

/** flightMode string constrained to the carrier name field length. */
const flightModeArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...NAME_ALPHABET), { maxLength: MAX_FLIGHT_MODE_LENGTH })
  .map((chars) => chars.join(''));

/** ISO timestamp built from integer epoch-ms so it round-trips through Date. */
const isoTimestampArb: fc.Arbitrary<string> = fc
  // 1970-01-01 .. ~2100, integer ms keeps Date round-trip lossless.
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map((ms) => new Date(ms).toISOString());

/** A fully valid telemetry sample suitable for the encode/parse round-trip. */
const validSampleArb: fc.Arbitrary<TelemetrySample> = fc.record({
  droneId: fc.constantFrom(...DRONE_IDS),
  ts: isoTimestampArb,
  lat: boundedFloat(-90, 90),
  lon: boundedFloat(-180, 180),
  altitude: boundedFloat(-500, 10_000),
  velocity: fc.record({
    vx: boundedFloat(-200, 200),
    vy: boundedFloat(-200, 200),
    vz: boundedFloat(-200, 200),
  }),
  attitude: fc.record({
    roll: boundedFloat(-Math.PI, Math.PI),
    pitch: boundedFloat(-Math.PI, Math.PI),
    yaw: boundedFloat(-Math.PI, Math.PI),
  }),
  battery: fc.record({
    voltage: boundedFloat(0, 60),
    current: boundedFloat(-100, 100),
    remainingPct: boundedFloat(0, 100),
  }),
  ekf2: fc.record({
    healthy: fc.boolean(),
    // Integer flags within float32-exact range; decode applies Math.round.
    flags: fc.integer({ min: 0, max: 1 << 20 }),
  }),
  rcSignalStrength: boundedFloat(0, 100),
  flightMode: flightModeArb,
  armed: fc.boolean(),
});

/**
 * Assert two numeric values are equal within float32 tolerance. fast-check's
 * `fc.float` yields exact float32 values and the codec stores float32, so the
 * round-trip is effectively lossless; we still allow a small relative epsilon.
 */
function expectCloseFloat32(actual: number, expected: number, field: string): void {
  const tolerance = 1e-3 * (1 + Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`field ${field} out of tolerance: ${actual} vs ${expected}`);
  }
}

describe('Telemetry property tests — parsing & persistence invariants (task 7.4)', () => {
  it('P15 — parse/serialize round-trip reconstructs samples within float32 tolerance (Req 8.3)', () => {
    fc.assert(
      fc.property(validSampleArb, (sample) => {
        const decoded = parseFrame(encode(sample), { droneId: sample.droneId });

        // Exact fields.
        expect(decoded.droneId).toBe(sample.droneId);
        expect(decoded.ts).toBe(sample.ts);
        expect(decoded.flightMode).toBe(sample.flightMode);
        expect(decoded.armed).toBe(sample.armed);
        expect(decoded.ekf2.healthy).toBe(sample.ekf2.healthy);
        expect(decoded.ekf2.flags).toBe(sample.ekf2.flags);

        // Numeric fields within float32 tolerance.
        expectCloseFloat32(decoded.lat, sample.lat, 'lat');
        expectCloseFloat32(decoded.lon, sample.lon, 'lon');
        expectCloseFloat32(decoded.altitude, sample.altitude, 'altitude');
        expectCloseFloat32(decoded.velocity.vx, sample.velocity.vx, 'velocity.vx');
        expectCloseFloat32(decoded.velocity.vy, sample.velocity.vy, 'velocity.vy');
        expectCloseFloat32(decoded.velocity.vz, sample.velocity.vz, 'velocity.vz');
        expectCloseFloat32(decoded.attitude.roll, sample.attitude.roll, 'attitude.roll');
        expectCloseFloat32(decoded.attitude.pitch, sample.attitude.pitch, 'attitude.pitch');
        expectCloseFloat32(decoded.attitude.yaw, sample.attitude.yaw, 'attitude.yaw');
        expectCloseFloat32(decoded.battery.voltage, sample.battery.voltage, 'battery.voltage');
        expectCloseFloat32(decoded.battery.current, sample.battery.current, 'battery.current');
        expectCloseFloat32(
          decoded.battery.remainingPct,
          sample.battery.remainingPct,
          'battery.remainingPct',
        );
        expectCloseFloat32(decoded.rcSignalStrength, sample.rcSignalStrength, 'rcSignalStrength');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P18 — isWithinBounds accepts iff remainingPct and rcSignalStrength are both in [0,100] (Req 8.4)', () => {
    // A percentage-like value that mixes in-range, out-of-range and special values.
    const percentish: fc.Arbitrary<number> = fc.oneof(
      boundedFloat(0, 100), // typically in range
      boundedFloat(-50, 200), // straddles the bounds
      fc.constantFrom(
        0,
        100,
        -1,
        101,
        -0.0001,
        100.0001,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ),
    );

    const baseSample = (remainingPct: number, rcSignalStrength: number): TelemetrySample => ({
      droneId: DRONE_IDS[0],
      ts: '2024-01-01T00:00:00.000Z',
      lat: 0,
      lon: 0,
      altitude: 0,
      velocity: { vx: 0, vy: 0, vz: 0 },
      attitude: { roll: 0, pitch: 0, yaw: 0 },
      battery: { voltage: 12, current: 1, remainingPct },
      ekf2: { healthy: true, flags: 0 },
      rcSignalStrength,
      flightMode: 'AUTO',
      armed: true,
    });

    fc.assert(
      fc.property(percentish, percentish, (remainingPct, rcSignalStrength) => {
        const sample = baseSample(remainingPct, rcSignalStrength);
        const expected = isPercentInRange(remainingPct) && isPercentInRange(rcSignalStrength);
        expect(isWithinBounds(sample)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P19 — MonotonicTimestampGate accepts iff ts strictly exceeds last accepted ts per drone (Req 8.5)', () => {
    // A small ms window so duplicates and out-of-order timestamps occur often.
    const msArb = fc.integer({ min: 1_700_000_000_000, max: 1_700_000_000_050 });

    const gateSampleArb = fc.record({
      droneId: fc.constantFrom(...DRONE_IDS),
      ms: msArb,
    });

    fc.assert(
      fc.property(fc.array(gateSampleArb, { minLength: 1, maxLength: 60 }), (events) => {
        const gate = new MonotonicTimestampGate();
        const expectedLast = new Map<Uuid, number>();

        for (const { droneId, ms } of events) {
          const sample: TelemetrySample = {
            droneId,
            ts: new Date(ms).toISOString(),
            lat: 0,
            lon: 0,
            altitude: 0,
            velocity: { vx: 0, vy: 0, vz: 0 },
            attitude: { roll: 0, pitch: 0, yaw: 0 },
            battery: { voltage: 12, current: 1, remainingPct: 50 },
            ekf2: { healthy: true, flags: 0 },
            rcSignalStrength: 50,
            flightMode: 'AUTO',
            armed: true,
          };

          const last = expectedLast.get(droneId);
          const shouldAccept = last === undefined || ms > last;

          // wouldAccept must be side-effect free and agree with the decision.
          expect(gate.wouldAccept(sample)).toBe(shouldAccept);
          expect(gate.wouldAccept(sample)).toBe(shouldAccept);

          const accepted = gate.accept(sample);
          expect(accepted).toBe(shouldAccept);

          if (accepted) {
            expectedLast.set(droneId, ms);
            expect(gate.lastAccepted(droneId)).toBe(ms);
          } else {
            // A rejected sample never advances the per-drone high-water mark.
            expect(gate.lastAccepted(droneId)).toBe(last);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P19 — unparseable timestamps are always rejected and do not advance state (Req 8.5)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DRONE_IDS), (droneId) => {
        const gate = new MonotonicTimestampGate();
        const sample: TelemetrySample = {
          droneId,
          ts: 'not-a-timestamp',
          lat: 0,
          lon: 0,
          altitude: 0,
          velocity: { vx: 0, vy: 0, vz: 0 },
          attitude: { roll: 0, pitch: 0, yaw: 0 },
          battery: { voltage: 12, current: 1, remainingPct: 50 },
          ekf2: { healthy: true, flags: 0 },
          rcSignalStrength: 50,
          flightMode: 'AUTO',
          armed: true,
        };
        expect(gate.wouldAccept(sample)).toBe(false);
        expect(gate.accept(sample)).toBe(false);
        expect(gate.lastAccepted(droneId)).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
