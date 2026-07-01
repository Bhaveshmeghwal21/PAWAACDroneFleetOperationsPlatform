import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsModule } from '../events/events.module';
import { DRONE_STORE } from './drone-store';
import { DronesController } from './drones.controller';
import { ComponentLifecycleEntity } from './entities/component-lifecycle.entity';
import { DroneEntity } from './entities/drone.entity';
import { FleetRegistryService } from './fleet-registry.service';
import { TypeOrmDroneStore } from './typeorm-drone-store';

/** Assembles the Fleet Registry drone feature: REST, service, store, events. */
@Module({
  imports: [TypeOrmModule.forFeature([DroneEntity, ComponentLifecycleEntity]), EventsModule],
  controllers: [DronesController],
  providers: [
    FleetRegistryService,
    TypeOrmDroneStore,
    { provide: DRONE_STORE, useExisting: TypeOrmDroneStore },
  ],
  exports: [FleetRegistryService],
})
export class DronesModule {}
