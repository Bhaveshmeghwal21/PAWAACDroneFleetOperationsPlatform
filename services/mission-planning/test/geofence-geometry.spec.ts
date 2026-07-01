import type { GeoPolygon, Waypoint } from '@pawaac/shared-types';
import {
  detectConflicts,
  pointInPolygon,
  segmentIntersectsPolygon,
  segmentsIntersect,
  type Point,
} from '../src/geofences/geometry';
import {
  isSelfIntersecting,
  validateGeofencePolygon,
} from '../src/geofences/geofence-validation';
import { squareRing, validWaypoint } from './helpers';

/** A 10x10 square no-fly ring with its lower-left corner at the origin. */
const SQUARE: GeoPolygon = squareRing(0, 0, 10);

/** Builds a waypoint at a given lon/lat, keeping all other fields valid. */
function wpAt(lon: number, lat: number, seq = 0): Waypoint {
  return validWaypoint({ seq, lon, lat });
}

describe('pointInPolygon — ray casting (design Algorithm 1)', () => {
  it('reports points strictly inside the polygon', () => {
    expect(pointInPolygon([5, 5], SQUARE)).toBe(true);
  });

  it('reports points clearly outside the polygon', () => {
    expect(pointInPolygon([-1, 5], SQUARE)).toBe(false);
    expect(pointInPolygon([11, 5], SQUARE)).toBe(false);
    expect(pointInPolygon([5, 20], SQUARE)).toBe(false);
  });

  it('is unaffected by the trailing closing point of the ring', () => {
    const open = SQUARE.slice(0, -1) as GeoPolygon;
    expect(pointInPolygon([5, 5], open)).toBe(pointInPolygon([5, 5], SQUARE));
  });
});

describe('segmentsIntersect — orientation test', () => {
  const a: Point = [0, 0];
  const b: Point = [10, 0];

  it('detects a proper crossing', () => {
    expect(segmentsIntersect(a, b, [5, -5], [5, 5])).toBe(true);
  });

  it('detects a touching endpoint as an intersection', () => {
    expect(segmentsIntersect(a, b, [10, 0], [10, 10])).toBe(true);
  });

  it('detects collinear overlap', () => {
    expect(segmentsIntersect(a, b, [5, 0], [15, 0])).toBe(true);
  });

  it('reports no intersection for disjoint segments', () => {
    expect(segmentsIntersect(a, b, [0, 5], [10, 5])).toBe(false);
  });
});

describe('segmentIntersectsPolygon', () => {
  it('detects a segment crossing the polygon boundary', () => {
    expect(segmentIntersectsPolygon({ start: [-1, 5], end: [5, 5] }, SQUARE)).toBe(true);
  });

  it('detects a segment that merely touches the boundary', () => {
    expect(segmentIntersectsPolygon({ start: [-5, 0], end: [0, 0] }, SQUARE)).toBe(true);
  });

  it('reports no intersection for a fully-outside segment', () => {
    expect(segmentIntersectsPolygon({ start: [-5, -5], end: [-1, -1] }, SQUARE)).toBe(false);
  });

  it('reports no boundary intersection for a segment fully inside', () => {
    // Inside containment is caught by pointInPolygon, not by edge intersection.
    expect(segmentIntersectsPolygon({ start: [3, 3], end: [7, 7] }, SQUARE)).toBe(false);
  });
});

