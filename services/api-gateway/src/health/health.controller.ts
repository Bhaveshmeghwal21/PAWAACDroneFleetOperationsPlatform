/**
 * Liveness (`/health`) and readiness (`/ready`) endpoints (Requirement 34.1).
 *
 * - `/health` is a pure liveness probe: it never touches a datastore so it can
 *   confirm the process is up even while dependencies are still warming.
 * - `/ready` reports whether the gateway can actually serve traffic. The gateway
 *   is stateless apart from Redis (used for rate-limit counters), so readiness
 *   checks Redis connectivity.
 */
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';

interface LivenessResult {
  status: 'ok';
  service: string;
  timestamp: string;
}

@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get('health')
  live(): LivenessResult {
    return {
      status: 'ok',
      service: 'api-gateway',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.redis.isHealthy('redis')]);
  }
}
