/**
 * Unit tests for {@link RateLimitGuard} (Requirement 19.2).
 *
 * Verifies the guard sets informational headers on allow, responds 429 with a
 * `Retry-After` header on deny, and passes through un-roled requests.
 */
import { HttpException, HttpStatus, type ExecutionContext } from '@nestjs/common';
import type { Role } from '@pawaac/shared-types';
import { RateLimitGuard, RETRY_AFTER_HEADER } from './rate-limit.guard';
import type { RateLimiterService } from './rate-limiter.service';
import type { RateLimitDecision } from './rate-limit';

interface FakeResponse {
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
}

function fakeResponse(): FakeResponse {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

function contextFor(
  role: Role | undefined,
  res: FakeResponse,
): ExecutionContext {
  const req = role === undefined ? {} : { authContext: { userId: 'u', role } };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

function limiterReturning(decision: RateLimitDecision): RateLimiterService {
  return { consume: jest.fn().mockResolvedValue(decision) } as unknown as RateLimiterService;
}

describe('RateLimitGuard', () => {
  it('allows the request and sets X-RateLimit headers when under the limit', async () => {
    const res = fakeResponse();
    const guard = new RateLimitGuard(
      limiterReturning({ allowed: true, limit: 5, remaining: 4, retryAfterSec: 0 }),
    );

    await expect(guard.canActivate(contextFor('operator', res))).resolves.toBe(true);
    expect(res.headers['X-RateLimit-Limit']).toBe('5');
    expect(res.headers['X-RateLimit-Remaining']).toBe('4');
    expect(res.headers[RETRY_AFTER_HEADER]).toBeUndefined();
  });

  it('responds 429 with a Retry-After header when the limit is exceeded (19.2)', async () => {
    const res = fakeResponse();
    const guard = new RateLimitGuard(
      limiterReturning({ allowed: false, limit: 5, remaining: 0, retryAfterSec: 42 }),
    );

    await expect(guard.canActivate(contextFor('viewer', res))).rejects.toBeInstanceOf(HttpException);
    expect(res.headers[RETRY_AFTER_HEADER]).toBe('42');

    try {
      await guard.canActivate(contextFor('viewer', res));
      fail('expected guard to throw');
    } catch (err) {
      expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });

  it('passes through requests without an authenticated role', async () => {
    const res = fakeResponse();
    const consume = jest.fn();
    const guard = new RateLimitGuard({ consume } as unknown as RateLimiterService);

    await expect(guard.canActivate(contextFor(undefined, res))).resolves.toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });
});