describe('detectConflicts (P7 completeness, P8 determinism, 5.7 no-mutation)', () => {
  const zone = { id: 'zone-1', polygon: SQUARE };

  it('returns an empty list when no segment touches or enters any zone', () => {
    const route = [wpAt(-5, -5, 0), wpAt(-5, 20, 1)];
    expect(detectConflicts(route, [zone])).toEqual([]);
  });

  it('emits one conflict per (segment, zone) when a segment crosses a zone', () => {
    const route = [wpAt(-1, 5, 0), wpAt(11, 5, 1)];
    expect(detectConflicts(route, [zone])).toEqual([{ segmentIndex: 0, zoneId: 'zone-1' }]);
  });

  it('emits a conflict when a segment lies entirely inside a zone', () => {
    const route = [wpAt(3, 3, 0), wpAt(7, 7, 1)];
    expect(detectConflicts(route, [zone])).toEqual([{ segmentIndex: 0, zoneId: 'zone-1' }]);
  });

  it('emits a separate conflict per offending segment and zone', () => {
    const zone2 = { id: 'zone-2', polygon: squareRing(0, 0, 10) };
    const route = [wpAt(5, 5, 0), wpAt(5, 6, 1), wpAt(50, 50, 2)];
    const conflicts = detectConflicts(route, [zone, zone2]);
    // Segment 0 (inside) conflicts with both zones; segment 1 exits through the
    // boundary so also conflicts with both.
    expect(conflicts).toEqual([
      { segmentIndex: 0, zoneId: 'zone-1' },
      { segmentIndex: 0, zoneId: 'zone-2' },
      { segmentIndex: 1, zoneId: 'zone-1' },
      { segmentIndex: 1, zoneId: 'zone-2' },
    ]);
  });

  it('is deterministic across repeated identical runs (P8)', () => {
    const route = [wpAt(-1, 5, 0), wpAt(11, 5, 1)];
    const first = detectConflicts(route, [zone]);
    const second = detectConflicts(route, [zone]);
    expect(second).toEqual(first);
  });

  it('does not mutate its input waypoints or zones (5.7)', () => {
    const route = [wpAt(-1, 5, 0), wpAt(11, 5, 1)];
    const routeSnapshot = structuredClone(route);
    const zoneSnapshot = structuredClone(zone);
    detectConflicts(route, [zone]);
    expect(route).toEqual(routeSnapshot);
    expect(zone).toEqual(zoneSnapshot);
  });

  it('returns no conflicts for a single-waypoint route (no segments)', () => {
    expect(detectConflicts([wpAt(5, 5, 0)], [zone])).toEqual([]);
  });
});

describe('isSelfIntersecting', () => {
  it('accepts a simple convex ring', () => {
    expect(isSelfIntersecting(SQUARE)).toBe(false);
  });

  it('detects a bow-tie (figure-eight) ring', () => {
    const bowtie: GeoPolygon = [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
      [0, 0],
    ];
    expect(isSelfIntersecting(bowtie)).toBe(true);
  });
});

describe('validateGeofencePolygon (5.1, 5.2)', () => {
  it('accepts a closed, simple ring of >= 4 points', () => {
    expect(validateGeofencePolygon(SQUARE)).toEqual([]);
  });

  it('rejects a ring with fewer than four points', () => {
    const errors = validateGeofencePolygon([
      [0, 0],
      [1, 1],
      [0, 0],
    ]);
    expect(errors.some((e) => e.field === 'polygon')).toBe(true);
  });

  it('rejects a non-closed ring', () => {
    const open: number[][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const errors = validateGeofencePolygon(open);
    expect(errors.some((e) => /closed/.test(e.message))).toBe(true);
  });

  it('rejects a self-intersecting ring', () => {
    const bowtie: number[][] = [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
      [0, 0],
    ];
    const errors = validateGeofencePolygon(bowtie);
    expect(errors.some((e) => /self-intersecting/.test(e.message))).toBe(true);
  });

  it('rejects out-of-range coordinates', () => {
    const ring: number[][] = [
      [0, 0],
      [200, 0],
      [200, 10],
      [0, 10],
      [0, 0],
    ];
    const errors = validateGeofencePolygon(ring);
    expect(errors.some((e) => e.field.includes('lon'))).toBe(true);
  });

  it('rejects a malformed point', () => {
    const ring = [[0, 0], [10], [10, 10], [0, 10], [0, 0]];
    const errors = validateGeofencePolygon(ring);
    expect(errors.some((e) => e.field === 'polygon[1]')).toBe(true);
  });
});
