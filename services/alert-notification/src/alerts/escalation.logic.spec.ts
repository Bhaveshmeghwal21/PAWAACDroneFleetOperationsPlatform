import type { AlertStatus } from '@pawaac/shared-types';
import {
  decideAcknowledge,
  decideTick,
  legalTransition,
  type TickInput,
} from './escalation.logic';

/**
 * Focused unit tests for the pure acknowledgement/escalation decision logic
 * (task 11.7). The >=100-iteration generator-driven property tests for P33/P34/
 * P35/P36/P38 are task 11.8; these pin the deterministic building blocks —
 * transition legality, ack idempotency, the level cap and the monotonic
 * reschedule — directly.
 */

const ALL_STATUSES: AlertStatus[] = ['OPEN', 'ACKNOWLEDGED', 'ESCALATED', 'CLOSED'];

describe('legalTransition (Req 16.7 / P38)', () => {
  it('permits every self-transition (an alert may remain in its state)', () => {
    for (const status of ALL_STATUSES) {
      expect(legalTransition(status, status)).toBe(true);
    }
  });

  it('permits exactly OPEN -> ACKNOWLEDGED | ESCALATED | CLOSED', () => {
    expect(legalTransition('OPEN', 'ACKNOWLEDGED')).toBe(true);
    expect(legalTransition('OPEN', 'ESCALATED')).toBe(true);
    expect(legalTransition('OPEN', 'CLOSED')).toBe(true);
  });

  it('permits ESCALATED -> ACKNOWLEDGED | CLOSED but not back to OPEN', () => {
    expect(legalTransition('ESCALATED', 'ACKNOWLEDGED')).toBe(true);
    expect(legalTransition('ESCALATED', 'CLOSED')).toBe(true);
    expect(legalTransition('ESCALATED', 'OPEN')).toBe(false);
  });

  it('permits ACKNOWLEDGED -> CLOSED only (no re-open, no re-escalate)', () => {
    expect(legalTransition('ACKNOWLEDGED', 'CLOSED')).toBe(true);
    expect(legalTransition('ACKNOWLEDGED', 'OPEN')).toBe(false);
    expect(legalTransition('ACKNOWLEDGED', 'ESCALATED')).toBe(false);
  });

  it('treats CLOSED as terminal (no outgoing transition except itself)', () => {
    for (const to of ALL_STATUSES) {
      expect(legalTransition('CLOSED', to)).toBe(to === 'CLOSED');
    }
  });
});

describe('decideAcknowledge (Req 16.2/16.3 / P36)', () => {
  it('acknowledges an OPEN alert', () => {
    expect(decideAcknowledge('OPEN')).toEqual({
      action: 'acknowledge',
      nextStatus: 'ACKNOWLEDGED',
    });
  });

  it('acknowledges an ESCALATED alert', () => {
    expect(decideAcknowledge('ESCALATED')).toEqual({
      action: 'acknowledge',
      nextStatus: 'ACKNOWLEDGED',
    });
  });

  it('is an idempotent no-op for an already-acknowledged alert (P36)', () => {
    expect(decideAcknowledge('ACKNOWLEDGED')).toEqual({ action: 'noop' });
  });

  it('rejects acknowledging a CLOSED alert as illegal', () => {
    expect(decideAcknowledge('CLOSED')).toEqual({ action: 'illegal' });
  });
});

/** Build a TickInput with sensible defaults overridden per test. */
function tick(overrides: Partial<TickInput> = {}): TickInput {
  return {
    status: 'OPEN',
    escalationLevel: 0,
    currentDueAt: 1_000,
    chainLength: 3,
    intervalMs: 60_000,
    now: 5_000,
    ...overrides,
  };
}

describe('decideTick — skip rules (Req 16.4 / P33)', () => {
  it.each<AlertStatus>(['ACKNOWLEDGED', 'CLOSED', 'ESCALATED'])(
    'never escalates a %s alert and cancels its stale timer',
    (status) => {
      expect(decideTick(tick({ status }))).toEqual({ action: 'skip', cancelTimer: true });
    },
  );

  it('leaves the timer in place for an OPEN alert that is not yet due', () => {
    expect(decideTick(tick({ currentDueAt: 9_000, now: 5_000 }))).toEqual({
      action: 'skip',
      cancelTimer: false,
    });
  });
});

describe('decideTick — escalation step (Req 16.5 / P35)', () => {
  it('increments the level by exactly one and dispatches the current contact', () => {
    const decision = decideTick(tick({ escalationLevel: 0, chainLength: 3 }));
    expect(decision).toMatchObject({
      action: 'escalate',
      contactIndex: 0,
      nextLevel: 1,
      nextStatus: 'OPEN',
      terminal: false,
    });
  });

  it('reschedules strictly further into the future (monotonicity, P35)', () => {
    const input = tick({ currentDueAt: 1_000, intervalMs: 60_000 });
    const decision = decideTick(input);
    if (decision.action !== 'escalate') {
      throw new Error('expected an escalate decision');
    }
    expect(decision.nextDueAt).toBe(61_000);
    expect(decision.nextDueAt!).toBeGreaterThan(input.currentDueAt);
  });

  it('always advances the level for successive ticks up the chain', () => {
    let level = 0;
    const chainLength = 4;
    for (let step = 0; step < chainLength; step += 1) {
      const decision = decideTick(tick({ escalationLevel: level, chainLength }));
      if (decision.action !== 'escalate') {
        throw new Error(`expected escalate at level ${level}`);
      }
      expect(decision.nextLevel).toBe(level + 1);
      expect(decision.contactIndex).toBe(level);
      level = decision.nextLevel;
    }
    expect(level).toBe(chainLength);
  });
});

describe('decideTick — level cap & terminal (Req 16.6 / P34)', () => {
  it('marks the final chain step terminal (status ESCALATED, no reschedule)', () => {
    const decision = decideTick(tick({ escalationLevel: 2, chainLength: 3 }));
    expect(decision).toEqual({
      action: 'escalate',
      contactIndex: 2,
      nextLevel: 3,
      nextStatus: 'ESCALATED',
      nextDueAt: null,
      terminal: true,
    });
  });

  it('never produces a level beyond the chain length', () => {
    for (let chainLength = 0; chainLength <= 5; chainLength += 1) {
      for (let level = 0; level <= chainLength; level += 1) {
        const decision = decideTick(tick({ escalationLevel: level, chainLength }));
        if (decision.action === 'escalate') {
          expect(decision.nextLevel).toBeLessThanOrEqual(chainLength);
        }
      }
    }
  });

  it('reports an exhausted chain (level == length) as terminal ESCALATED', () => {
    expect(decideTick(tick({ escalationLevel: 3, chainLength: 3 }))).toEqual({
      action: 'exhausted',
      nextStatus: 'ESCALATED',
    });
  });

  it('treats an empty escalation chain as immediately exhausted', () => {
    expect(decideTick(tick({ escalationLevel: 0, chainLength: 0 }))).toEqual({
      action: 'exhausted',
      nextStatus: 'ESCALATED',
    });
  });
});
