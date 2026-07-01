/**
 * Root module for the API Gateway service.
 *
 * Bootstraps configuration, the shared Redis client (rate-limit counter store),
 * health/readiness endpoints, the trace-id propagation middleware, and the
 * authenticated entry-point features — JWT authentication, RBAC authorization,
 * per-role rate limiting (applied by the routing layer), upstream
 * routing/proxying ({@link RoutingModule}) and the merged OpenAPI surface
 * ({@link OpenApiModule}).
 */
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { RequestLoggingInterceptor } from './common/request-logging.interceptor';
import { TraceIdMiddleware } from './common/trace';
import { HealthModule } from './health/health.module';
import { OpenApiModule } from './openapi/openapi.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RedisModule } from './redis/redis.module';
import { RoutingModule } from './routing/routing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RedisModule,
    HealthModule,
    AuthModule,
    RateLimitModule,
    RoutingModule,
    OpenApiModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceIdMiddleware).forRoutes('*');
  }
}
