/**
 * Wires the gateway's authentication/authorization building blocks
 * (Requirement 18): the JWT service, the {@link AuthService} (verify + RBAC
 * decision) and the {@link JwtAuthGuard}/{@link RbacGuard} guards.
 *
 * The JWT secret is supplied per-verification from the `JWT_SECRET` environment
 * variable inside {@link AuthService}, so `JwtModule` is registered without a
 * static secret here. The routing/proxy layer (task 13.6) applies these guards
 * to upstream routes; rate limiting and tracing are layered on separately
 * (task 13.4).
 */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RbacGuard } from './rbac.guard';

@Module({
  imports: [JwtModule.register({})],
  providers: [AuthService, JwtAuthGuard, RbacGuard],
  exports: [AuthService, JwtAuthGuard, RbacGuard],
})
export class AuthModule {}
