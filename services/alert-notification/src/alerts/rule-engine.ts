/**
 * Pure rule-engine evaluation (Requirement 14, design "Algorithm 5: Rule Engine
 * Evaluation").
 *
 * Everything in this module is a side-effect-free, deterministic function of its
 * arguments — no database, clock, or I/O access — so it is trivially unit- and
 * property-testable (design properties P30 rule-match soundness, P31 order
 * independence, P32 time-window wrap-around; the property TESTS live in task
 * 11.4). The persistence/DTO concerns live in `rules.service.ts`.
 */
import type { AlertRule, Condition, DomainEvent, TimeWindow } from '@pawaac/shared-types';

/** Minutes in a full day; minutes-of-day values live in `[0, MINUTES_PER_DAY)`. */
export const MINUTES_PER_DAY = 1440;

/**
 * Resolve a dot-path (e.g. `payload.kind`) against a domain event, returning
 * `undefined` when any segment is missing or a non-object is traversed. Never
 * throws and never mutates the event.
 */
export function resolveField(event: DomainEvent, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = event;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Strict primitive equality (no coercion); reference equality for objects. */
function valuesEqual(actual: unknown, expected: unknown): boolean {
  return actual === expected;
}

/** Numeric comparison guard: both operands must be finite numbers. */
function compareNumbers(
  actual: unknown,
  expected: unknown,
  predicate: (a: number, b: number) => boolean,
): boolean {
  if (typeof actual !== 'number' || typeof expected !== 'number') {
    return false;
  }
  if (Number.isNaN(actual) || Number.isNaN(expected)) {
    return false;
  }
  return predicate(actual, expected);
}

/** True iff `actual` is a member of the `expected` array (strict equality). */
function isMember(actual: unknown, expected: unknown): boolean {
  return Array.isArray(expected) && expected.some((candidate) => valuesEqual(candidate, actual));
}

/**
 * Evaluate a single field predicate against an event. Returns `false` for any
 * type mismatch rather than throwing, so a malformed condition can never crash
 * evaluation.
 */
export function evalCondition(condition: Condition, event: DomainEvent): boolean {
  const actual = resolveField(event, condition.field);
  const expected = condition.value;

  switch (condition.operator) {
    case 'eq':
      return valuesEqual(actual, expected);
    case 'neq':
      return !valuesEqual(actual, expected);
    case 'gt':
      return compareNumbers(actual, expected, (a, b) => a > b);
    case 'gte':
      return compareNumbers(actual, expected, (a, b) => a >= b);
    case 'lt':
      return compareNumbers(actual, expected, (a, b) => a < b);
    case 'lte':
      return compareNumbers(actual, expected, (a, b) => a <= b);
    case 'in':
      return isMember(actual, expected);
    case 'nin':
      // Logical negation of `in` for consistency with `neq = !eq`.
      return !isMember(actual, expected);
    case 'contains':
      if (typeof actual === 'string') {
        return typeof expected === 'string' && actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.some((candidate) => valuesEqual(candidate, expected));
      }
      return false;
    default:
      return false;
  }
}

/**
 * Minutes-of-day (UTC) for an ISO-8601 timestamp, in `[0, MINUTES_PER_DAY)`.
 * UTC is used so evaluation is deterministic regardless of host timezone.
 *
 * @throws if `ts` is not a parseable timestamp (callers pass well-formed event
 *   timestamps; an unparseable value is a programming error, not a match miss).
 */
export function minutesOfDay(ts: string): number {
  const parsed = new Date(ts);
  const epochMs = parsed.getTime();
  if (Number.isNaN(epochMs)) {
    throw new Error(`Invalid timestamp for rule evaluation: "${ts}"`);
  }
  return parsed.getUTCHours() * 60 + parsed.getUTCMinutes();
}

/**
 * Half-open `[startMin, endMin)` membership test with wrap-around support
 * (Requirement 14.4 / design property P32). When `startMin > endMin` the window
 * spans midnight, so a minute matches if it is at/after the start OR before the
 * end. When `startMin === endMin` the window is empty.
 */
export function inWindow(minute: number, window: TimeWindow): boolean {
  const { startMin, endMin } = window;
  if (startMin <= endMin) {
    return minute >= startMin && minute < endMin;
  }
  return minute >= startMin || minute < endMin;
}

/** Optional zone scope carried by an event, regardless of its concrete variant. */
function eventZoneId(event: DomainEvent): string | undefined {
  return (event as { zoneId?: string }).zoneId;
}

/**
 * True iff a rule matches an event: it must be enabled, its `eventKind` must
 * equal the event kind, its `zoneId` must match when set, its `timeWindow` must
 * hold when set, and ALL of its conditions must hold (AND semantics). Pure and
 * deterministic (Requirement 14.2, 14.5 / design property P30).
 */
export function ruleMatches(rule: AlertRule, event: DomainEvent): boolean {
  if (!rule.enabled) {
    return false;
  }
  if (rule.eventKind !== event.kind) {
    return false;
  }
  if (rule.zoneId !== undefined && rule.zoneId !== null && rule.zoneId !== eventZoneId(event)) {
    return false;
  }
  if (rule.timeWindow !== undefined && rule.timeWindow !== null) {
    if (!inWindow(minutesOfDay(event.ts), rule.timeWindow)) {
      return false;
    }
  }
  return rule.conditions.every((condition) => evalCondition(condition, event));
}

/**
 * Evaluate an event against a set of rules, returning exactly the rules that
 * match (design Algorithm 5). The result is order-independent over `rules`
 * (design property P31): permuting the input permutes the output but yields the
 * same matched set. Pure — neither `event` nor `rules` is mutated.
 */
export function evaluateRules(event: DomainEvent, rules: AlertRule[]): AlertRule[] {
  return rules.filter((rule) => ruleMatches(rule, event));
}
