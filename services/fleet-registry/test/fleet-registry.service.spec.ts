import { ConflictException, NotFoundException } from '@nestjs/common';
import { STATUS_CHANGED_EVENT } from '../src/events/event-transport';
import { buildHarness, Harness } from './helpers';

describe('FleetRegistryService — Drone CRUD (Requirement 1)', () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  it('creates a drone with version 1 and a default active status (1.1)', async () => {
    const drone = await h.service.createDrone({
      serialNumber: 'SN-001',
      model: 'PX4-Quad',
      firmwareVersion: '1.0.0',
    });
    expect(drone.id).toBeDefined();
    expect(drone.version).toBe(1);
    expect(drone.status).toBe('active');
  });

  it('rejects a duplicate serial number with a conflict (1.3 / P6)', async () => {
    await h.service.createDrone({ serialNumber: 'SN-DUP', model: 'm', firmwareVersion: '1' });
    await expect(
      h.service.createDrone({ serialNumber: 'SN-DUP', model: 'm', firmwareVersion: '1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    const all = await h.store.findAll();
    expect(all).toHaveLength(1);
  });

  it('returns a matching drone by id and 404s for unknown ids (1.4)', async () => {
    const created = await h.service.createDrone({
      serialNumber: 'SN-002',
      model: 'm',
      firmwareVersion: '1',
    });
    await expect(h.service.getDrone(created.id)).resolves.toMatchObject({ id: created.id });
    await expect(h.service.getDrone('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lists drones filtered by status (1.5)', async () => {
    const a = await h.service.createDrone({ serialNumber: 'A', model: 'm', firmwareVersion: '1' });
    await h.service.createDrone({ serialNumber: 'B', model: 'm', firmwareVersion: '1' });
    await h.service.updateDrone(a.id, { status: 'maintenance' });

    const maintenance = await h.service.listDrones({ status: 'maintenance' });
    expect(maintenance).toHaveLength(1);
    expect(maintenance[0]?.id).toBe(a.id);
  });

  it('assigns a strictly greater version on update (1.8 / P2)', async () => {
    const created = await h.service.createDrone({
      serialNumber: 'SN-003',
      model: 'm',
      firmwareVersion: '1',
    });
    const updated = await h.service.updateDrone(created.id, { firmwareVersion: '2' });
    expect(updated.version).toBeGreaterThan(created.version);
  });

  it('rejects a stale-version update with an optimistic-lock conflict (1.9)', async () => {
    const created = await h.service.createDrone({
      serialNumber: 'SN-004',
      model: 'm',
      firmwareVersion: '1',
    });
    await h.service.updateDrone(created.id, { firmwareVersion: '2' });
    await expect(
      h.service.updateDrone(created.id, { firmwareVersion: '3', version: created.version }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('decommissions a drone (1.10) and emits a status-change event (3.2)', async () => {
    const created = await h.service.createDrone({
      serialNumber: 'SN-005',
      model: 'm',
      firmwareVersion: '1',
    });
    const result = await h.service.decommissionDrone(created.id);
    expect(result.status).toBe('decommissioned');
    expect(h.transport.count(STATUS_CHANGED_EVENT)).toBe(1);
  });

  it('does not emit a status-change event when status is unchanged (3.3 / P5)', async () => {
    const created = await h.service.createDrone({
      serialNumber: 'SN-006',
      model: 'm',
      firmwareVersion: '1',
    });
    await h.service.updateDrone(created.id, { firmwareVersion: '2' });
    expect(h.transport.count(STATUS_CHANGED_EVENT)).toBe(0);
  });
});
