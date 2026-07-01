import fc from 'fast-check';
import type { GeoPolygon, GeofenceConflict, Waypoint } from '@pawaac/shared-types';
import {
  detectConflicts,
  pointInPolygon,
  type ConflictZone,
  type Point,
} from '../src/geofences/geometry';
import { validWaypoint } from './helpers';

/**
 * Property-based tests for in-process geofence conflict detection
 * (design **Algorithm 1**, properties **P7**, **P8**, **P9**; Requirement 5).
 *
 * Strategy: confine generated no-fly zones to **axis-aligned rectangles** so an
 * independent reference predicate is trivial to state and is computed by a
 * different algorithm than the one under test:
 *   - segment/zone overlap is decided by a Separating-Axis-Theorem (SAT) test
 *     against the rectangle (integer arithmetic, no division) — completely
 *     independent of the orientation/ray-casting logic in `geometry.ts`;
 *   - point containment is decided by a plain coordinate-bounds check.
 *
 * All coordinates are integers within valid lon/lat ranges, which keeps every
 * reference computation exact and avoids floating-point boundary ambiguity.
 * Every property runs at least 100 iterations via `numRuns`.
 */

/** Minimum iterations mandated by task 5.6 (">=100 iterations each"). */
const NUM_RUNS = 200;

/** An axis-aligned rectangle no-fly zone, `xmin < xmax` and `ymin < ymax`. */
interface Rect {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

/** A generated zone: identity + reference rectangle + its closed polygon ring. */
interface RectZone extends ConflictZone {
  readonly rect: Rect;
}

/** Closed CCW ring (first point repeated) for an axis-aligned rectangle. */
function rectRing(r: Rect): GeoPolygon {
  return [
    [r.xmin, r.ymin],
    [r.xmax, r.ymin],
    [r.xmax, r.ymax],
    [r.xmin, r.ymax],
    [r.xmin, r.ymin],
  ];
}

/**
 * Independent reference for "the closed segment `a -> b` touches or enters the
 * closed rectangle `r`", via the Separating Axis Theorem. A segment (degenerate
 * box) and an axis-aligned box are disjoint iff some axis separates them; the
 * candidate axes are the two box axes (x, y) plus the segment's normal. Uses
 * only sums/products of integer coordinates, so it is exact and shares no code
 * path with the orientation / ray-casting routines under test.
 */
function segmentTouchesRect(a: Point, b: Point, r: Rect): boolean {
  // Axis x: projections onto the x-axis.
  if (Math.max(a[0], b[0]) < r.xmin || Math.min(a[0], b[0]) > r.xmax) {
    return false;
  }
  // Axis y: projections onto the y-axis.
  if (Math.max(a[1], b[1]) < r.ymin || Math.min(a[1], b[1]) > r.ymax) {
    return false;
  }
  // Axis = segment normal. Both endpoints project to the same scalar `d`
  // (the normal is perpendicular to the segment direction).
  const nx = -(b[1] - a[1]);
  const ny = b[0] - a[0];
  const d = nx * a[0] + ny * a[1];
  const corners: readonly Point[] = [
    [r.xmin, r.ymin],
    [r.xmax, r.ymin],
    [r.xmax, r.ymax],
    [r.xmin, r.ymax],
  ];
  let rmin = Infinity;
  let rmax = -Infinity;
  for (const c of corners) {
    const proj = nx * c[0] + ny * c[1];
    rmin = Math.min(rmin, proj);
    rmax = Math.max(rmax, proj);
  }
  if (d < rmin || d > rmax) {
    return false;
  }
  return true;
}

/** Strict interior of an axis-aligned rectangle (boundary excluded). */
function strictlyInsideRect(p: Point, r: Rect): boolean {
  return p[0] > r.xmin && p[0] < r.xmax && p[1] > r.ymin && p[1] < r.ymax;
}

/** True iff `p` lies exactly on one of the rectangle's bounding lines. */
function onRectBoundaryLine(p: Point, r: Rect): boolean {
  return p[0] === r.xmin || p[0] === r.xmax || p[1] === r.ymin || p[1] === r.ymax;
}

/**
 * A second, independent even-odd ray-casting implementation (horizontal ray to
 * +x, half-open `[yi, yj)` edge rule). Deliberately formulated differently from
 * the production `pointInPolygon` so P9 compares two implementations.
 */
function rayCastReference(p: Point, ring: GeoPolygon): boolean {
  const [x, y] = p;
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const vi = ring[i];
    const vj = ring[i + 1];
    if (vi === undefined || vj === undefined) {
      continue;
    }
    const [xi, yi] = vi;
    const [xj, yj] = vj;
    const crosses = yi <= y ? yj > y : yj <= y;
    if (crosses) {
      const t = (y - yi) / (yj - yi);
      const xCross = xi + t * (xj - xi);
      if (x < xCross) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Independent expected conflict set, built in the detector's emission order. */
function expectedConflicts(
  waypoints: readonly Waypoint[],
  zones: readonly RectZone[],
): GeofenceConflict[] {
  const out: GeofenceConflict[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];
    if (from === undefined || to === undefined) {
      continue;
    }
    const a: Point = [from.lon, from.lat];
    const b: Point = [to.lon, to.lat];
    for (const zone of zones) {
      if (segmentTouchesRect(a, b, zone.rect)) {
        out.push({ segmentIndex: i, zoneId: zone.id });
      }
    }
  }
  return out;
}

/** Recursively freezes an object/array graph to detect any input mutation. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// --- Generators -------------------------------------------------------------

/** Integer coordinate within valid lon/lat ranges, kept small and exact. */
const coordArb = fc.integer({ min: -40, max: 40 });

/** A planar `[lon, lat]` point. */
const pointArb: fc.Arbitrary<Point> = fc.tuple(coordArb, coordArb);

/** A non-degenerate axis-aligned rectangle (`width, height >= 1`). */
const rectArb: fc.Arbitrary<Rect> = fc
  .record({
    x0: coordArb,
    y0: coordArb,
    w: fc.integer({ min: 1, max: 40 }),
    h: fc.integer({ min: 1, max: 40 }),
  })
  .map(({ x0, y0, w, h }) => ({ xmin: x0, ymin: y0, xmax: x0 + w, ymax: y0 + h }));

/** A route of 0..6 waypoints (covers no-segment and multi-segment routes). */
const routeArb: fc.Arbitrary<Waypoint[]> = fc
  .array(pointArb, { minLength: 0, maxLength: 6 })
  .map((points) =>
    points.map((p, seq): Waypoint => validWaypoint({ seq, lon: p[0], lat: p[1] })),
  );

/** 0..4 rectangle zones, each with a unique id and its closed polygon ring. */
const zonesArb: fc.Arbitrary<RectZone[]> = fc
  .array(rectArb, { minLength: 0, maxLength: 4 })
  .map((rects) =>
    rects.map((rect, idx) => ({ id: `zone-${idx}`, rect, polygon: rectRing(rect) })),
  );

/** Strips the reference rectangle, leaving exactly what the detector accepts. */
const toConflictZones = (zones: readonly RectZone[]): ConflictZone[] =>
  zones.map((z) => ({ id: z.id, polygon: z.polygon }));

describe('P7 — Conflict completeness (design P7, Algorithm 1)', () => {
  it('emits exactly one conflict per (segment, zone) that touches/enters, and empty iff none do — Validates: Requirements 5.3, 5.4', () => {
    fc.assert(
      fc.property(routeArb, zonesArb, (route, zones) => {
        const conflicts = detectConflicts(route, toConflictZones(zones));
        const expected = expectedConflicts(route, zones);

        // One conflict per offending (segment, zone) pair, in order (5.4).
        expect(conflicts).toEqual(expected);

        // Empty if and only if no segment enters or touches any zone (5.3).
        expect(conflicts.length === 0).toBe(expected.length === 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never emits a duplicate (segmentIndex, zoneId) pair — Validates: Requirements 5.4', () => {
    fc.assert(
      fc.property(routeArb, zonesArb, (route, zones) => {
        const conflicts = detectConflicts(route, toConflictZones(zones));
        const keys = conflicts.map((c) => `${c.segmentIndex}:${c.zoneId}`);
        expect(new Set(keys).size).toBe(keys.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('P8 — Conflict determinism & input immutability (design P8)', () => {
  it('returns identical results for repeated identical inputs — Validates: Requirements 5.5', () => {
    fc.assert(
      fc.property(routeArb, zonesArb, (route, zones) => {
        const zonesArg = toConflictZones(zones);
        const first = detectConflicts(route, zonesArg);
        const second = detectConflicts(route, zonesArg);
        const third = detectConflicts(route, toConflictZones(zones));
        expect(second).toEqual(first);
        expect(third).toEqual(first);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not mutate its input waypoints or zones — Validates: Requirements 5.7', () => {
    fc.assert(
      fc.property(routeArb, zonesArb, (route, zones) => {
        const zonesArg = toConflictZones(zones);
        const routeSnapshot = structuredClone(route);
        const zonesSnapshot = structuredClone(zonesArg);

        // Freezing turns any attempted mutation into a thrown TypeError.
        deepFreeze(route);
        deepFreeze(zonesArg);

        expect(() => detectConflicts(route, zonesArg)).not.toThrow();

        expect(route).toEqual(routeSnapshot);
        expect(zonesArg).toEqual(zonesSnapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('P9 — Point-in-polygon parity (design P9, Algorithm 1)', () => {
  it('ray-casting pointInPolygon agrees with independent references off-boundary — Validates: Requirements 5.6', () => {
    fc.assert(
      fc.property(pointArb, rectArb, (point, rect) => {
        const ring = rectRing(rect);
        const production = pointInPolygon(point, ring);

        // Boundary points carry an inherent even-odd ambiguity ("modulo boundary
        // tolerance"); the detector covers them via edge-intersection instead.
        if (onRectBoundaryLine(point, rect)) {
          return;
        }

        // Off-boundary: production must match both the rectangle-containment
        // reference and the independent even-odd ray-cast reference.
        expect(production).toBe(strictlyInsideRect(point, rect));
        expect(production).toBe(rayCastReference(point, ring));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
