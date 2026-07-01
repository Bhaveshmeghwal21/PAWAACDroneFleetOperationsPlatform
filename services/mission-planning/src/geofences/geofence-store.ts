import type { Geofence, GeofenceConflict, GeofenceKind, GeoPolygon, Waypoint } from '@pawaac/shared-types';

/**
 * The content of a geofence to persist (everything except the store-assigned
 * identity). Used by {@link GeofenceStore.create}.
 */
export interface NewGeofence {
  name: string;
  kind: GeofenceKind;
  /** A validated closed, non-self-intersecting ring of `[lon, lat]` points. */
  polygon: GeoPolygon;
}

/**
 * Persistence port for geofences plus the conflict-detection query (Requirement
 * 5). The service depends only on this interface; production wires a
 * PostGIS-backed TypeORM adapter that runs `ST_Intersects`, while tests use an
 * in-memory adapter that runs the in-process ray-casting detector. Both honour
 * the same contract, which is what gives the in-process and PostGIS paths their
 * parity (P9).
 */
export interface GeofenceStore {
  /** Persists a new geofence and returns it with its assigned id. */
  create(input: NewGeofence): Promise<Geofence>;
  /** Returns a geofence by id, or `null` when none exists. */
  findById(id: string): Promise<Geofence | null>;
  /** Returns all persisted geofences (deterministic order). */
  findAll(): Promise<Geofence[]>;
  /**
   * Returns one {@link GeofenceConflict} per `(segmentIndex, zoneId)` pair where
   * a route segment of `waypoints` intersects or lies inside a persisted no-fly
   * polygon. Deterministic and free of input mutation (Requirements 5.3–5.5,
   * 5.7).
   */
  detectConflicts(waypoints: readonly Waypoint[]): Promise<GeofenceConflict[]>;
}

/** DI token for the {@link GeofenceStore} port. */
export const GEOFENCE_STORE = Symbol('GEOFENCE_STORE');

/** Thrown when a geofence id cannot be found. */
export class GeofenceNotFoundError extends Error {
  constructor(id: string) {
    super(`Geofence "${id}" was not found`);
    this.name = 'GeofenceNotFoundError';
  }
}
