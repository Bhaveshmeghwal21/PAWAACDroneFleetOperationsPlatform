/**
 * Fleet Registry domain types: drone assets, component lifecycle counters,
 * maintenance thresholds and derived maintenance alerts.
 */
import type { IsoTimestamp, Uuid } from './common.js';

/**
 * Lifecycle state of a drone asset.
 *
 * Exposed as a runtime tuple so consuming services can validate inbound values
 * against the canonical set; the `DroneStatus` type is derived from it to keep
 * the value list and the type in lock-step.
 */
export const DRONE_STATUSES = ['active', 'maintenance', 'decommissioned'] as const;
export type DroneStatus = (typeof DRONE_STATUSES)[number];

/** A registered drone asset (system of record in Fleet Registry). */
export interface Drone {
  /** UUID primary key. */
  id: Uuid;
  /** Globally unique, non-empty manufacturer serial number. */
  serialNumber: string;
  model: string;
  firmwareVersion: string;
  /** Flexible JSONB hardware configuration blob. */
  hardwareConfig: Record<string, unknown>;
  status: DroneStatus;
  /** Optimistic-concurrency version, monotonically increasing per update. */
  version: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * Configurable thresholds that drive maintenance-due/overdue evaluation for a
 * drone's components.
 */
export interface MaintenanceThresholds {
  maxBatteryCycles: number;
  maxMotorHours: number;
  maxPropellerLifeHours: number;
}

/** Accumulated component usage counters for a drone (all non-negative). */
export interface ComponentLifecycle {
  droneId: Uuid;
  /** Number of full battery charge cycles, `>= 0`. */
  batteryCycles: number;
  /** Cumulative motor run-time in hours, `>= 0`. */
  motorHours: number;
  /** Count of propeller replacements, `>= 0`. */
  propellerReplacements: number;
  thresholds: MaintenanceThresholds;
}

/** Components tracked for maintenance evaluation. */
export const MAINTENANCE_COMPONENTS = ['battery', 'motor', 'propeller'] as const;
export type MaintenanceComponent = (typeof MAINTENANCE_COMPONENTS)[number];

/** Whether a component has reached (`due`) or exceeded (`overdue`) its threshold. */
export const MAINTENANCE_STATUSES = ['due', 'overdue'] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

/**
 * A maintenance alert derived by `evaluateMaintenance`: emitted when a
 * component counter reaches or exceeds its configured threshold.
 */
export interface MaintenanceAlert {
  droneId: Uuid;
  component: MaintenanceComponent;
  status: MaintenanceStatus;
  /** The current counter value that triggered the alert. */
  currentValue: number;
  /** The configured threshold for the component. */
  threshold: number;
}
