import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MissionEntity } from './entities/mission.entity';
import { WaypointEntity } from './entities/waypoint.entity';
import { MISSION_CONFIG, loadMissionConfig } from './mission.config';
import { MISSION_STORE } from './mission-store';
import { MissionPlanningService } from './mission-planning.service';
import { MissionsController } from './missions.controller';
import { TypeOrmMissionStore } from './typeorm-mission-store';

/**
 * Assembles the Mission Planning authoring feature (task 5.3): REST controller,
 * application service, the configurable altitude ceiling, and the TypeORM
 * persistence adapter bound to the {@link MISSION_STORE} port.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MissionEntity, WaypointEntity])],
  controllers: [MissionsController],
  providers: [
    MissionPlanningService,
    TypeOrmMissionStore,
    { provide: MISSION_STORE, useExisting: TypeOrmMissionStore },
    { provide: MISSION_CONFIG, useFactory: loadMissionConfig },
  ],
  exports: [MissionPlanningService],
})
export class MissionsModule {}
