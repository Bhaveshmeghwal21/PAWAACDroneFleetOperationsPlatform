import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dataSourceOptions } from './data-source';
import { ExportModule } from './export/export.module';
import { GeofencesModule } from './geofences/geofences.module';
import { HealthModule } from './health/health.module';
import { MissionsModule } from './missions/missions.module';
import { TemplatesModule } from './templates/templates.module';

/**
 * Root module wiring configuration, the PostGIS-backed database connection, the
 * health probes, versioned mission authoring, geofence
 * definition/conflict-detection, the mission template library and PX4 MAVLink
 * export.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({ ...dataSourceOptions, retryAttempts: 10, retryDelay: 3000 }),
    HealthModule,
    MissionsModule,
    GeofencesModule,
    TemplatesModule,
    ExportModule,
  ],
})
export class AppModule {}
