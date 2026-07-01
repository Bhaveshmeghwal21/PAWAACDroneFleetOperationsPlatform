import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dataSourceOptions } from './data-source';
import { DronesModule } from './drones/drones.module';
import { HealthModule } from './health/health.module';

/** Root module wiring configuration, the database, health probes and drones. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({ ...dataSourceOptions, retryAttempts: 10, retryDelay: 3000 }),
    HealthModule,
    DronesModule,
  ],
})
export class AppModule {}
