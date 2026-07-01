/**
 * Generator-driven property tests for the API Gateway auth/RBAC layer
 * (task 13.3). These complement the focused example-based unit tests in
 * `route-permissions.spec.ts` and `auth.service.spec.ts`.
 *
 * Properties validated (design "Correctness Properties", API Gateway):
 *   - P40 — Default deny       (Requirement 18.3)
 *   - P41 — Role monotonicity  (Requirement 18.4)
 *   - P45 — Auth required       (Requirement 18.1)
 *
 * Each property runs >= 100 iterations (here 200; see NUM_RUNS). The expected
 * outcomes are derived directly from the acceptance criteria — for the RBAC
 * decision we recompute "is this (role, route) explicitly granted (or inherited
 * by Super Admin)?" from the permission map independently of the production
 * branch structure, and for authentication we assert the throw/accept contract
 * against tokens signed with the real JwtService (no crypto mocking).
 */
import fc from 'fast-check';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '@pawaac/shared-types';
import {
  authorize,
  buildPermissionMap,
  routeKey,
  type RouteMeta,
} from './route-permissions';
import { ROLES_BY_PRIVILEGE, SUPER_ADMIN_ROLE, rolePrivilege } from './roles';
import { AuthService } from './auth.service';

const NUM_RUNS = 200;

// --- Shared generators --------------------------------------------------------

