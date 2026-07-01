import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { ConditionOperator } from '@pawaac/shared-types';
import { AlertRuleEntity } from './alert-rule.entity';

/**
 * A single AND-combined field predicate belonging to an {@link AlertRuleEntity}
 * (Requirement 14, design "Alert & Notification" data model).
 *
 * Conditions are persisted as their own rows (rather than embedded JSON) so the
 * rule engine implemented in task 11.3 can load, reorder and reason over them
 * relationally. `position` records the author-defined ordering; evaluation is
 * order-independent (Requirement 14.3) but the ordering is preserved for
 * round-trip fidelity.
 */
@Entity('alert_conditions')
export class ConditionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Owning rule id (foreign key to `alert_rules`). */
  @Index('idx_alert_conditions_rule_id')
  @Column({ type: 'uuid' })
  ruleId!: string;

  /** Author-defined ordering of the predicate within its rule. */
  @Column({ type: 'int', default: 0 })
  position!: number;

  /** Dot-path of the event field to evaluate (e.g. `payload.kind`). */
  @Column({ type: 'varchar', length: 255 })
  field!: string;

  /** Comparison operator applied between the field value and `value`. */
  @Column({ type: 'varchar', length: 16 })
  operator!: ConditionOperator;

  /** Comparison operand; shape depends on `operator`, hence schemaless JSONB. */
  @Column({ type: 'jsonb', nullable: true })
  value!: unknown;

  @ManyToOne(() => AlertRuleEntity, (rule) => rule.conditions, {
    onDelete: 'CASCADE',
    orphanedRowAction: 'delete',
  })
  @JoinColumn({ name: 'ruleId' })
  rule!: AlertRuleEntity;
}
