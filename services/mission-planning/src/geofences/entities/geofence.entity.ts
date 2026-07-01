import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { GeofenceKind } from '@pawaac/shared-types';

/**
 * A GeoJSON Polygon geometry as read from / written to a PostGIS `geometry`
 * column. The shared-types `GeoPolygon` (a closed ring of `[lon, lat]` points)
 * is converted to/from this representation by the service layer (task 5.5);
 * the persistence column itself speaks GeoJSON, which is what TypeORM maps for
 * spatial columns.
 */
export interface GeoJsonPolygon {
  type: 'Polygon';
  /** Array of linear rings; each ring is an array of `[lon, lat]` positions. */
  coordinates: number[][][];
}

/**
 * Persistent geofence (no-fly zone) record (Requirement 5, data model in
 * design). The polygon is stored in a PostGIS `geometry(Polygon, 4326)` column
 * so production conflict detection can use spatial predicates such as
 * `ST_Intersects` (added by task 5.5). A GiST spatial index accelerates those
 * queries.
 */
@Entity('geofences')
export class GeofenceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 32, default: 'no_fly' })
  kind!: GeofenceKind;

  /** Closed, non-self-intersecting ring stored as WGS84 (SRID 4326) geometry. */
  @Index('idx_geofences_polygon', { spatial: true })
  @Column({ type: 'geometry', spatialFeatureType: 'Polygon', srid: 4326 })
  polygon!: GeoJsonPolygon;
}
