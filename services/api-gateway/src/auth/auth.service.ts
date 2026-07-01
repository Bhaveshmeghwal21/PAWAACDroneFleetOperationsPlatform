/**
 * Authentication and authorization service for the API Gateway
 * (Requirement 18).
 *
 * - {@link AuthService.authenticate} verifies the inbound JWT and extracts the
 *   `{ userId, role }` {@link AuthContext}. It throws `401 Unauthorized` for any
 *   missing, malformed, expired or otherwise invalid token — this runs *before*
 *   the request is proxied to any upstream service (Requirement 18.1, 18.5;
 *   property P45). Token verification uses the `JWT_SECRET` environment secret.
 * - {@link AuthService.authorize} applies the default-deny RBAC decision over
 *   the gateway's {@link DEFAULT_ROUTE_PERMISSIONS} registry (Requirement 18.3,
 *   18.4; properties P40/P41) by delegating to the pure
 *   {@link authorize | authorize() function}.
 */
import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { AuthContext } from '@pawaac/shared-types';
import { isRole } from './roles';
import {
  authorize,
  matchRoute,
  DEFAULT_ROUTE_PERMISSIONS,
  type RouteMeta,
  type RoutePermissionMap,
} from './route-permissions';

/** Prefix of the HTTP `Authorization: Bearer <token>` scheme. */
const BEARER_PREFIX = 'Bearer ';

/**
 * Extracts a bearer token from the request's `Authorization` header, or
 * `undefined` when absent/not a bearer credential.
 */
export function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : undefined;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    // Marked `@Optional()` so the Nest container can construct this provider
    // without a registered binding for the `RoutePermissionMap` type — when
    // none is supplied the gateway's default route-permission registry is used.
    @Optional() private readonly permissions: RoutePermissionMap = DEFAULT_ROUTE_PERMISSIONS,
  ) {}

  /**
   * Verifies the request's JWT and returns the authenticated principal.
   *
   * @throws UnauthorizedException (401) when the token is missing, malformed,
   *   expired, has an invalid signature, or carries an unknown/absent role.
   */
  authenticate(req: Request): AuthContext {
    const token = extractBearerToken(req);
    if (token === undefined) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const secret = process.env.JWT_SECRET;
    if (secret === undefined || secret.length === 0) {
      // A missing server secret is a misconfiguration, not a client error.
      throw new Error('JWT_SECRET is not configured');
    }

    let payload: unknown;
    try {
      payload = this.jwt.verify(token, { secret });
    } catch {
      // Expired, wrong signature, or otherwise malformed (Requirement 18.5).
      throw new UnauthorizedException('Invalid or expired token');
    }

    return this.toAuthContext(payload);
  }

  /**
   * RBAC decision for an authenticated principal against a target route
   * (default-deny; Super Admin inherits lower-privilege routes).
   *
   * The incoming `route` carries the *concrete* request path; it is first
   * resolved to the matching declarative permission pattern (supporting
   * `:param` segments, e.g. `/fleet/drones/123` → `/fleet/drones/:id`) so the
   * decision is made against the canonical route. A concrete path that matches
   * no permission entry is denied by default (P40).
   */
  authorize(ctx: AuthContext, route: RouteMeta): boolean {
    const matched = matchRoute(route, this.permissions);
    if (matched === undefined) {
      return false;
    }
    return authorize(ctx.role, matched, this.permissions);
  }

  /** Validates and narrows a decoded JWT payload into an {@link AuthContext}. */
  private toAuthContext(payload: unknown): AuthContext {
    if (typeof payload !== 'object' || payload === null) {
      throw new UnauthorizedException('Invalid token payload');
    }
    const claims = payload as Record<string, unknown>;
    const subject = claims['sub'] ?? claims['userId'];
    const role = claims['role'];

    if (typeof subject !== 'string' || subject.length === 0) {
      throw new UnauthorizedException('Token is missing a subject');
    }
    if (!isRole(role)) {
      throw new UnauthorizedException('Token carries an unknown role');
    }

    return { userId: subject, role };
  }
}
