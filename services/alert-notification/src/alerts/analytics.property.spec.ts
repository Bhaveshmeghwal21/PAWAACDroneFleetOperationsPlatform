import fc from 'fast-check';
import {
  UNZONED_KEY,
  buildAnalytics,
  groupByHour,
  groupByZone,
  sumCounts,
  type AlertAnalyticInput,
} from './analytics.logic';

/**
 * Property-based test for the alert analytics aggregation (task 11.10).
 *
 * Validates **design property P39 — Analytics conservation** (Requirement
 * 17.2): for any set of alerts in a queried range, the sum of the per-zone
 * counts and the sum of the per-hour counts each equal the total number of
 * alerts in that range. The pure aggregator counts every alert in exactly one
 * zone bucket (an unzoned rule falls under the stable `unzoned` key) and exactly
 * one hour bucket, so neither grouping may drop or double-count an alert.
 *
 * The property runs for real (>=100 iterations) with fast-check; it does not
 * depend on any database or Docker.
 */

/** A small zone pool — including `null`/`undefined` — so the `unzoned` bucket and
 * genuine zone collisions are both exercised by the generator. */
const zoneArb: fc.Arbitrary<string | null | undefined> = fc.constantFrom(
  'zone-A',
  'zone-B',
  'zone-C',
  'zone-D',
  null,
  undefined,
);

/**
 * A bounded query window. Timestamps are drawn from a span that comfortably
 * crosses several UTC-hour boundaries (and a day boundary) so per-hour bucketing
 * is meaningfully stressed.
 */
const RANGE_START_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
const RANGE_END_MS = Date.UTC(2024, 0, 3, 0, 0, 0); // 48h window

/** An alert whose creation time lies within the [from, to] query window. */
const inRangeAlertArb: fc.Arbitrary<AlertAnalyticInput> = fc
  .record({
    createdAtMs: fc.integer({ min: RANGE_START_MS, max: RANGE_END_MS }),
    zoneId: zoneArb,
  })
  .map(({ createdAtMs, zoneId }) => {
    const createdAt = new Date(createdAtMs).toISOString();
    // Preserve the distinction between an absent and an explicit-null zone, both
    // of which must collapse into the same `unzoned` bucket.
    return zoneId === undefined ? { createdAt } : { createdAt, zoneId };
  });

const FROM = new Date(RANGE_START_MS).toISOString();
const TO = new Date(RANGE_END_MS).toISOString();

describe('Analytics aggregation — P39: conservation (Req 17.2)', () => {
  it('P39: per-zone and per-hour counts each sum to the total in range', () => {
    fc.assert(
      fc.property(fc.array(inRangeAlertArb, { maxLength: 250 }), (alerts) => {
        const analytics = buildAnalytics(alerts, FROM, TO);

        // Total reflects every alert handed in.
        expect(analytics.total).toBe(alerts.length);
        // P39: neither grouping drops or double-counts an alert.
        expect(sumCounts(analytics.byZone)).toBe(analytics.total);
        expect(sumCounts(analytics.byHour)).toBe(analytics.total);
      }),
      { numRuns: 200 },
    );
  });

  it('P39: groupings never produce empty or duplicate buckets, and every count is positive', () => {
    fc.assert(
      fc.property(fc.array(inRangeAlertArb, { maxLength: 250 }), (alerts) => {
        const byZone = groupByZone(alerts);
        const byHour = groupByHour(alerts);

        // No bucket is empty and every count is a positive integer.
        for (const bucket of [...byZone, ...byHour]) {
          expect(bucket.count).toBeGreaterThan(0);
          expect(Number.isInteger(bucket.count)).toBe(true);
        }

        // Bucket keys are unique (each alert lands in exactly one bucket).
        const zoneKeys = byZone.map((b) => b.zoneId);
        const hourKeys = byHour.map((b) => b.hourStart);
        expect(new Set(zoneKeys).size).toBe(zoneKeys.length);
        expect(new Set(hourKeys).size).toBe(hourKeys.length);

        // Conservation still holds at the grouping level.
        expect(sumCounts(byZone)).toBe(alerts.length);
        expect(sumCounts(byHour)).toBe(alerts.length);
      }),
      { numRuns: 200 },
    );
  });

  it('P39: filtering an arbitrary set to the query range conserves the in-range total', () => {
    // Alerts may fall outside [from, to]; mirror the service, which only feeds
    // the aggregator rows inside the range. Conservation must hold for that
    // in-range subset regardless of how many were excluded.
    const anyTimeAlertArb: fc.Arbitrary<AlertAnalyticInput> = fc
      .record({
        createdAtMs: fc.integer({
          min: RANGE_START_MS - 86_400_000,
          max: RANGE_END_MS + 86_400_000,
        }),
        zoneId: zoneArb,
      })
      .map(({ createdAtMs, zoneId }) => {
        const createdAt = new Date(createdAtMs).toISOString();
        return zoneId === undefined ? { createdAt } : { createdAt, zoneId };
      });

    fc.assert(
      fc.property(fc.array(anyTimeAlertArb, { maxLength: 250 }), (alerts) => {
        const inRange = alerts.filter((a) => {
          const t = new Date(a.createdAt).getTime();
          return t >= RANGE_START_MS && t <= RANGE_END_MS;
        });

        const analytics = buildAnalytics(inRange, FROM, TO);

        expect(analytics.total).toBe(inRange.length);
        expect(sumCounts(analytics.byZone)).toBe(inRange.length);
        expect(sumCounts(analytics.byHour)).toBe(inRange.length);
      }),
      { numRuns: 200 },
    );
  });

  it('P39: an all-unzoned set collapses to a single zone bucket equal to the total', () => {
    const unzonedArb: fc.Arbitrary<AlertAnalyticInput> = fc
      .integer({ min: RANGE_START_MS, max: RANGE_END_MS })
      .map((ms) => ({ createdAt: new Date(ms).toISOString() }));

    fc.assert(
      fc.property(fc.array(unzonedArb, { minLength: 1, maxLength: 250 }), (alerts) => {
        const byZone = groupByZone(alerts);
        expect(byZone).toHaveLength(1);
        expect(byZone[0]?.zoneId).toBe(UNZONED_KEY);
        expect(byZone[0]?.count).toBe(alerts.length);
      }),
      { numRuns: 100 },
    );
  });
});
