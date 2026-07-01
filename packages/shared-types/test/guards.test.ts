import { describe, expect, it } from 'vitest';

import {
  // constant sets
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ANOMALY_KINDS,
  CHANNEL_TYPES,
  CONDITION_OPERATORS,
  DRONE_STATUSES,
  EVENT_KINDS,
  GEOFENCE_KINDS,
  MAINTENANCE_COMPONENTS,
  MAINTENANCE_STATUSES,
  MISSION_STATUSES,
  ROLES,
  SCENE_EVENT_KINDS,
  // guards
  isAlertSeverity,
  isAlertStatus,
  isAnomalyKind,
  isChannelType,
  isConditionOperator,
  isDroneStatus,
  isEventKind,
  isGeofenceKind,
  isMaintenanceComponent,
  isMaintenanceStatus,
  isMissionStatus,
  isOneOf,
  isRole,
  isSceneEventKind,
} from '../src/index.js';

/**
 * Validates: Requirements 27.1 — the shared-types package is the single source
 * of truth for the canonical cross-service enum sets, so these tests pin the
 * exact membership of every runtime tuple and assert each exported guard
 * accepts only those members (default-deny).
 */

describe('shared-types canonical constant sets', () => {
  it('DRONE_STATUSES has the expected members', () => {
    expect(DRONE_STATUSES).toEqual(['active', 'maintenance', 'decommissioned']);
  });

  it('MAINTENANCE_COMPONENTS has the expected members', () => {
    expect(MAINTENANCE_COMPONENTS).toEqual(['battery', 'motor', 'propeller']);
  });

  it('MAINTENANCE_STATUSES has the expected members', () => {
    expect(MAINTENANCE_STATUSES).toEqual(['due', 'overdue']);
  });

  it('CONDITION_OPERATORS has the expected members', () => {
    expect(CONDITION_OPERATORS).toEqual([
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'in',
      'nin',
      'contains',
    ]);
  });

  it('CHANNEL_TYPES has the expected members', () => {
    expect(CHANNEL_TYPES).toEqual(['in_app', 'email', 'whatsapp']);
  });

  it('EVENT_KINDS has the expected members', () => {
    expect(EVENT_KINDS).toEqual(['anomaly', 'scene', 'maintenance']);
  });

  it('ALERT_SEVERITIES has the expected members', () => {
    expect(ALERT_SEVERITIES).toEqual(['info', 'warning', 'critical']);
  });

  it('ALERT_STATUSES has the expected members', () => {
    expect(ALERT_STATUSES).toEqual(['OPEN', 'ACKNOWLEDGED', 'ESCALATED', 'CLOSED']);
  });

  it('MISSION_STATUSES has the expected members', () => {
    expect(MISSION_STATUSES).toEqual(['draft', 'validated', 'archived']);
  });

  it('GEOFENCE_KINDS has the expected members', () => {
    expect(GEOFENCE_KINDS).toEqual(['no_fly']);
  });

  it('ANOMALY_KINDS has the expected members', () => {
    expect(ANOMALY_KINDS).toEqual([
      'ALTITUDE_DROP',
      'BATTERY_DRAIN_SPIKE',
      'EKF2_DEGRADED',
      'GPS_ACCURACY_LOSS',
    ]);
  });

  it('SCENE_EVENT_KINDS has the expected members', () => {
    expect(SCENE_EVENT_KINDS).toEqual([
      'person_entered_zone',
      'vehicle_stopped',
      'group_gathering',
    ]);
  });

  it('ROLES has the expected members in privilege order', () => {
    expect(ROLES).toEqual(['viewer', 'analyst', 'operator', 'super_admin']);
  });

  it('every constant set is non-empty and free of duplicates', () => {
    const sets: readonly (readonly string[])[] = [
      DRONE_STATUSES,
      MAINTENANCE_COMPONENTS,
      MAINTENANCE_STATUSES,
      CONDITION_OPERATORS,
      CHANNEL_TYPES,
      EVENT_KINDS,
      ALERT_SEVERITIES,
      ALERT_STATUSES,
      MISSION_STATUSES,
      GEOFENCE_KINDS,
      ANOMALY_KINDS,
      SCENE_EVENT_KINDS,
      ROLES,
    ];
    for (const set of sets) {
      expect(set.length).toBeGreaterThan(0);
      expect(new Set(set).size).toBe(set.length);
    }
  });
});

describe('isOneOf generic membership guard', () => {
  it('accepts a member of the set and narrows it', () => {
    expect(isOneOf(DRONE_STATUSES, 'active')).toBe(true);
  });

  it('rejects values not in the set', () => {
    expect(isOneOf(DRONE_STATUSES, 'flying')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    for (const bad of [undefined, null, 0, 1, {}, [], true, Symbol('x')]) {
      expect(isOneOf(DRONE_STATUSES, bad)).toBe(false);
    }
  });

  it('is case-sensitive', () => {
    expect(isOneOf(ALERT_STATUSES, 'open')).toBe(false);
    expect(isOneOf(ALERT_STATUSES, 'OPEN')).toBe(true);
  });
});

describe('typed enum guards accept every member and reject outsiders', () => {
  const cases: ReadonlyArray<{
    name: string;
    guard: (value: unknown) => boolean;
    values: readonly string[];
  }> = [
    { name: 'isDroneStatus', guard: isDroneStatus, values: DRONE_STATUSES },
    { name: 'isMaintenanceComponent', guard: isMaintenanceComponent, values: MAINTENANCE_COMPONENTS },
    { name: 'isMaintenanceStatus', guard: isMaintenanceStatus, values: MAINTENANCE_STATUSES },
    { name: 'isConditionOperator', guard: isConditionOperator, values: CONDITION_OPERATORS },
    { name: 'isChannelType', guard: isChannelType, values: CHANNEL_TYPES },
    { name: 'isEventKind', guard: isEventKind, values: EVENT_KINDS },
    { name: 'isAlertSeverity', guard: isAlertSeverity, values: ALERT_SEVERITIES },
    { name: 'isAlertStatus', guard: isAlertStatus, values: ALERT_STATUSES },
    { name: 'isMissionStatus', guard: isMissionStatus, values: MISSION_STATUSES },
    { name: 'isGeofenceKind', guard: isGeofenceKind, values: GEOFENCE_KINDS },
    { name: 'isAnomalyKind', guard: isAnomalyKind, values: ANOMALY_KINDS },
    { name: 'isSceneEventKind', guard: isSceneEventKind, values: SCENE_EVENT_KINDS },
    { name: 'isRole', guard: isRole, values: ROLES },
  ];

  for (const { name, guard, values } of cases) {
    it(`${name} accepts every canonical member`, () => {
      for (const value of values) {
        expect(guard(value)).toBe(true);
      }
    });

    it(`${name} rejects invalid / out-of-set values`, () => {
      for (const bad of ['__not_a_member__', '', undefined, null, 42, {}]) {
        expect(guard(bad)).toBe(false);
      }
    });
  }
});
