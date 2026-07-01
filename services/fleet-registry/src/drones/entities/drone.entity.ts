import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import type { DroneStatus } from '@pawaac/shared-types';

/** Persistent drone asset record (Requirement 1, data model in design). */
@Entity('drones')
export class DroneEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uq_drones_serial_number', { unique: true })
  @Column({ type: 'varchar', length: 255 })
  serialNumber!: string;

  @Column({ type: 'varchar', length: 255 })
  model!: string;

  @Column({ type: 'varchar', length: 255 })
  firmwareVersion!: string;

  @Column({ type: 'jsonb', default: {} })
  hardwareConfig!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 32, default: 'active' })
  status!: DroneStatus;

  /** Optimistic-concurrency token, auto-incremented on every persisted update. */
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
