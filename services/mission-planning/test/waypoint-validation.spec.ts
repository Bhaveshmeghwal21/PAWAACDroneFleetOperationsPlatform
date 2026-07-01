import type { Waypoint } from '@pawaac/shared-types';
import { validateWaypoints } from '../src/missions/waypoint-validation';
import { validRoute, validWaypoint } from './helpers';

const MAX_ALTITUDE = 500;

describe('validateWaypoints — range and sequence rules (Requirement 4.2/4.4, P10)', () => {
  it('accepts a contiguous route of in-range waypoints', () => {
    expect(validateWaypoints(validRoute(3), MAX_ALTITUDE)).toEqual([]);
  });

  it('accepts an empty route (vacuously contiguous)', () => {
    expect(validateWaypoints([], MAX_ALTITUDE)).toEqual([]);
  });

  it('accepts boundary values at the inclusive edges of each range', () => {
    const boundary = validWaypoint({
      lat: 90,
      lon: -180,
      altitude: MAX_ALTITUDE,
      gimbalAngle: 90,
      loiterTime: 0,
      speed: 0.001,
    });
    expect(validateWaypoints([boundary], MAX_ALTITUDE)).toEqual([]);
  });

  it.each<[string, Partial<Waypoint>, string]>([
    ['latitude above 90', { lat: 90.1 }, 'waypoints[0].lat'],
    ['latitude below -90', { lat: -90.1 }, 'waypoints[0].lat'],
    ['longitude above 180', { lon: 180.1 }, 'waypoints[0].lon'],
    ['longitude below -180', { lon: -180.1 }, 'waypoints[0].lon'],
    ['altitude of 0', { altitude: 0 }, 'waypoints[0].altitude'],
    ['altitude above the ceiling', { altitude: MAX_ALTITUDE + 1 }, 'waypoints[0].altitude'],
    ['speed of 0', { speed: 0 }, 'waypoints[0].speed'],
    ['negative speed', { speed: -1 }, 'waypoints[0].speed'],
    ['gimbal above 90', { gimbalAngle: 90.1 }, 'waypoints[0].gimbalAngle'],
    ['gimbal below -90', { gimbalAngle: -90.1 }, 'waypoints[0].gimbalAngle'],
    ['negative loiter time', { loiterTime: -0.1 }, 'waypoints[0].loiterTime'],
  ])('rejects %s with a field-level error', (_label, override, expectedField) => {
    const errors = validateWaypoints([validWaypoint(override)], MAX_ALTITUDE);
    expect(errors.map((e) => e.field)).toContain(expectedField);
  });

  it('rejects a sequence that does not start at 0', () => {
    const route = [validWaypoint({ seq: 1 }), validWaypoint({ seq: 2 })];
    const errors = validateWaypoints(route, MAX_ALTITUDE);
    expect(errors.map((e) => e.field)).toContain('waypoints.seq');
  });

  it('rejects a sequence with a gap', () => {
    const route = [validWaypoint({ seq: 0 }), validWaypoint({ seq: 2 })];
    const errors = validateWaypoints(route, MAX_ALTITUDE);
    expect(errors.map((e) => e.field)).toContain('waypoints.seq');
  });

  it('rejects a sequence with duplicate indices', () => {
    const route = [validWaypoint({ seq: 0 }), validWaypoint({ seq: 0 })];
    const errors = validateWaypoints(route, MAX_ALTITUDE);
    expect(errors.map((e) => e.field)).toContain('waypoints.seq');
  });

  it('treats the altitude ceiling as configurable', () => {
    const tall = validWaypoint({ altitude: 750 });
    expect(validateWaypoints([tall], 500)).not.toEqual([]);
    expect(validateWaypoints([tall], 1000)).toEqual([]);
  });
});
