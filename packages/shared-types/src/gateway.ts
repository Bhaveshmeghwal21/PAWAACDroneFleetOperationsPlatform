/**
 * API Gateway domain types: roles used for RBAC authorization.
 */

/**
 * RBAC roles, ordered from least to most privileged for documentation
 * purposes. Authorization is default-deny; `super_admin` inherits routes
 * permitted to lower-privilege roles.
 */
export const ROLES = ['viewer', 'analyst', 'operator', 'super_admin'] as const;
export type Role = (typeof ROLES)[number];

/** An authenticated principal extracted from a verified JWT. */
export interface AuthContext {
  userId: string;
  role: Role;
}
