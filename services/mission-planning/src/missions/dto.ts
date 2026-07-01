import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { MissionStatus, Waypoint } from '@pawaac/shared-types';

/**
 * Canonical mission status values, pinned to the shared `MissionStatus` type.
 * Declared locally (mirroring Fleet Registry's status list) so the runtime
 * array does not need to be imported from the ESM shared-types package under
 * the service's CommonJS test runtime; the `satisfies` clause keeps it in lock
 * step with the shared union.
 */
export const MISSION_STATUS_VALUES = ['draft', 'validated', 'archived'] as const satisfies readonly MissionStatus[];

/**
 * A single waypoint in a create/edit request (Requirements 4.2, 4.4). The
 * range checks here mirror the canonical domain validation; the
 * deployment-configurable `altitude <= maxAltitude` ceiling cannot be a static
 * decorator, so it is enforced in the service layer.
 */
export class WaypointDto implements Waypoint {
  @IsInt()
  @Min(0)
  seq!: number;

  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lon!: number;

  @IsNumber()
  @IsPositive()
  altitude!: number;

  @IsNumber()
  @IsPositive()
  speed!: number;

  @IsNumber()
  @Min(-90)
  @Max(90)
  gimbalAngle!: number;

  @IsNumber()
  @Min(0)
  loiterTime!: number;
}

/** Body for creating a mission (Requirement 4.1). */
export class CreateMissionDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsIn(MISSION_STATUS_VALUES)
  status?: MissionStatus;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => WaypointDto)
  waypoints!: WaypointDto[];
}

/**
 * Body for editing a mission (Requirement 4.5). Any subset of fields may be
 * supplied; omitted fields are carried over from the prior version. A
 * passing edit produces a new immutable version.
 */
export class UpdateMissionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsIn(MISSION_STATUS_VALUES)
  status?: MissionStatus;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => WaypointDto)
  waypoints?: WaypointDto[];
}
