import { randomUUID } from 'node:crypto';
import type { Geofence, GeofenceConflict, GeoPolygon, Waypoint } from '@pawaac/shared-types';
import { ConflictZone, detectConflicts } from './geometry';
import { GeofenceStore, NewGeofence } from './geofence-store';

/** Deep-clones a polygon ring so stored state can never be mutated by reference. */
function clonePolygon(polygon: GeoPolygon): GeoPolygon {
  return polygon.map((point) => [point[0], point[1]] as const);
}

/** Returns a deep, reference-independent copy of a geofence. */
function cloneGeofence(geofence: Geofence): Geofence {
  return {
    id: geofence.id,
    name: geofence.name,
    kind: geofence.kind,
    polygon: clonePolygon(geofence.polygon),
  };
}

/**
 * A fully functional in-memory {@link GeofenceStore} for unit and property
 * tests. Conflict detection delegates to the pure in-process
 * {@link detectConflicts} (design Algorithm 1), so this adapter is the
 * in-process counterpart to the production PostGIS path and exercises the exact
 * geometry the property tests target (P7/P8/P9).
 *
 * Every geofence is deep-cloned on the way in and out so callers can never
 * mutate persisted state, and `detectConflicts` never mutates its input
 * waypoints (Requirement 5.7).
 */
export class InMemoryGeofenceStore implements GeofenceStore {
  /** Insertion-ordered geofence records keyed by id. */
  private readonly geofences = new Map<string, Geofence>();

  async create(input: NewGeofence): Promise<Geofence> {
    const geofence: Geofence = {
      id: randomUUID(),
      name: input.name,
      kind: input.kind,
      polygon: clonePolygon(input.polygon),
    };
    this.geofences.set(geofence.id, geofence);
    return cloneGeofence(geofence);
  }

  async findById(id: string): Promise<Geofence | null> {
    const found = this.geofences.get(id);
    return found ? cloneGeofence(found) : null;
  }

  async findAll(): Promise<Geofence[]> {
    return [...this.geofences.values()].map(cloneGeofence);
  }

  async detectConflicts(waypoints: readonly Waypoint[]): Promise<GeofenceConflict[]> {
    const zones: ConflictZone[] = [...this.geofences.values()].map((g) => ({
      id: g.id,
      polygon: g.polygon,
    }));
    return detectConflicts(waypoints, zones);
  }
}
