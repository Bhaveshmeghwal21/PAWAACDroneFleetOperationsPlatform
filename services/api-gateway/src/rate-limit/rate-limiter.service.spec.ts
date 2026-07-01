/**
 * Unit tests for {@link RateLimiterService} (Requirement 19.1, 19.2 — design
 * property P42).
 *
 * A lightweight in-memory stub stands in for ioredis so the atomic
 * increment-and-expire semantics are exercised without a live Redis: it models
 * INCR + first-use expiry + PTTL per key, exactly as the Lua script does.
 */
import type { Role } from '@pawaac/shared-types';
import { RateLimiterService, type RateLimitStore } from './rate-limiter.service';
import type { RateLimitConfig } from './rate-limit.config';

/** In-memory fixed-window counter store mirroring the Lua script's behaviour. */
class FakeRedisStore implements RateLimitStore {
  private readonly counts = new Map<string, number>();
  private readonly expiry = new Map<string, number>();

  constructor(private now: () => number) {}

  setNow(now: () => number): void {
    this.now = now;
  }

  eval(_script: string, _numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const key = String(args[0]);
    const windowMs = Number(args[1]);
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    if (next === 1) {
      this.expiry.set(key, this.now() + windowMs);
    }
    const ttl = Math.max(0, (this.expiry.get(key) ?? this.now()) - this.now());
    return Promise.resolve([next, ttl]);
  }
}

const CONFIG: RateLimitConfig = {
  viewer: { limit: 3, windowSec: 60 },
  analyst: { limit: 5, windowSec: 60 },
  operator: { limit: 5, windowSec: 60 },
  super_admin: { limit: 10, windowSec: 60 },
};

function makeLimiter(nowRef: { t: number }): { limiter: RateLimiterService; store: FakeRedisStore } {
  const store = new FakeRedisStore(() => nowRef.t);
  const limiter = new RateLimiterService(store, CONFIG, () => nowRef.t);
  return { limiter, store };
}

describe('RateLimiterService.consume', () => {
  it('allows exactly the role limit within a window, then denies (P42)', async () => {
    const nowRef = { t: 1_000_000 };
    const { limiter } = makeLimiter(nowRef);
    const role: Role = 'viewer';

    const results = [];
    for (let i = 0; i < CONFIG.viewer.limit + 2; i += 1) {
      results.push(await limiter.consume(role));
    }

    const allowed = results.filter((r) => r.allowed);
    expect(allowed).toHaveLength(CONFIG.viewer.limit);
    // Every request beyond the limit is denied.
    expect(results.slice(CONFIG.viewer.limit).every((r) => !r.allowed)).toBe(true);
  });

  it('decrements remaining on each allowed request', async () => {
    const nowRef = { t: 2_000_000 };
    const { limiter } = makeLimiter(nowRef);
    const first = await limiter.consume('operator');
    const second = await limiter.consume('operator');
    expect(first.remaining).toBe(CONFIG.operator.limit - 1);
    expect(second.remaining).toBe(CONFIG.operator.limit - 2);
  });

  it('returns a positive Retry-After when the limit is exceeded (19.2)', async () => {
    const nowRef = { t: 3_000_000 };
    const { limiter } = makeLimiter(nowRef);
    for (let i = 0; i < CONFIG.viewer.limit; i += 1) {
      await limiter.consume('viewer');
    }
    const denied = await limiter.consume('viewer');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(CONFIG.viewer.windowSec);
  });

  it('resets the quota once the window rolls over', async () => {
    const nowRef = { t: 0 };
    const { limiter } = makeLimiter(nowRef);
    for (let i = 0; i < CONFIG.viewer.limit; i += 1) {
      await limiter.consume('viewer');
    }
    expect((await limiter.consume('viewer')).allowed).toBe(false);

    // Advance past the window boundary → a fresh counter key.
    nowRef.t += CONFIG.viewer.windowSec * 1000;
    expect((await limiter.consume('viewer')).allowed).toBe(true);
  });

  it('meters each role independently', async () => {
    const nowRef = { t: 5_000_000 };
    const { limiter } = makeLimiter(nowRef);
    for (let i = 0; i < CONFIG.viewer.limit; i += 1) {
      await limiter.consume('viewer');
    }
    // viewer is now exhausted, but operator has its own untouched budget.
    expect((await limiter.consume('viewer')).allowed).toBe(false);
    expect((await limiter.consume('operator')).allowed).toBe(true);
  });
});
