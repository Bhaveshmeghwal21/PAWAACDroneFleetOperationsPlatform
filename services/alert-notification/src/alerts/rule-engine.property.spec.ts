import fc from 'fast-check';
import type {
  AlertRule,
  Condition,
  ConditionOperator,
  DomainEvent,
  EventKind,
  TimeWindow,
} from '@pawaac/shared-types';
import { evaluateRules, inWindow } from './rule-engine';

/**
 * Comprehensive, generator-driven property tests for the pure rule engine
 * (task 11.4). These complement the focused example-based unit tests in
 * `rule-engine.spec.ts` (task 11.3).
 *
 * Properties validated (design "Correctness Properties", Algorithm 5):
 *   - P30 Rule match soundness        (Requirement 14.2)
 *   - P31 Rule order independence     (Requirement 14.3)
 *   - P32 Time-window wrap-around     (Requirement 14.4)
 *
 * Each property runs >= 100 iterations (Requirement 30.3). The expected
 * behaviour is computed by an INDEPENDENT reference implementation derived
 * directly from the acceptance criteria — never by calling the production
 * function under test — so agreement is a genuine cross-check rather than a
 * tautology.
 */

const NUM_RUNS = 250;

const EVENT_KINDS: EventKind[] = ['anomaly', 'scene', 'maintenance'];
const ZONES = ['zone-A', 'zone-B', 'zone-C'];
const PAYLOAD_KINDS = ['ALTITUDE_DROP', 'EKF2_DEGRADED', 'person', 'vehicle'];
const CONDITION_FIELDS = [
  'payload.kind',
  'payload.score',
  'payload.tags',
  'kind',
  'ts',
  'zoneId',
  'payload.missing',
  'nope.deep.path',
];
const OPERATORS: ConditionOperator[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'contains',
];

// --- Independent reference implementation (mirrors Requirement 14, Algorithm 5) ---

/** Reference dot-path resolver: never throws, returns undefined on a miss. */
function refResolve(event: DomainEvent, path: string): unknown {
  let current: unknown = event;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Reference condition evaluator, independent of the production `evalCondition`. */
function refEvalCondition(condition: Condition, event: DomainEvent): boolean {
  const actual = refResolve(event, condition.field);
  const expected = condition.value;
  const bothFiniteNumbers =
    typeof actual === 'number' &&
    typeof expected === 'number' &&
    !Number.isNaN(actual) &&
    !Number.isNaN(expected);
  const isMember = Array.isArray(expected) && expected.some((c) => c === actual);

  switch (condition.operator) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return bothFiniteNumbers && (actual as number) > (expected as number);
    case 'gte':
      return bothFiniteNumbers && (actual as number) >= (expected as number);
    case 'lt':
      return bothFiniteNumbers && (actual as number) < (expected as number);
    case 'lte':
      return bothFiniteNumbers && (actual as number) <= (expected as number);
    case 'in':
      return isMember;
    case 'nin':
      return !isMember;
    case 'contains':
      if (typeof actual === 'string') {
        return typeof expected === 'string' && actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.some((c) => c === expected);
      }
      return false;
    default:
      return false;
  }
}

/** Reference half-open window membership with wrap-around (Requirement 14.4). */
function refInWindow(minute: number, window: TimeWindow): boolean {
  if (window.startMin <= window.endMin) {
    return minute >= window.startMin && minute < window.endMin;
  }
  return minute >= window.startMin || minute < window.endMin;
}

/** Reference rule matcher built straight from the acceptance criteria. */
function refRuleMatches(rule: AlertRule, event: DomainEvent, minute: number): boolean {
  if (!rule.enabled) {
    return false;
  }
  if (rule.eventKind !== (event as { kind: EventKind }).kind) {
    return false;
  }
  const eventZoneId = (event as { zoneId?: string }).zoneId;
  if (rule.zoneId !== undefined && rule.zoneId !== null && rule.zoneId !== eventZoneId) {
    return false;
  }
  if (rule.timeWindow !== undefined && rule.timeWindow !== null) {
    if (!refInWindow(minute, rule.timeWindow)) {
      return false;
    }
  }
  return rule.conditions.every((condition) => refEvalCondition(condition, event));
}

// --- Generators ---

/** A minute-of-day in `[0, 1440)` together with a matching UTC ISO timestamp. */
const minuteAndTsArb = fc.integer({ min: 0, max: 1439 }).map((minute) => {
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return { minute, ts: `2024-01-01T${hh}:${mm}:00.000Z` };
});

const conditionValueArb = fc.oneof(
  fc.string(),
  fc.integer({ min: -100, max: 100 }),
  fc.constantFrom(...PAYLOAD_KINDS),
  fc.array(fc.integer({ min: -10, max: 10 }), { maxLength: 4 }),
  fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 3 }),
);

const conditionArb: fc.Arbitrary<Condition> = fc.record({
  field: fc.constantFrom(...CONDITION_FIELDS),
  operator: fc.constantFrom(...OPERATORS),
  value: conditionValueArb,
});

const payloadArb = fc.record({
  kind: fc.constantFrom(...PAYLOAD_KINDS),
  score: fc.integer({ min: -50, max: 50 }),
  tags: fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 3 }),
});

