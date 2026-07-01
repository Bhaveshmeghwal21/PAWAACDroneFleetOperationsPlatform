import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { AlertSeverity, AlertStatus } from '@pawaac/shared-types';
import { AlertRuleEntity } from './alert-rule.entity';

/**
 * A raised alert instance tracked through acknowledgement and escalation
 * (Requirement 16, design "Alert & Notification" data model).
 *
 * Lifecycle invariants enforced by the service layer (tasks 11.7+), not by raw
 * SQL constraints: status follows only OPEN -> (ACKNOWLEDGED | ESCALATED) ->
 * CLOSED while permitting self-transitions, and `escalationLevel` never exceeds
 * the owning rule's escalation-chain length. Alerts are created with status
 * OPEN at level 0.
 */
@Entity('alerts')
export class AlertEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Rule that produced this alert (foreign key to `alert_rules`). */
  @Index('idx_alerts_rule_id')
  @Column({ type: 'uuid' })
  ruleId!: string;

  @Column({ type: 'varchar', length: 16 })
  severity!: AlertSeverity;

  @Index('idx_alerts_status')
  @Column({ type: 'varchar', length: 16, default: 'OPEN' })
  status!: AlertStatus;

  /** Current escalation level in `0..escalationChain.length`. */
  @Column({ type: 'int', default: 0 })
  escalationLevel!: number;

  @Index('idx_alerts_created_at')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  acknowledgedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  acknowledgedBy!: string | null;

  @ManyToOne(() => AlertRuleEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'ruleId' })
  rule!: AlertRuleEntity;
}
