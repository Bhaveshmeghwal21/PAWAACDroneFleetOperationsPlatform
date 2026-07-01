import fc from 'fast-check';
import type { Mission, Waypoint } from '@pawaac/shared-types';
import {
  canonicalize,
  exportMavlink,
  parseMavlink,
} from '../src/export/mavlink';

/**
 * Property-based tests for PX4 MAVLink serialization (design **Algorithm 7**,
 * properties **P12** and **P13**; Requirement 7). Both properties exercise the
 * pure serialization functions over randomly generated *validated* missions, so
 * no NestJS app or Postgres connection is required.
 *
 * Each property runs at least 100 iterations via `numRuns`.
 */

/** Minimum iterations mandated for every property (task 5.10: ">=100 each"). */
const NUM_RUNS = 300;

// --- Generators -------------------------------------------------------------

/**
 * Generates the numeric fields of an always-valid waypoint, strictly within the
 * domain constraints from Requirement 4 / the {@link Waypoint} contract:
 *   - lat in [-90, 90], lon in [-180, 180]
 *   - altitude > 0, speed > 0
 *   - gimbalAngle in [-90, 90], loiterTime >= 0
 *
 * Coordinates span the full valid range, including small negative values close
 * to the equator/prime-meridian (which `round(deg * 1e7)` maps to zero) — those
 * are realistic inputs the round-trip property must cover.
 */
const validWaypointFieldsArb = fc.record({
  lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
  lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
  altitude: fc.double({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true }),
  speed: fc.double({ min: 1, max: 50, noNaN: true, noDefaultInfinity: true }),
  gimbalAngle: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
  loiterTime: fc.double({ min: 0, max: 600, noNaN: true, noDefaultInfinity: true }),
});

/**
 * A non-empty route of 1..N valid waypoints with contiguous `seq` 0..n-1, in
 * order — exactly the shape a validated mission carries (Requirement 4.2).
 */
const validRouteArb: fc.Arbitrary<Waypoint[]> = fc
  .array(validWaypointFieldsArb, { minLength: 1, maxLength: 8 })
  .map((fields) => fields.map((f, seq): Waypoint => ({ seq, ...f })));

/**
 * A `validated` {@link Mission} built around a valid route. `id`, `version` and
 * `createdAt` are irrelevant to serialization (which depends only on the
 * waypoints) but are populated with plausible values for realism.
 */
const validatedMissionArb: fc.Arbitrary<Mission> = fc
  .record({
    waypoints: validRouteArb,
    name: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
    version: fc.integer({ min: 1, max: 50 }),
  })
  .map(
    ({ waypoints, name, version }): Mission => ({
      id: '11111111-1111-1111-1111-111111111111',
      version,
      name,
      waypoints,
      status: 'validated',
      createdAt: '2024-01-01T00:00:00.000Z',
    }),
  );

describe('P12 — MAVLink round-trip (design P12, Algorithm 7)', () => {
  it('parseMavlink(exportMavlink(m, "binary").bytes) deep-equals canonicalize(m) — Validates: Requirements 7.5', () => {
    fc.assert(
      fc.property(validatedMissionArb, (mission) => {
        const exported = exportMavlink(mission, 'binary');
        // Binary exports always carry bytes (design Algorithm 7).
        expect(Buffer.isBuffer(exported.bytes)).toBe(true);

        const parsed = parseMavlink(exported.bytes as Buffer);
        // The parsed item sequence reconstructs the canonical geometry/params.
        expect(parsed).toEqual(canonicalize(mission));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('P13 — Export determinism (design P13, Algorithm 7)', () => {
  it('exportMavlink(m, "binary").bytes is byte-identical across repeated runs — Validates: Requirements 7.6', () => {
    fc.assert(
      fc.property(validatedMissionArb, (mission) => {
        const first = exportMavlink(mission, 'binary').bytes as Buffer;
        const second = exportMavlink(mission, 'binary').bytes as Buffer;
        const third = exportMavlink(mission, 'binary').bytes as Buffer;

        expect(Buffer.isBuffer(first)).toBe(true);
        // Buffer.equals compares the bytes themselves, not object identity.
        expect(first.equals(second)).toBe(true);
        expect(first.equals(third)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
