/**
 * Property-based tests for the historical telemetry query pipeline (task 7.8,
 * Requirement 10). Uses fast-check with >=100 iterations per property and
 * references the design property numbers it validates.
 *
 * Covered properties:
 *  - P20 — Downsampling bound (Req 10.3): for any valid query requesting B
 *    buckets, {@link PgHistoryQuery} (against a fake DB that honours the SQL
 *    LIMIT and emits evenly-spaced buckets across [from, to]) returns at most B
 *    buckets.
 *  - P21 — Query time-range soundness (Req 10.2): every returned bucket
 *    timestamp ts satisfies from <= ts <= to.
 *
 * The fake {@link HistoryQueryable} mirrors the one in `history.test.ts`: it
 * parses the bucket width / origin / inclusive upper bound / LIMIT out of the
 * generated parameter array, synthesizes evenly-spaced buckets pinned to the
 * range start, and applies the LIMIT — so both properties can be asserted
 * end-to-end and deterministically without a live TimescaleDB.
 */
import fc from 'fast-check';

import {
  MAX_BUCKETS,
  PgHistoryQuery,
  type HistoryQueryable,
  type HistoryRow,
} from './history.js';

/** At least 100 iterations per property (Requirement 30.3); use headroom. */
const NUM_RUNS = 200;

const DRONE_ID = '11111111-1111-1111-1111-111111111111';

/**
 * A fake datastore emulating a database that honours the downsampling SQL: it
 * reads the bucket width (`$1`), bucket origin (`$2`, pinned to the range
 * start), inclusive upper bound (`$5`) and row LIMIT (`$6`) from the parameter
 * array, then emits evenly-spaced buckets across `[origin, to]`, never
 * exceeding the LIMIT. This is the same harness used by the example-based
 * tests, lifted here so the properties exercise the real query pipeline.
 */
function makeFakeDb(): HistoryQueryable {
  return {
    query(_text: string, values: readonly unknown[]) {
      const widthSeconds = Number(values[0]);
      const origin = Date.parse(String(values[1]));
      const toMs = Date.parse(String(values[4]));
      const limit = Number(values[5]);

      const rows: HistoryRow[] = [];
      const stepMs = widthSeconds * 1000;
      for (let t = origin; t <= toMs && rows.length < limit; t += stepMs) {
        rows.push({
          bucket: new Date(t).toISOString(),
          sample_count: 1,
          avg_altitude: 100,
          min_altitude: 100,
          max_altitude: 100,
          avg_bat_remaining_pct: 50,
          min_bat_remaining_pct: 50,
          avg_rc_signal_strength: 75,
          min_rc_signal_strength: 75,
        });
      }
      return Promise.resolve({ rows });
    },
  };
}

/**
 * A valid history query: an integer-ms range with `from <= to` plus a positive
 * requested bucket count. `from` is anchored to integer epoch-ms so the ISO
 * round-trip through {@link Date} is lossless; the duration spans sub-second to
 * ~30 days so the planner exercises raw / 1m / 1h source selection.
 */
const validQueryArb = fc
  .record({
    fromMs: fc.integer({ min: 0, max: 4_102_444_800_000 }),
    durationMs: fc.integer({ min: 0, max: 30 * 24 * 3600 * 1000 }),
    buckets: fc.integer({ min: 1, max: MAX_BUCKETS }),
  })
  .map(({ fromMs, durationMs, buckets }) => ({
    droneId: DRONE_ID,
    from: new Date(fromMs).toISOString(),
    to: new Date(fromMs + durationMs).toISOString(),
    buckets,
  }));

describe('History query property tests — downsampling & range soundness (task 7.8)', () => {
  it('P20 — returns at most the requested number of buckets (Req 10.3)', async () => {
    await fc.assert(
      fc.asyncProperty(validQueryArb, async (input) => {
        const reader = new PgHistoryQuery(makeFakeDb());
        const series = await reader.queryHistory(input);

        // The hard LIMIT (= requested bucket count) caps both the reported
        // count and the materialized points.
        expect(series.bucketCount).toBeLessThanOrEqual(input.buckets);
        expect(series.points.length).toBeLessThanOrEqual(input.buckets);
        expect(series.points.length).toBe(series.bucketCount);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P21 — every returned bucket timestamp satisfies from <= ts <= to (Req 10.2)', async () => {
    await fc.assert(
      fc.asyncProperty(validQueryArb, async (input) => {
        const reader = new PgHistoryQuery(makeFakeDb());
        const series = await reader.queryHistory(input);

        const fromMs = Date.parse(series.from);
        const toMs = Date.parse(series.to);
        for (const point of series.points) {
          const ts = Date.parse(point.ts);
          expect(ts).toBeGreaterThanOrEqual(fromMs);
          expect(ts).toBeLessThanOrEqual(toMs);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
