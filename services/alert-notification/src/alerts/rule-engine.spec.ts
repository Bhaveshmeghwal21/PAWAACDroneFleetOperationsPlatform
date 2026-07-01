import type { AlertRule, Condition, DomainEvent } from '@pawaac/shared-types';
import {
  evalCondition,
  evaluateRules,
  inWindow,
  minutesOfDay,
  ruleMatches,
} from './rule-engine';

/**
 * Focused unit tests for the pure rule engine (task 11.3). Comprehensive,
 * generator-driven property tests for P30 (match soundness), P31 (order
 * independence) and P32 (wrap-around) are task 11.4.
 */

/** Build an anomaly domain event, allowing the payload to be extended for tests. */
function anomalyEvent(overrides: {
  ts?: string;
  zoneId?: string;
  payload?: Record<string, unknown>;
}): DomainEvent {
  const event = {
    kind: 'anomaly' as const,
    ts: overrides.ts ?? '2024-01-01T12:00:00.000Z',
    droneId: 'drone-1',
    ...(overrides.zoneId !== undefined ? { zoneId: overrides.zoneId } : {}),
    payload: {
      kind: 'ALTITUDE_DROP',
      droneId: 'drone-1',
      ts: overrides.ts ?? '2024-01-01T12:00:00.000Z',
      ...(overrides.payload ?? {}),
    },
  };
  return event as unknown as DomainEvent;
}

function rule(overrides: Partial<AlertRule>): AlertRule {
  return {
    id: overrides.id ?? 'rule-1',
    name: overrides.name ?? 'rule',
    enabled: overrides.enabled ?? true,
    eventKind: overrides.eventKind ?? 'anomaly',
    conditions: overrides.conditions ?? [],
    ...(overrides.timeWindow ? { timeWindow: overrides.timeWindow } : {}),
    ...(overrides.zoneId ? { zoneId: overrides.zoneId } : {}),
    severity: overrides.severity ?? 'warning',
    channels: overrides.channels ?? [],
    escalationChain: overrides.escalationChain ?? [],
    escalationIntervalMin: overrides.escalationIntervalMin ?? 5,
  };
}

describe('inWindow', () => {
  it('treats a non-wrapping window as half-open [start, end)', () => {
    const window = { startMin: 540, endMin: 1020 }; // 09:00–17:00
    expect(inWindow(540, window)).toBe(true); // inclusive start
    expect(inWindow(700, window)).toBe(true);
    expect(inWindow(1020, window)).toBe(false); // exclusive end
    expect(inWindow(539, window)).toBe(false);
    expect(inWindow(1021, window)).toBe(false);
  });

  it('includes after-start OR before-end times for a wrap-around window (P32)', () => {
    const window = { startMin: 1320, endMin: 360 }; // 22:00–06:00
    expect(inWindow(1320, window)).toBe(true); // 22:00 (start)
    expect(inWindow(1380, window)).toBe(true); // 23:00
    expect(inWindow(0, window)).toBe(true); // 00:00
    expect(inWindow(359, window)).toBe(true); // 05:59
    expect(inWindow(360, window)).toBe(false); // 06:00 (exclusive end)
    expect(inWindow(720, window)).toBe(false); // 12:00 outside
    expect(inWindow(1319, window)).toBe(false); // 21:59 outside
  });

  it('treats an equal-bound window as empty', () => {
    const window = { startMin: 600, endMin: 600 };
    expect(inWindow(600, window)).toBe(false);
    expect(inWindow(0, window)).toBe(false);
  });
});

describe('minutesOfDay', () => {
  it('computes minutes-of-day in UTC', () => {
    expect(minutesOfDay('2024-01-01T00:00:00.000Z')).toBe(0);
    expect(minutesOfDay('2024-01-01T01:30:00.000Z')).toBe(90);
    expect(minutesOfDay('2024-06-15T23:59:00.000Z')).toBe(1439);
  });

  it('throws on an unparseable timestamp', () => {
    expect(() => minutesOfDay('not-a-date')).toThrow();
  });
});

