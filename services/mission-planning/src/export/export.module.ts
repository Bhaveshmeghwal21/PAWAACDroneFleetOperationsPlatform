import { Module } from '@nestjs/common';
import { GeofencesModule } from '../geofences/geofences.module';
import { MissionsModule } from '../missions/missions.module';
import { ExportController } from './export.controller';
import { MavlinkExportService } from './mavlink-export.service';

/**
 * Assembles the PX4 MAVLink export feature (task 5.9): the REST controller and
 * the {@link MavlinkExportService}. Imports {@link MissionsModule} (to load the
 * mission being exported) and {@link GeofencesModule} (to block export when the
 * route conflicts with a geofence, Requirement 7.7). Both expose their services,
 * so no providers are duplicated and the dependency graph stays acyclic.
 */
@Module({
  imports: [MissionsModule, GeofencesModule],
  controllers: [ExportController],
  providers: [MavlinkExportService],
})
export class ExportModule {}
