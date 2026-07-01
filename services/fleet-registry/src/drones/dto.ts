import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import type { DroneStatus } from '@pawaac/shared-types';

/** Canonical drone status values, pinned to the shared `DroneStatus` type. */
export const DRONE_STATUS_VALUES: readonly DroneStatus[] = [
  'active',
  'maintenance',
  'decommissioned',
];

/** Body for creating a drone (Requirements 1.1, 1.2). */
export class CreateDroneDto {
  @IsString()
  @IsNotEmpty()
  serialNumber!: string;

  @IsString()
  @IsNotEmpty()
  model!: string;

  @IsString()
  @IsNotEmpty()
  firmwareVersion!: string;

  @IsOptional()
  @IsObject()
  hardwareConfig?: Record<string, unknown>;

  @IsOptional()
  @IsIn(DRONE_STATUS_VALUES)
  status?: DroneStatus;
}

/** Body for updating a drone; `version` carries the optimistic-lock guard. */
export class UpdateDroneDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  model?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  firmwareVersion?: string;

  @IsOptional()
  @IsObject()
  hardwareConfig?: Record<string, unknown>;

  @IsOptional()
  @IsIn(DRONE_STATUS_VALUES)
  status?: DroneStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

/** Query filter for listing drones (Requirement 1.5). */
export class DroneFilterDto {
  @IsOptional()
  @IsIn(DRONE_STATUS_VALUES)
  status?: DroneStatus;

  @IsOptional()
  @IsString()
  model?: string;
}

/** Configurable maintenance thresholds. */
export class MaintenanceThresholdsDto {
  @IsNumber()
  @Min(0)
  maxBatteryCycles!: number;

  @IsNumber()
  @Min(0)
  maxMotorHours!: number;

  @IsNumber()
  @Min(0)
  maxPropellerLifeHours!: number;
}

/**
 * Incremental component usage deltas (Requirement 2.1). Deltas may be negative
 * (e.g. corrections); the resulting counters are clamped to be non-negative.
 */
export class ComponentUsageDto {
  @IsOptional()
  @IsNumber()
  batteryCyclesDelta?: number;

  @IsOptional()
  @IsNumber()
  motorHoursDelta?: number;

  @IsOptional()
  @IsNumber()
  propellerReplacementsDelta?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => MaintenanceThresholdsDto)
  thresholds?: MaintenanceThresholdsDto;
}
