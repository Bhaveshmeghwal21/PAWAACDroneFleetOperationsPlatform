/**
 * Unit tests for the pure RBAC decision function (Requirement 18.3, 18.4).
 *
 * Covers default-deny (property P40) and Super-Admin role monotonicity
 * (property P41) by example; comprehensive property-based coverage lives in
 * task 13.3.
 */
import type { Role } from '@pawaac/shared-types';
import {
  authorize,
  buildPermissionMap,
  DEFAULT_ROUTE_PERMISSIONS,
  matchRoute,
  pathMatchesPattern,
  routeKey,
  type RouteMeta,
  type RoutePermissionMap,
} from './route-permissions';
import { ROLES_BY_PRIVILEGE, SUPER_ADMIN_ROLE } from './roles';

const LOWER_PRIVILEGE_ROLES: Role[] = ROLES_BY_PRIVILEGE.filter((r) => r !== SUPER_ADMIN_ROLE);

describe('routeKey', () => {
  it('normalises the method to upper-case', () => {
    expect(routeKey({ method: 'get', path: '/fleet/drones' })).toBe('GET /fleet/drones');
  });
});

describe('authorize (default-deny, P40)', () => {
  const route: RouteMeta = { method: 'GET', path: '/fleet/drones' };
  const permissions: RoutePermissionMap = buildPermissionMap([
    { method: 'GET', path: '/fleet/drones', roles: ['analyst', 'operator'] },
  ]);

  it('permits a role explicitly listed for the route', () => {
    expect(authorize('analyst', route, permissions)).toBe(true);
    expect(authorize('operator', route, permissions)).toBe(true);
  });

  it('denies a role not explicitly listed for the route', () => {
    expect(authorize('viewer', route, permissions)).toBe(false);
  });

  it('denies every role for an unknown route', () => {
    const unknown: RouteMeta = { method: 'DELETE', path: '/unknown' };
    for (const role of ROLES_BY_PRIVILEGE) {
      expect(authorize(role, unknown, permissions)).toBe(false);
    }
  });

  it('denies every role when the route has an empty permitted set', () => {
    const empty = buildPermissionMap([{ method: 'GET', path: '/locked', roles: [] }]);
    for (const role of ROLES_BY_PRIVILEGE) {
      expect(authorize(role, { method: 'GET', path: '/locked' }, empty)).toBe(false);
    }
  });

  it('treats the method as part of the route identity', () => {
    // POST is not permitted even though GET on the same path is.
    expect(authorize('operator', { method: 'POST', path: '/fleet/drones' }, permissions)).toBe(
      false,
    );
  });
});

describe('authorize (role monotonicity, P41)', () => {
  it('grants Super Admin any route permitted to a lower-privilege role', () => {
    for (const lower of LOWER_PRIVILEGE_ROLES) {
      const permissions = buildPermissionMap([
        { method: 'GET', path: '/r', roles: [lower] },
      ]);
      expect(authorize(SUPER_ADMIN_ROLE, { method: 'GET', path: '/r' }, permissions)).toBe(true);
    }
  });

  it('still denies Super Admin on an unknown route (default-deny is not bypassed)', () => {
    const permissions = buildPermissionMap([
      { method: 'GET', path: '/r', roles: ['viewer'] },
    ]);
    expect(authorize(SUPER_ADMIN_ROLE, { method: 'GET', path: '/other' }, permissions)).toBe(false);
  });

  it('does not let a non-super-admin role inherit a lower role\u2019s route', () => {
    // operator is higher-privilege than viewer, but only super_admin inherits.
    const permissions = buildPermissionMap([
      { method: 'GET', path: '/r', roles: ['viewer'] },
    ]);
    expect(authorize('operator', { method: 'GET', path: '/r' }, permissions)).toBe(false);
    expect(authorize('analyst', { method: 'GET', path: '/r' }, permissions)).toBe(false);
  });
});

describe('pathMatchesPattern', () => {
  it('matches an exact, param-free path', () => {
    expect(pathMatchesPattern('/fleet/drones', '/fleet/drones')).toBe(true);
  });

  it('matches a concrete segment against a :param placeholder', () => {
    expect(pathMatchesPattern('/fleet/drones/123', '/fleet/drones/:id')).toBe(true);
    expect(pathMatchesPattern('/alerts/abc/acknowledge', '/alerts/:id/acknowledge')).toBe(true);
  });

  it('rejects paths of differing segment length', () => {
    expect(pathMatchesPattern('/fleet/drones', '/fleet/drones/:id')).toBe(false);
    expect(pathMatchesPattern('/fleet/drones/123/extra', '/fleet/drones/:id')).toBe(false);
  });

  it('rejects a non-matching literal segment', () => {
    expect(pathMatchesPattern('/fleet/missions/123', '/fleet/drones/:id')).toBe(false);
  });
});

describe('matchRoute (concrete path -> permission pattern)', () => {
  const permissions: RoutePermissionMap = buildPermissionMap([
    { method: 'GET', path: '/fleet/drones', roles: ['viewer'] },
    { method: 'GET', path: '/fleet/drones/:id', roles: ['viewer'] },
    { method: 'POST', path: '/alerts/:id/acknowledge', roles: ['operator'] },
  ]);

  it('resolves an exact path to its canonical route', () => {
    expect(matchRoute({ method: 'GET', path: '/fleet/drones' }, permissions)).toEqual({
      method: 'GET',
      path: '/fleet/drones',
    });
  });

  it('resolves a concrete id path to its :param pattern', () => {
    expect(matchRoute({ method: 'GET', path: '/fleet/drones/123' }, permissions)).toEqual({
      method: 'GET',
      path: '/fleet/drones/:id',
    });
    expect(matchRoute({ method: 'POST', path: '/alerts/77/acknowledge' }, permissions)).toEqual({
      method: 'POST',
      path: '/alerts/:id/acknowledge',
    });
  });

  it('normalises the method to upper-case when matching', () => {
    expect(matchRoute({ method: 'get', path: '/fleet/drones/9' }, permissions)).toEqual({
      method: 'GET',
      path: '/fleet/drones/:id',
    });
  });

  it('returns undefined when no permission entry matches', () => {
    expect(matchRoute({ method: 'GET', path: '/unknown/path' }, permissions)).toBeUndefined();
    // Right path shape, wrong method.
    expect(matchRoute({ method: 'DELETE', path: '/fleet/drones/1' }, permissions)).toBeUndefined();
  });
});

describe('DEFAULT_ROUTE_PERMISSIONS registry', () => {
  it('permits viewers to read the fleet but not to create drones', () => {
    expect(
      authorize('viewer', { method: 'GET', path: '/fleet/drones' }, DEFAULT_ROUTE_PERMISSIONS),
    ).toBe(true);
    expect(
      authorize('viewer', { method: 'POST', path: '/fleet/drones' }, DEFAULT_ROUTE_PERMISSIONS),
    ).toBe(false);
  });

  it('grants Super Admin access to operator-only writes via inheritance', () => {
    expect(
      authorize(
        SUPER_ADMIN_ROLE,
        { method: 'POST', path: '/fleet/drones' },
        DEFAULT_ROUTE_PERMISSIONS,
      ),
    ).toBe(true);
  });
});
