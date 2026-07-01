import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Mission, Waypoint } from '@pawaac/shared-types';
import { CreateMissionDto, UpdateMissionDto } from './dto';
import { MISSION_CONFIG, MissionConfig } from './mission.config';
import {
  MISSION_STORE,
  MissionNotFoundError,
  MissionStore,
  NewMission,
} from './mission-store';
import { validateWaypoints } from './waypoint-validation';

/**
 * Mission Planning application service (Requirement 4): validated authoring of
 * immutable, versioned missions.
 *
 * - Creating a mission validates its waypoints and persists version 1.
 * - Editing validates the resulting content and, only when valid, persists a
 *   new version numbered one greater than the prior — invalid edits are
 *   rejected and create no version (Requirements 4.5, 4.6; property P11).
 * - Validation is delegated to the canonical {@link validateWaypoints} function
 *   so the HTTP service and property tests share one definition of validity
 *   (property P10).
 */
@Injectable()
export class MissionPlanningService {
  constructor(
    @Inject(MISSION_STORE) private readonly store: MissionStore,
    @Inject(MISSION_CONFIG) private readonly config: MissionConfig,
  ) {}

  /** Creates and persists version 1 of a new validated mission (4.1–4.4). */
  async createMission(dto: CreateMissionDto): Promise<Mission> {
    const input: NewMission = {
      name: dto.name,
      status: dto.status ?? 'draft',
      waypoints: this.toWaypoints(dto.waypoints),
    };
    this.assertValid(input.waypoints);
    return this.store.create(input);
  }

  /**
   * Edits a mission by persisting a new version. Omitted fields are carried
   * over from the latest version. The edit is validated before anything is
   * written; a failing edit throws and leaves all prior versions intact
   * (4.5–4.7).
   */
  async updateMission(id: string, dto: UpdateMissionDto): Promise<Mission> {
    const latest = await this.store.findLatest(id);
    if (!latest) {
      throw new NotFoundException(`Mission "${id}" was not found`);
    }

    const waypoints =
      dto.waypoints !== undefined ? this.toWaypoints(dto.waypoints) : latest.waypoints;
    const next: NewMission = {
      name: dto.name ?? latest.name,
      status: dto.status ?? latest.status,
      waypoints,
    };
    this.assertValid(next.waypoints);

    try {
      return await this.store.addVersion(id, next);
    } catch (error) {
      if (error instanceof MissionNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  /** Returns the content of a specific mission version (4.8). */
  async getMissionVersion(id: string, version: number): Promise<Mission> {
    const mission = await this.store.findVersion(id, version);
    if (!mission) {
      throw new NotFoundException(`Mission "${id}" version ${version} was not found`);
    }
    return mission;
  }

  /** Returns the latest version of a mission. */
  async getLatestMission(id: string): Promise<Mission> {
    const mission = await this.store.findLatest(id);
    if (!mission) {
      throw new NotFoundException(`Mission "${id}" was not found`);
    }
    return mission;
  }

  /**
   * Runs canonical waypoint validation (property P10) and raises a
   * `400 Bad Request` carrying field-level errors when invalid (4.2, 4.3).
   */
  private assertValid(waypoints: Waypoint[]): void {
    const errors = validateWaypoints(waypoints, this.config.maxAltitude);
    if (errors.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: errors.map((e) => `${e.field}: ${e.message}`),
      });
    }
  }

  /** Narrows validated DTO waypoints to the shared domain `Waypoint` shape. */
  private toWaypoints(waypoints: readonly Waypoint[]): Waypoint[] {
    return waypoints.map((wp) => ({
      seq: wp.seq,
      lat: wp.lat,
      lon: wp.lon,
      altitude: wp.altitude,
      speed: wp.speed,
      gimbalAngle: wp.gimbalAngle,
      loiterTime: wp.loiterTime,
    }));
  }
}