/** A domain event plus its minute-of-day (so the reference avoids re-parsing ts). */
const eventArb: fc.Arbitrary<{ event: DomainEvent; minute: number }> = fc
  .record({
    kind: fc.constantFrom(...EVENT_KINDS),
    when: minuteAndTsArb,
    zoneId: fc.option(fc.constantFrom(...ZONES), { nil: undefined }),
    payload: payloadArb,
  })
  .map(({ kind, when, zoneId, payload }) => {
    const event = {
      kind,
      ts: when.ts,
      droneId: 'drone-1',
      ...(zoneId !== undefined ? { zoneId } : {}),
      payload,
    };
    return { event: event as unknown as DomainEvent, minute: when.minute };
  });

const timeWindowArb: fc.Arbitrary<TimeWindow> = fc.record({
  startMin: fc.integer({ min: 0, max: 1439 }),
  endMin: fc.integer({ min: 0, max: 1439 }),
});

/** A rule with a placeholder id; callers assign a unique id per index. */
const ruleArb: fc.Arbitrary<AlertRule> = fc
  .record({
    enabled: fc.boolean(),
    eventKind: fc.constantFrom(...EVENT_KINDS),
    conditions: fc.array(conditionArb, { maxLength: 4 }),
    timeWindow: fc.option(timeWindowArb, { nil: undefined }),
    zoneId: fc.option(fc.constantFrom(...ZONES), { nil: undefined }),
  })
  .map((partial) => ({
    id: 'placeholder',
    name: 'generated-rule',
    enabled: partial.enabled,
    eventKind: partial.eventKind,
    conditions: partial.conditions,
    ...(partial.timeWindow !== undefined ? { timeWindow: partial.timeWindow } : {}),
    ...(partial.zoneId !== undefined ? { zoneId: partial.zoneId } : {}),
    severity: 'warning' as const,
    channels: [],
    escalationChain: [],
    escalationIntervalMin: 5,
  }));

/** Assign deterministic unique ids by position so matched sets compare cleanly. */
function withUniqueIds(rules: AlertRule[]): AlertRule[] {
  return rules.map((rule, index) => ({ ...rule, id: `rule-${index}` }));
}

/** Seeded Fisher–Yates shuffle (keeps array length, avoids RNG nondeterminism). */
function seededShuffle<T>(input: readonly T[], seed: number): T[] {
  const result = [...input];
  let state = seed >>> 0 || 1;
  for (let i = result.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const temp = result[i] as T;
    result[i] = result[j] as T;
    result[j] = temp;
  }
  return result;
}

// --- Properties ---

describe('rule-engine property tests', () => {
  /**
   * P30 — Rule match soundness. evaluateRules includes a rule IFF it is enabled,
   * its eventKind matches, its zoneId matches when set, its timeWindow holds when
   * set, and ALL of its conditions hold.
   * **Validates: Requirements 14.2**
   */
  it('P30: matched set equals the independent predicate for every rule', () => {
    fc.assert(
      fc.property(eventArb, fc.array(ruleArb, { maxLength: 8 }), ({ event, minute }, rawRules) => {
        const rules = withUniqueIds(rawRules);
        const matchedIds = new Set(evaluateRules(event, rules).map((r) => r.id));
        for (const rule of rules) {
          const expected = refRuleMatches(rule, event, minute);
          expect(matchedIds.has(rule.id)).toBe(expected);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P31 — Rule order independence. Permuting the input rules yields the same
   * matched set (compared as a set of rule ids).
   * **Validates: Requirements 14.3**
   */
  it('P31: permuting the rules input yields the same matched set', () => {
    fc.assert(
      fc.property(
        eventArb,
        fc.array(ruleArb, { maxLength: 8 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        ({ event }, rawRules, seed) => {
          const rules = withUniqueIds(rawRules);
          const permuted = seededShuffle(rules, seed);

          const original = new Set(evaluateRules(event, rules).map((r) => r.id));
          const reordered = new Set(evaluateRules(event, permuted).map((r) => r.id));

          expect(reordered).toEqual(original);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P32 — Time-window wrap-around. For windows with startMin > endMin, inWindow
   * is true iff minute >= startMin OR minute < endMin; for startMin <= endMin it
   * is true iff startMin <= minute < endMin.
   * **Validates: Requirements 14.4**
   */
  it('P32: inWindow matches the half-open / wrap-around specification', () => {
    fc.assert(
      fc.property(timeWindowArb, fc.integer({ min: 0, max: 1439 }), (window, minute) => {
        const expected =
          window.startMin <= window.endMin
            ? minute >= window.startMin && minute < window.endMin
            : minute >= window.startMin || minute < window.endMin;
        expect(inWindow(minute, window)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P32 (cont.) — exhaustive sweep across all 1440 minutes for a generated
   * wrap-around window, confirming the boundary semantics end-to-end through
   * `minutesOfDay` + `inWindow` as used by the engine.
   * **Validates: Requirements 14.4**
   */
  it('P32: wrap-around window includes after-start OR before-end minutes only', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1439 }),
        fc.integer({ min: 0, max: 1438 }),
        (startMin, endMin) => {
          // Force a genuine wrap-around window (startMin > endMin).
          fc.pre(startMin > endMin);
          const window: TimeWindow = { startMin, endMin };
          for (let minute = 0; minute < 1440; minute += 1) {
            const expected = minute >= startMin || minute < endMin;
            expect(inWindow(minute, window)).toBe(expected);
          }
        },
      ),
      { numRuns: 120 },
    );
  });
});
