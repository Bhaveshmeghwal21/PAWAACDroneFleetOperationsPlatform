import type { ComponentLifecycle, Drone, DroneStatus } from '@pawaac/shared-types';

/** Optional filter applied when listing drones. */
export interface DroneFilter {
  status?: DroneStatus;
  model?: string;
}

/** The mutable fields accepted when creating or updating a drone. */
export interface NewDrone {
  serialNumber: string;
  model: string;
  firmwareVersion: string;
  hardwareConfig: Record<string, unknown>;
  status: DroneStatus;
}

/**
 * Persistence port for the Fleet Registry. The service depends only on this
 * interface; production wires a TypeORM/Postgres adapter while tests use a
 * fully functional in-memory adapter. Both honour the same contract
 * (serial uniqueness, monotonic versions, optimistic locking).
 */
export interface DroneStore {
  create(input: NewDrone): Promise<Drone>;
  findById(id: string): Promise<Drone | null>;
  findAll(filter?: DroneFilter): Promise<Drone[]>;
  /**
   * Optimistically updates a drone. When `expectedVersion` is provided it must
   * match the persisted version or {@link OptimisticLockError} is thrown. The
   * returned record always carries a version strictly greater than before.
   */
  update(
    id: string,
    expectedVersion: number | undefined,
    changes: Partial<NewDrone>,
  ): Promise<Drone>;
  getLifecycle(droneId: string): Promise<ComponentLifecycle | null>;
  saveLifecycle(lifecycle: ComponentLifecycle): Promise<ComponentLifecycle>;
}

/** DI token for the {@link DroneStore} port. */
export const DRONE_STORE = Symbol('DRONE_STORE');

/** Thrown when a create request reuses an existing serial number. */
export class SerialAlreadyExistsError extends Error {
  constructor(serialNumber: string) {
    super(`A drone with serial number "${serialNumber}" already exists`);
    this.name = 'SerialAlreadyExistsError';
  }
}

/** Thrown when an operation targets a drone id that does not exist. */
export class DroneNotFoundError extends Error {
  constructor(id: string) {
    super(`Drone "${id}" was not found`);
    this.name = 'DroneNotFoundError';
  }
}

/** Thrown when an update carries a stale optimistic-lock version. */
export class OptimisticLockError extends Error {
  constructor(id: string) {
    super(`Drone "${id}" was modified concurrently; the supplied version is stale`);
    this.name = 'OptimisticLockError';
  }
}
