/**
 * Terminus health indicator that reports Redis connectivity for `/ready`
 * (Requirement 34.1).
 */
import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicator, type HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {
    super();
  }

  /** Pings Redis; healthy when the server answers `PONG`. */
  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const pong = await this.client.ping();
      const ok = pong === 'PONG';
      const result = this.getStatus(key, ok);
      if (ok) {
        return result;
      }
      throw new HealthCheckError('Redis ping failed', result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      throw new HealthCheckError('Redis unavailable', this.getStatus(key, false, { message }));
    }
  }
}
