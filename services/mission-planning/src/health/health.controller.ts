import { Controller, Get, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

interface ReadinessResult {
  status: string;
  checks: { database: string };
}

/**
 * Liveness and readiness probes (Requirement 34.1). `/health` reports process
 * liveness; `/ready` additionally verifies datastore connectivity and fails
 * with an RFC 7807 problem+json 503 when the database is unreachable.
 */
@Controller()
export class HealthController {
  constructor(
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  @Get('health')
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(): Promise<ReadinessResult> {
    if (!this.dataSource || !this.dataSource.isInitialized) {
      throw new ServiceUnavailableException('Database connection is not initialised');
    }
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('Database connectivity check failed');
    }
    return { status: 'ready', checks: { database: 'up' } };
  }
}
