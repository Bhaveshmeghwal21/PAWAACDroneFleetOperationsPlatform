/**
 * `pg`-backed adapter for the historical telemetry query (Requirement 10).
 *
 * Kept separate from the pure query-shaping logic in `./history.ts` so that
 * module stays database-agnostic and trivially unit-testable. This thin wrapper
 * adapts a `pg.Pool` to the {@link HistoryQueryable} seam.
 */
import type pg from 'pg';
import {
  PgHistoryQuery,
  type HistoryQueryable,
  type HistoryQueryReader,
  type HistoryRow,
} from './history.js';

/** Adapt a `pg.Pool` (or pooled client) to a {@link HistoryQueryReader}. */
export function createPgHistoryQuery(pool: pg.Pool): HistoryQueryReader {
  const queryable: HistoryQueryable = {
    async query(queryText: string, values: readonly unknown[]) {
      const result = await pool.query(queryText, values as unknown[]);
      return { rows: result.rows as HistoryRow[] };
    },
  };
  return new PgHistoryQuery(queryable);
}
