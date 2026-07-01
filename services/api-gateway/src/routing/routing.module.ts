/**
 * Wires the gateway's routing/reverse-proxy layer (Requirement 20.1, 20.2).
 *
 * Provides the {@link UpstreamRegistry} (pure path→upstream resolution + env
 * base-URL lookup) and the {@link ProxyService} that forwards requests, and
 * registers the {@link ProxyController} catch-all guarded by JWT auth, RBAC and
 * rate limiting. The guards are supplied by {@link AuthModule} and
 * {@link RateLimitModule}.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { UpstreamRegistry } from './upstream-registry.service';

@Module({
  imports: [AuthModule, RateLimitModule],
  controllers: [ProxyController],
  providers: [UpstreamRegistry, ProxyService],
  exports: [UpstreamRegistry, ProxyService],
})
export class RoutingModule {}
