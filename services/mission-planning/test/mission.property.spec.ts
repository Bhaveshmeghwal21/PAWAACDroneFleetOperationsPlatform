import fc from 'fast-check';
import type { Mission, MissionStatus, Waypoint } from '@pawaac/shared-types';
import { validateWaypoints } from '../src/missions/waypoint-validation';
import { CreateMissionDto, UpdateMissionDto } from '../src/missions/dto';
import { buildHarness, TEST_MAX_ALTITUDE } from './helpers';

/**
 * Property-based tests for Mission Planning validation and versioning
 * (design properties P10 and P11). Each property runs at least 100 iterations
 * via `numRuns` (Requirement 30.3) and references the design property it
 * validates.
 */

/** Minimum iterations mandated for every property (Requirement 30.3). */
const NUM_RUNS = 300;

const MAX_ALTITUDE = TEST_MAX_ALTITUDE;

/** Builds `[0, 1, ..., n-1]`. */
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/**
 * Independent re-statement of the validity predicate from Requirement 4
 * (design property P10). A mission is valid **iff** every waypoint satisfies
 * all range constraints AND the `seq` multiset is exactly `{0..n-1}`. This is
 * deliberately written separately from {@link validateWaypoints} so the
 * property compares two independent implementations.
 */
function isValidRoute(waypoints: readonly Waypoint[], maxAltitude: number): boolean {
  const rangeOk = waypoints.every(
    (wp) =>
      Number.isFinite(wp.lat) &&
      wp.lat >= -90 &&
      wp.lat <= 90 &&
      Number.isFinite(wp.lon) &&
      wp.lon >= -180 &&
      wp.lon <= 180 &&
      Number.isFinite(wp.altitude) &&
      wp.altitude > 0 &&
      wp.altitude <= maxAltitude &&
      Number.isFinite(wp.speed) &&
      wp.speed > 0 &&
      Number.isFinite(wp.gimbalAngle) &&
      wp.gimbalAngle >= -90 &&
      wp.gimbalAngle <= 90 &&
      Number.isFinite(wp.loiterTime) &&
      wp.loiterTime >= 0,
  );
  const sortedSeq = waypoints.map((wp) => wp.seq).sort((a, b) => a - b);
  const seqOk = sortedSeq.every((seq, index) => seq === index);
  return rangeOk && seqOk;
}

/**
 * Generates the numeric fields of a waypoint across ranges that straddle every
 * constraint boundary, so a healthy mix of valid and invalid waypoints is
 * produced (no NaN/Infinity — those are covered by the `Number.isFinite`
 * branch in both implementations, but excluded here for predictable mixing).
 */
const waypointFieldsArb = fc.record({
  lat: fc.double({ min: -180, max: 180, noNaN: true }),
  lon: fc.double({ min: -360, max: 360, noNaN: true }),
  altitude: fc.double({ min: -50, max: MAX_ALTITUDE * 2, noNaN: true }),
  speed: fc.double({ min: -10, max: 50, noNaN: true }),
  gimbalAngle: fc.double({ min: -180, max: 180, noNaN: true }),
  loiterTime: fc.double({ min: -10, max: 100, noNaN: true }),
});

/**
 * Generates `seq` arrays of length `n` that are either a true permutation of
 * `{0..n-1}` (contiguous — valid sequence) or arbitrary small integers (very
 * often non-contiguous — invalid sequence), guaranteeing both branches.
 */
const seqsArb = (n: number): fc.Arbitrary<number[]> =>
  fc.oneof(
    fc.shuffledSubarray(range(n), { minLength: n, maxLength: n }),
    fc.array(fc.integer({ min: 0, max: n + 2 }), { minLength: n, maxLength: n }),
  );

/** A possibly-valid, possibly-invalid route exercising both P10 branches. */
const arbitraryRouteArb: fc.Arbitrary<Waypoint[]> = fc
  .integer({ min: 0, max: 6 })
  .chain((n) =>
    fc
      .record({
        fields: fc.array(waypointFieldsArb, { minLength: n, maxLength: n }),
        seqs: seqsArb(n),
      })
      .map(({ fields, seqs }) =>
        fields.map((f, i): Waypoint => ({ seq: seqs[i] as number, ...f })),
      ),
  );

