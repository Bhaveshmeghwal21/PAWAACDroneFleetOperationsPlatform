import type { GeoPolygon } from '@pawaac/shared-types';
import { Point, segmentsIntersect } from './geometry';

/**
 * A single field-level validation error describing why a submitted geofence
 * polygon is invalid (Requirement 5.2). `field` uses a dotted/bracketed path so
 * clients can map it back to the offending coordinate.
 */
export interface GeofenceValidationError {
  field: string;
  message: string;
}

/** Inclusive latitude bounds in decimal degrees. */
const LAT_RANGE = { min: -90, max: 90 } as const;
/** Inclusive longitude bounds in decimal degrees. */
const LON_RANGE = { min: -180, max: 180 } as const;

const isFinitePair = (value: unknown): value is Point =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === 'number' &&
  Number.isFinite(value[0]) &&
  typeof value[1] === 'number' &&
  Number.isFinite(value[1]);

/** True iff two points are exactly equal in both coordinates. */
const pointsEqual = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];

/**
 * Detects whether a closed ring is self-intersecting. The ring's vertices
 * (excluding the duplicated closing point) form the polygon's edges; the ring
 * is self-intersecting iff any pair of **non-adjacent** edges intersect, or any
 * pair of **adjacent** edges overlap beyond their single shared vertex.
 *
 * Adjacency is taken on the cyclic edge list, so the last edge is adjacent to
 * the first. The check is pure and reuses the same {@link segmentsIntersect}
 * primitive the conflict detector uses, keeping definition and detection
 * consistent.
 *
 * @param ring a closed ring (first point equal to last) of `[lon, lat]` points
 */
export function isSelfIntersecting(ring: GeoPolygon): boolean {
  // Work on the distinct vertices (drop the duplicated closing point).
  const vertices = ring.slice(0, -1) as Point[];
  const n = vertices.length;
  if (n < 3) {
    return false;
  }

  const edge = (k: number): readonly [Point, Point] => {
    const a = vertices[k % n];
    const b = vertices[(k + 1) % n];
    // Guarded by the modulo; the assertion documents the invariant for the
    // strict `noUncheckedIndexedAccess` compiler setting.
    return [a as Point, b as Point];
  };

  for (let i = 0; i < n; i++) {
    const [a1, a2] = edge(i);
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      const [b1, b2] = edge(j);
      if (!segmentsIntersect(a1, a2, b1, b2)) {
        continue;
      }
      if (!adjacent) {
        // Non-adjacent edges may not touch at all in a simple polygon.
        return true;
      }
      // Adjacent edges legitimately share exactly one endpoint. Any further
      // intersection (collinear overlap or a coincident second point) means the
      // boundary doubles back on itself.
      const shared = sharedEndpoint(a1, a2, b1, b2);
      if (shared === null || collinearOverlapBeyondPoint([a1, a2], [b1, b2], shared)) {
        return true;
      }
    }
  }
  return false;
}

/** Returns the single endpoint shared by two adjacent edges, or null if none. */
function sharedEndpoint(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const candidates: Array<[Point, Point]> = [
    [a1, b1],
    [a1, b2],
    [a2, b1],
    [a2, b2],
  ];
  for (const [p, q] of candidates) {
    if (pointsEqual(p, q)) {
      return p;
    }
  }
  return null;
}

/**
 * True iff two adjacent edges (sharing `shared`) intersect at more than just
 * that vertex — i.e. they are collinear and overlap. Detected by checking
 * whether the non-shared endpoint of one edge lies on the other edge.
 */
function collinearOverlapBeyondPoint(
  edgeA: readonly [Point, Point],
  edgeB: readonly [Point, Point],
  shared: Point,
): boolean {
  const otherA = pointsEqual(edgeA[0], shared) ? edgeA[1] : edgeA[0];
  const otherB = pointsEqual(edgeB[0], shared) ? edgeB[1] : edgeB[0];
  // If the two distinct endpoints coincide, the edges fold onto each other.
  if (pointsEqual(otherA, otherB)) {
    return true;
  }
  // Collinear overlap: otherA lies strictly along edgeB (or vice versa).
  return pointStrictlyOnSegment(otherA, edgeB[0], edgeB[1]) ||
    pointStrictlyOnSegment(otherB, edgeA[0], edgeA[1]);
}

/** True iff `p` is collinear with and strictly between `a` and `b`. */
function pointStrictlyOnSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (cross !== 0) {
    return false;
  }
  const within =
    p[0] > Math.min(a[0], b[0]) &&
    p[0] < Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) &&
    p[1] <= Math.max(a[1], b[1]);
  const withinVertical =
    p[1] > Math.min(a[1], b[1]) &&
    p[1] < Math.max(a[1], b[1]) &&
    p[0] >= Math.min(a[0], b[0]) &&
    p[0] <= Math.max(a[0], b[0]);
  return within || withinVertical;
}

/**
 * Validates a submitted geofence polygon ring (Requirements 5.1, 5.2). A ring
 * is valid **iff** this returns an empty array, meaning it:
 *
 * - contains at least four points, each a finite `[lon, lat]` pair within the
 *   WGS84 coordinate bounds;
 * - is **closed** (the first point equals the last);
 * - is **not self-intersecting**.
 *
 * The function is pure and is the single source of truth for geofence validity,
 * shared by the HTTP service and the property tests (task 5.6).
 */
export function validateGeofencePolygon(ring: unknown): GeofenceValidationError[] {
  const errors: GeofenceValidationError[] = [];

  if (!Array.isArray(ring)) {
    return [{ field: 'polygon', message: 'polygon must be an array of [lon, lat] points' }];
  }

  if (ring.length < 4) {
    errors.push({
      field: 'polygon',
      message: 'polygon must be a closed ring of at least four points',
    });
  }

  ring.forEach((point, index) => {
    if (!isFinitePair(point)) {
      errors.push({
        field: `polygon[${index}]`,
        message: 'each point must be a finite [lon, lat] pair',
      });
      return;
    }
    const [lon, lat] = point;
    if (lon < LON_RANGE.min || lon > LON_RANGE.max) {
      errors.push({
        field: `polygon[${index}].lon`,
        message: 'longitude must be between -180 and 180 degrees',
      });
    }
    if (lat < LAT_RANGE.min || lat > LAT_RANGE.max) {
      errors.push({
        field: `polygon[${index}].lat`,
        message: 'latitude must be between -90 and 90 degrees',
      });
    }
  });

  // Structural checks below require well-formed numeric points.
  if (errors.length > 0) {
    return errors;
  }

  const points = ring as Point[];
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || !pointsEqual(first, last)) {
    errors.push({
      field: 'polygon',
      message: 'polygon must be closed: the first point must equal the last point',
    });
    return errors;
  }

  if (isSelfIntersecting(points)) {
    errors.push({ field: 'polygon', message: 'polygon must not be self-intersecting' });
  }

  return errors;
}
