/**
 * TimescaleDB/Postgres connection pool and a lightweight connectivity check
 * used by the readiness endpoint (Requirement 34.1).
 *
 * Persistence and query logic are introduced by later tasks (7.2+); this module
 * only provides the pool factory and a ping used to report readiness.
 */
import pg from 'pg';

const { Pool } = pg;

/** Abstraction over "can we reach the datastore right now?" for readiness. */
export interface ReadinessProbe {
  ping(): Promise<void>;
}

/**
 * Create a pg connection pool for the configured database URL. The pool is
 * created lazily by callers; no connection is opened until first use.
 */
export function createPool(connectionString: string): pg.Pool {
  return new Pool({ connectionString });
}

/**
 * Wrap a pg pool in a {@link ReadinessProbe}. The probe issues a trivial
 * `SELECT 1` so a failure (rejected promise) cleanly signals "not ready".
 */
export function createReadinessProbe(pool: pg.Pool): ReadinessProbe {
  return {
    async ping(): Promise<void> {
      await pool.query('SELECT 1');
    },
  };
}
