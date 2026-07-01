/**
 * Pure rate-limit decision logic and Redis key derivation (Requirement 19.1,
 * 19.2 — design property P42, rate-limit safety).
 *
 * The decision is deliberately a **pure function** over counter state: given the
 * post-increment request count within the current window and the role's
 * configured rule, it decides whether the request is allowed and — when denied —
 * how long the client should wait before retrying. Keeping this logic free of
 * I/O makes it trivially unit- and property-testable (the property tests in task
 * 13.5 quantify P42 over generated request sequences).
 */
import type { Role } from '@pawaac/shared-types';
import type { RateLimitRule } from './rate-limit.config';

/** Outcome of a single rate-limit evaluation. */
export interface RateLimitDecision {
  /** Whether the request is permitted under the role's quota. */
  readonly allowed: boolean;
  /** The role's configured per-window limit. */
  readonly limit: number;
  /** Remaining requests in the current window (never negative). */
  readonly remaining: number;
  /**
   * Seconds the client should wait before retrying. `0` when allowed; otherwise
   * the time remaining until the current window resets (>= 1).
   */
  readonly retryAfterSec: number;
}

/**
 * Decides whether a request is allowed given the **post-increment** count of
 * requests observed in the current window.
 *
 * Contract (mirrors design `rateLimit` Pre/Post and property P42):
 * - The request is allowed iff `countAfterIncrement <= rule.limit`; therefore
 *   the number of allowed requests in any window never exceeds `rule.limit`.
 * - `remaining` is `max(0, limit - countAfterIncrement)`.
 * - When denied, `retryAfterSec` is the time until the window resets, derived
 *   from `ttlMs`, and is always `>= 1` so a client never sees `Retry-After: 0`.
 *
 * @param countAfterIncrement the request count in the window *including* this
 *   request (i.e. the value returned by an atomic INCR)
 * @param rule                the role's configured limit/window
 * @param ttlMs               milliseconds until the current window key expires
 */
export function decideRateLimit(
  countAfterIncrement: number,
  rule: RateLimitRule,
  ttlMs: number,
): RateLimitDecision {
  const allowed = countAfterIncrement <= rule.limit;
  const remaining = Math.max(0, rule.limit - countAfterIncrement);
  if (allowed) {
    return { allowed: true, limit: rule.limit, remaining, retryAfterSec: 0 };
  }
  // Fall back to the full window length when the TTL is unknown/expired so the
  // advertised Retry-After is never below one second.
  const ttlSec = ttlMs > 0 ? Math.ceil(ttlMs / 1000) : rule.windowSec;
  return {
    allowed: false,
    limit: rule.limit,
    remaining: 0,
    retryAfterSec: Math.max(1, ttlSec),
  };
}

/** Prefix for all gateway rate-limit counter keys in Redis. */
export const RATE_LIMIT_KEY_PREFIX = 'ratelimit';

/**
 * Builds the fixed-window Redis counter key for a role. The current window index
 * is folded into the key (`floor(nowSec / windowSec)`) so each window owns a
 * distinct counter and windows roll over automatically without a separate reset
 * step.
 *
 * @param role      the requester's role (the rate-limit dimension)
 * @param windowSec window length in seconds
 * @param nowSec    current time in seconds (epoch)
 */
export function rateLimitKey(role: Role, windowSec: number, nowSec: number): string {
  const windowIndex = Math.floor(nowSec / windowSec);
  return `${RATE_LIMIT_KEY_PREFIX}:${role}:${windowIndex}`;
}
