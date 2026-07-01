/**
 * Pure alert-analytics aggregation (task 11.9, Requirement 17; design
 * "Alert & Notification" — alerts per zone / per hour, and the conservation
 * invariant captured as design property P39).
 *
 * Everything in this module is side-effect-free and deterministic: it takes a
 * plain list of alert records (each carrying a creation time and the zone its
 * owning rule scopes) and buckets them by zone and by hour. The database query
 * that loads those records lives in `analytics.service.ts`; keeping the
 * bucketing pure makes the conservation guarantee (the sum of per-zone counts
 * and the sum of per-hour counts each equal the total) trivially unit- and
 * property-testable. The property TESTS (>=100 iterations) are task 11.10.
 */

/** Stable bucket key for alerts whose rule scopes no zone (`zoneId` null). */
export const UNZONED_KEY = 'unzoned';

/** Default and maximum page sizes for an alert-history query (Requirement 17.3). */
export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 1000;

/** Number of milliseconds in one hour; used to truncate timestamps to the hour. */
const MS_PER_HOUR = 3_600_000;

/**
 * One alert as seen by the aggregator. `zoneId` is the zone the alert's *rule*
 * scopes (joined alerts -> rules); `null`/`undefined` means the rule is
 * fleet-wide and the alert is bucketed under {@link UNZONED_KEY}. `createdAt`
 * may be a `Date`, an epoch-millisecond number, or an ISO-8601 string.
 */
export interface AlertAnalyticInput {
  zoneId?: string | null;
  createdAt: Date | string | number;
}

/** Count of alerts attributed to a single zone bucket. */
export interface ZoneCount {
  /** Zone id, or {@link UNZONED_KEY} for alerts with no zone. */
  zoneId: string;
  count: number;
}

/** Count of alerts whose creation time falls in a single UTC-hour bucket. */
export interface HourCount {
  /** ISO-8601 timestamp of the start of the hour (UTC), e.g. `…T12:00:00.000Z`. */
  hourStart: string;
  count: number;
}

/** Alert counts grouped by zone and by hour for a queried range (Requirement 17.1). */
export interface AlertAnalytics {
  /** Inclusive lower bound of the queried range (ISO-8601). */
  from: string;
  /** Inclusive upper bound of the queried range (ISO-8601). */
  to: string;
  /** Total number of alerts in the queried range. */
  total: number;
  /** Per-zone counts; the sum of `count` equals `total` (P39). */
  byZone: ZoneCount[];
  /** Per-hour counts; the sum of `count` equals `total` (P39). */
  byHour: HourCount[];
}

/** Coerce a `Date | string | number` to a `Date`; throws on an unparseable value. */
function toDate(value: Date | string | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid alert timestamp for analytics: "${String(value)}"`);
  }
  return date;
}

/** ISO-8601 timestamp of the start of the UTC hour containing `date`. */
function hourStartIso(date: Date): string {
  const truncated = Math.floor(date.getTime() / MS_PER_HOUR) * MS_PER_HOUR;
  return new Date(truncated).toISOString();
}

/**
 * Group alerts by zone. Every input falls into exactly one bucket
 * ({@link UNZONED_KEY} when it has no zone), so the returned counts sum to
 * `alerts.length`. Buckets are sorted by `zoneId` for deterministic output.
 */
export function groupByZone(alerts: readonly AlertAnalyticInput[]): ZoneCount[] {
  const counts = new Map<string, number>();
  for (const alert of alerts) {
    const key = alert.zoneId == null ? UNZONED_KEY : alert.zoneId;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([zoneId, count]) => ({ zoneId, count }))
    .sort((a, b) => (a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0));
}

/**
 * Group alerts by the UTC hour of their creation time. Every input falls into
 * exactly one hour bucket, so the returned counts sum to `alerts.length`.
 * Buckets are sorted chronologically for deterministic output.
 */
export function groupByHour(alerts: readonly AlertAnalyticInput[]): HourCount[] {
  const counts = new Map<string, number>();
  for (const alert of alerts) {
    const key = hourStartIso(toDate(alert.createdAt));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([hourStart, count]) => ({ hourStart, count }))
    .sort((a, b) => (a.hourStart < b.hourStart ? -1 : a.hourStart > b.hourStart ? 1 : 0));
}

/** Sum the `count` field across a list of buckets. */
export function sumCounts(buckets: readonly { count: number }[]): number {
  return buckets.reduce((total, bucket) => total + bucket.count, 0);
}

/**
 * Build the full {@link AlertAnalytics} result for a queried `[from, to]` range
 * from the alerts that fall within it (Requirement 17.1). By construction the
 * sum of `byZone` counts and the sum of `byHour` counts each equal `total`
 * (Requirement 17.2 / design property P39), because every alert is counted in
 * exactly one zone bucket and exactly one hour bucket.
 */
export function buildAnalytics(
  alerts: readonly AlertAnalyticInput[],
  from: string,
  to: string,
): AlertAnalytics {
  return {
    from,
    to,
    total: alerts.length,
    byZone: groupByZone(alerts),
    byHour: groupByHour(alerts),
  };
}
