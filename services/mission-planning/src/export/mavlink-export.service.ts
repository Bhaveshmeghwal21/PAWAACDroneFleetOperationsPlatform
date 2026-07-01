import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GeofenceService } from '../geofences/geofence.service';
import { MissionPlanningService } from '../missions/mission-planning.service';
import { exportMavlink, MavlinkFormat, MavlinkMission } from './mavlink';

/**
 * Application service for PX4 MAVLink export (Requirement 7, design Algorithm 7).
 *
 * It orchestrates the two preconditions that guard the pure serialization in
 * {@link exportMavlink}:
 *
 * - The mission must be `validated` — otherwise the export is rejected
 *   (`422 Unprocessable Entity`, Requirement 7.2). Loading the mission via
 *   {@link MissionPlanningService} also yields a `404` for unknown ids.
 * - Geofence conflict detection must return an empty result — a non-empty
 *   result blocks the export with `409 Conflict` (Requirement 7.7).
 *
 * Wiring {@link GeofenceService} here (rather than into the authoring service)
 * keeps the dependency graph acyclic: `GeofenceService` already depends on
 * `MissionPlanningService`, and this export service depends on both.
 */
@Injectable()
export class MavlinkExportService {
  constructor(
    private readonly missions: MissionPlanningService,
    private readonly geofences: GeofenceService,
  ) {}

  /**
   * Exports the latest version of a mission to MAVLink in the requested format.
   *
   * @throws {NotFoundException} when the mission id is unknown (via the
   * authoring service).
   * @throws {UnprocessableEntityException} when the mission is not `validated`
   * (Requirement 7.2).
   * @throws {ConflictException} when geofence conflict detection returns a
   * non-empty result (Requirement 7.7).
   */
  async exportMission(missionId: string, format: MavlinkFormat): Promise<MavlinkMission> {
    const mission = await this.missions.getLatestMission(missionId);

    if (mission.status !== 'validated') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: `Mission "${missionId}" must be validated before it can be exported`,
      });
    }

    const conflicts = await this.geofences.detectConflicts({ waypoints: mission.waypoints });
    if (conflicts.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `Mission "${missionId}" has ${conflicts.length} geofence conflict(s); export is blocked`,
        conflicts,
      });
    }

    return exportMavlink(mission, format);
  }
}
