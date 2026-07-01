/**
 * Route-permission registry and the pure RBAC decision function
 * (Requirement 18.3, 18.4 — properties P40 default-deny, P41 role
 * monotonicity).
 *
 * The {@link authorize} function is intentionally **pure**: it depends only on
 * its arguments `(role, route, permissions)` and performs no I/O, so it is
 * trivially unit- and property-testable. The gateway's runtime wiring (the
 * RBAC guard) supplies the request's role/route and the
 * {@link DEFAULT_ROUTE_PERMISSIONS} map; the routing layer that maps incoming
 * paths to upstream targets is implemented separately (task 13.6).
 */
import type { Role } from '@pawaac/shared-types';
import { SUPER_ADMIN_ROLE, rolePrivilege } from './roles';

/**
 * Identifies a target route for an authorization decision. A route is the
 * combination of an HTTP method and a path pattern.
 */
export interface RouteMeta {
  /** HTTP method, e.g. `GET` (compared case-insensitively). */
  method: string;
  /** Route path/pattern, e.g. `/fleet/drones`. */
  path: string;
}

/** Maps a canonical route key to the set of roles explicitly permitted on it. */
export type RoutePermissionMap = ReadonlyMap<string, ReadonlySet<Role>>;

/** Builds the canonical, case-normalised key for a route. */
export function routeKey(route: RouteMeta): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

/** Splits a path into its non-empty segments (e.g. `/fleet/drones` → `['fleet','drones']`). */
function pathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * True iff a concrete request path matches a route pattern that may contain
 * `:param` placeholders (e.g. concrete `/fleet/drones/123` matches the pattern
 * `/fleet/drones/:id`). A `:param` segment matches exactly one non-empty
 * concrete segment; all other segments must be string-equal.
 */
export function pathMatchesPattern(concretePath: string, pattern: string): boolean {
  const concrete = pathSegments(concretePath);
  const patternSegments = pathSegments(pattern);
  if (concrete.length !== patternSegments.length) {
    return false;
  }
  return patternSegments.every((segment, index) => {
    if (segment.startsWith(':')) {
      return concrete[index] !== undefined && concrete[index]!.length > 0;
    }
    return segment === concrete[index];
  });
}

/**
 * Resolves a concrete request `(method, path)` to the canonical {@link RouteMeta}
 * of the matching permission entry, supporting `:param` patterns. Used by the
 * gateway's RBAC layer to map a concrete proxied path (which Express only ever
 * matches against the proxy's wildcard route) onto the declarative permission
 * table before the {@link authorize} decision.
 *
 * An exact (param-free) match is preferred over a `:param` match; among multiple
 * `:param` matches the first in iteration order wins. Returns `undefined` when
 * no permission entry matches the concrete route (the caller then default-denies
 * per P40).
 */
export function matchRoute(
  route: RouteMeta,
  permissions: RoutePermissionMap,
): RouteMeta | undefined {
  const method = route.method.toUpperCase();

  // Fast path: an exact key match (also covers routes without :param segments).
  if (permissions.has(routeKey(route))) {
    return { method, path: route.path };
  }

  let paramMatch: RouteMeta | undefined;
  for (const key of permissions.keys()) {
    const spaceIndex = key.indexOf(' ');
    const keyMethod = key.slice(0, spaceIndex);
    const keyPath = key.slice(spaceIndex + 1);
    if (keyMethod !== method) {
      continue;
    }
    if (keyPath === route.path) {
      return { method, path: keyPath };
    }
    if (paramMatch === undefined && pathMatchesPattern(route.path, keyPath)) {
      paramMatch = { method, path: keyPath };
    }
  }
  return paramMatch;
}

/**
 * Decides whether `role` may access `route` given the explicit permission map.
 *
 * The contract (mirrors design `authorize` Pre/Post and properties P40/P41):
 * - **Default-deny (P40):** returns `false` for any `(role, route)` pair that is
 *   not explicitly permitted — including unknown routes and routes with an empty
 *   permitted set.
 * - **Explicit grant:** returns `true` when the route's permitted set contains
 *   `role`.
 * - **Role monotonicity (P41):** the Super Admin role additionally inherits any
 *   route that is permitted to a strictly lower-privilege role.
 *
 * @param role        the authenticated requester's role
 * @param route       the target route
 * @param permissions the explicit role-per-route registry
 */
export function authorize(role: Role, route: RouteMeta, permissions: RoutePermissionMap): boolean {
  const permitted = permissions.get(routeKey(route));

  // Default-deny: unknown route or no role permitted at all.
  if (permitted === undefined || permitted.size === 0) {
    return false;
  }

  // Explicit grant.
  if (permitted.has(role)) {
    return true;
  }

  // Role monotonicity (P41): Super Admin (highest privilege) inherits any route
  // granted to a strictly lower-privilege role.
  if (role === SUPER_ADMIN_ROLE) {
    const requesterPrivilege = rolePrivilege(role);
    for (const allowedRole of permitted) {
      if (rolePrivilege(allowedRole) < requesterPrivilege) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Declarative permission table: each known route lists the roles explicitly
 * permitted on it. Super Admin is intentionally omitted from these lists — it is
 * granted implicitly by the monotonicity rule in {@link authorize}. Any route
 * not listed here is denied by default (P40).
 *
 * This is the gateway's source of truth for per-route RBAC; the routing layer
 * (task 13.6) maps concrete request paths onto these route patterns.
 */
const ROUTE_PERMISSION_TABLE: ReadonlyArray<{
  method: string;
  path: string;
  roles: readonly Role[];
}> = [
  // Fleet Registry — reads open to all hands-on roles; writes restricted to operator.
  { method: 'GET', path: '/fleet/drones', roles: ['viewer', 'analyst', 'operator'] },
  { method: 'GET', path: '/fleet/drones/:id', roles: ['viewer', 'analyst', 'operator'] },
  { method: 'POST', path: '/fleet/drones', roles: ['operator'] },
  { method: 'PATCH', path: '/fleet/drones/:id', roles: ['operator'] },
  // Mission Planning — operators plan/edit; analysts and viewers may read.
  { method: 'GET', path: '/missions', roles: ['viewer', 'analyst', 'operator'] },
  { method: 'POST', path: '/missions', roles: ['operator'] },
  { method: 'PATCH', path: '/missions/:id', roles: ['operator'] },
  // Telemetry — read access for monitoring and analysis.
  { method: 'GET', path: '/telemetry/history', roles: ['viewer', 'analyst', 'operator'] },
  // Vision AI detections — analysts and operators query results.
  { method: 'GET', path: '/vision/detections', roles: ['analyst', 'operator'] },
  // Alerts — operators acknowledge; analysts and operators view history.
  { method: 'GET', path: '/alerts', roles: ['viewer', 'analyst', 'operator'] },
  { method: 'POST', path: '/alerts/:id/acknowledge', roles: ['operator'] },
];

/** Builds an immutable {@link RoutePermissionMap} from the declarative table. */
export function buildPermissionMap(
  table: ReadonlyArray<{ method: string; path: string; roles: readonly Role[] }>,
): RoutePermissionMap {
  const map = new Map<string, ReadonlySet<Role>>();
  for (const entry of table) {
    map.set(routeKey({ method: entry.method, path: entry.path }), new Set(entry.roles));
  }
  return map;
}

/** The gateway's default role-per-route registry. */
export const DEFAULT_ROUTE_PERMISSIONS: RoutePermissionMap =
  buildPermissionMap(ROUTE_PERMISSION_TABLE);
