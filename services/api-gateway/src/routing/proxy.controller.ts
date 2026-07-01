/**
 * Catch-all reverse-proxy controller for the gateway's upstream API surface
 * (Requirement 20.1, 20.2).
 *
 * The controller binds every gateway-owned path prefix (`/fleet`, `/missions`,
 * …) — derived from {@link UPSTREAM_DEFINITIONS} — and applies the full
 * authenticated-entry-point pipeline before forwarding:
 * {@link JwtAuthGuard} (reject missing/invalid JWT before any upstream),
 * {@link RbacGuard} (default-deny RBAC), then {@link RateLimitGuard} (per-role
 * limit). Only after all guards pass does {@link ProxyService.forward} stream the
 * request to the resolved upstream, injecting the downstream trace headers.
 *
 * Paths that match no prefix never reach this controller and fall through to
 * Nest's default `404` (Requirement 20.2); paths that match a prefix but resolve
 * to no configured upstream are rejected with `404` inside the proxy service.
 */
import { All, Controller, Next, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { ProxyService } from './proxy.service';
import { UPSTREAM_DEFINITIONS } from './upstreams';

/**
 * Express route patterns covering each upstream prefix and everything beneath
 * it (e.g. `/fleet` and `/fleet/*`).
 */
export const PROXY_ROUTE_PATTERNS: readonly string[] = UPSTREAM_DEFINITIONS.flatMap((def) => [
  def.prefix,
  `${def.prefix}/*`,
]);

@ApiExcludeController()
@Controller()
export class ProxyController {
  constructor(private readonly proxy: ProxyService) {}

  @All([...PROXY_ROUTE_PATTERNS])
  @UseGuards(JwtAuthGuard, RbacGuard, RateLimitGuard)
  handle(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    this.proxy.forward(req, res, next);
  }
}
