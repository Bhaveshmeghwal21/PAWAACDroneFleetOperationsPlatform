/**
 * Historical telemetry query with time-range filtering and downsampling
 * (Requirement 10, design `queryHistory(q)` contract; properties P20/P21).
 *
 * Query-shaping is split into small, side-effect-free functions so the
 * behaviour that the spec cares about — input validation (including the
 * `from > to` rejection, Req 10.4), bucket selection / downsample cap
 * (Req 10.3 / P20), and the range predicate (Req 10.1/10.2 / P21) — is unit
 * testable without a live database. The actual SQL execution is hidden behind
 * the injectable {@link HistoryQueryable} interface (satisfied by `pg.Pool`),
 * mirroring the persistence layer's {@link import('../persist/store.js').Queryable}
 * seam.
 *
 * Downsampling is expressed with TimescaleDB `time_bucket(...)`, reading from
 * the coarse continuous aggregates (`telemetry_sample_1m` / `telemetry_sample_1h`)
 * when the requested bucket width is coarse enough, and from the base
 * `telemetry_sample` hypertable otherwise. The bucket origin is pinned to the
 * range start so every emitted bucket timestamp satisfies `from <= ts <= to`
 * (P21), and a hard `LIMIT` equal to the requested bucket count guarantees the
 * result never exceeds it (P20).
 */
import type { IsoTimestamp, Uuid } from '@pawaac/shared-types';

/** Base hypertable holding raw normalized samples. */
const TABLE = 'telemetry_sample';
/** 1-minute downsampling continuous aggregate. */
const CAGG_1M = 'telemetry_sample_1m';
/** 1-hour downsampling continuous aggregate. */
const CAGG_1H = 'telemetry_sample_1h';

/** Default bucket cap applied when a caller does not request one. */
export const DEFAULT_BUCKETS = 500;
/** Upper safety bound on the requested bucket count. */
export const MAX_BUCKETS = 5000;

/** Bucket widths (seconds) at which a coarser source aggregate is preferred. */
const ONE_MINUTE_SECONDS = 60;
const ONE_HOUR_SECONDS = 3600;

/**
 * Raw query parameters as received from a caller / REST endpoint. `from` and
 * `to` are ISO-8601 timestamps; `buckets` may arrive as a query-string value.
 */
export interface HistoryQueryInput {
  readonly droneId: string;
  readonly from: string;
  readonly to: string;
  readonly buckets?: string | number | undefined;
}

/** A validated, normalized query (canonical ISO timestamps + resolved cap). */
export interface NormalizedHistoryQuery {
  readonly droneId: Uuid;
  /** Canonical ISO-8601 (UTC) range start. */
  readonly from: IsoTimestamp;
  /** Canonical ISO-8601 (UTC) range end. */
  readonly to: IsoTimestamp;
  readonly fromMs: number;
  readonly toMs: number;
  /** Resolved bucket cap: a positive integer in `[1, MAX_BUCKETS]`. */
  readonly buckets: number;
}

/** Which relation a query reads from. */
export type HistorySource = 'raw' | '1m' | '1h';

/** A pure plan describing how the downsampled SQL should be shaped. */
export interface QueryPlan {
  readonly source: HistorySource;
  /** Physical relation name to read from. */
  readonly relation: string;
  /** Time column on the chosen relation (`ts` for raw, `bucket` for caggs). */
  readonly timeColumn: 'ts' | 'bucket';
  /** Bucket width in whole seconds (>= 1). */
  readonly bucketSeconds: number;
  /** Hard row cap (equal to the requested bucket count). */
  readonly limit: number;
  /** True when reading from a pre-aggregated continuous aggregate. */
  readonly fromAggregate: boolean;
}

/** One downsampled bucket of telemetry. */
export interface TelemetryBucket {
  /** Bucket start timestamp; always within `[from, to]`. */
  readonly ts: IsoTimestamp;
  /** Number of underlying raw samples contributing to the bucket. */
  readonly sampleCount: number;
  readonly avgAltitude: number | null;
  readonly minAltitude: number | null;
  readonly maxAltitude: number | null;
  readonly avgBatRemainingPct: number | null;
  readonly minBatRemainingPct: number | null;
  readonly avgRcSignalStrength: number | null;
  readonly minRcSignalStrength: number | null;
}

