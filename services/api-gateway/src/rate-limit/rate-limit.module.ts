/**
 * Wires the gateway's per-role rate-limiting building blocks (Requirement 19.1,
 * 19.2): the resolved {@link RateLimitConfig}, the Redis-backed
 * {@link RateLimiterService}, and the {@link RateLimitGuard} the proxy layer
 * (task 13.6) applies to upstream routes.
 *
 * The shared `ioredis` client is provided globally by {@link RedisModule}, so
 * this module only contributes the config + limiter + guard.
 */
import { Module } from '@nestjs/common';
import { RATE_LIMIT_CONFIG } from './rate-limit.tokens';
import { loadRateLimitConfig } from './rate-limit.config';
import { RateLimiterService } from './rate-limiter.service';
import { RateLimitGuard } from './rate-limit.guard';

@Module({
  providers: [
    { provide: RATE_LIMIT_CONFIG, useFactory: () => loadRateLimitConfig() },
    RateLimiterService,
    RateLimitGuard,
  ],
  exports: [RateLimiterService, RateLimitGuard, RATE_LIMIT_CONFIG],
})
export class RateLimitModule {}
