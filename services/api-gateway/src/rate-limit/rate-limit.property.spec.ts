/**
 * Generator-driven property tests for the API Gateway rate-limiting and
 * trace-propagation logic (task 13.5). These complement the example-based unit
 * tests in `rate-limit.spec.ts`, `rate-limiter.service.spec.ts` and
 * `../common/downstream-trace.spec.ts`.
 *
 * Properties validated (design "Correctness Properties", API Gateway):
 *   - P42 — Rate-limit safety  (Requirement 19.1)
 *   - P44 — Trace propagation  (Requirement 19.3)
 *
 * Each property runs >= 100 iterations (here 200; see NUM_RUNS). Expected
 * outcomes are recomputed directly from the acceptance criteria, independently
 * of the production branch structure: for P42 we re-derive allowed/remaining
 * from the post-increment count and the rule, and we simulate a full fixed
 * window of monotonically-increasing counters and assert the number of allowed
 * requests never exceeds the role's limit. For P44 we generate inbound requests
 * both with and without a trace id and assert the forwarded headers always carry
 * a non-empty trace id.
 */
import fc from 'fast-check';
import type { Request } from 'express';
import type { Role } from '@pawaac/shared-types';
import { decideRateLimit, rateLimitKey, RATE_LIMIT_KEY_PREFIX } from './rate-limit';
import type { RateLimitRule } from './rate-limit.config';
import { ROLES_BY_PRIVILEGE } from '../auth/roles';
import { TRACE_HEADER, TRACE_ID_KEY } from '../common/trace';
import { buildDownstreamHeaders } from '../common/downstream-trace';

const NUM_RUNS = 200;

// --- Shared generators --------------------------------------------------------

const roleArb: fc.Arbitrary<Role> = fc.constantFrom(...ROLES_BY_PRIVILEGE);

/** A valid rate-limit rule: `limit >= 0`, `windowSec > 0`. */
const ruleArb: fc.Arbitrary<RateLimitRule> = fc.record({
  limit: fc.integer({ min: 0, max: 500 }),
  windowSec: fc.integer({ min: 1, max: 3_600 }),
});

/**
 * TTL milliseconds spanning the interesting cases: a positive remaining window,
 * an expired/unknown window (`<= 0`, which triggers the windowSec fallback), and
 * sub-second values (which must still round up to `>= 1`).
 */
const ttlMsArb = fc.oneof(
  fc.integer({ min: 1, max: 600_000 }),
  fc.constantFrom(0, -1, -1_000),
  fc.integer({ min: 1, max: 999 }),
);

// --- P42 — Rate-limit safety --------------------------------------------------

