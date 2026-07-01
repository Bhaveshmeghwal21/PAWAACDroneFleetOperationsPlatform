import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { AlertRule, DomainEvent } from '@pawaac/shared-types';
import { AlertRuleEntity } from './entities/alert-rule.entity';
import { ConditionEntity } from './entities/condition.entity';
import { UpsertRuleDto } from './dto';
import { evaluateRules } from './rule-engine';

/**
 * Map a persisted rule (with its eagerly-loaded condition rows) to the shared
 * `AlertRule` domain type the pure rule engine consumes. Conditions are ordered
 * by their author-defined `position` for round-trip fidelity; evaluation itself
 * is order-independent (Requirement 14.3).
 */
export function toAlertRule(entity: AlertRuleEntity): AlertRule {
  const conditions = [...(entity.conditions ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      value: condition.value,
    }));

  return {
    id: entity.id,
    name: entity.name,
    enabled: entity.enabled,
    eventKind: entity.eventKind,
    conditions,
    ...(entity.timeWindow ? { timeWindow: entity.timeWindow } : {}),
    ...(entity.zoneId ? { zoneId: entity.zoneId } : {}),
    severity: entity.severity,
    channels: entity.channels ?? [],
    escalationChain: entity.escalationChain ?? [],
    escalationIntervalMin: entity.escalationIntervalMin,
  };
}

/**
 * Configurable rule-engine application service (Requirement 14): persists rules
 * via `upsertRule` and exposes the pure, order-independent `evaluateRules`
 * matcher (design Algorithm 5). Dispatch, escalation and analytics are layered
 * on by later tasks (11.5+).
 */
@Injectable()
export class RulesService {
  constructor(
    @InjectRepository(AlertRuleEntity)
    private readonly rules: Repository<AlertRuleEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Persist a rule and return it (Requirement 14.1). When `dto.id` matches an
   * existing rule it is replaced in place (including a full replacement of its
   * conditions); otherwise a new rule is created. Condition `position` records
   * the submitted ordering.
   */
  async upsertRule(dto: UpsertRuleDto): Promise<AlertRule> {
    const id = await this.dataSource.transaction(async (manager) => {
      const ruleRepo = manager.getRepository(AlertRuleEntity);
      const conditionRepo = manager.getRepository(ConditionEntity);

      let entity: AlertRuleEntity;
      if (dto.id) {
        const existing = await ruleRepo.findOne({ where: { id: dto.id } });
        if (!existing) {
          throw new NotFoundException(`Alert rule "${dto.id}" was not found`);
        }
        // Replace conditions wholesale so removed predicates do not linger.
        await conditionRepo.delete({ ruleId: dto.id });
        entity = existing;
      } else {
        entity = ruleRepo.create();
      }

      entity.name = dto.name;
      entity.enabled = dto.enabled ?? true;
      entity.eventKind = dto.eventKind;
      entity.timeWindow = dto.timeWindow ?? null;
      entity.zoneId = dto.zoneId ?? null;
      entity.severity = dto.severity;
      entity.channels = dto.channels ?? [];
      entity.escalationChain = dto.escalationChain ?? [];
      entity.escalationIntervalMin = dto.escalationIntervalMin;
      entity.conditions = (dto.conditions ?? []).map((condition, index) =>
        conditionRepo.create({
          field: condition.field,
          operator: condition.operator,
          value: condition.value ?? null,
          position: index,
        }),
      );

      const saved = await ruleRepo.save(entity);
      return saved.id;
    });

    return toAlertRule(await this.getRuleEntity(id));
  }

  /** Load all enabled rules and evaluate them against an event (pure matcher). */
  async evaluateEvent(event: DomainEvent): Promise<AlertRule[]> {
    const entities = await this.rules.find({ where: { enabled: true } });
    return evaluateRules(event, entities.map(toAlertRule));
  }

  /**
   * Pure, order-independent rule matcher (Requirement 14.2–14.5 / design
   * Algorithm 5). Exposed on the service for callers that already hold the rule
   * set; the underlying implementation performs no I/O.
   */
  evaluateRules(event: DomainEvent, rules: AlertRule[]): AlertRule[] {
    return evaluateRules(event, rules);
  }

  private async getRuleEntity(id: string): Promise<AlertRuleEntity> {
    const entity = await this.rules.findOne({ where: { id } });
    if (!entity) {
      throw new NotFoundException(`Alert rule "${id}" was not found`);
    }
    return entity;
  }
}
