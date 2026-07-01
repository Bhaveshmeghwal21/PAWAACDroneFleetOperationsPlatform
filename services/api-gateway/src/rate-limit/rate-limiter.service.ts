/**
 * Redis-backed per-role rate limiter (Requirement 19.1, 19.2 — design property
 * P42).
 *
 * Enforcement uses a **fixed-window counter** stored in Redis. For each request
 * the limiter atomically increments the counter for the requester's role and
 * current window and reads the key's remaining TTL in a single round trip via a
 * Lua script — this makes the increment-and-expire pair atomic and therefore
 * race-free under concurrency (design "Performance Considerations": atomic Lua
 * scripts avoid race conditions). The pure {@link decideRateLimit} function then
 * turns the post-increment count into an allow/deny {@link RateLimitDecision}.
 *
 * The limiter depends only on a minimal {@link RateLimitStore} (the `eval`
 * surface of ioredis) and an injectable clock, so it is fully unit-testable with
 * a stub store and no live Redis.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Role } from '@pawaac/shared-types';
import { REDIS_CLIENT } from '../redis/redis.module';
import { RATE_LIMIT_CONFIG } from './rate-limit.tokens';
import type { RateLimitConfig } from './rate-limit.config';
import { decideRateLimit, rateLimitKey, type RateLimitDecision } from './rate-limit';

/**
 * Minimal Redis surface required by the limiter: a single `eval` capable of
 * running the atomic counter script. Declared structurally so tests can supply
 * a lightweight stub.
 */
export interface RateLimitStore {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/**
 * Atomic fixed-window counter: increment the key, set its expiry on first use,
 * and return both the post-increment count and the remaining TTL (ms). Doing
 * this in one Lua call guarantees the INCR and PEXPIRE cannot interleave with a
 * concurrent request.
 */
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

/** Coerces a value returned from the Lua script into a finite number. */
function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

@Injectable()
export class RateLimiterService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly store: RateLimitStore,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
    /**
     * Injectable clock (ms since epoch); overridable in tests. Marked
     * `@Optional()` so the Nest container can construct this provider without a
     * registered binding for the bare `() => number` type — when none is
     * supplied the default `Date.now` is used.
     */
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  /**
   * Consumes one unit of the role's quota for the current window and returns the
   * resulting decision. The window the request is accounted to is derived from
   * the current time, so windows roll over automatically.
   */
  async consume(role: Role): Promise<RateLimitDecision> {
    const rule = this.config[role];
    const nowSec = Math.floor(this.now() / 1000);
    const key = rateLimitKey(role, rule.windowSec, nowSec);

    const raw = (await this.store.eval(
      FIXED_WINDOW_SCRIPT,
      1,
      key,
      rule.windowSec * 1000,
    )) as unknown;

    const [countRaw, ttlRaw] = Array.isArray(raw) ? raw : [raw, -1];
    const count = toNumber(countRaw);
    const ttlMs = toNumber(ttlRaw);

    return decideRateLimit(count, rule, ttlMs);
  }
}
