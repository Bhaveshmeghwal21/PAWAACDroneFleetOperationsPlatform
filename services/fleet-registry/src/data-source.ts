import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ComponentLifecycleEntity } from './drones/entities/component-lifecycle.entity';
import { DroneEntity } from './drones/entities/drone.entity';
import { InitFleetRegistry1700000000000 } from './migrations/1700000000000-InitFleetRegistry';

/**
 * Shared TypeORM configuration used both by the running application and by the
 * migration CLI. Migrations run on startup and schema synchronization is
 * disabled so all schema changes flow through versioned migrations
 * (Requirement 28).
 */
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env['DB_HOST'] ?? 'localhost',
  port: Number(process.env['DB_PORT'] ?? 5432),
  username: process.env['DB_USER'] ?? 'postgres',
  password: process.env['DB_PASSWORD'] ?? 'postgres',
  database: process.env['DB_NAME'] ?? 'fleet_registry',
  entities: [DroneEntity, ComponentLifecycleEntity],
  migrations: [InitFleetRegistry1700000000000],
  migrationsRun: true,
  synchronize: false,
  logging: false,
};

const dataSource = new DataSource(dataSourceOptions);
export default dataSource;
