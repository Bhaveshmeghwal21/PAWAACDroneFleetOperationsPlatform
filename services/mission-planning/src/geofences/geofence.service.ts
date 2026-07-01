import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Geofence, GeofenceConflict, GeoPolygon, Waypoint } from '@pawaac/shared-types';
import { MissionPlanningService } from '../missions/mission-planning.service';
import { DefineGeofenceDto, DetectConflictsDto } from './dto';
import { validateGeofencePolygon } from './geofence-validation';
import { GEOFENCE_STORE, GeofenceStore } from './geofence-store';

/**
 * Mission Planning geofence application service (Requirement 5).
 *
 * - {@link defineGeofence} validates a submitted polygon with the canonical
 *   {@link validateGeofencePolygon} (closed, in-range, non-self-intersecting)
 *   and persists it, rejecting invalid polygons with a `400` (5.1, 5.2).
 * - {@link detectConflicts} resolves a route — either a mission's latest
 *   waypoints or an explicit waypoint list — and delegates to the store, which
 *   returns one conflict per `(segmentIndex, zoneId)` pair. Detection is
 *   deterministic and never mutates its inputs (5.3–5.5, 5.7); the in-memory
 *   store runs the in-process ray-casting detector while production runs PostGIS
 *   `ST_Intersects` (5.6 / P9).
 */
@Injectable()
export class GeofenceService {
  constructor(
    @Inject(GEOFENCE_STORE) private readonly store: GeofenceStore,
    private readonly missions: MissionPlanningService,
  ) {}

  /** Validates and persists a geofence no-fly zone (5.1, 5.2). */
  async defineGeofence(dto: DefineGeofenceDto): Promise<Geofence> {
    const errors = validateGeofencePolygon(dto.polygon);
    if (errors.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: errors.map((e) => `${e.field}: ${e.message}`),
      });
    }
    const polygon = (dto.polygon as number[][]).map(
      (point) => [point[0] as number, point[1] as number] as const,
    ) as GeoPolygon;
    return this.store.create({
      name: dto.name,
      kind: dto.kind ?? 'no_fly',
      polygon,
    });
  }

  /** Returns all persisted geofences. */
  async listGeofences(): Promise<Geofence[]> {
    return this.store.findAll();
  }

  /** Returns a geofence by id, or 404 when unknown. */
  async getGeofence(id: string): Promise<Geofence> {
    const geofence = await this.store.findById(id);
    if (!geofence) {
      throw new NotFoundException(`Geofence "${id}" was not found`);
    }
    return geofence;
  }

  /**
   * Detects geofence conflicts for a route (5.3–5.5). The route is taken from
   * `dto.waypoints` when provided, otherwise from the latest version of
   * `dto.missionId`. Supplying neither is a `400`. A route shorter than two
   * waypoints has no segments and therefore no conflicts.
   */
  async detectConflicts(dto: DetectConflictsDto): Promise<GeofenceConflict[]> {
    const waypoints = await this.resolveWaypoints(dto);
    return this.store.detectConflicts(waypoints);
  }

  /** Resolves the route waypoints from either an explicit list or a mission. */
  private async resolveWaypoints(dto: DetectConflictsDto): Promise<Waypoint[]> {
    if (dto.waypoints && dto.waypoints.length > 0) {
      return dto.waypoints;
    }
    if (dto.missionId) {
      const mission = await this.missions.getLatestMission(dto.missionId);
      return mission.waypoints;
    }
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: ['either missionId or waypoints must be provided'],
    });
  }
}
