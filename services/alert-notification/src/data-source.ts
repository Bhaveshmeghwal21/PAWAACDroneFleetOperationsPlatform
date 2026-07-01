import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AlertEntity } from './alerts/entities/alert.entity';
import { AlertRuleEntity } from './alerts/entities/alert-rule.entity';
import { ConditionEntity } from './alerts/entities/condition.entity';
import { InitAlertNotification1700000000200 } from './migrations/1700000000200-InitAlertNotification';

/**
 * Persisted entities for the Alert & Notification service. Shared between the
 * running application (registered via `TypeOrmModule.forFeature`) and the
 * migration CLI / data source below so there is a single source of truth.
 */
export const entities = [AlertRuleEntity, ConditionEntity, AlertEntity];

/**
 * Ordered list of versioned migrations. Schema changes flow exclusively through
 * these migrations — runtime synchronization stays disabled (Requirement 28).
 */
export const migrations = [InitAlertNotification1700000000200];

/**
 * Shared TypeORM configuration used by the migration CLI and mirrored by the
 * NestJS `TypeOrmModule` wiring in `app.module.ts`. Environment variables drive
 * all connection details so no secrets are committed (Requirement 31.3).
 */
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env['DB_HOST'] ?? 'localhost',
  port: Number(process.env['DB_PORT'] ?? 5432),
  username: process.env['DB_USER'] ?? 'alert_notification',
  password: process.env['DB_PASSWORD'] ?? 'alert_notification',
  database: process.env['DB_NAME'] ?? 'alert_notification',
  entities,
  migrations,
  migrationsRun: true,
  synchronize: false,
  logging: false,
};

const dataSource = new DataSource(dataSourceOptions);
export default dataSource;
