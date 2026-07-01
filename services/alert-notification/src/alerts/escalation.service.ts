/**
 * Acknowledgement + escalation orchestration (task 11.7, Requirement 16; design
 * "Algorithm 6: Escalation Timer Tick" and the alert state machine).
 *
 * This service is the impure shell around the pure decisions in
 * `escalation.logic.ts`. It loads/persists alerts (Postgres via TypeORM),
 * schedules/cancels/sweeps escalation timers (Redis sorted set, behind the
 * injectable {@link EscalationTimerPort}) and fans escalation notifications out
 * through the {@link AlertDispatcher}. Every status change is funnelled through
 * the legal-transition guard so an illegal transition can never be persisted
 * (Requirement 16.7 / property P38).
 *
 * Responsibilities:
 * - `createAlert`  — persist a new alert OPEN at level 0 and arm its timer (16.1).
 * - `acknowledge`  — OPEN/ESCALATED -> ACKNOWLEDGED, cancel the timer; idempotent
 *                    for already-acknowledged alerts (16.2/16.3 / P36).
 * - `tickEscalations` — escalate every due, open, unacknowledged alert one step,
 *                    dispatch the next contact and reschedule; never escalate
 *                    acknowledged/closed alerts; cap the level at the chain
 *                    length (16.4/16.5/16.6 / P33/P34/P35).
 */
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Alert, AlertStatus, Channel } from '@pawaac/shared-types';
import { AlertEntity } from './entities/alert.entity';
import { AlertRuleEntity } from './entities/alert-rule.entity';
import { decideAcknowledge, decideTick, legalTransition } from './escalation.logic';
import { ESCALATION_TIMER, type EscalationTimerPort } from './escalation.timer';

/** Number of milliseconds in one minute (escalation intervals are in minutes). */
const MS_PER_MINUTE = 60_000;

/** Minimal dispatch surface the escalation engine depends on (Requirement 16.5). */
export interface AlertDispatcher {
  dispatch(alert: Alert, channels: Channel[]): Promise<unknown>;
}

/** DI token for the dispatcher the escalation engine notifies through. */
export const ESCALATION_DISPATCHER = Symbol('ESCALATION_DISPATCHER');

/** Input needed to raise a new alert from a matched rule. */
export interface CreateAlertInput {
  /** Owning rule id. */
  ruleId: string;
  /** Severity carried by the alert (typically the rule's severity). */
  severity: Alert['severity'];
  /** Minutes between escalation steps (`> 0`); used to arm the first timer. */
  escalationIntervalMin: number;
}

/**
 * A record of one escalation step taken during a {@link tickEscalations} sweep
 * (design `EscalationAction[]`). Returned so callers (and tests) can observe
 * exactly which alerts escalated, to whom, and how they were rescheduled.
 */
export interface EscalationAction {
  alertId: string;
  /** Escalation level before this tick. */
  fromLevel: number;
  /** Escalation level after this tick (`fromLevel` when no escalation occurred). */
  toLevel: number;
  /** Contact notified this step, or `null` when the chain was already exhausted. */
  contactId: string | null;
  /** Alert status after this tick. */
  status: AlertStatus;
  /** Next due time (epoch ms), or `null` when escalation is now terminal. */
  nextDueAt: number | null;
  /** Whether a dispatch was attempted for this step. */
  dispatched: boolean;
  /** Whether this step exhausted the chain (terminal ESCALATED). */
  terminal: boolean;
}

@Injectable()
export class EscalationService {
  private readonly logger = new Logger(EscalationService.name);

  constructor(
    @InjectRepository(AlertEntity)
    private readonly alerts: Repository<AlertEntity>,
    @InjectRepository(AlertRuleEntity)
    private readonly rules: Repository<AlertRuleEntity>,
    @Inject(ESCALATION_TIMER)
    private readonly timer: EscalationTimerPort,
    @Inject(ESCALATION_DISPATCHER)
    private readonly dispatcher: AlertDispatcher,
  ) {}

  /**
   * Persist a new alert as OPEN at escalation level 0 and arm its escalation
   * timer one interval into the future (Requirement 16.1).
   */
  async createAlert(input: CreateAlertInput, now: Date = new Date()): Promise<Alert> {
    const entity = this.alerts.create({
      ruleId: input.ruleId,
      severity: input.severity,
      status: 'OPEN',
      escalationLevel: 0,
      createdAt: now,
      acknowledgedAt: null,
      acknowledgedBy: null,
    });
    const saved = await this.alerts.save(entity);

    const intervalMs = this.intervalMsOf(input.escalationIntervalMin);
    await this.timer.schedule(saved.id, now.getTime() + intervalMs);
    return toAlert(saved);
  }

  /**
   * Acknowledge an alert (Requirement 16.2/16.3 / property P36).
   *
   * - OPEN or ESCALATED -> ACKNOWLEDGED, recording the actor/time and cancelling
   *   the escalation timer so it is never escalated again (property P33).
   * - Already ACKNOWLEDGED -> idempotent no-op returning the same state (P36).
   * - CLOSED -> rejected as an illegal transition (property P38).
   */
  async acknowledge(alertId: string, userId: string, now: Date = new Date()): Promise<Alert> {
    const alert = await this.alerts.findOne({ where: { id: alertId } });
    if (!alert) {
      throw new NotFoundException(`Alert "${alertId}" was not found`);
    }

    const decision = decideAcknowledge(alert.status);
    if (decision.action === 'noop') {
      // Idempotent: do not mutate state or re-touch the timer.
      return toAlert(alert);
    }
    if (decision.action === 'illegal') {
      throw new ConflictException(
        `Alert "${alertId}" cannot be acknowledged from status ${alert.status}`,
      );
    }

    this.applyTransition(alert, decision.nextStatus);
    alert.acknowledgedAt = now;
    alert.acknowledgedBy = userId;
    const saved = await this.alerts.save(alert);
    await this.timer.cancel(alertId);
    return toAlert(saved);
  }