/** Result of {@link HistoryQueryReader.queryHistory}. */
export interface TelemetrySeries {
  readonly droneId: Uuid;
  readonly from: IsoTimestamp;
  readonly to: IsoTimestamp;
  /** Effective bucket width (seconds) used for downsampling. */
  readonly bucketSeconds: number;
  /** Number of buckets returned (always `<= requested buckets`). */
  readonly bucketCount: number;
  /** Which relation served the query. */
  readonly source: HistorySource;
  readonly points: readonly TelemetryBucket[];
}

/** A single untyped row returned by the datastore. */
export type HistoryRow = Record<string, unknown>;

/** Minimal query surface needed for reads (satisfied by `pg.Pool`). */
export interface HistoryQueryable {
  query(queryText: string, values: readonly unknown[]): Promise<{ rows: HistoryRow[] }>;
}

/** Reader abstraction the HTTP layer depends on. */
export interface HistoryQueryReader {
  queryHistory(input: HistoryQueryInput): Promise<TelemetrySeries>;
}

/**
 * Raised when a query fails validation. Maps to an HTTP 400 at the REST edge
 * (Req 10.4); `status` is carried so the handler need not re-derive it.
 */
export class HistoryQueryValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'HistoryQueryValidationError';
  }
}

/** Parse an ISO timestamp to epoch millis, or `null` when unparseable. */
function parseTimestamp(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Resolve the requested bucket cap. Unset/blank falls back to
 * {@link DEFAULT_BUCKETS}; otherwise the value must be a positive integer and
 * is clamped to {@link MAX_BUCKETS}.
 */
function resolveBuckets(raw: string | number | undefined): number {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return DEFAULT_BUCKETS;
  }
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HistoryQueryValidationError(
      `"buckets" must be a positive integer, received "${String(raw)}".`,
    );
  }
  return Math.min(parsed, MAX_BUCKETS);
}

/**
 * Validate and normalize a raw query. Throws {@link HistoryQueryValidationError}
 * (HTTP 400) for a missing/empty drone id, unparseable timestamps, an inverted
 * range (`from > to`, Req 10.4), or an invalid bucket count.
 */
export function validateHistoryQuery(input: HistoryQueryInput): NormalizedHistoryQuery {
  const droneId = input.droneId?.trim();
  if (!droneId) {
    throw new HistoryQueryValidationError('"droneId" is required.');
  }

  const fromMs = parseTimestamp(input.from);
  if (fromMs === null) {
    throw new HistoryQueryValidationError(`"from" is not a valid ISO timestamp: "${input.from}".`);
  }
  const toMs = parseTimestamp(input.to);
  if (toMs === null) {
    throw new HistoryQueryValidationError(`"to" is not a valid ISO timestamp: "${input.to}".`);
  }

  if (fromMs > toMs) {
    throw new HistoryQueryValidationError(
      `"from" (${input.from}) must be less than or equal to "to" (${input.to}).`,
    );
  }

  const buckets = resolveBuckets(input.buckets);

  return {
    droneId,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    fromMs,
    toMs,
    buckets,
  };
}

/**
 * Choose a downsampling plan for a validated query. The bucket width is the
 * smallest whole number of seconds that keeps the bucket count at or below the
 * request (`ceil(rangeSeconds / buckets)`, min 1); the source relation is the
 * coarsest continuous aggregate whose native granularity is no finer than the
 * bucket width, falling back to the raw hypertable.
 */
export function planQuery(query: NormalizedHistoryQuery): QueryPlan {
  const rangeSeconds = (query.toMs - query.fromMs) / 1000;
  const bucketSeconds = Math.max(1, Math.ceil(rangeSeconds / query.buckets));

  if (bucketSeconds >= ONE_HOUR_SECONDS) {
    return {
      source: '1h',
      relation: CAGG_1H,
      timeColumn: 'bucket',
      bucketSeconds,
      limit: query.buckets,
      fromAggregate: true,
    };
  }
  if (bucketSeconds >= ONE_MINUTE_SECONDS) {
    return {
      source: '1m',
      relation: CAGG_1M,
      timeColumn: 'bucket',
      bucketSeconds,
      limit: query.buckets,
      fromAggregate: true,
    };
  }
  return {
    source: 'raw',
    relation: TABLE,
    timeColumn: 'ts',
    bucketSeconds,
    limit: query.buckets,
    fromAggregate: false,
  };
}

/**
 * Build the parameterized downsampling SQL and its value array. Pure, so the
 * generated shape (range predicate, bucket origin, `LIMIT`) can be asserted in
 * unit tests without a database.
 *
 * Parameter order: `$1` bucket width (seconds), `$2` bucket origin (= range
 * start), `$3` drone id, `$4` range start, `$5` range end, `$6` row limit.
 */
