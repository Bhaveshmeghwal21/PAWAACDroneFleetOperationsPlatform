import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { GeofenceEntity } from './geofences/entities/geofence.entity';
import { MissionEntity } from './missions/entities/mission.entity';
import { WaypointEntity } from './missions/entities/waypoint.entity';
import { InitMissionPlanning1700000001000 } from './migrations/1700000001000-InitMissionPlanning';

/**
 * Shared TypeORM configuration used both by the running application and by the
 * migration CLI. It targets a PostGIS-enabled Postgres (see docker-compose.yml:
 * `postgres-mission` uses the `postgis/postgis` image) so the geofence polygon
 * geometry column maps cleanly and later tasks can run spatial queries
 * (`ST_Intersects`).
 *
 * Migrations run on startup and schema synchronization is disabled so every
 * schema change flows through versioned migrations (Requirement 28). The
 * mission/waypoint/geofence model and its initial migration are registered
 * here (task 5.2).
 */
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env['DB_HOST'] ?? 'localhost',
  port: Number(process.env['DB_PORT'] ?? 5432),
  username: process.env['DB_USER'] ?? 'postgres',
  password: process.env['DB_PASSWORD'] ?? 'postgres',
  database: process.env['DB_NAME'] ?? 'mission_planning',
  entities: [MissionEntity, WaypointEntity, GeofenceEntity],
  migrations: [InitMissionPlanning1700000001000],
  migrationsRun: true,
  synchronize: false,
  logging: false,
};

const dataSource = new DataSource(dataSourceOptions);
export default dataSource;
