/**
 * Unit tests for the pure rate-limit decision logic, key derivation, and config
 * loading (Requirement 19.1, 19.2 — design property P42).
 */
import {
  decideRateLimit,
  rateLimitKey,
  RATE_LIMIT_KEY_PREFIX,
} from './rate-limit';
import {
  DEFAULT_ROLE_LIMITS,
  DEFAULT_WINDOW_SEC,
  loadRateLimitConfig,
} from './rate-limit.config';

const RULE = { limit: 3, windowSec: 60 } as const;

describe('decideRateLimit', () => {
  it('allows requests up to and including the limit (P42)', () => {
    for (let count = 1; count <= RULE.limit; count += 1) {
      const decision = decideRateLimit(count, RULE, 30_000);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(RULE.limit - count);
      expect(decision.retryAfterSec).toBe(0);
    }
  });

  it('denies the first request that exceeds the limit (P42)', () => {
    const decision = decideRateLimit(RULE.limit + 1, RULE, 30_000);
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  it('reports Retry-After as the ceil of the remaining TTL when denied (19.2)', () => {
    const decision = decideRateLimit(RULE.limit + 5, RULE, 4200);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSec).toBe(5); // ceil(4200/1000)
  });

  it('never advertises a Retry-After below one second', () => {
    const denied = decideRateLimit(RULE.limit + 1, RULE, 1);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the full window when TTL is unknown/expired', () => {
    const decision = decideRateLimit(RULE.limit + 1, RULE, -1);
    expect(decision.retryAfterSec).toBe(RULE.windowSec);
  });

  it('never reports a negative remaining count', () => {
    expect(decideRateLimit(100, RULE, 1000).remaining).toBe(0);
  });
});

describe('rateLimitKey', () => {
  it('namespaces keys by role and window index', () => {
    const key = rateLimitKey('operator', 60, 125); // window index floor(125/60) = 2
    expect(key).toBe(`${RATE_LIMIT_KEY_PREFIX}:operator:2`);
  });

  it('keeps the same key within a window and rolls over at the boundary', () => {
    const a = rateLimitKey('viewer', 60, 0);
    const b = rateLimitKey('viewer', 60, 59);
    const c = rateLimitKey('viewer', 60, 60);
    expect(a).toBe(b);
    expect(c).not.toBe(b);
  });
});

describe('loadRateLimitConfig', () => {
  it('applies defaults when no environment overrides are present', () => {
    const config = loadRateLimitConfig({});
    expect(config.viewer).toEqual({ limit: DEFAULT_ROLE_LIMITS.viewer, windowSec: DEFAULT_WINDOW_SEC });
    expect(config.super_admin.limit).toBe(DEFAULT_ROLE_LIMITS.super_admin);
  });

  it('honours per-role and window overrides', () => {
    const config = loadRateLimitConfig({
      RATE_LIMIT_WINDOW_SEC: '30',
      RATE_LIMIT_OPERATOR: '10',
    });
    expect(config.operator).toEqual({ limit: 10, windowSec: 30 });
    expect(config.viewer.windowSec).toBe(30);
  });

  it('ignores invalid overrides and falls back to defaults', () => {
    const config = loadRateLimitConfig({
      RATE_LIMIT_WINDOW_SEC: 'not-a-number',
      RATE_LIMIT_VIEWER: '-5',
    });
    expect(config.viewer.limit).toBe(DEFAULT_ROLE_LIMITS.viewer);
    expect(config.viewer.windowSec).toBe(DEFAULT_WINDOW_SEC);
  });
});
