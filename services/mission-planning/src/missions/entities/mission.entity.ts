import { Column, CreateDateColumn, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import type { MissionStatus } from '@pawaac/shared-types';
import { WaypointEntity } from './waypoint.entity';

/**
 * Persistent, immutable mission record (Requirement 4, data model in design).
 *
 * Immutable versioning is modelled with a composite primary key of
 * `(id, version)`: every edit persists a brand-new row with `version` one
 * greater than the prior one, leaving earlier versions byte-identical
 * (Requirements 4.5, 4.7). The actual versioning/validation logic is added by
 * task 5.3 — this entity only declares the persistent shape.
 */
@Entity('missions')
export class MissionEntity {
  /** Mission identity, shared across every version of the same mission. */
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  /** Monotonically increasing version; the first persisted version is 1. */
  @PrimaryColumn({ type: 'int' })
  version!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 32, default: 'draft' })
  status!: MissionStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /** Waypoints belonging to this specific mission version, ordered by `seq`. */
  @OneToMany(() => WaypointEntity, (waypoint) => waypoint.mission, {
    cascade: true,
    eager: true,
  })
  waypoints!: WaypointEntity[];
}