describe('P10 — Waypoint validation (Requirement 4.2, design P10)', () => {
  it('validates iff every waypoint is in range AND seq is contiguous from 0 — Validates: Requirements 4.2', () => {
    fc.assert(
      fc.property(arbitraryRouteArb, (route) => {
        const isEmpty = validateWaypoints(route, MAX_ALTITUDE).length === 0;
        expect(isEmpty).toBe(isValidRoute(route, MAX_ALTITUDE));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('always reports field-level errors for invalid routes and none for valid routes — Validates: Requirements 4.2', () => {
    fc.assert(
      fc.property(arbitraryRouteArb, (route) => {
        const errors = validateWaypoints(route, MAX_ALTITUDE);
        if (isValidRoute(route, MAX_ALTITUDE)) {
          expect(errors).toEqual([]);
        } else {
          expect(errors.length).toBeGreaterThan(0);
          // Every error carries a non-empty field path (Requirement 4.3).
          expect(errors.every((e) => typeof e.field === 'string' && e.field.length > 0)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

/** Generates a single always-valid waypoint (used for valid routes/edits). */
const validWaypointFieldsArb = fc.record({
  lat: fc.double({ min: -90, max: 90, noNaN: true }),
  lon: fc.double({ min: -180, max: 180, noNaN: true }),
  altitude: fc.double({ min: Number.MIN_VALUE, max: MAX_ALTITUDE, noNaN: true }),
  speed: fc.double({ min: Number.MIN_VALUE, max: 50, noNaN: true }),
  gimbalAngle: fc.double({ min: -90, max: 90, noNaN: true }),
  loiterTime: fc.double({ min: 0, max: 100, noNaN: true }),
});

/** A non-empty, always-valid route with contiguous seq 0..n-1. */
const validRouteArb: fc.Arbitrary<Waypoint[]> = fc
  .array(validWaypointFieldsArb, { minLength: 1, maxLength: 5 })
  .map((fields) => fields.map((f, seq): Waypoint => ({ seq, ...f })));

const nameArb = fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0);
const statusArb = fc.constantFrom<MissionStatus>('draft', 'validated', 'archived');

/**
 * A valid edit (UpdateMissionDto). Any subset of `name`, `status`, `waypoints`
 * may be present; omitted keys are carried over by the service. Keys are
 * omitted (not set to `undefined`) to satisfy `exactOptionalPropertyTypes`.
 */
const editArb: fc.Arbitrary<UpdateMissionDto> = fc
  .record(
    {
      name: nameArb,
      status: statusArb,
      waypoints: validRouteArb,
    },
    { requiredKeys: [] },
  )
  .map((parts) => {
    const dto: UpdateMissionDto = {};
    if (parts.name !== undefined) dto.name = parts.name;
    if (parts.status !== undefined) dto.status = parts.status;
    if (parts.waypoints !== undefined) dto.waypoints = parts.waypoints as CreateMissionDto['waypoints'];
    return dto;
  });

describe('P11 — Immutable versioning (Requirements 4.5, 4.7, design P11)', () => {
  it('each valid edit creates version v+1 and leaves every prior version byte-identical — Validates: Requirements 4.5, 4.7', async () => {
    await fc.assert(
      fc.asyncProperty(
        validRouteArb,
        nameArb,
        statusArb,
        fc.array(editArb, { minLength: 1, maxLength: 4 }),
        async (route, name, status, edits) => {
          const h = buildHarness(MAX_ALTITUDE);
          const create: CreateMissionDto = {
            name,
            status,
            waypoints: route as CreateMissionDto['waypoints'],
          };
          const v1 = await h.service.createMission(create);

          // Byte-identical snapshots of every persisted version so far.
          const snapshots = new Map<number, Mission>();
          snapshots.set(v1.version, structuredClone(v1));
          let prevVersion = v1.version;

          for (const edit of edits) {
            const next = await h.service.updateMission(v1.id, edit);

            // New version is exactly one greater than the prior (4.5).
            expect(next.version).toBe(prevVersion + 1);
            prevVersion = next.version;

            // Every previously captured version is still byte-identical (4.7).
            for (const [version, snapshot] of snapshots) {
              const reread = await h.service.getMissionVersion(v1.id, version);
              expect(reread).toEqual(snapshot);
            }

            snapshots.set(next.version, structuredClone(next));
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a rejected (invalid) edit creates no new version and leaves v1 intact — Validates: Requirements 4.5, 4.7', async () => {
    await fc.assert(
      fc.asyncProperty(validRouteArb, nameArb, async (route, name) => {
        const h = buildHarness(MAX_ALTITUDE);
        const v1 = await h.service.createMission({
          name,
          waypoints: route as CreateMissionDto['waypoints'],
        });
        const snapshot = structuredClone(v1);

        // An out-of-range altitude makes the edit invalid; it must be rejected.
        const badEdit: UpdateMissionDto = {
          waypoints: [
            { seq: 0, lat: 0, lon: 0, altitude: MAX_ALTITUDE + 1, speed: 5, gimbalAngle: 0, loiterTime: 0 },
          ] as CreateMissionDto['waypoints'],
        };
        await expect(h.service.updateMission(v1.id, badEdit)).rejects.toBeDefined();

        // No version 2 exists and version 1 is unchanged.
        await expect(h.service.getMissionVersion(v1.id, 2)).rejects.toBeDefined();
        const reread = await h.service.getMissionVersion(v1.id, 1);
        expect(reread).toEqual(snapshot);
      }),
      { numRuns: 100 },
    );
  });
});