export function buildHistorySql(
  query: NormalizedHistoryQuery,
  plan: QueryPlan,
): { text: string; values: unknown[] } {
  const t = plan.timeColumn;
  const agg = plan.fromAggregate;

  const countExpr = agg ? 'sum(sample_count)::bigint' : 'count(*)::bigint';
  const avgAltitude = agg ? 'avg(avg_altitude)' : 'avg(altitude)';
  const minAltitude = agg ? 'min(min_altitude)' : 'min(altitude)';
  const maxAltitude = agg ? 'max(max_altitude)' : 'max(altitude)';
  const avgBat = agg ? 'avg(avg_bat_remaining_pct)' : 'avg(bat_remaining_pct)';
  const minBat = agg ? 'min(min_bat_remaining_pct)' : 'min(bat_remaining_pct)';
  const avgRc = agg ? 'avg(avg_rc_signal_strength)' : 'avg(rc_signal_strength)';
  const minRc = agg ? 'min(min_rc_signal_strength)' : 'min(rc_signal_strength)';

  const text =
    `SELECT ` +
    `time_bucket(make_interval(secs => $1::double precision), ${t}, $2::timestamptz) AS bucket, ` +
    `${countExpr} AS sample_count, ` +
    `${avgAltitude} AS avg_altitude, ${minAltitude} AS min_altitude, ${maxAltitude} AS max_altitude, ` +
    `${avgBat} AS avg_bat_remaining_pct, ${minBat} AS min_bat_remaining_pct, ` +
    `${avgRc} AS avg_rc_signal_strength, ${minRc} AS min_rc_signal_strength ` +
    `FROM ${plan.relation} ` +
    `WHERE drone_id = $3 AND ${t} >= $4::timestamptz AND ${t} <= $5::timestamptz ` +
    `GROUP BY bucket ` +
    `ORDER BY bucket ASC ` +
    `LIMIT $6`;

  const values: unknown[] = [
    plan.bucketSeconds,
    query.from,
    query.droneId,
    query.from,
    query.to,
    plan.limit,
  ];
  return { text, values };
}

/** Coerce a datastore numeric (number | numeric-string | null) to a number/null. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a timestamptz cell (pg `Date` or ISO string) to a canonical ISO string. */
function toIso(value: unknown): IsoTimestamp {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

/** Map one raw aggregate row to a {@link TelemetryBucket}. Pure. */
export function mapRowToBucket(row: HistoryRow): TelemetryBucket {
  return {
    ts: toIso(row.bucket),
    sampleCount: toNumberOrNull(row.sample_count) ?? 0,
    avgAltitude: toNumberOrNull(row.avg_altitude),
    minAltitude: toNumberOrNull(row.min_altitude),
    maxAltitude: toNumberOrNull(row.max_altitude),
    avgBatRemainingPct: toNumberOrNull(row.avg_bat_remaining_pct),
    minBatRemainingPct: toNumberOrNull(row.min_bat_remaining_pct),
    avgRcSignalStrength: toNumberOrNull(row.avg_rc_signal_strength),
    minRcSignalStrength: toNumberOrNull(row.min_rc_signal_strength),
  };
}

/** Assemble the final {@link TelemetrySeries} from datastore rows. Pure. */
export function mapRowsToSeries(
  query: NormalizedHistoryQuery,
  plan: QueryPlan,
  rows: readonly HistoryRow[],
): TelemetrySeries {
  const points = rows.map(mapRowToBucket);
  return {
    droneId: query.droneId,
    from: query.from,
    to: query.to,
    bucketSeconds: plan.bucketSeconds,
    bucketCount: points.length,
    source: plan.source,
    points,
  };
}

/**
 * Datastore-backed {@link HistoryQueryReader}. Composes the pure
 * validate → plan → build → map pipeline around an injected
 * {@link HistoryQueryable}, so all query-shaping logic is exercised without a
 * live database while production runs against TimescaleDB.
 */
export class PgHistoryQuery implements HistoryQueryReader {
  constructor(private readonly db: HistoryQueryable) {}

  async queryHistory(input: HistoryQueryInput): Promise<TelemetrySeries> {
    const query = validateHistoryQuery(input);
    const plan = planQuery(query);
    const { text, values } = buildHistorySql(query, plan);
    const { rows } = await this.db.query(text, values);
    return mapRowsToSeries(query, plan, rows);
  }
}
