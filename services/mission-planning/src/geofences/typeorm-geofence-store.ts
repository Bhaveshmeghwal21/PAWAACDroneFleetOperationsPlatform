import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Geofence, GeofenceConflict, GeoPolygon, Waypoint } from '@pawaac/shared-types';
import { GeofenceEntity, GeoJsonPolygon } from './entities/geofence.entity';
import { GeofenceStore, NewGeofence } from './geofence-store';

/** Converts the shared closed ring to the GeoJSON Polygon stored by PostGIS. */
function toGeoJson(polygon: GeoPolygon): GeoJsonPolygon {
  return {
    type: 'Polygon',
    coordinates: [polygon.map((point) => [point[0], point[1]])],
  };
}

/** Converts a persisted GeoJSON Polygon back to the shared closed ring. */
function toPolygon(geojson: GeoJsonPolygon): GeoPolygon {
  const ring = geojson.coordinates[0] ?? [];
  return ring.map((coord) => [coord[0] as number, coord[1] as number] as const);
}

/** Maps a persisted geofence row to the shared domain type. */
function toDomain(entity: GeofenceEntity): Geofence {
  return {
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    polygon: toPolygon(entity.polygon),
  };
}

/**
 * Production {@link GeofenceStore} backed by TypeORM / PostGIS. Polygons are
 * persisted into a `geometry(Polygon, 4326)` column and conflict detection runs
 * the spatial `ST_Intersects` predicate against a per-segment `LINESTRING`,
 * which is the authoritative production path that the in-process ray-casting
 * detector mirrors (design Algorithm 1; property P9).
 *
 * `ST_Intersects` treats the polygon as a filled surface, so it returns true
 * both when a segment crosses or touches the polygon boundary and when the
 * segment lies entirely inside it — exactly the conflict condition of
 * Requirement 5.4. Segments are processed in ascending index order and zone
 * rows are ordered by id, giving deterministic output (Requirement 5.5).
 */
@Injectable()
export class TypeOrmGeofenceStore implements GeofenceStore {
  constructor(
    @InjectRepository(GeofenceEntity)
    private readonly geofences: Repository<GeofenceEntity>,
  ) {}

  async create(input: NewGeofence): Promise<Geofence> {
    const id = randomUUID();
    await this.geofences
      .createQueryBuilder()
      .insert()
      .into(GeofenceEntity)
      .values({
        id,
        name: input.name,
        kind: input.kind,
        // PostGIS needs the SRID applied explicitly; ST_GeomFromGeoJSON yields
        // an SRID-less geometry otherwise.
        polygon: () => 'ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326)',
      })
      .setParameter('geojson', JSON.stringify(toGeoJson(input.polygon)))
      .execute();

    const created = await this.findById(id);
    if (!created) {
      throw new Error(`Geofence "${id}" failed to persist`);
    }
    return created;
  }

  async findById(id: string): Promise<Geofence | null> {
    const entity = await this.geofences.findOne({ where: { id } });
    return entity ? toDomain(entity) : null;
  }

  async findAll(): Promise<Geofence[]> {
    const entities = await this.geofences.find({ order: { id: 'ASC' } });
    return entities.map(toDomain);
  }

  async detectConflicts(waypoints: readonly Waypoint[]): Promise<GeofenceConflict[]> {
    const conflicts: GeofenceConflict[] = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const from = waypoints[i];
      const to = waypoints[i + 1];
      if (from === undefined || to === undefined) {
        continue;
      }
      const rows = await this.geofences
        .createQueryBuilder('g')
        .select('g.id', 'id')
        .where(
          'ST_Intersects(g.polygon, ST_SetSRID(ST_MakeLine(ST_MakePoint(:lon1, :lat1), ST_MakePoint(:lon2, :lat2)), 4326))',
          { lon1: from.lon, lat1: from.lat, lon2: to.lon, lat2: to.lat },
        )
        .orderBy('g.id', 'ASC')
        .getRawMany<{ id: string }>();
      for (const row of rows) {
        conflicts.push({ segmentIndex: i, zoneId: row.id });
      }
    }
    return conflicts;
  }
}
