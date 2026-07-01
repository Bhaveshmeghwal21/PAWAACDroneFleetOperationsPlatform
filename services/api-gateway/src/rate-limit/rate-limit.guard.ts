/**
 * Guard that enforces the per-role rate limit (Requirement 19.1, 19.2 — design
 * property P42).
 *
 * It must run *after* {@link JwtAuthGuard}, which populates `req.authContext`
 * with the authenticated role used as the rate-limit dimension. For each request
 * it consumes one unit of the role's quota via {@link RateLimiterService}; on
 * success it annotates the response with informational `X-RateLimit-*` headers,
 * and when the role has exceeded its window budget it responds `429 Too Many
 * Requests` carrying a `Retry-After` header (Requirement 19.2). The RFC 7807
 * filter renders the thrown 429 as problem+json while preserving the header.
 *
 * Requests without an authenticated principal are passed through untouched: the
 * upstream proxy pipeline runs the JWT guard first, so an un-roled request never
 * reaches a protected upstream.
 */
import {
  HttpException,
  HttpStatus,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthedRequest } from '../auth/authed-request';
import { RateLimiterService } from './rate-limiter.service';

/** HTTP header advertising how long to wait before retrying (RFC 7231). */
export const RETRY_AFTER_HEADER = 'Retry-After';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const role = req.authContext?.role;

    // No authenticated role → nothing to meter (auth guards gate access first).
    if (role === undefined) {
      return true;
    }

    const res = http.getResponse<Response>();
    const decision = await this.limiter.consume(role);

    res.setHeader('X-RateLimit-Limit', String(decision.limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));

    if (!decision.allowed) {
      res.setHeader(RETRY_AFTER_HEADER, String(decision.retryAfterSec));
      throw new HttpException(
        `Rate limit exceeded for role '${role}'. Retry after ${decision.retryAfterSec}s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