  /**
   * Sweep all timers due at `now` and escalate each open, unacknowledged alert
   * one step (design "Algorithm 6"). Acknowledged/closed/terminal alerts are
   * skipped (their stale timers are cancelled). Returns one
   * {@link EscalationAction} per alert that escalated or became terminal.
   */
  async tickEscalations(now: Date | number = new Date()): Promise<EscalationAction[]> {
    const nowMs = typeof now === 'number' ? now : now.getTime();
    const due = await this.timer.dueEntries(nowMs);
    const actions: EscalationAction[] = [];

    for (const entry of due) {
      const action = await this.processDueAlert(entry.alertId, entry.dueAt, nowMs);
      if (action) {
        actions.push(action);
      }
    }
    return actions;
  }

  /** Process a single due timer entry; returns an action when one was taken. */
  private async processDueAlert(
    alertId: string,
    currentDueAt: number,
    nowMs: number,
  ): Promise<EscalationAction | null> {
    const alert = await this.alerts.findOne({ where: { id: alertId } });
    if (!alert) {
      // Orphaned timer (alert deleted): drop it so the wheel stays clean.
      await this.timer.cancel(alertId);
      return null;
    }

    const rule = await this.rules.findOne({ where: { id: alert.ruleId } });
    const chain = rule?.escalationChain ?? [];
    const intervalMs = this.intervalMsOf(rule?.escalationIntervalMin);

    const decision = decideTick({
      status: alert.status,
      escalationLevel: alert.escalationLevel,
      currentDueAt,
      chainLength: chain.length,
      intervalMs,
      now: nowMs,
    });

    if (decision.action === 'skip') {
      if (decision.cancelTimer) {
        await this.timer.cancel(alertId);
      }
      return null;
    }

    const fromLevel = alert.escalationLevel;

    if (decision.action === 'exhausted') {
      // No contact left to notify: make the alert terminally ESCALATED and stop.
      if (alert.status !== decision.nextStatus) {
        this.applyTransition(alert, decision.nextStatus);
        await this.alerts.save(alert);
      }
      await this.timer.cancel(alertId);
      return {
        alertId,
        fromLevel,
        toLevel: fromLevel,
        contactId: null,
        status: alert.status,
        nextDueAt: null,
        dispatched: false,
        terminal: true,
      };
    }

    // decision.action === 'escalate'
    const contactId = chain[decision.contactIndex] ?? null;
    this.applyTransition(alert, decision.nextStatus);
    alert.escalationLevel = decision.nextLevel;
    const saved = await this.alerts.save(alert);

    await this.dispatchEscalation(saved, rule?.channels ?? [], contactId);

    if (decision.terminal || decision.nextDueAt === null) {
      await this.timer.cancel(alertId);
    } else {
      await this.timer.schedule(alertId, decision.nextDueAt);
    }

    return {
      alertId,
      fromLevel,
      toLevel: decision.nextLevel,
      contactId,
      status: saved.status,
      nextDueAt: decision.nextDueAt,
      dispatched: true,
      terminal: decision.terminal,
    };
  }

  /**
   * Notify the next escalation contact. The dispatcher contract treats partial
   * delivery as success and never throws; we still guard defensively so a
   * dispatch hiccup cannot abort the rest of the sweep.
   */
  private async dispatchEscalation(
    alert: AlertEntity,
    channels: Channel[],
    contactId: string | null,
  ): Promise<void> {
    try {
      await this.dispatcher.dispatch(toAlert(alert), channels);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Escalation dispatch for alert ${alert.id} (contact ${contactId ?? 'n/a'}) failed: ${message}`,
      );
    }
  }

  /**
   * Mutate `alert.status` to `to`, refusing any transition the state machine
   * does not permit (Requirement 16.7 / property P38). This is the single choke
   * point through which every status change passes.
   */
  private applyTransition(alert: AlertEntity, to: AlertStatus): void {
    if (!legalTransition(alert.status, to)) {
      throw new ConflictException(
        `Illegal alert status transition ${alert.status} -> ${to} for alert "${alert.id}"`,
      );
    }
    alert.status = to;
  }

  /** Convert a rule's escalation interval (minutes, `> 0`) to milliseconds. */
  private intervalMsOf(escalationIntervalMin: number | undefined): number {
    const minutes = escalationIntervalMin && escalationIntervalMin > 0 ? escalationIntervalMin : 1;
    return minutes * MS_PER_MINUTE;
  }
}

/** Map a persisted {@link AlertEntity} to the shared {@link Alert} domain type. */
export function toAlert(entity: AlertEntity): Alert {
  return {
    id: entity.id,
    ruleId: entity.ruleId,
    severity: entity.severity,
    status: entity.status,
    escalationLevel: entity.escalationLevel,
    createdAt: entity.createdAt.toISOString(),
    ...(entity.acknowledgedAt ? { acknowledgedAt: entity.acknowledgedAt.toISOString() } : {}),
    ...(entity.acknowledgedBy ? { acknowledgedBy: entity.acknowledgedBy } : {}),
  };
}
