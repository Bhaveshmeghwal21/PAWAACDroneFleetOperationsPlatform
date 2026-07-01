import { randomUUID } from 'node:crypto';
import type { ComponentLifecycle, Drone } from '@pawaac/shared-types';
import {
  DroneFilter,
  DroneNotFoundError,
  DroneStore,
  NewDrone,
  OptimisticLockError,
  SerialAlreadyExistsError,
} from './drone-store';

/**
 * A fully functional in-memory implementation of {@link DroneStore}.
 *
 * It enforces the same invariants as the production adapter — serial
 * uniqueness, strictly increasing versions and optimistic locking — so it is a
 * faithful store for unit and property tests rather than a behaviour-faking
 * mock. Records are deep-cloned on the way in and out so callers can never
 * mutate persisted state by reference.
 */
export class InMemoryDroneStore implements DroneStore {
  private readonly drones = new Map<string, Drone>();
  private readonly serials = new Map<string, string>();
  private readonly lifecycles = new Map<string, ComponentLifecycle>();

  async create(input: NewDrone): Promise<Drone> {
    if (this.serials.has(input.serialNumber)) {
      throw new SerialAlreadyExistsError(input.serialNumber);
    }
    const now = new Date().toISOString();
    const drone: Drone = {
      id: randomUUID(),
      serialNumber: input.serialNumber,
      model: input.model,
      firmwareVersion: input.firmwareVersion,
      hardwareConfig: structuredClone(input.hardwareConfig),
      status: input.status,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.drones.set(drone.id, drone);
    this.serials.set(drone.serialNumber, drone.id);
    return structuredClone(drone);
  }

  async findById(id: string): Promise<Drone | null> {
    const found = this.drones.get(id);
    return found ? structuredClone(found) : null;
  }

  async findAll(filter?: DroneFilter): Promise<Drone[]> {
    let all = [...this.drones.values()];
    if (filter?.status !== undefined) {
      all = all.filter((d) => d.status === filter.status);
    }
    if (filter?.model !== undefined) {
      all = all.filter((d) => d.model === filter.model);
    }
    return all.map((d) => structuredClone(d));
  }

  async update(
    id: string,
    expectedVersion: number | undefined,
    changes: Partial<NewDrone>,
  ): Promise<Drone> {
    const current = this.drones.get(id);
    if (!current) {
      throw new DroneNotFoundError(id);
    }
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new OptimisticLockError(id);
    }
    if (
      changes.serialNumber !== undefined &&
      changes.serialNumber !== current.serialNumber &&
      this.serials.has(changes.serialNumber)
    ) {
      throw new SerialAlreadyExistsError(changes.serialNumber);
    }

    const updated: Drone = {
      ...current,
      ...(changes.serialNumber !== undefined ? { serialNumber: changes.serialNumber } : {}),
      ...(changes.model !== undefined ? { model: changes.model } : {}),
      ...(changes.firmwareVersion !== undefined
        ? { firmwareVersion: changes.firmwareVersion }
        : {}),
      ...(changes.hardwareConfig !== undefined
        ? { hardwareConfig: structuredClone(changes.hardwareConfig) }
        : {}),
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };

    if (changes.serialNumber !== undefined && changes.serialNumber !== current.serialNumber) {
      this.serials.delete(current.serialNumber);
      this.serials.set(changes.serialNumber, id);
    }
    this.drones.set(id, updated);
    return structuredClone(updated);
  }

  async getLifecycle(droneId: string): Promise<ComponentLifecycle | null> {
    const found = this.lifecycles.get(droneId);
    return found ? structuredClone(found) : null;
  }

  async saveLifecycle(lifecycle: ComponentLifecycle): Promise<ComponentLifecycle> {
    this.lifecycles.set(lifecycle.droneId, structuredClone(lifecycle));
    return structuredClone(lifecycle);
  }
}
