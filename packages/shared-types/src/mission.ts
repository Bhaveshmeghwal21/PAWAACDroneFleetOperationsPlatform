/**
 * Mission Planning domain types: waypoints, versioned missions and geofences.
 */
import type { GeoPolygon, IsoTimestamp, Uuid } from './common.js';

/** A single ordered waypoint in a mission route. */
export interface Waypoint {
  /** Contiguous sequence index starting at 0. */
  seq: number;
  /** Latitude in decimal degrees, `[-90, 90]`. */
  lat: number;
  /** Longitude in decimal degrees, `[-180, 180]`. */
  lon: number;
  /** Altitude in meters, `> 0` and `<= maxAltitude`. */
  altitude: number;
  /** Ground/air speed in m/s, `> 0`. */
  speed: number;
  /** Gimbal pitch in degrees, `[-90, 90]`. */
  gimbalAngle: number;
  /** Loiter duration in seconds, `>= 0`. */
  loiterTime: number;
}

/** Lifecycle state of a mission record. */
export const MISSION_STATUSES = ['draft', 'validated', 'archived'] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

/**
 * An immutable, versioned mission record. Editing a mission produces a new
 * `version`; prior versions remain byte-identical.
 */
export interface Mission {
  id: Uuid;
  /** Monotonically increasing version; first version is 1. */
  version: number;
  name: string;
  /** Waypoints ordered by `seq`. */
  waypoints: Waypoint[];
  status: MissionStatus;
  createdAt: IsoTimestamp;
}

/** Categories of geofence zone. */
export const GEOFENCE_KINDS = ['no_fly'] as const;
export type GeofenceKind = (typeof GEOFENCE_KINDS)[number];

/** A geofence polygon (e.g. a no-fly zone) for conflict detection. */
export interface Geofence {
  id: Uuid;
  name: string;
  /** Closed, non-self-intersecting ring with `>= 4` points (first == last). */
  polygon: GeoPolygon;
  kind: GeofenceKind;
}

/**
 * A detected conflict between a mission route segment and a geofence zone:
 * one entry per (segment, zone) pair that intersects or is contained.
 */
export interface GeofenceConflict {
  /** Index of the route segment (waypoint `i` -> `i + 1`). */
  segmentIndex: number;
  zoneId: Uuid;
}
