import fc from 'fast-check';
import type { AlertStatus } from '@pawaac/shared-types';
import {
  decideAcknowledge,
  decideTick,
  legalTransition,
  type TickInput,
} from './escalation.logic';

/**
 * Generator-driven property tests for the pure acknowledgement / escalation
 * decision logic (task 11.8). These complement the focused example-based unit
 * tests in `escalation.logic.spec.ts` (task 11.7) and exercise the pure
 * functions `legalTransition`, `decideAcknowledge` and `decideTick` directly.
 *
 * Properties validated (design "Correctness Properties", Algorithm 6 —
 * Escalation Timer Tick; Requirement 16):
 *   - P33 Ack cancels escalation      (Requirement 16.4)
 *   - P34 Escalation bound            (Requirement 16.6)
 *   - P35 Escalation monotonicity     (Requirement 16.5)
 *   - P36 Ack idempotency             (Requirement 16.3)
 *   - P38 Status transition legality  (Requirement 16.7)
 *
 * Each property runs >= 100 iterations (Requirement 30.3). Expected behaviour is
 * computed from INDEPENDENT references derived straight from the acceptance
 * criteria (e.g. the P38 transition table below) rather than by re-calling the
 * function under test, so agreement is a genuine cross-check, not a tautology.
 */

const NUM_RUNS = 250;

const ALL_STATUSES: readonly AlertStatus[] = ['OPEN', 'ACKNOWLEDGED', 'ESCALATED', 'CLOSED'];
const NON_OPEN_STATUSES: readonly AlertStatus[] = ['ACKNOWLEDGED', 'ESCALATED', 'CLOSED'];

// --- Generators -----------------------------------------------------------

const statusArb: fc.Arbitrary<AlertStatus> = fc.constantFrom(...ALL_STATUSES);

