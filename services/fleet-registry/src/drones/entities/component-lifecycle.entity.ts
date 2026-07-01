import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { MaintenanceThresholds } from '@pawaac/shared-types';

/** Accumulated component usage counters for a drone (Requirement 2). */
@Entity('component_lifecycle')
export class ComponentLifecycleEntity {
  @PrimaryColumn({ type: 'uuid' })
  droneId!: string;

  @Column({ type: 'int', default: 0 })
  batteryCycles!: number;

  @Column({ type: 'double precision', default: 0 })
  motorHours!: number;

  @Column({ type: 'int', default: 0 })
  propellerReplacements!: number;

  @Column({ type: 'jsonb' })
  thresholds!: MaintenanceThresholds;
}
