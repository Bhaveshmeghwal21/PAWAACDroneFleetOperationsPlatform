import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import type { GeofenceKind, Waypoint } from '@pawaac/shared-types';
import { WaypointDto } from '../missions/dto';

/**
 * Canonical geofence-kind values, pinned to the shared `GeofenceKind` union.
 * Declared locally (mirroring the mission-status pattern) so the runtime array
 * is available under the service's CommonJS test runtime; `satisfies` keeps it
 * in lock step with the shared type.
 */
export const GEOFENCE_KIND_VALUES = ['no_fly'] as const satisfies readonly GeofenceKind[];

/**
 * Body for defining a geofence no-fly zone (Requirements 5.1, 5.2). The polygon
 * is an array of `[lon, lat]` pairs forming a closed ring. Structural validity
 * — at least four points, finite in-range coordinates, closed, and
 * non-self-intersecting — is enforced by the canonical
 * `validateGeofencePolygon` in the service layer (which the property tests also
 * use), so the DTO only checks the coarse array shape here.
 */
export class DefineGeofenceDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsIn(GEOFENCE_KIND_VALUES)
  kind?: GeofenceKind;

  @IsArray()
  polygon!: number[][];
}

/**
 * Body for conflict detection (Requirements 5.3–5.5). Exactly one input source
 * must be supplied: either a `missionId` (the latest version's waypoints are
 * used) or an explicit `waypoints` route. The service rejects requests that
 * provide neither.
 */
export class DetectConflictsDto {
  @IsOptional()
  @IsUUID()
  missionId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => WaypointDto)
  waypoints?: Waypoint[];
}
