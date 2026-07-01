import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { AlertSeverity, Channel, EventKind, TimeWindow } from '@pawaac/shared-types';
import { ConditionEntity } from './condition.entity';

/**
 * Persistent configurable alert rule (Requirement 14, design "Alert &
 * Notification" data model). The rule engine (task 11.3) and dispatcher
 * (task 11.5) consume these records; this entity only defines persistence.
 *
 * Validation rules enforced elsewhere (not at the schema layer): a present
 * `timeWindow` keeps both minutes within `[0, 1440)` and may wrap around
 * midnight when `startMin > endMin`; `escalationIntervalMin` is strictly
 * positive. These predicates are validated by the DTO/service layer in later
 * tasks rather than via raw SQL check constraints.
 */
@Entity('alert_rules')
export class AlertRuleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Index('idx_alert_rules_enabled')
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Index('idx_alert_rules_event_kind')
  @Column({ type: 'varchar', length: 32 })
  eventKind!: EventKind;

  /**
   * Optional active window expressed in minutes-of-day. Stored as JSONB so the
   * `{ startMin, endMin }` shape maps directly to the shared `TimeWindow` type.
   */
  @Column({ type: 'jsonb', nullable: true })
  timeWindow!: TimeWindow | null;

  /** Optional zone scope; `null` means the rule applies fleet-wide. */
  @Column({ type: 'uuid', nullable: true })
  zoneId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  severity!: AlertSeverity;

  /** Configured delivery channels (in-app / email / WhatsApp). */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  channels!: Channel[];

  /** Ordered contact ids walked during escalation. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  escalationChain!: string[];

  /** Minutes between escalation steps; strictly positive (validated in service). */
  @Column({ type: 'int' })
  escalationIntervalMin!: number;

  @OneToMany(() => ConditionEntity, (condition) => condition.rule, {
    cascade: true,
    eager: true,
  })
  conditions!: ConditionEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