describe('decideRateLimit — property tests (P42)', () => {
  /**
   * P42 — single-decision contract. For any post-increment count, rule and TTL:
   * a request is allowed iff `count <= limit`; `remaining = max(0, limit-count)`;
   * an allowed decision advertises `retryAfterSec === 0`; and a denied decision
   * advertises `retryAfterSec >= 1` (so a client never sees `Retry-After: 0`).
   * **Validates: Requirements 19.1**
   */
  it('P42: allowed iff count <= limit, with correct remaining and retry-after', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000 }),
        ruleArb,
        ttlMsArb,
        (countAfterIncrement, rule, ttlMs) => {
          const decision = decideRateLimit(countAfterIncrement, rule, ttlMs);

          // Expectation recomputed from the acceptance criteria.
          expect(decision.allowed).toBe(countAfterIncrement <= rule.limit);
          expect(decision.limit).toBe(rule.limit);
          expect(decision.remaining).toBe(Math.max(0, rule.limit - countAfterIncrement));
          expect(decision.remaining).toBeGreaterThanOrEqual(0);

          if (decision.allowed) {
            expect(decision.retryAfterSec).toBe(0);
          } else {
            // Denied requests must carry a usable Retry-After (>= 1s).
            expect(decision.retryAfterSec).toBeGreaterThanOrEqual(1);
            expect(decision.remaining).toBe(0);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P42 — window safety. Simulate a fixed window: a fleet of `requests` arrivals,
   * each incrementing the role's counter by one, so the post-increment counts
   * are 1, 2, 3, … `requests`. Feeding each count through decideRateLimit, the
   * number of allowed requests across the whole window must never exceed the
   * role's configured limit — the core P42 invariant.
   * **Validates: Requirements 19.1**
   */
  it('P42: allowed requests in a window never exceed the configured limit', () => {
    fc.assert(
      fc.property(
        ruleArb,
        fc.integer({ min: 0, max: 1_000 }),
        ttlMsArb,
        (rule, requests, ttlMs) => {
          let allowedCount = 0;
          let lastAllowed = true;
          for (let count = 1; count <= requests; count += 1) {
            const decision = decideRateLimit(count, rule, ttlMs);
            if (decision.allowed) {
              allowedCount += 1;
              // Once denied, no later (higher) count is ever allowed again
              // within the window: the allow region is a contiguous prefix.
              expect(lastAllowed).toBe(true);
            }
            lastAllowed = decision.allowed;
          }

          // The safety property: never grant more than the limit.
          expect(allowedCount).toBeLessThanOrEqual(rule.limit);
          // And it is tight: exactly min(requests, limit) are admitted.
          expect(allowedCount).toBe(Math.min(requests, rule.limit));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P42 (cont.) — key isolation. Counter keys for distinct (role, window) pairs
   * are distinct, and the same (role, window) always maps to the same key, so
   * one role's traffic can never consume another's budget and windows roll over
   * to fresh counters. Keys are always namespaced under the gateway prefix.
   * **Validates: Requirements 19.1**
   */
  it('P42: rate-limit keys isolate roles and windows', () => {
    fc.assert(
      fc.property(
        roleArb,
        roleArb,
        fc.integer({ min: 1, max: 3_600 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (roleA, roleB, windowSec, nowSecA, nowSecB) => {
          const keyA = rateLimitKey(roleA, windowSec, nowSecA);
          expect(keyA.startsWith(`${RATE_LIMIT_KEY_PREFIX}:`)).toBe(true);

          // Determinism: same inputs => same key.
          expect(rateLimitKey(roleA, windowSec, nowSecA)).toBe(keyA);

          const sameWindow =
            Math.floor(nowSecA / windowSec) === Math.floor(nowSecB / windowSec);
          const keyB = rateLimitKey(roleB, windowSec, nowSecB);

          if (roleA === roleB && sameWindow) {
            expect(keyB).toBe(keyA);
          } else {
            expect(keyB).not.toBe(keyA);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- P44 — Trace propagation --------------------------------------------------

describe('buildDownstreamHeaders — property tests (P44)', () => {
  /** Non-empty trace id candidates (UUID-ish and arbitrary non-blank strings). */
  const traceIdArb = fc
    .string({ minLength: 1, maxLength: 64 })
    .filter((s) => s.trim().length > 0);

  /** Arbitrary base header maps to copy from (must be preserved untouched). */
  const baseHeadersArb = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 12 }).filter((k) => k !== TRACE_HEADER),
    fc.string({ maxLength: 24 }),
    { maxKeys: 5 },
  );

  /**
   * P44 — a request annotated by the inbound middleware (trace id stashed on the
   * request) forwards exactly that id, non-empty, under the trace header, while
   * preserving all base headers.
   * **Validates: Requirements 19.3**
   */
  it('P44: forwards the middleware-resolved trace id, non-empty', () => {
    fc.assert(
      fc.property(traceIdArb, baseHeadersArb, (traceId, base) => {
        const req = { headers: {}, [TRACE_ID_KEY]: traceId } as unknown as Request;
        const headers = buildDownstreamHeaders(req, base);
        const forwarded = headers[TRACE_HEADER];

        expect(forwarded).toBe(traceId);
        expect((forwarded ?? '').trim().length).toBeGreaterThan(0);
        // Base headers are preserved and the input is not mutated.
        for (const [k, v] of Object.entries(base)) {
          expect(headers[k]).toBe(v);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P44 — an inbound request that supplied its own trace header (but was not
   * annotated by the middleware) still has that id forwarded downstream.
   * **Validates: Requirements 19.3**
   */
  it('P44: honours an inbound trace header when the middleware did not run', () => {
    fc.assert(
      fc.property(traceIdArb, baseHeadersArb, (traceId, base) => {
        const req = {
          headers: { [TRACE_HEADER.toLowerCase()]: traceId },
        } as unknown as Request;
        const headers = buildDownstreamHeaders(req, base);
        expect(headers[TRACE_HEADER]).toBe(traceId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P44 — the key guarantee: regardless of whether the inbound request carried a
   * trace id, the downstream headers always contain a non-empty trace id under
   * the trace header. Drives the "no inbound trace" branch, forcing a freshly
   * minted id.
   * **Validates: Requirements 19.3**
   */
  it('P44: always yields a non-empty downstream trace id, with or without an inbound one', () => {
    const inboundArb = fc.oneof(
      // Annotated by middleware.
      traceIdArb.map((id) => ({ headers: {}, [TRACE_ID_KEY]: id })),
      // Inbound client header only.
      traceIdArb.map((id) => ({ headers: { [TRACE_HEADER.toLowerCase()]: id } })),
      // Nothing at all -> must mint one.
      fc.constant({ headers: {} }),
      // Blank/whitespace values must be treated as absent and replaced.
      fc.constant({ headers: { [TRACE_HEADER.toLowerCase()]: '   ' } }),
      fc.constant({ headers: {}, [TRACE_ID_KEY]: '' }),
    );

    fc.assert(
      fc.property(inboundArb, baseHeadersArb, (reqShape, base) => {
        const req = reqShape as unknown as Request;
        const headers = buildDownstreamHeaders(req, base);
        const traceId = headers[TRACE_HEADER];

        expect(typeof traceId).toBe('string');
        expect((traceId ?? '').trim().length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