describe('evalCondition', () => {
  it('resolves dot-paths and supports eq/neq', () => {
    const event = anomalyEvent({ payload: { kind: 'ALTITUDE_DROP' } });
    expect(evalCondition({ field: 'payload.kind', operator: 'eq', value: 'ALTITUDE_DROP' }, event)).toBe(
      true,
    );
    expect(evalCondition({ field: 'payload.kind', operator: 'neq', value: 'EKF2_DEGRADED' }, event)).toBe(
      true,
    );
    expect(evalCondition({ field: 'kind', operator: 'eq', value: 'anomaly' }, event)).toBe(true);
  });

  it('returns false for missing fields rather than throwing', () => {
    const event = anomalyEvent({});
    expect(evalCondition({ field: 'payload.missing.deep', operator: 'eq', value: 1 }, event)).toBe(
      false,
    );
  });

  it('compares numbers with gt/gte/lt/lte and rejects non-numeric operands', () => {
    const event = anomalyEvent({ payload: { descentRate: 12 } });
    expect(evalCondition({ field: 'payload.descentRate', operator: 'gt', value: 10 }, event)).toBe(
      true,
    );
    expect(evalCondition({ field: 'payload.descentRate', operator: 'gte', value: 12 }, event)).toBe(
      true,
    );
    expect(evalCondition({ field: 'payload.descentRate', operator: 'lt', value: 12 }, event)).toBe(
      false,
    );
    expect(evalCondition({ field: 'payload.descentRate', operator: 'lte', value: 12 }, event)).toBe(
      true,
    );
    // Non-numeric actual against numeric operand -> false (no coercion).
    expect(evalCondition({ field: 'payload.kind', operator: 'gt', value: 10 }, event)).toBe(false);
  });

  it('supports in/nin/contains', () => {
    const event = anomalyEvent({ payload: { kind: 'ALTITUDE_DROP', tags: ['a', 'b'] } });
    expect(
      evalCondition(
        { field: 'payload.kind', operator: 'in', value: ['ALTITUDE_DROP', 'EKF2_DEGRADED'] },
        event,
      ),
    ).toBe(true);
    expect(
      evalCondition({ field: 'payload.kind', operator: 'nin', value: ['EKF2_DEGRADED'] }, event),
    ).toBe(true);
    expect(evalCondition({ field: 'payload.tags', operator: 'contains', value: 'a' }, event)).toBe(
      true,
    );
    expect(evalCondition({ field: 'payload.kind', operator: 'contains', value: 'DROP' }, event)).toBe(
      true,
    );
  });
});

describe('ruleMatches / evaluateRules', () => {
  it('does not match a disabled rule', () => {
    const event = anomalyEvent({});
    expect(ruleMatches(rule({ enabled: false }), event)).toBe(false);
  });

  it('requires the event kind to match', () => {
    const event = anomalyEvent({});
    expect(ruleMatches(rule({ eventKind: 'maintenance' }), event)).toBe(false);
    expect(ruleMatches(rule({ eventKind: 'anomaly' }), event)).toBe(true);
  });

  it('matches zone only when the rule scopes one', () => {
    const zoned = anomalyEvent({ zoneId: 'zone-A' });
    expect(ruleMatches(rule({ zoneId: 'zone-A' }), zoned)).toBe(true);
    expect(ruleMatches(rule({ zoneId: 'zone-B' }), zoned)).toBe(false);
    // No zone scope on the rule -> zone is ignored.
    expect(ruleMatches(rule({}), zoned)).toBe(true);
  });

  it('honours a wrap-around time window (P32)', () => {
    const nightWindow = { startMin: 1320, endMin: 360 }; // 22:00–06:00
    const lateNight = anomalyEvent({ ts: '2024-01-01T23:30:00.000Z' });
    const midday = anomalyEvent({ ts: '2024-01-01T12:00:00.000Z' });
    expect(ruleMatches(rule({ timeWindow: nightWindow }), lateNight)).toBe(true);
    expect(ruleMatches(rule({ timeWindow: nightWindow }), midday)).toBe(false);
  });

  it('requires ALL conditions to hold (AND semantics)', () => {
    const event = anomalyEvent({ payload: { kind: 'ALTITUDE_DROP', descentRate: 15 } });
    const conditions: Condition[] = [
      { field: 'payload.kind', operator: 'eq', value: 'ALTITUDE_DROP' },
      { field: 'payload.descentRate', operator: 'gt', value: 10 },
    ];
    expect(ruleMatches(rule({ conditions }), event)).toBe(true);

    const failingConditions: Condition[] = [
      { field: 'payload.kind', operator: 'eq', value: 'ALTITUDE_DROP' },
      { field: 'payload.descentRate', operator: 'gt', value: 100 }, // fails
    ];
    expect(ruleMatches(rule({ conditions: failingConditions }), event)).toBe(false);
  });

  it('returns the same matched set regardless of rule order (P31)', () => {
    const event = anomalyEvent({ zoneId: 'zone-A', payload: { kind: 'ALTITUDE_DROP' } });
    const matching = rule({
      id: 'match',
      conditions: [{ field: 'payload.kind', operator: 'eq', value: 'ALTITUDE_DROP' }],
    });
    const nonMatching = rule({ id: 'nomatch', eventKind: 'maintenance' });
    const zoneMiss = rule({ id: 'zonemiss', zoneId: 'zone-B' });

    const forward = evaluateRules(event, [matching, nonMatching, zoneMiss]).map((r) => r.id);
    const reversed = evaluateRules(event, [zoneMiss, nonMatching, matching]).map((r) => r.id);
    expect(new Set(forward)).toEqual(new Set(reversed));
    expect(new Set(forward)).toEqual(new Set(['match']));
  });

  it('is pure: does not mutate the event or rules', () => {
    const event = anomalyEvent({ payload: { kind: 'ALTITUDE_DROP' } });
    const eventSnapshot = JSON.stringify(event);
    const rules = [rule({ conditions: [{ field: 'payload.kind', operator: 'eq', value: 'ALTITUDE_DROP' }] })];
    const rulesSnapshot = JSON.stringify(rules);

    evaluateRules(event, rules);

    expect(JSON.stringify(event)).toBe(eventSnapshot);
    expect(JSON.stringify(rules)).toBe(rulesSnapshot);
  });
});
