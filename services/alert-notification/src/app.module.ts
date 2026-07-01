/**
 * Root module for the Alert & Notification service.
 *
 * Bootstraps configuration, the Postgres (TypeORM) connection, the shared Redis
 * client, health/readiness endpoints, the in-app WebSocket transport, and the
 * trace-id propagation middleware. Domain features (rule engine, dispatch,
 * escalation, analytics) are layered on by later tasks.
 */
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertsModule } from './alerts/alerts.module';
import { TraceIdMiddleware } from './common/trace';
import { migrations } from './data-source';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USER', 'alert_notification'),
        password: config.get<string>('DB_PASSWORD', ''),
        database: config.get<string>('DB_NAME', 'alert_notification'),
        autoLoadEntities: true,
        // Schema changes are managed by versioned migrations (this task 11.2
        // onward), never by runtime synchronization. Migrations run on startup
        // so the service fails fast on a schema mismatch (Requirement 28).
        synchronize: false,
        migrations,
        migrationsRun: true,
        retryAttempts: 5,
        retryDelay: 2000,
      }),
    }),
    RedisModule,
    HealthModule,
    NotificationsModule,
    AlertsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceIdMiddleware).forRoutes('*');
  }
}
