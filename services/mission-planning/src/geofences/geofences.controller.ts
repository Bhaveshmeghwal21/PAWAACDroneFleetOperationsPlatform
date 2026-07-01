import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import type { Geofence, GeofenceConflict } from '@pawaac/shared-types';
import { DefineGeofenceDto, DetectConflictsDto } from './dto';
import { GeofenceService } from './geofence.service';

/** REST surface for geofence definition and conflict detection (Requirement 5). */
@Controller('geofences')
export class GeofencesController {
  constructor(private readonly service: GeofenceService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  define(@Body() dto: DefineGeofenceDto): Promise<Geofence> {
    return this.service.defineGeofence(dto);
  }

  @Get()
  list(): Promise<Geofence[]> {
    return this.service.listGeofences();
  }

  /**
   * Detects conflicts for a route supplied as either a `missionId` or an
   * explicit `waypoints` list. Modelled as a POST because it carries a route
   * payload and is a (side-effect-free) computation rather than a resource read.
   */
  @Post('detect-conflicts')
  @HttpCode(HttpStatus.OK)
  detectConflicts(@Body() dto: DetectConflictsDto): Promise<GeofenceConflict[]> {
    return this.service.detectConflicts(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<Geofence> {
    return this.service.getGeofence(id);
  }
}
