import type {
  ComponentLifecycle,
  MaintenanceAlert,
  MaintenanceComponent,
  MaintenanceThresholds,
} from '@pawaac/shared-types';

/** Conservative default thresholds applied when a drone has none configured. */
export const DEFAULT_THRESHOLDS: MaintenanceThresholds = {
  maxBatteryCycles: 500,
  maxMotorHours: 1000,
  maxPropellerLifeHours: 200,
};

/**
 * Pure, side-effect-free maintenance evaluation (Requirements 2.3, 2.4 / P4).
 *
 * Returns one alert per component whose counter is greater than or equal to its
 * configured threshold — and only those. A counter exactly at the threshold is
 * reported as `due`; strictly above it is `overdue`. Identical inputs always
 * produce identical output and the input is never mutated.
 */
export function evaluateMaintenance(lifecycle: ComponentLifecycle): MaintenanceAlert[] {
  const { thresholds } = lifecycle;
  const checks: ReadonlyArray<readonly [MaintenanceComponent, number, number]> = [
    ['battery', lifecycle.batteryCycles, thresholds.maxBatteryCycles],
    ['motor', lifecycle.motorHours, thresholds.maxMotorHours],
    ['propeller', lifecycle.propellerReplacements, thresholds.maxPropellerLifeHours],
  ];

  const alerts: MaintenanceAlert[] = [];
  for (const [component, currentValue, threshold] of checks) {
    if (currentValue >= threshold) {
      alerts.push({
        droneId: lifecycle.droneId,
        component,
        status: currentValue > threshold ? 'overdue' : 'due',
        currentValue,
        threshold,
      });
    }
  }
  return alerts;
}
