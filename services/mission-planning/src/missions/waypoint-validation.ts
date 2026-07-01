import type { Waypoint } from '@pawaac/shared-types';

/**
 * A single field-level validation error describing why a waypoint (or the
 * waypoint sequence as a whole) is invalid. The `field` uses a dotted/bracketed
 * path (e.g. `waypoints[2].altitude`) so clients can map it back to the input
 * (Requirement 4.3).
 */
export interface WaypointValidationError {
  field: string;
  message: string;
}

/** Inclusive latitude bounds in decimal degrees (Requirement 4.4). */
export const LAT_RANGE = { min: -90, max: 90 } as const;
/** Inclusive longitude bounds in decimal degrees (Requirement 4.4). */
export const LON_RANGE = { min: -180, max: 180 } as const;
/** Inclusive gimbal pitch bounds in degrees (Requirement 4.4). */
export const GIMBAL_RANGE = { min: -90, max: 90 } as const;

const inInclusive = (value: number, min: number, max: number): boolean =>
  Number.isFinite(value) && value >= min && value <= max;

/**
 * Validates a mission's waypoints against the range and sequencing rules of
 * Requirement 4 (formal property **P10**). The function is pure and the single
 * source of truth for waypoint validity: a mission is valid **iff** this
 * returns an empty array, i.e. every waypoint satisfies all range constraints
 * and the sequence numbers are contiguous starting at 0.
 *
 * Range constraints (Requirement 4.4):
 * - `lat` in `[-90, 90]`, `lon` in `[-180, 180]`, `gimbalAngle` in `[-90, 90]`
 * - `altitude` `> 0` and `<= maxAltitude` (the configured ceiling)
 * - `speed` `> 0`, `loiterTime` `>= 0`
 *
 * Sequencing: the multiset of `seq` values must be exactly `{0, 1, ..., n-1}`
 * (contiguous, gap-free, duplicate-free, starting at 0).
 *
 * @param waypoints the waypoints to validate (any order)
 * @param maxAltitude the configured maximum altitude ceiling (meters)
 */
export function validateWaypoints(
  waypoints: readonly Waypoint[],
  maxAltitude: number,
): WaypointValidationError[] {
  const errors: WaypointValidationError[] = [];

  waypoints.forEach((wp, index) => {
    const at = (field: keyof Waypoint): string => `waypoints[${index}].${field}`;

    if (!inInclusive(wp.lat, LAT_RANGE.min, LAT_RANGE.max)) {
      errors.push({ field: at('lat'), message: 'lat must be between -90 and 90 degrees' });
    }
    if (!inInclusive(wp.lon, LON_RANGE.min, LON_RANGE.max)) {
      errors.push({ field: at('lon'), message: 'lon must be between -180 and 180 degrees' });
    }
    if (!(Number.isFinite(wp.altitude) && wp.altitude > 0 && wp.altitude <= maxAltitude)) {
      errors.push({
        field: at('altitude'),
        message: `altitude must be greater than 0 and at most ${maxAltitude} meters`,
      });
    }
    if (!(Number.isFinite(wp.speed) && wp.speed > 0)) {
      errors.push({ field: at('speed'), message: 'speed must be greater than 0' });
    }
    if (!inInclusive(wp.gimbalAngle, GIMBAL_RANGE.min, GIMBAL_RANGE.max)) {
      errors.push({
        field: at('gimbalAngle'),
        message: 'gimbalAngle must be between -90 and 90 degrees',
      });
    }
    if (!(Number.isFinite(wp.loiterTime) && wp.loiterTime >= 0)) {
      errors.push({
        field: at('loiterTime'),
        message: 'loiterTime must be greater than or equal to 0',
      });
    }
  });

  errors.push(...validateSequence(waypoints));

  return errors;
}

/**
 * Checks that the waypoint `seq` values form a contiguous run `0..n-1` with no
 * gaps or duplicates. Returns a single `waypoints.seq` error when the sequence
 * is malformed (Requirement 4.2). An empty list is vacuously contiguous.
 */
function validateSequence(waypoints: readonly Waypoint[]): WaypointValidationError[] {
  const sorted = [...waypoints.map((wp) => wp.seq)].sort((a, b) => a - b);
  const contiguous = sorted.every((seq, index) => seq === index);
  if (!contiguous) {
    return [
      {
        field: 'waypoints.seq',
        message: 'waypoint sequence numbers must be contiguous starting at 0',
      },
    ];
  }
  return [];
}
