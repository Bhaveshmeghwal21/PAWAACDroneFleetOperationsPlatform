/**
 * Pure decision logic for the alert acknowledgement / escalation workflow
 * (task 11.7, Requirement 16; design "Alert state machine" + "Algorithm 6:
 * Escalation Timer Tick").
 *
 * Everything in this module is a side-effect-free, deterministic function of its
 * arguments — no Redis, no database, no clock, no dispatch. The state-machine
 * legality predicate (`legalTransition`, Requirement 16.7 / property P38), the
 * acknowledgement decision (`decideAcknowledge`, Requirement 16.2/16.3 /
 * property P36) and the per-alert "what to do on this tick" decision
 * (`decideTick`, Requirement 16.4/16.5/16.6 / properties P33/P34/P35) all live
 * here so they can be unit- and property-tested in isolation, while the impure
 * orchestration (loading alerts, ZADD/ZREM scheduling, dispatching) lives in
 * `escalation.service.ts`.
 */
import type { AlertStatus } from '@pawaac/shared-types';

/**
 * The legal alert status transitions (Requirement 16.7 / property P38):
 *
 *   OPEN        -> ACKNOWLEDGED | ESCALATED | CLOSED
 *   ESCALATED   -> ACKNOWLEDGED | CLOSED
 *   ACKNOWLEDGED-> CLOSED
 *   CLOSED      -> (terminal)
 *
 * plus a self-transition from every state (an alert may "remain in its current
 * state"). `CLOSED` is terminal; `ESCALATED` is terminal w.r.t. escalation but
 * may still be acknowledged or closed. The allowed *target* set below excludes
 * self-transitions, which {@link legalTransition} permits separately.
 */
const ALLOWED_TARGETS: Readonly<Record<AlertStatus, readonly AlertStatus[]>> = {
  OPEN: ['ACKNOWLEDGED', 'ESCALATED', 'CLOSED'],
  ESCALATED: ['ACKNOWLEDGED', 'CLOSED'],
  ACKNOWLEDGED: ['CLOSED'],
  CLOSED: [],
};

/**
 * True iff moving an alert from `from` to `to` is a legal status transition
 * (Requirement 16.7 / property P38). Self-transitions are always legal so the
 * predicate is reflexive; every other edge must appear in {@link ALLOWED_TARGETS}.
 */
export function legalTransition(from: AlertStatus, to: AlertStatus): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED_TARGETS[from].includes(to);
}

/** Minimal mutable alert state the escalation decisions reason over. */
export interface EscalationState {
  status: AlertStatus;
  /** Current escalation level in `0..escalationChain.length`. */
  escalationLevel: number;
}

/** Outcome of {@link decideAcknowledge}. */
export type AckDecision =
  | {
      /** A legal OPEN/ESCALATED -> ACKNOWLEDGED transition should be applied. */
      readonly action: 'acknowledge';
      readonly nextStatus: 'ACKNOWLEDGED';
    }
  | {
      /** Already acknowledged: idempotent no-op returning the same state (P36). */
      readonly action: 'noop';
    }
  | {
      /** Acknowledging from this state (e.g. CLOSED) is not a legal transition. */
      readonly action: 'illegal';
    };

/**
 * Decide how an `acknowledge(alertId, userId)` call should be handled given the
 * alert's current status (Requirement 16.2/16.3 / property P36). Pure:
 *
 * - OPEN or ESCALATED -> `acknowledge` (apply the transition, cancel the timer).
 * - ACKNOWLEDGED       -> `noop` (idempotent; return the same state unchanged).
 * - CLOSED             -> `illegal` (CLOSED is terminal; cannot be acknowledged).
 */
export function decideAcknowledge(status: AlertStatus): AckDecision {
  if (status === 'ACKNOWLEDGED') {
    return { action: 'noop' };
  }
  if (legalTransition(status, 'ACKNOWLEDGED')) {
    return { action: 'acknowledge', nextStatus: 'ACKNOWLEDGED' };
  }
  return { action: 'illegal' };
}