/** HTTP methods, including lower-case variants to exercise key normalisation. */
const methodArb = fc.constantFrom('GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'get', 'post');

/**
 * Route paths drawn from a small pool of real and unknown routes, plus random
 * paths. The small pool makes collisions with generated permission-map entries
 * likely, so the default-deny / grant partition is genuinely exercised.
 */
const pathArb = fc.oneof(
  fc.constantFrom(
    '/fleet/drones',
    '/fleet/drones/:id',
    '/missions',
    '/missions/:id',
    '/telemetry/history',
    '/vision/detections',
    '/alerts',
    '/alerts/:id/acknowledge',
    '/unknown',
    '/locked',
  ),
  fc.string({ minLength: 1, maxLength: 12 }).map((s) => `/${s}`),
);

const roleArb: fc.Arbitrary<Role> = fc.constantFrom(...ROLES_BY_PRIVILEGE);

const routeArb: fc.Arbitrary<RouteMeta> = fc.record({ method: methodArb, path: pathArb });

/** A subset (possibly empty) of all roles — empty sets exercise default-deny. */
const roleSubsetArb: fc.Arbitrary<Role[]> = fc.subarray(ROLES_BY_PRIVILEGE as Role[]);

/** A single permission-table entry. */
const entryArb = fc.record({ method: methodArb, path: pathArb, roles: roleSubsetArb });

/** A list of entries used to build a randomised permission map. */
const entriesArb = fc.array(entryArb, { maxLength: 8 });

/** All roles strictly less privileged than Super Admin. */
const LOWER_PRIVILEGE_ROLES: Role[] = ROLES_BY_PRIVILEGE.filter(
  (r) => rolePrivilege(r) < rolePrivilege(SUPER_ADMIN_ROLE),
);

// --- P40 / P41 ----------------------------------------------------------------

describe('RBAC authorize — property tests', () => {
  /**
   * P40 — Default deny. For any (role, route) pair, authorize() grants access
   * if and only if the role is explicitly listed for the route, or the role is
   * Super Admin inheriting a strictly-lower-privilege grant. In particular,
   * unknown routes, empty permitted sets, and unlisted roles are all denied.
   * **Validates: Requirements 18.3**
   */
  it('P40: denies by default and grants only on explicit (or inherited) permission', () => {
    fc.assert(
      fc.property(entriesArb, roleArb, routeArb, (entries, role, route) => {
        const map = buildPermissionMap(entries);
        const permitted = map.get(routeKey(route));

        // Expectation recomputed from the acceptance criteria, independent of
        // the production control flow.
        const explicitlyGranted = permitted?.has(role) ?? false;
        const superAdminInherits =
          role === SUPER_ADMIN_ROLE &&
          permitted !== undefined &&
          [...permitted].some((r) => rolePrivilege(r) < rolePrivilege(SUPER_ADMIN_ROLE));
        const expected = explicitlyGranted || superAdminInherits;

        const actual = authorize(role, route, map);
        expect(actual).toBe(expected);

        // Emphasise the default-deny direction: a non-granted pair is always false.
        if (!expected) {
          expect(actual).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P40 (cont.) — any route absent from the map is denied for every role,
   * regardless of the rest of the map's contents.
   * **Validates: Requirements 18.3**
   */
  it('P40: an unknown route is denied for every role', () => {
    fc.assert(
      fc.property(entriesArb, roleArb, routeArb, (entries, role, route) => {
        const map = buildPermissionMap(entries);
        fc.pre(!map.has(routeKey(route)));
        expect(authorize(role, route, map)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P41 — Role monotonicity. Any route permitted to a strictly-lower-privilege
   * role is also permitted to Super Admin. Built by granting a random route to
   * a non-empty set of lower-privilege roles (amid noise) and asserting Super
   * Admin is allowed.
   * **Validates: Requirements 18.4**
   */
  it('P41: Super Admin inherits any route granted to a lower-privilege role', () => {
    fc.assert(
      fc.property(
        routeArb,
        fc.subarray(LOWER_PRIVILEGE_ROLES, { minLength: 1 }),
        entriesArb,
        (route, grantedLowerRoles, noise) => {
          // Our grant goes last so it wins if any noise entry shares the key.
          const map = buildPermissionMap([
            ...noise,
            { method: route.method, path: route.path, roles: grantedLowerRoles },
          ]);
          expect(authorize(SUPER_ADMIN_ROLE, route, map)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P41 (cont.) — sweep over an arbitrary map: for every route whose permitted
   * set contains a strictly-lower-privilege role, Super Admin must be allowed.
   * **Validates: Requirements 18.4**
   */
  it('P41: every lower-privilege grant in an arbitrary map is inherited by Super Admin', () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        const map = buildPermissionMap(entries);
        for (const [key, permitted] of map) {
          const hasLowerGrant = [...permitted].some(
            (r) => rolePrivilege(r) < rolePrivilege(SUPER_ADMIN_ROLE),
          );
          if (!hasLowerGrant) {
            continue;
          }
          // Reconstruct the route from its canonical "METHOD path" key.
          const spaceIdx = key.indexOf(' ');
          const route: RouteMeta = {
            method: key.slice(0, spaceIdx),
            path: key.slice(spaceIdx + 1),
          };
          expect(authorize(SUPER_ADMIN_ROLE, route, map)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- P45 ----------------------------------------------------------------------

describe('AuthService.authenticate — property tests', () => {
  const SECRET = 'test-secret-value';
  const jwt = new JwtService();
  const service = new AuthService(jwt);
  const originalSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  });

  /** Builds a minimal Express-like request carrying the given Authorization header. */
  function requestWith(authorization?: string): Request {
    return { headers: authorization === undefined ? {} : { authorization } } as Request;
  }

  /** Absent or malformed Authorization headers (no usable bearer token). */
  const malformedAuthArb = fc.oneof(
    fc.constant(undefined),
    fc.constant(''),
    fc.constant('Bearer '),
    fc.constant('Basic dXNlcjpwYXNz'),
    fc.string({ maxLength: 24 }), // arbitrary non-bearer header
    fc.string({ maxLength: 24 }).map((s) => `Bearer ${s}`), // bearer + garbage token
  );

  /**
   * P45 — Auth required. Requests with no token or a malformed/garbage token are
   * rejected (401) before any upstream is reached.
   * **Validates: Requirements 18.1**
   */
  it('P45: rejects missing or malformed Authorization headers', () => {
    fc.assert(
      fc.property(malformedAuthArb, (authorization) => {
        expect(() => service.authenticate(requestWith(authorization))).toThrow(
          UnauthorizedException,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P45 (cont.) — expired tokens (otherwise correctly signed) are rejected.
   * **Validates: Requirements 18.1**
   */
  it('P45: rejects expired tokens', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), roleArb, (ageSeconds, role) => {
        const token = jwt.sign(
          { sub: 'user', role, exp: Math.floor(Date.now() / 1000) - ageSeconds },
          { secret: SECRET },
        );
        expect(() => service.authenticate(requestWith(`Bearer ${token}`))).toThrow(
          UnauthorizedException,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P45 (cont.) — tokens signed with the wrong secret (bad signature) are
   * rejected.
   * **Validates: Requirements 18.1**
   */
  it('P45: rejects tokens signed with the wrong secret', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s !== SECRET),
        roleArb,
        (wrongSecret, role) => {
          const forged = jwt.sign({ sub: 'user', role }, { secret: wrongSecret });
          expect(() => service.authenticate(requestWith(`Bearer ${forged}`))).toThrow(
            UnauthorizedException,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P45 (cont.) — the complement: a well-formed token signed with the configured
   * secret and carrying a known role is accepted, confirming the guard is not
   * vacuously rejecting everything.
   * **Validates: Requirements 18.1, 18.2**
   */
  it('P45: accepts a valid token signed with the configured secret', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 24 }), roleArb, (subject, role) => {
        const token = jwt.sign({ sub: subject, role }, { secret: SECRET });
        const ctx = service.authenticate(requestWith(`Bearer ${token}`));
        expect(ctx).toEqual({ userId: subject, role });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
