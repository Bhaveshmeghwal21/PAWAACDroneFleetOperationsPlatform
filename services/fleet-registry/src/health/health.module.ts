import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Exposes the liveness and readiness probes. */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