/** Inputs to a single escalation-tick decision for one alert. */
export interface TickInput {
  /** Current alert status. */
  readonly status: AlertStatus;
  /** Current escalation level (`0..chainLength`). */
  readonly escalationLevel: number;
  /** Absolute time (epoch ms) this alert's escalation is currently due. */
  readonly currentDueAt: number;
  /** Number of contacts in the owning rule's escalation chain (`>= 0`). */
  readonly chainLength: number;
  /** Milliseconds between escalation steps (`> 0`). */
  readonly intervalMs: number;
  /** "Now" the tick is evaluated against (epoch ms). */
  readonly now: number;
}

/** Outcome of {@link decideTick} for a single due alert. */
export type TickDecision =
  | {
      /**
       * Nothing to do: the alert is acknowledged/closed/terminally-escalated, or
       * not yet due. `cancelTimer` is true when the timer entry should be removed
       * because the alert can never escalate again (acknowledged/closed/ESCALATED).
       */
      readonly action: 'skip';
      readonly cancelTimer: boolean;
    }
  | {
      /**
       * Escalate one step (Requirement 16.5): dispatch to `contactId`
       * (`escalationChain[escalationLevel]`) and advance to `nextLevel`. When
       * `terminal` is true the chain is now exhausted, status becomes ESCALATED
       * and the timer is cancelled; otherwise status stays OPEN and the timer is
       * rescheduled to `nextDueAt` (strictly later than `currentDueAt`).
       */
      readonly action: 'escalate';
      readonly contactIndex: number;
      readonly nextLevel: number;
      readonly nextStatus: 'OPEN' | 'ESCALATED';
      readonly nextDueAt: number | null;
      readonly terminal: boolean;
    }
  | {
      /**
       * The escalation chain is already fully walked (`escalationLevel >=
       * chainLength`, including the empty-chain case): there is no further contact
       * to notify. Mark the alert terminally ESCALATED and cancel the timer.
       */
      readonly action: 'exhausted';
      readonly nextStatus: 'ESCALATED';
    };

/**
 * Decide what to do for a single alert on an escalation tick (design
 * "Algorithm 6: Escalation Timer Tick"). Pure and deterministic.
 *
 * Only OPEN alerts ever escalate — acknowledged, closed and (terminally)
 * escalated alerts are skipped and their timers cancelled (Requirement 16.4 /
 * property P33). For a due OPEN alert with a contact remaining, the level is
 * incremented by exactly one (property P35) and capped at the chain length
 * (Requirement 16.6 / property P34); the reschedule is `currentDueAt +
 * intervalMs`, strictly later than the previous due time since `intervalMs > 0`
 * (property P35).
 */
export function decideTick(input: TickInput): TickDecision {
  const { status, escalationLevel, currentDueAt, chainLength, intervalMs, now } = input;

  // Acknowledged, closed or already-terminal alerts never escalate; drop any
  // lingering timer entry (Requirement 16.4 / property P33).
  if (status !== 'OPEN') {
    return { action: 'skip', cancelTimer: true };
  }

  // Not yet due — leave the timer in place for a later tick.
  if (now < currentDueAt) {
    return { action: 'skip', cancelTimer: false };
  }

  // Chain already exhausted (or empty): nothing left to notify. Become terminal
  // ESCALATED and stop rescheduling (Requirement 16.6 / property P34).
  if (escalationLevel >= chainLength) {
    return { action: 'exhausted', nextStatus: 'ESCALATED' };
  }

  const nextLevel = escalationLevel + 1;
  const terminal = nextLevel >= chainLength;
  return {
    action: 'escalate',
    contactIndex: escalationLevel,
    nextLevel,
    nextStatus: terminal ? 'ESCALATED' : 'OPEN',
    nextDueAt: terminal ? null : currentDueAt + intervalMs,
    terminal,
  };
}
