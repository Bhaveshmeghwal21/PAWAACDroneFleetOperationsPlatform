import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { ComponentLifecycle, Drone, MaintenanceAlert } from '@pawaac/shared-types';
import { ComponentUsageDto, CreateDroneDto, DroneFilterDto, UpdateDroneDto } from './dto';
import { FleetRegistryService } from './fleet-registry.service';

/** REST surface for drone and component operations (Requirement 3.1). */
@Controller('drones')
export class DronesController {
  constructor(private readonly service: FleetRegistryService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateDroneDto): Promise<Drone> {
    return this.service.createDrone(dto);
  }

  @Get()
  list(@Query() filter: DroneFilterDto): Promise<Drone[]> {
    return this.service.listDrones(filter);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<Drone> {
    return this.service.getDrone(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDroneDto): Promise<Drone> {
    return this.service.updateDrone(id, dto);
  }

  @Post(':id/decommission')
  decommission(@Param('id', ParseUUIDPipe) id: string): Promise<Drone> {
    return this.service.decommissionDrone(id);
  }

  @Post(':id/component-usage')
  recordUsage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ComponentUsageDto,
  ): Promise<ComponentLifecycle> {
    return this.service.recordComponentUsage(id, dto);
  }

  @Get(':id/maintenance')
  maintenance(@Param('id', ParseUUIDPipe) id: string): Promise<MaintenanceAlert[]> {
    return this.service.evaluateMaintenance(id);
  }
}
