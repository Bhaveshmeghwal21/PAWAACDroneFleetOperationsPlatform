/**
 * Telemetry Ingestion domain types: normalized MAVLink samples and the
 * anomalies derived from them.
 */
import type { IsoTimestamp, Uuid } from './common.js';

/** Linear velocity components in m/s. */
export interface Velocity {
  vx: number;
  vy: number;
  vz: number;
}

/** Vehicle attitude in radians (or degrees per service convention). */
export interface Attitude {
  roll: number;
  pitch: number;
  yaw: number;
}

/** Battery state. */
export interface BatteryState {
  voltage: number;
  current: number;
  /** Remaining charge percentage, `[0, 100]`. */
  remainingPct: number;
}

/** EKF2 estimator health snapshot. */
export interface Ekf2State {
  healthy: boolean;
  /** Bitmask of unhealthy flags; `0` when fully healthy. */
  flags: number;
}

/** A normalized telemetry sample persisted to the TimescaleDB hypertable. */
export interface TelemetrySample {
  droneId: Uuid;
  /** Hypertable time dimension; strictly increasing per drone. */
  ts: IsoTimestamp;
  lat: number;
  lon: number;
  altitude: number;
  velocity: Velocity;
  attitude: Attitude;
  battery: BatteryState;
  ekf2: Ekf2State;
  /** RC link signal strength, `[0, 100]`. */
  rcSignalStrength: number;
  flightMode: string;
  armed: boolean;
}

/** Kinds of telemetry anomaly detected in real time. */
export const ANOMALY_KINDS = [
  'ALTITUDE_DROP',
  'BATTERY_DRAIN_SPIKE',
  'EKF2_DEGRADED',
  'GPS_ACCURACY_LOSS',
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

/** An anomaly flagged for a drone at a point in time. */
export interface Anomaly {
  kind: AnomalyKind;
  droneId: Uuid;
  ts: IsoTimestamp;
  /** Optional human-readable context for the breach. */
  detail?: string;
}
