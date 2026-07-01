import type { ComponentLifecycle } from '@pawaac/shared-types';
import { MAINTENANCE_DUE_EVENT } from '../src/events/event-transport';
import { evaluateMaintenance } from '../src/drones/maintenance';
import { buildHarness, Harness } from './helpers';

const lifecycle = (overrides: Partial<ComponentLifecycle>): ComponentLifecycle => ({
  droneId: 'drone-1',
  batteryCycles: 0,
  motorHours: 0,
  propellerReplacements: 0,
  thresholds: { maxBatteryCycles: 100, maxMotorHours: 50, maxPropellerLifeHours: 10 },
  ...overrides,
});

describe('evaluateMaintenance (Requirements 2.3, 2.4 / P4)', () => {
  it('returns no alerts when every counter is below threshold', () => {
    expect(evaluateMaintenance(lifecycle({ batteryCycles: 99 }))).toEqual([]);
  });

  it('reports "due" exactly at the threshold and "overdue" above it', () => {
    const due = evaluateMaintenance(lifecycle({ batteryCycles: 100 }));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ component: 'battery', status: 'due' });

    const overdue = evaluateMaintenance(lifecycle({ batteryCycles: 101 }));
    expect(overdue[0]).toMatchObject({ component: 'battery', status: 'overdue' });
  });

  it('is pure: repeated calls on identical input yield identical output (2.4)', () => {
    const input = lifecycle({ batteryCycles: 120, motorHours: 60 });
    expect(evaluateMaintenance(input)).toEqual(evaluateMaintenance(input));
  });
});

describe('FleetRegistryService — component lifecycle (Requirements 2.1, 2.2, 2.5)', () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  it('accumulates usage counters (2.1)', async () => {
    const drone = await h.service.createDrone({
      serialNumber: 'SN-L1',
      model: 'm',
      firmwareVersion: '1',
    });
    await h.service.recordComponentUsage(drone.id, { batteryCyclesDelta: 3, motorHoursDelta: 1.5 });
    const lc = await h.service.recordComponentUsage(drone.id, { batteryCyclesDelta: 2 });
    expect(lc.batteryCycles).toBe(5);
    expect(lc.motorHours).toBeCloseTo(1.5);
  });

  it('clamps counters to be non-negative (2.2 / P3)', async () => {
    const drone = await h.service.createDrone({
      serialNumber: 'SN-L2',
      model: 'm',
      firmwareVersion: '1',
    });
    const lc = await h.service.recordComponentUsage(drone.id, { batteryCyclesDelta: -50 });
    expect(lc.batteryCycles).toBe(0);
  });

  it('emits a maintenance-due event when a counter first crosses its threshold (2.5)', async () => {
    const drone = await h.service.createDrone({
      serialNumber: 'SN-L3',
      model: 'm',
      firmwareVersion: '1',
    });
    await h.service.recordComponentUsage(drone.id, {
      batteryCyclesDelta: 10,
      thresholds: { maxBatteryCycles: 10, maxMotorHours: 1000, maxPropellerLifeHours: 1000 },
    });
    expect(h.transport.count(MAINTENANCE_DUE_EVENT)).toBe(1);
  });
});
