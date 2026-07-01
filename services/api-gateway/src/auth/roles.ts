/**
 * RBAC role helpers (Requirement 18.2, 18.4).
 *
 * `Role` is owned by `@pawaac/shared-types`, but that package is ESM-only and is
 * therefore consumed by this CommonJS service via `import type` exclusively (see
 * the note in `tsconfig.json`) — importing its `ROLES` tuple as a *runtime*
 * value would break resolution at boot. We instead keep the privilege ordering
 * locally as a `Record<Role, number>`: because the record must list exactly the
 * members of the `Role` union, it fails to compile if a role is ever added or
 * removed upstream, keeping this table in lock-step with the shared type.
 *
 * Privilege rank increases with privilege (`viewer` < `analyst` < `operator` <
 * `super_admin`). The authorization model is default-deny (Requirement 18.3);
 * the sole exception is that the most-privileged role (Super Admin) inherits any
 * route granted to a lower-privilege role (Requirement 18.4 / property P41).
 */
import type { Role } from '@pawaac/shared-types';

/**
 * Privilege rank per role; higher means more privileged. The
 * `Record<Role, number>` shape makes this exhaustive over the `Role` union at
 * compile time.
 */
const ROLE_PRIVILEGE: Record<Role, number> = {
  viewer: 0,
  analyst: 1,
  operator: 2,
  super_admin: 3,
};

/**
 * All known roles in ascending privilege order. Derived from the privilege
 * table so it cannot drift from {@link ROLE_PRIVILEGE}.
 */
export const ROLES_BY_PRIVILEGE: readonly Role[] = (Object.keys(ROLE_PRIVILEGE) as Role[])
  .slice()
  .sort((a, b) => ROLE_PRIVILEGE[a] - ROLE_PRIVILEGE[b]);

/**
 * The most-privileged role. By Requirement 18.4 it inherits every route
 * permitted to a lower-privilege role.
 */
export const SUPER_ADMIN_ROLE = 'super_admin' satisfies Role;

/** Type guard narrowing an arbitrary value to a known {@link Role}. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLE_PRIVILEGE, value);
}

/**
 * Returns the privilege rank of a role. Higher numbers denote greater
 * privilege.
 */
export function rolePrivilege(role: Role): number {
  return ROLE_PRIVILEGE[role];
}
