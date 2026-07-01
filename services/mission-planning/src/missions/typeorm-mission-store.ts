import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Mission, Waypoint } from '@pawaac/shared-types';
import { MissionEntity } from './entities/mission.entity';
import { WaypointEntity } from './entities/waypoint.entity';
import { MissionNotFoundError, MissionStore, NewMission } from './mission-store';

/** Maps a persisted mission row (with eager waypoints) to the domain type. */
function toDomain(entity: MissionEntity): Mission {
  const waypoints: Waypoint[] = [...(entity.waypoints ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .map((wp) => ({
      seq: wp.seq,
      lat: wp.lat,
      lon: wp.lon,
      altitude: wp.altitude,
      speed: wp.speed,
      gimbalAngle: wp.gimbalAngle,
      loiterTime: wp.loiterTime,
    }));
  return {
    id: entity.id,
    version: entity.version,
    name: entity.name,
    status: entity.status,
    waypoints,
    createdAt: entity.createdAt.toISOString(),
  };
}

/**
 * Production {@link MissionStore} backed by TypeORM / Postgres. Each version is
 * a self-contained row in `missions` keyed by `(id, version)` with its own
 * `waypoints` rows; appending a version therefore never touches prior rows,
 * which keeps earlier versions byte-identical (Requirements 4.5, 4.7 / P11).
 */
@Injectable()
export class TypeOrmMissionStore implements MissionStore {
  constructor(
    @InjectRepository(MissionEntity)
    private readonly missions: Repository<MissionEntity>,
  ) {}

  async create(input: NewMission): Promise<Mission> {
    const id = randomUUID();
    const saved = await this.persistVersion(id, 1, input);
    return toDomain(saved);
  }

  async addVersion(id: string, input: NewMission): Promise<Mission> {
    const latest = await this.missions.findOne({
      where: { id },
      order: { version: 'DESC' },
    });
    if (!latest) {
      throw new MissionNotFoundError(id);
    }
    const saved = await this.persistVersion(id, latest.version + 1, input);
    return toDomain(saved);
  }

  async findVersion(id: string, version: number): Promise<Mission | null> {
    const entity = await this.missions.findOne({ where: { id, version } });
    return entity ? toDomain(entity) : null;
  }

  async findLatest(id: string): Promise<Mission | null> {
    const entity = await this.missions.findOne({
      where: { id },
      order: { version: 'DESC' },
    });
    return entity ? toDomain(entity) : null;
  }

  /** Builds and inserts a single immutable mission version with its waypoints. */
  private async persistVersion(
    id: string,
    version: number,
    input: NewMission,
  ): Promise<MissionEntity> {
    const waypoints = [...input.waypoints]
      .sort((a, b) => a.seq - b.seq)
      .map((wp) => {
        const entity = new WaypointEntity();
        entity.missionId = id;
        entity.missionVersion = version;
        entity.seq = wp.seq;
        entity.lat = wp.lat;
        entity.lon = wp.lon;
        entity.altitude = wp.altitude;
        entity.speed = wp.speed;
        entity.gimbalAngle = wp.gimbalAngle;
        entity.loiterTime = wp.loiterTime;
        return entity;
      });
    const mission = this.missions.create({
      id,
      version,
      name: input.name,
      status: input.status,
      waypoints,
    });
    return this.missions.save(mission);
  }
}
