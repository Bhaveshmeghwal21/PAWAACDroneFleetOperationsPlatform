/**
 * Alert & Notification domain module.
 *
 * Registers the rule/condition/alert TypeORM entities (task 11.2) and wires the
 * configurable rule engine (task 11.3): the `RulesService` (upsert + pure
 * order-independent evaluation) and its REST upsert endpoint. As of task 11.7 it
 * also wires the acknowledgement/escalation engine — `EscalationService` over
 * the Redis-backed escalation timer (`RedisEscalationTimer`) and the
 * multi-channel `DispatchService` (re-used from `NotificationsModule`). As of
 * task 11.9 it also wires the alert history + analytics read surface — the
 * `AnalyticsService` (alerts grouped by zone/hour with conservation, plus a
 * queryable history) behind its `AlertsController` REST endpoints.
 */
import { Module, type Provider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { DispatchService } from '../notifications/dispatch/dispatch.service';
import { AlertEntity } from './entities/alert.entity';
import { AlertRuleEntity } from './entities/alert-rule.entity';
import { ConditionEntity } from './entities/condition.entity';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';
import { AlertsController } from './alerts.controller';
import { AnalyticsService } from './analytics.service';
import { ESCALATION_DISPATCHER, EscalationService } from './escalation.service';
import { ESCALATION_TIMER, RedisEscalationTimer } from './escalation.timer';

/** Bind the escalation timer port to its Redis-backed implementation. */
const escalationTimerProvider: Provider = {
  provide: ESCALATION_TIMER,
  useClass: RedisEscalationTimer,
};

/** Re-use the multi-channel dispatcher as the escalation notification sink. */
const escalationDispatcherProvider: Provider = {
  provide: ESCALATION_DISPATCHER,
  useExisting: DispatchService,
};

@Module({
  imports: [
    TypeOrmModule.forFeature([AlertRuleEntity, ConditionEntity, AlertEntity]),
    NotificationsModule,
  ],
  controllers: [RulesController, AlertsController],
  providers: [
    RulesService,
    AnalyticsService,
    EscalationService,
    escalationTimerProvider,
    escalationDispatcherProvider,
  ],
  exports: [TypeOrmModule, RulesService, EscalationService, AnalyticsService],
})
export class AlertsModule {}
