import { describe, expect, it } from 'vitest';
import type { Drone, TelemetrySample } from '@pawaac/shared-types';

import type { DroneStatusEvent } from './ws-client';
import {
  applyStatusEvent,
  applyTelemetrySample,
  emptyFleetState,
  seedDrones,
  toMarkerList,
  type FleetMarkerState,
} from './fleet-map-state';

const DRONE_A = '11111111-1111-1111-1111-111111111111';
const DRONE_B = '22222222-2222-2222-2222-222222222222';

function makeDrone(overrides: Partial<Drone> = {}): Drone {
  return {
    id: DRONE_A,
    serialNumber: 'SN-A',
    model: 'Falcon',
    firmwareVersion: '1.0.0',
    hardwareConfig: {},
    status: 'active',
    version: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSample(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    droneId: DRONE_A,
    ts: '2024-01-01T00:00:10.000Z',
    lat: 12.34,
    lon: 56.78,
    altitude: 120,
    velocity: { vx: 1, vy: 0, vz: 0 },
    attitude: { roll: 0, pitch: 0, yaw: 0 },
    battery: { voltage: 22.2, current: 5, remainingPct: 87 },
    ekf2: { healthy: true, flags: 0 },
    rcSignalStrength: 95,
    flightMode: 'AUTO',
    armed: true,
    ...overrides,
  };
}

describe('seedDrones', () => {
  it('builds one marker per drone carrying registry metadata and status', () => {
    const state = seedDrones([
      makeDrone({ id: DRONE_A, serialNumber: 'SN-A', status: 'active' }),
      makeDrone({ id: DRONE_B, serialNumber: 'SN-B', status: 'maintenance' }),
    ]);

    expect(Object.keys(state)).toHaveLength(2);
    expect(state[DRONE_A]).toMatchObject({
      droneId: DRONE_A,
      serialNumber: 'SN-A',
      model: 'Falcon',
      status: 'active',
    });
    expect(state[DRONE_B]?.status).toBe('maintenance');
  });

  it('leaves telemetry-derived fields undefined until a sample arrives', () => {
    const state = seedDrones([makeDrone()]);
    const marker = state[DRONE_A];

    expect(marker?.position).toBeUndefined();
    expect(marker?.batteryPct).toBeUndefined();
    expect(marker?.flightMode).toBeUndefined();
    expect(marker?.lastTelemetryTs).toBeUndefined();
  });

  it('returns an empty state for an empty drone list', () => {
    expect(seedDrones([])).toEqual({});
  });
});

describe('applyTelemetrySample (Requirements 21.1, 21.2)', () => {
  it('updates position, battery, flight mode and altitude on a seeded drone', () => {
    const seeded = seedDrones([makeDrone()]);
    const next = applyTelemetrySample(seeded, makeSample());

    expect(next[DRONE_A]).toMatchObject({
      position: { lat: 12.34, lon: 56.78 },
      batteryPct: 87,
      flightMode: 'AUTO',
      altitude: 120,
      lastTelemetryTs: '2024-01-01T00:00:10.000Z',
    });
    // Registry metadata is preserved through telemetry updates.
    expect(next[DRONE_A]?.serialNumber).toBe('SN-A');
    expect(next[DRONE_A]?.status).toBe('active');
  });

  it('does not mutate the input state (purity)', () => {
    const seeded = seedDrones([makeDrone()]);
    const snapshot = structuredClone(seeded);

    applyTelemetrySample(seeded, makeSample());

    expect(seeded).toEqual(snapshot);
  });

  it('creates a marker for a drone not present in the registry seed', () => {
    const next = applyTelemetrySample(emptyFleetState(), makeSample({ droneId: DRONE_B }));

    expect(next[DRONE_B]).toMatchObject({
      droneId: DRONE_B,
      status: 'active',
      position: { lat: 12.34, lon: 56.78 },
      batteryPct: 87,
    });
    expect(next[DRONE_B]?.serialNumber).toBeUndefined();
  });

  it('applies a newer sample and reflects the latest values', () => {
    const seeded = seedDrones([makeDrone()]);
    const first = applyTelemetrySample(seeded, makeSample({ ts: '2024-01-01T00:00:10.000Z' }));
    const second = applyTelemetrySample(
      first,
      makeSample({ ts: '2024-01-01T00:00:20.000Z', lat: 1, lon: 2, flightMode: 'RTL' }),
    );

    expect(second[DRONE_A]).toMatchObject({
      position: { lat: 1, lon: 2 },
      flightMode: 'RTL',
      lastTelemetryTs: '2024-01-01T00:00:20.000Z',
    });
  });

  it('ignores a stale (out-of-order) sample and returns the same reference', () => {
    const seeded = seedDrones([makeDrone()]);
    const current = applyTelemetrySample(seeded, makeSample({ ts: '2024-01-01T00:00:20.000Z' }));

    const stale = applyTelemetrySample(
      current,
      makeSample({ ts: '2024-01-01T00:00:05.000Z', flightMode: 'MANUAL' }),
    );

    expect(stale).toBe(current);
    expect(stale[DRONE_A]?.flightMode).toBe('AUTO');
  });
});

describe('applyStatusEvent (Requirement 21.3)', () => {
  it('updates the affected drone status while preserving telemetry', () => {
    const seeded = seedDrones([makeDrone()]);
    const withTelemetry = applyTelemetrySample(seeded, makeSample());

    const event: DroneStatusEvent = { droneId: DRONE_A, status: 'maintenance' };
    const next = applyStatusEvent(withTelemetry, event);

    expect(next[DRONE_A]?.status).toBe('maintenance');
    // Telemetry survives the status change.
    expect(next[DRONE_A]?.position).toEqual({ lat: 12.34, lon: 56.78 });
    expect(next[DRONE_A]?.batteryPct).toBe(87);
  });

  it('does not mutate the input state (purity)', () => {
    const seeded = seedDrones([makeDrone()]);
    const snapshot = structuredClone(seeded);

    applyStatusEvent(seeded, { droneId: DRONE_A, status: 'decommissioned' });

    expect(seeded).toEqual(snapshot);
  });

  it('returns the same reference when the status is unchanged', () => {
    const seeded = seedDrones([makeDrone({ status: 'active' })]);
    const next = applyStatusEvent(seeded, { droneId: DRONE_A, status: 'active' });

    expect(next).toBe(seeded);
  });

  it('creates a marker when a status arrives for an unknown drone', () => {
    const next = applyStatusEvent(emptyFleetState(), {
      droneId: DRONE_B,
      status: 'decommissioned',
    });

    expect(next[DRONE_B]).toMatchObject({
      droneId: DRONE_B,
      status: 'decommissioned',
      position: undefined,
    });
  });
});

describe('toMarkerList', () => {
  it('returns markers deterministically sorted by drone id', () => {
    const state: FleetMarkerState = seedDrones([
      makeDrone({ id: DRONE_B, serialNumber: 'SN-B' }),
      makeDrone({ id: DRONE_A, serialNumber: 'SN-A' }),
    ]);

    const list = toMarkerList(state);

    expect(list.map((m) => m.droneId)).toEqual([DRONE_A, DRONE_B]);
  });
});