/** A TickInput for an OPEN, currently-due alert with a non-trivial chain. */
const dueOpenTickArb: fc.Arbitrary<TickInput> = fc
  .record({
    chainLength: fc.integer({ min: 1, max: 12 }),
    levelFrac: fc.integer({ min: 0, max: 11 }),
    currentDueAt: fc.integer({ min: 0, max: 5_000_000 }),
    intervalMs: fc.integer({ min: 1, max: 3_600_000 }),
    overdueBy: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .map(({ chainLength, levelFrac, currentDueAt, intervalMs, overdueBy }) => ({
    status: 'OPEN' as AlertStatus,
    // Keep level within `0..chainLength` (the documented valid range).
    escalationLevel: levelFrac % (chainLength + 1),
    currentDueAt,
    chainLength,
    intervalMs,
    // now >= currentDueAt so the alert is due this tick.
    now: currentDueAt + overdueBy,
  }));

/** An arbitrary TickInput across every status and the full level range. */
const anyTickArb: fc.Arbitrary<TickInput> = fc
  .record({
    status: statusArb,
    chainLength: fc.integer({ min: 0, max: 12 }),
    escalationLevel: fc.integer({ min: 0, max: 12 }),
    currentDueAt: fc.integer({ min: 0, max: 5_000_000 }),
    intervalMs: fc.integer({ min: 1, max: 3_600_000 }),
    now: fc.integer({ min: 0, max: 6_000_000 }),
  })
  .map((r) => ({ ...r }));

// --- P38 independent reference --------------------------------------------

/**
 * Independent transition-legality table built directly from Requirement 16.7:
 * OPEN -> ACKNOWLEDGED | ESCALATED | CLOSED; ESCALATED -> ACKNOWLEDGED | CLOSED;
 * ACKNOWLEDGED -> CLOSED; CLOSED terminal; plus every self-transition.
 */
function refLegalTransition(from: AlertStatus, to: AlertStatus): boolean {
  if (from === to) {
    return true;
  }
  const table: Record<AlertStatus, readonly AlertStatus[]> = {
    OPEN: ['ACKNOWLEDGED', 'ESCALATED', 'CLOSED'],
    ESCALATED: ['ACKNOWLEDGED', 'CLOSED'],
    ACKNOWLEDGED: ['CLOSED'],
    CLOSED: [],
  };
  return table[from].includes(to);
}

// --- Properties -----------------------------------------------------------

describe('escalation property tests', () => {
  /**
   * P33 — Ack cancels escalation. A non-OPEN (acknowledged / closed / terminally
   * escalated) alert is NEVER escalated by a tick, regardless of due time, level
   * or chain length. And once `decideAcknowledge` acknowledges an alert, ticking
   * the resulting ACKNOWLEDGED state yields no escalation.
   * **Validates: Requirements 16.4**
   */
  it('P33: a non-OPEN alert is never escalated by decideTick', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NON_OPEN_STATUSES),
        anyTickArb,
        (status, base) => {
          const decision = decideTick({ ...base, status });
          expect(decision.action).toBe('skip');
          // The stale timer is dropped because the alert can never escalate again.
          if (decision.action === 'skip') {
            expect(decision.cancelTimer).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('P33: after decideAcknowledge succeeds, ticking the alert never escalates', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<AlertStatus>('OPEN', 'ESCALATED'),
        anyTickArb,
        (startStatus, base) => {
          const ack = decideAcknowledge(startStatus);
          // OPEN/ESCALATED are acknowledgeable.
          expect(ack.action).toBe('acknowledge');
          if (ack.action !== 'acknowledge') {
            return;
          }
          // Tick the post-ack state at any time: no escalation, timer cancelled.
          const decision = decideTick({ ...base, status: ack.nextStatus });
          expect(decision.action).toBe('skip');
          if (decision.action === 'skip') {
            expect(decision.cancelTimer).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P34 — Escalation bound. Across any sequence of repeated escalating ticks the
   * level never exceeds `chainLength`; it terminates at exactly `chainLength`.
   * **Validates: Requirements 16.6**
   */
  it('P34: escalationLevel never exceeds chainLength across a full tick sequence', () => {
    fc.assert(
      fc.property(dueOpenTickArb, (start) => {
        let level = start.escalationLevel;
        let dueAt = start.currentDueAt;
        let status: AlertStatus = 'OPEN';

        // Walk ticks until terminal/exhausted; bound iterations defensively.
        for (let i = 0; i <= start.chainLength + 2; i += 1) {
          const decision = decideTick({
            status,
            escalationLevel: level,
            currentDueAt: dueAt,
            chainLength: start.chainLength,
            intervalMs: start.intervalMs,
            now: dueAt, // always due
          });

          if (decision.action === 'escalate') {
            expect(decision.nextLevel).toBeLessThanOrEqual(start.chainLength);
            level = decision.nextLevel;
            status = decision.nextStatus;
            if (decision.terminal || decision.nextDueAt === null) {
              break;
            }
            dueAt = decision.nextDueAt;
          } else if (decision.action === 'exhausted') {
            // Reached the cap with no further contact.
            break;
          } else {
            break;
          }
        }
        // Final invariant: never past the chain length.
        expect(level).toBeLessThanOrEqual(start.chainLength);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P35 — Escalation monotonicity. Each escalating tick increases the level by
   * exactly one and reschedules `nextDueAt` strictly later than `currentDueAt`
   * (until the terminal step, where there is no reschedule).
   * **Validates: Requirements 16.5**
   */
  it('P35: each escalating tick raises level by exactly 1 and reschedules strictly later', () => {
    fc.assert(
      fc.property(dueOpenTickArb, (input) => {
        const decision = decideTick(input);

        // A due OPEN alert with a remaining contact must escalate; otherwise it
        // is at/over the cap and is reported as exhausted (no escalate to check).
        if (input.escalationLevel < input.chainLength) {
          expect(decision.action).toBe('escalate');
          if (decision.action !== 'escalate') {
            return;
          }
          // Exactly one level increment, dispatching the current contact index.
          expect(decision.nextLevel).toBe(input.escalationLevel + 1);
          expect(decision.contactIndex).toBe(input.escalationLevel);

          if (decision.terminal) {
            // Terminal step: ESCALATED, no further reschedule.
            expect(decision.nextStatus).toBe('ESCALATED');
            expect(decision.nextDueAt).toBeNull();
          } else {
            // Non-terminal: stays OPEN and is rescheduled strictly into the future.
            expect(decision.nextStatus).toBe('OPEN');
            expect(decision.nextDueAt).not.toBeNull();
            expect(decision.nextDueAt as number).toBeGreaterThan(input.currentDueAt);
            expect(decision.nextDueAt as number).toBe(input.currentDueAt + input.intervalMs);
          }
        } else {
          expect(decision.action).toBe('exhausted');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P36 — Ack idempotency. Acknowledging an already-ACKNOWLEDGED alert is a
   * no-op; for OPEN/ESCALATED it acknowledges; for CLOSED it is illegal. The
   * decision is also stable under repetition (idempotent).
   * **Validates: Requirements 16.3**
   */
  it('P36: decideAcknowledge on ACKNOWLEDGED is a no-op and is repetition-stable', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const first = decideAcknowledge(status);

        if (status === 'ACKNOWLEDGED') {
          expect(first).toEqual({ action: 'noop' });
        } else if (status === 'CLOSED') {
          expect(first).toEqual({ action: 'illegal' });
        } else {
          expect(first).toEqual({ action: 'acknowledge', nextStatus: 'ACKNOWLEDGED' });
        }

        // Idempotency: acknowledging the resulting state again is a stable no-op
        // whenever the first call moved the alert to ACKNOWLEDGED.
        if (first.action === 'acknowledge' || first.action === 'noop') {
          expect(decideAcknowledge('ACKNOWLEDGED')).toEqual({ action: 'noop' });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P38 — Status transition legality. `legalTransition` agrees with the
   * independent table for every (from, to) pair: only OPEN->(ACK|ESCALATED|
   * CLOSED), ESCALATED->(ACK|CLOSED), ACKNOWLEDGED->CLOSED and self-transitions.
   * **Validates: Requirements 16.7**
   */
  it('P38: legalTransition matches the independent transition table for all pairs', () => {
    fc.assert(
      fc.property(statusArb, statusArb, (from, to) => {
        expect(legalTransition(from, to)).toBe(refLegalTransition(from, to));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P38: every self-transition is legal and CLOSED is terminal', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        expect(legalTransition(status, status)).toBe(true);
        // Nothing escapes CLOSED except staying CLOSED.
        for (const to of ALL_STATUSES) {
          expect(legalTransition('CLOSED', to)).toBe(to === 'CLOSED');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
