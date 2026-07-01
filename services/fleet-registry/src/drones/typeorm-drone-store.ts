import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, OptimisticLockVersionMismatchError, Repository } from 'typeorm';
import type { ComponentLifecycle, Drone } from '@pawaac/shared-types';
import {
  DroneFilter,
  DroneNotFoundError,
  DroneStore,
  NewDrone,
  OptimisticLockError,
  SerialAlreadyExistsError,
} from './drone-store';
import { ComponentLifecycleEntity } from './entities/component-lifecycle.entity';
import { DroneEntity } from './entities/drone.entity';

/** Postgres error code for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

function toDomain(entity: DroneEntity): Drone {
  return {
    id: entity.id,
    serialNumber: entity.serialNumber,
    model: entity.model,
    firmwareVersion: entity.firmwareVersion,
    hardwareConfig: entity.hardwareConfig,
    status: entity.status,
    version: entity.version,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

/** Production {@link DroneStore} backed by TypeORM / Postgres. */
@Injectable()
export class TypeOrmDroneStore implements DroneStore {
  constructor(
    @InjectRepository(DroneEntity)
    private readonly drones: Repository<DroneEntity>,
    @InjectRepository(ComponentLifecycleEntity)
    private readonly lifecycles: Repository<ComponentLifecycleEntity>,
  ) {}

  async create(input: NewDrone): Promise<Drone> {
    const existing = await this.drones.findOne({ where: { serialNumber: input.serialNumber } });
    if (existing) {
      throw new SerialAlreadyExistsError(input.serialNumber);
    }
    const entity = this.drones.create({
      serialNumber: input.serialNumber,
      model: input.model,
      firmwareVersion: input.firmwareVersion,
      hardwareConfig: input.hardwareConfig,
      status: input.status,
    });
    try {
      const saved = await this.drones.save(entity);
      return toDomain(saved);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SerialAlreadyExistsError(input.serialNumber);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Drone | null> {
    const entity = await this.drones.findOne({ where: { id } });
    return entity ? toDomain(entity) : null;
  }

  async findAll(filter?: DroneFilter): Promise<Drone[]> {
    const where: FindOptionsWhere<DroneEntity> = {};
    if (filter?.status !== undefined) {
      where.status = filter.status;
    }
    if (filter?.model !== undefined) {
      where.model = filter.model;
    }
    const entities = await this.drones.find({
      where,
      order: { createdAt: 'ASC' },
    });
    return entities.map(toDomain);
  }

  async update(
    id: string,
    expectedVersion: number | undefined,
    changes: Partial<NewDrone>,
  ): Promise<Drone> {
    const entity = await this.drones.findOne({ where: { id } });
    if (!entity) {
      throw new DroneNotFoundError(id);
    }
    if (expectedVersion !== undefined && expectedVersion !== entity.version) {
      throw new OptimisticLockError(id);
    }
    if (changes.serialNumber !== undefined) {
      entity.serialNumber = changes.serialNumber;
    }
    if (changes.model !== undefined) {
      entity.model = changes.model;
    }
    if (changes.firmwareVersion !== undefined) {
      entity.firmwareVersion = changes.firmwareVersion;
    }
    if (changes.hardwareConfig !== undefined) {
      entity.hardwareConfig = changes.hardwareConfig;
    }
    if (changes.status !== undefined) {
      entity.status = changes.status;
    }
    try {
      const saved = await this.drones.save(entity);
      return toDomain(saved);
    } catch (error) {
      if (error instanceof OptimisticLockVersionMismatchError) {
        throw new OptimisticLockError(id);
      }
      if (isUniqueViolation(error)) {
        throw new SerialAlreadyExistsError(changes.serialNumber ?? entity.serialNumber);
      }
      throw error;
    }
  }

  async getLifecycle(droneId: string): Promise<ComponentLifecycle | null> {
    const entity = await this.lifecycles.findOne({ where: { droneId } });
    return entity
      ? {
          droneId: entity.droneId,
          batteryCycles: entity.batteryCycles,
          motorHours: entity.motorHours,
          propellerReplacements: entity.propellerReplacements,
          thresholds: entity.thresholds,
        }
      : null;
  }

  async saveLifecycle(lifecycle: ComponentLifecycle): Promise<ComponentLifecycle> {
    const entity = this.lifecycles.create({
      droneId: lifecycle.droneId,
      batteryCycles: lifecycle.batteryCycles,
      motorHours: lifecycle.motorHours,
      propellerReplacements: lifecycle.propellerReplacements,
      thresholds: lifecycle.thresholds,
    });
    await this.lifecycles.save(entity);
    return lifecycle;
  }
}
