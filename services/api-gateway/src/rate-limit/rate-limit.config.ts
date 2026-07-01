/**
 * Per-role rate-limit configuration (Requirement 19.1).
 *
 * The gateway enforces a fixed-window request quota per {@link Role}: each role
 * may issue no more than its configured number of requests within a window of
 * `windowSec` seconds (design property P42 — rate-limit safety). Both the
 * window length and the per-role limits are configurable via environment
 * variables so operators can tune them per deployment without code changes.
 *
 * Environment variables (all optional; sensible defaults applied):
 * - `RATE_LIMIT_WINDOW_SEC`   — window length in seconds (default 60).
 * - `RATE_LIMIT_VIEWER`       — max requests/window for the `viewer` role.
 * - `RATE_LIMIT_ANALYST`      — max requests/window for the `analyst` role.
 * - `RATE_LIMIT_OPERATOR`     — max requests/window for the `operator` role.
 * - `RATE_LIMIT_SUPER_ADMIN`  — max requests/window for the `super_admin` role.
 */
import type { Role } from '@pawaac/shared-types';
import { ROLES_BY_PRIVILEGE } from '../auth/roles';

/** A single role's quota: at most `limit` requests per `windowSec` seconds. */
export interface RateLimitRule {
  /** Maximum number of allowed requests within one window. Must be `>= 0`. */
  readonly limit: number;
  /** Window length in seconds. Must be `> 0`. */
  readonly windowSec: number;
}

/** Resolved per-role quota table. */
export type RateLimitConfig = Readonly<Record<Role, RateLimitRule>>;

/** Default window length (seconds) when `RATE_LIMIT_WINDOW_SEC` is unset. */
export const DEFAULT_WINDOW_SEC = 60;

/**
 * Default per-role request budgets per window. More privileged roles get larger
 * budgets; every role has a finite, positive default so the limiter is always
 * active (default-protect rather than default-allow).
 */
export const DEFAULT_ROLE_LIMITS: Readonly<Record<Role, number>> = {
  viewer: 60,
  analyst: 120,
  operator: 240,
  super_admin: 600,
};

/** Maps a role to the environment variable that overrides its limit. */
function envVarForRole(role: Role): string {
  return `RATE_LIMIT_${role.toUpperCase()}`;
}

/**
 * Parses a non-negative integer from a string, returning `undefined` for
 * missing/blank/invalid/negative values so the caller can fall back to a
 * default.
 */
function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * Builds the per-role {@link RateLimitConfig} from an environment-like record
 * (defaults to `process.env`), applying defaults for any absent/invalid entry.
 */
export function loadRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  const parsedWindow = parseNonNegativeInt(env.RATE_LIMIT_WINDOW_SEC);
  const windowSec = parsedWindow !== undefined && parsedWindow > 0 ? parsedWindow : DEFAULT_WINDOW_SEC;

  const config = {} as Record<Role, RateLimitRule>;
  for (const role of ROLES_BY_PRIVILEGE) {
    const override = parseNonNegativeInt(env[envVarForRole(role)]);
    const limit = override ?? DEFAULT_ROLE_LIMITS[role];
    config[role] = { limit, windowSec };
  }
  return config;
}
