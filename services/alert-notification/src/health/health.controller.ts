/**
 * Liveness (`/health`) and readiness (`/ready`) endpoints (Requirement 34.1).
 *
 * - `/health` is a pure liveness probe: it never touches a datastore so it can
 *   confirm the process is up even while dependencies are still warming.
 * - `/ready` reports whether the service can actually serve traffic by checking
 *   Postgres and Redis connectivity.
 */
import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
  type HealthCheckResult,
} from '@nestjs/terminus';
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
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get('health')
  live(): LivenessResult {
    return {
      status: 'ok',
      service: 'alert-notification',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 1500 }),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
