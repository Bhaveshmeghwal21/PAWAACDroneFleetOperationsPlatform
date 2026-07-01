/**
 * Runtime type-guards / enum validators for the canonical constant sets
 * exported by this package.
 *
 * The domain modules expose their enums as runtime tuples (e.g.
 * `DRONE_STATUSES`) so that consuming services can validate inbound values
 * against the single source of truth. These guards turn each tuple into a
 * reusable, type-narrowing predicate (default-deny: anything not in the set is
 * rejected) so services don't re-implement membership checks per call site.
 */
import { DRONE_STATUSES, MAINTENANCE_COMPONENTS, MAINTENANCE_STATUSES } from './fleet.js';
import type { DroneStatus, MaintenanceComponent, MaintenanceStatus } from './fleet.js';
import {
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  CHANNEL_TYPES,
  CONDITION_OPERATORS,
  EVENT_KINDS,
} from './alert.js';
import type {
  AlertSeverity,
  AlertStatus,
  ChannelType,
  ConditionOperator,
  EventKind,
} from './alert.js';
import { GEOFENCE_KINDS, MISSION_STATUSES } from './mission.js';
import type { GeofenceKind, MissionStatus } from './mission.js';
import { ANOMALY_KINDS } from './telemetry.js';
import type { AnomalyKind } from './telemetry.js';
import { SCENE_EVENT_KINDS } from './vision.js';
import type { SceneEventKind } from './vision.js';
import { ROLES } from './gateway.js';
import type { Role } from './gateway.js';

/**
 * Generic membership predicate: returns `true` iff `value` is one of the
 * members of the readonly `values` tuple. Narrows `value` to the tuple's
 * element type. Non-string and unknown inputs are rejected.
 */
export function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** True iff `value` is a canonical {@link DroneStatus}. */
export const isDroneStatus = (value: unknown): value is DroneStatus =>
  isOneOf(DRONE_STATUSES, value);

/** True iff `value` is a canonical {@link MaintenanceComponent}. */
export const isMaintenanceComponent = (value: unknown): value is MaintenanceComponent =>
  isOneOf(MAINTENANCE_COMPONENTS, value);

/** True iff `value` is a canonical {@link MaintenanceStatus}. */
export const isMaintenanceStatus = (value: unknown): value is MaintenanceStatus =>
  isOneOf(MAINTENANCE_STATUSES, value);

/** True iff `value` is a canonical {@link ConditionOperator}. */
export const isConditionOperator = (value: unknown): value is ConditionOperator =>
  isOneOf(CONDITION_OPERATORS, value);

/** True iff `value` is a canonical {@link ChannelType}. */
export const isChannelType = (value: unknown): value is ChannelType =>
  isOneOf(CHANNEL_TYPES, value);

/** True iff `value` is a canonical {@link EventKind}. */
export const isEventKind = (value: unknown): value is EventKind =>
  isOneOf(EVENT_KINDS, value);

/** True iff `value` is a canonical {@link AlertSeverity}. */
export const isAlertSeverity = (value: unknown): value is AlertSeverity =>
  isOneOf(ALERT_SEVERITIES, value);

/** True iff `value` is a canonical {@link AlertStatus}. */
export const isAlertStatus = (value: unknown): value is AlertStatus =>
  isOneOf(ALERT_STATUSES, value);

/** True iff `value` is a canonical {@link MissionStatus}. */
export const isMissionStatus = (value: unknown): value is MissionStatus =>
  isOneOf(MISSION_STATUSES, value);

/** True iff `value` is a canonical {@link GeofenceKind}. */
export const isGeofenceKind = (value: unknown): value is GeofenceKind =>
  isOneOf(GEOFENCE_KINDS, value);

/** True iff `value` is a canonical {@link AnomalyKind}. */
export const isAnomalyKind = (value: unknown): value is AnomalyKind =>
  isOneOf(ANOMALY_KINDS, value);

/** True iff `value` is a canonical {@link SceneEventKind}. */
export const isSceneEventKind = (value: unknown): value is SceneEventKind =>
  isOneOf(SCENE_EVENT_KINDS, value);

/** True iff `value` is a canonical {@link Role}. */
export const isRole = (value: unknown): value is Role => isOneOf(ROLES, value);
