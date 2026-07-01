/**
 * Redis connectivity for the API Gateway service.
 *
 * Redis backs the per-role token-bucket rate-limit counters (implemented in a
 * later task). This module only establishes a shared, injectable `ioredis`
 * client and exposes it for readiness checks; it does NOT implement any
 * rate-limiting logic yet.
 */
import {
  Global,
  Logger,
  Module,
  type OnModuleDestroy,
  type Provider,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';

/** DI token for the shared ioredis client. */
export const REDIS_CLIENT = 'REDIS_CLIENT';

const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    const logger = new Logger('RedisClient');
    const client = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
      db: config.get<number>('REDIS_DB', 1),
      // Do not crash the process on a transient connection blip; readiness
      // checks surface unavailability instead.
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    client.on('error', (err: Error) => logger.error(`Redis error: ${err.message}`));
    return client;
  },
};

@Global()
@Module({
  imports: [ConfigModule],
  providers: [redisProvider],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onModuleDestroy(): Promise<void> {
    const client = this.moduleRef.get<Redis>(REDIS_CLIENT, { strict: false });
    if (client) {
      await client.quit().catch(() => undefined);
    }
  }
}
