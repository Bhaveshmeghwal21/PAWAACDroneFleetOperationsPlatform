import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MissionsModule } from '../missions/missions.module';
import { GeofenceEntity } from './entities/geofence.entity';
import { GEOFENCE_STORE } from './geofence-store';
import { GeofenceService } from './geofence.service';
import { GeofencesController } from './geofences.controller';
import { TypeOrmGeofenceStore } from './typeorm-geofence-store';

/**
 * Assembles the geofence feature (task 5.5): the REST controller, the
 * application service, and the PostGIS-backed persistence/conflict-detection
 * adapter bound to the {@link GEOFENCE_STORE} port. Imports {@link MissionsModule}
 * so conflict detection can resolve a mission's latest waypoints.
 */
@Module({
  imports: [TypeOrmModule.forFeature([GeofenceEntity]), MissionsModule],
  controllers: [GeofencesController],
  providers: [
    GeofenceService,
    TypeOrmGeofenceStore,
    { provide: GEOFENCE_STORE, useExisting: TypeOrmGeofenceStore },
  ],
  exports: [GeofenceService],
})
export class GeofencesModule {}
