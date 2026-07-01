import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { MissionEntity } from './mission.entity';

/**
 * A single ordered waypoint belonging to one mission version (Requirement 4,
 * data model in design). Waypoints are part of the immutable mission snapshot,
 * so they are keyed by `(missionId, missionVersion, seq)` and reference the
 * owning {@link MissionEntity} through a composite foreign key.
 *
 * Range/sequence validation (lat/lon/altitude/speed/gimbal/loiter, contiguous
 * `seq` from 0) is enforced by task 5.3; this entity only declares storage.
 */
@Entity('waypoints')
export class WaypointEntity {
  @PrimaryColumn({ type: 'uuid' })
  missionId!: string;

  @PrimaryColumn({ type: 'int' })
  missionVersion!: number;

  /** Contiguous sequence index starting at 0 within a mission version. */
  @PrimaryColumn({ type: 'int' })
  seq!: number;

  /** Latitude in decimal degrees, `[-90, 90]`. */
  @Column({ type: 'double precision' })
  lat!: number;

  /** Longitude in decimal degrees, `[-180, 180]`. */
  @Column({ type: 'double precision' })
  lon!: number;

  /** Altitude in meters, `> 0` and `<= maxAltitude`. */
  @Column({ type: 'double precision' })
  altitude!: number;

  /** Ground/air speed in m/s, `> 0`. */
  @Column({ type: 'double precision' })
  speed!: number;

  /** Gimbal pitch in degrees, `[-90, 90]`. */
  @Column({ type: 'double precision' })
  gimbalAngle!: number;

  /** Loiter duration in seconds, `>= 0`. */
  @Column({ type: 'double precision' })
  loiterTime!: number;

  @ManyToOne(() => MissionEntity, (mission) => mission.waypoints, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    { name: 'missionId', referencedColumnName: 'id' },
    { name: 'missionVersion', referencedColumnName: 'version' },
  ])
  mission!: MissionEntity;
}
