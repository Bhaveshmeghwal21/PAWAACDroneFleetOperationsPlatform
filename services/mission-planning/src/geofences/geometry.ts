import type { GeofenceConflict, GeoPolygon, Waypoint } from '@pawaac/shared-types';

/**
 * Pure, dependency-free planar geometry primitives backing geofence definition
 * validation and in-process conflict detection (Requirement 5; design
 * Algorithm 1). Every function here is a total, deterministic, side-effect-free
 * function of its arguments and never mutates its inputs, which is what lets the
 * service guarantee determinism (P8) and input-immutability (5.7) and lets the
 * property tests (task 5.6) exercise the geometry directly.
 *
 * Coordinates use GeoJSON axis ordering throughout: a point is `[lon, lat]`
 * (x = longitude, y = latitude). Treating the WGS84 lon/lat plane as Euclidean
 * is the standard approach for the small-area conflict checks performed here and
 * is exactly what mirrors the PostGIS `ST_Intersects` production path within
 * boundary tolerance (P9).
 */

/** A planar point as `[x, y]` (i.e. `[lon, lat]`). */
export type Point = readonly [number, number];

/** A directed segment between two points. */
export interface Segment {
  readonly start: Point;
  readonly end: Point;
}

/**
 * Signed area (twice) of triangle `a, b, c`; equivalently the 2-D cross product
 * of `b - a` and `c - a`. Sign encodes the orientation of `c` relative to the
 * directed line `a -> b`: positive = counter-clockwise, negative = clockwise,
 * zero = collinear.
 */
function orientation(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

const sign = (value: number): number => (value > 0 ? 1 : value < 0 ? -1 : 0);

/**
 * True iff point `p` lies within the axis-aligned bounding box of segment
 * `a -> b`. Used to confirm a collinear point actually falls on the segment
 * rather than on its infinite extension.
 */
function withinBoundingBox(a: Point, b: Point, p: Point): boolean {
  return (
    p[0] >= Math.min(a[0], b[0]) &&
    p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) &&
    p[1] <= Math.max(a[1], b[1])
  );
}

/**
 * True iff the closed segments `p1 -> p2` and `p3 -> p4` intersect, including
 * the cases where they merely touch at an endpoint or overlap collinearly. This
 * is the standard orientation-based test (CLRS) extended with collinear
 * on-segment checks so that "touching" counts as an intersection — exactly the
 * semantics Requirement 5.4 needs (a segment that touches a polygon boundary is
 * a conflict).
 */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = sign(orientation(p3, p4, p1));
  const d2 = sign(orientation(p3, p4, p2));
  const d3 = sign(orientation(p1, p2, p3));
  const d4 = sign(orientation(p1, p2, p4));

  // Proper crossing: each segment straddles the line through the other.
  if (d1 !== d2 && d3 !== d4) {
    return true;
  }

  // Collinear / touching cases.
  if (d1 === 0 && withinBoundingBox(p3, p4, p1)) return true;
  if (d2 === 0 && withinBoundingBox(p3, p4, p2)) return true;
  if (d3 === 0 && withinBoundingBox(p1, p2, p3)) return true;
  if (d4 === 0 && withinBoundingBox(p1, p2, p4)) return true;

  return false;
}

/**
 * Ray-casting (even-odd rule) point-in-polygon test against a closed ring.
 *
 * Returns true when `point` is strictly inside `ring`. Boundary points are
 * intentionally not relied upon here: a point exactly on an edge may report
 * either way under floating-point evaluation, but the conflict detector also
 * runs explicit segment/edge intersection tests, so boundary touches are still
 * detected via {@link segmentIntersectsPolygon}. The ring is expected to be
 * closed (first point equals last); a trailing duplicate point contributes a
 * zero-length edge and is harmless.
 *
 * @param point the `[lon, lat]` location to test
 * @param ring a closed polygon ring of `[lon, lat]` points
 */
export function pointInPolygon(point: Point, ring: GeoPolygon): boolean {
  const [x, y] = point;
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const vi = ring[i];
    const vj = ring[j];
    if (vi === undefined || vj === undefined) {
      continue;
    }
    const [xi, yi] = vi;
    const [xj, yj] = vj;
    const straddlesRay = yi > y !== yj > y;
    if (straddlesRay) {
      const intersectX = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (x < intersectX) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * True iff the segment touches or crosses any edge of the closed `ring`. Tests
 * the segment against every polygon edge with {@link segmentsIntersect}, so a
 * segment that merely grazes the boundary is reported (Requirement 5.4).
 */
export function segmentIntersectsPolygon(segment: Segment, ring: GeoPolygon): boolean {
  const n = ring.length;
  for (let i = 0; i < n - 1; i++) {
    const edgeStart = ring[i];
    const edgeEnd = ring[i + 1];
    if (edgeStart === undefined || edgeEnd === undefined) {
      continue;
    }
    if (segmentsIntersect(segment.start, segment.end, edgeStart, edgeEnd)) {
      return true;
    }
  }
  return false;
}

/** Converts a waypoint to its planar `[lon, lat]` point (no mutation). */
function waypointToPoint(waypoint: Waypoint): Point {
  return [waypoint.lon, waypoint.lat];
}

/**
 * The shape of a no-fly zone the conflict detector needs: an identity plus a
 * closed polygon ring. Accepting this minimal structural type (rather than the
 * full `Geofence`) keeps the pure detector decoupled from persistence.
 */
export interface ConflictZone {
  readonly id: string;
  readonly polygon: GeoPolygon;
}

/**
 * In-process geofence conflict detection (design **Algorithm 1**, properties
 * **P7/P8/P9**).
 *
 * For each route segment `i` (waypoint `i -> i + 1`) and each `zone`, emits one
 * conflict `{ segmentIndex: i, zoneId: zone.id }` iff the segment intersects the
 * polygon boundary OR either endpoint lies inside the polygon — i.e. the segment
 * enters or touches the no-fly zone. The result is therefore empty iff no
 * segment touches or enters any zone (P7), and is deterministic for fixed inputs
 * because segments are visited in ascending index order and zones in their given
 * order (P8).
 *
 * The function is pure: inputs are only read, never mutated (Requirement 5.7).
 *
 * @param waypoints ordered route waypoints (a route needs `>= 2` for a segment)
 * @param zones no-fly zones to test against, each a closed polygon ring
 */
export function detectConflicts(
  waypoints: readonly Waypoint[],
  zones: readonly ConflictZone[],
): GeofenceConflict[] {
  const conflicts: GeofenceConflict[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];
    if (from === undefined || to === undefined) {
      continue;
    }
    const segment: Segment = { start: waypointToPoint(from), end: waypointToPoint(to) };
    for (const zone of zones) {
      const touchesOrEnters =
        segmentIntersectsPolygon(segment, zone.polygon) ||
        pointInPolygon(segment.start, zone.polygon) ||
        pointInPolygon(segment.end, zone.polygon);
      if (touchesOrEnters) {
        conflicts.push({ segmentIndex: i, zoneId: zone.id });
      }
    }
  }
  return conflicts;
}
