import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ComponentLifecycle,
  Drone,
  MaintenanceAlert,
  MaintenanceDomainEvent,
} from '@pawaac/shared-types';
import { ResilientEventPublisher } from '../events/resilient-event-publisher';
import {
  DRONE_STORE,
  DroneNotFoundError,
  DroneStore,
  NewDrone,
  OptimisticLockError,
  SerialAlreadyExistsError,
} from './drone-store';
import { ComponentUsageDto, CreateDroneDto, DroneFilterDto, UpdateDroneDto } from './dto';
import { DEFAULT_THRESHOLDS, evaluateMaintenance } from './maintenance';

const clampNonNegative = (value: number): number => (value > 0 ? value : 0);

/**
 * Fleet Registry application service: drone CRUD with optimistic concurrency
 * (Requirement 1), component lifecycle tracking and maintenance evaluation
 * (Requirement 2), and real-time status / maintenance events (Requirement 3).
 */
@Injectable()
export class FleetRegistryService {
  constructor(
    @Inject(DRONE_STORE) private readonly store: DroneStore,
    private readonly publisher: ResilientEventPublisher,
  ) {}

  async createDrone(dto: CreateDroneDto): Promise<Drone> {
    const input: NewDrone = {
      serialNumber: dto.serialNumber,
      model: dto.model,
      firmwareVersion: dto.firmwareVersion,
      hardwareConfig: dto.hardwareConfig ?? {},
      status: dto.status ?? 'active',
    };
    try {
      return await this.store.create(input);
    } catch (error) {
      throw this.toHttp(error);
    }
  }

  async getDrone(id: string): Promise<Drone> {
    const drone = await this.store.findById(id);
    if (!drone) {
      throw new NotFoundException(`Drone "${id}" was not found`);
    }
    return drone;
  }

  async listDrones(filter?: DroneFilterDto): Promise<Drone[]> {
    return this.store.findAll(filter);
  }

  async updateDrone(id: string, dto: UpdateDroneDto): Promise<Drone> {
    const previous = await this.store.findById(id);
    if (!previous) {
      throw new NotFoundException(`Drone "${id}" was not found`);
    }

    const changes: Partial<NewDrone> = {
      ...(dto.model !== undefined ? { model: dto.model } : {}),
      ...(dto.firmwareVersion !== undefined ? { firmwareVersion: dto.firmwareVersion } : {}),
      ...(dto.hardwareConfig !== undefined ? { hardwareConfig: dto.hardwareConfig } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    };

    let updated: Drone;
    try {
      updated = await this.store.update(id, dto.version, changes);
    } catch (error) {
      throw this.toHttp(error);
    }

    if (updated.status !== previous.status) {
      await this.publisher.publishStatusChange({
        droneId: updated.id,
        previousStatus: previous.status,
        status: updated.status,
        version: updated.version,
        ts: updated.updatedAt,
      });
    }
    return updated;
  }

  async decommissionDrone(id: string): Promise<Drone> {
    return this.updateDrone(id, { status: 'decommissioned' });
  }

  async recordComponentUsage(
    droneId: string,
    dto: ComponentUsageDto,
  ): Promise<ComponentLifecycle> {
    const drone = await this.store.findById(droneId);
    if (!drone) {
      throw new NotFoundException(`Drone "${droneId}" was not found`);
    }

    const existing = await this.store.getLifecycle(droneId);
    const base: ComponentLifecycle = existing ?? {
      droneId,
      batteryCycles: 0,
      motorHours: 0,
      propellerReplacements: 0,
      thresholds: { ...DEFAULT_THRESHOLDS },
    };
    const before = evaluateMaintenance(base);

    const next: ComponentLifecycle = {
      droneId,
      batteryCycles: clampNonNegative(base.batteryCycles + (dto.batteryCyclesDelta ?? 0)),
      motorHours: clampNonNegative(base.motorHours + (dto.motorHoursDelta ?? 0)),
      propellerReplacements: clampNonNegative(
        base.propellerReplacements + (dto.propellerReplacementsDelta ?? 0),
      ),
      thresholds: dto.thresholds ? { ...dto.thresholds } : base.thresholds,
    };
    const saved = await this.store.saveLifecycle(next);

    const after = evaluateMaintenance(saved);
    const newlyDue = after.filter(
      (alert) => !before.some((prior) => prior.component === alert.component),
    );
    for (const alert of newlyDue) {
      const event: MaintenanceDomainEvent = {
        kind: 'maintenance',
        ts: new Date().toISOString(),
        droneId,
        payload: alert,
      };
      await this.publisher.publishMaintenanceDue(event);
    }

    return saved;
  }

  async evaluateMaintenance(droneId: string): Promise<MaintenanceAlert[]> {
    const lifecycle = await this.store.getLifecycle(droneId);
    if (!lifecycle) {
      const drone = await this.store.findById(droneId);
      if (!drone) {
        throw new NotFoundException(`Drone "${droneId}" was not found`);
      }
      return [];
    }
    return evaluateMaintenance(lifecycle);
  }

  private toHttp(error: unknown): Error {
    if (error instanceof SerialAlreadyExistsError || error instanceof OptimisticLockError) {
      return new ConflictException(error.message);
    }
    if (error instanceof DroneNotFoundError) {
      return new NotFoundException(error.message);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
