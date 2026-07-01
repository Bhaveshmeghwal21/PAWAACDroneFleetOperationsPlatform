/**
 * Unit tests for the historical telemetry query-shaping logic (task 7.7,
 * Requirement 10). These exercise the pure functions (validation, planning, SQL
 * shape, row mapping) plus the {@link PgHistoryQuery} pipeline against an
 * in-memory fake datastore — no live database required.
 *
 * Property-based tests for the downsampling bound (P20) and time-range
 * soundness (P21) live in task 7.8; here we cover focused examples:
 * range soundness, the bucket cap, and the `from > to` rejection (Req 10.4).
 */
import {
  buildHistorySql,
  DEFAULT_BUCKETS,
  HistoryQueryValidationError,
  mapRowsToSeries,
  mapRowToBucket,
  MAX_BUCKETS,
  PgHistoryQuery,
  planQuery,
  validateHistoryQuery,
  type HistoryQueryable,
  type HistoryRow,
} from './history.js';

const DRONE_ID = '11111111-1111-1111-1111-111111111111';

describe('validateHistoryQuery', () => {
  it('normalizes a valid query to canonical ISO timestamps and resolves the default cap', () => {
    const q = validateHistoryQuery({
      droneId: DRONE_ID,
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-01T01:00:00Z',
    });
    expect(q.droneId).toBe(DRONE_ID);
    expect(q.from).toBe('2024-01-01T00:00:00.000Z');
    expect(q.to).toBe('2024-01-01T01:00:00.000Z');
    expect(q.fromMs).toBeLessThanOrEqual(q.toMs);
    expect(q.buckets).toBe(DEFAULT_BUCKETS);
  });

  it('rejects an inverted range (from > to) with a 400 validation error (Req 10.4)', () => {
    expect(() =>
      validateHistoryQuery({
        droneId: DRONE_ID,
        from: '2024-01-01T02:00:00Z',
        to: '2024-01-01T01:00:00Z',
      }),
    ).toThrow(HistoryQueryValidationError);

    try {
      validateHistoryQuery({
        droneId: DRONE_ID,
        from: '2024-01-01T02:00:00Z',
        to: '2024-01-01T01:00:00Z',
      });
      fail('expected a validation error');
    } catch (err) {
      expect(err).toBeInstanceOf(HistoryQueryValidationError);
      expect((err as HistoryQueryValidationError).status).toBe(400);
    }
  });

  it('accepts an empty range where from === to', () => {
    const q = validateHistoryQuery({
      droneId: DRONE_ID,
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-01T00:00:00Z',
    });
    expect(q.fromMs).toBe(q.toMs);
  });

  it('rejects a missing drone id', () => {
    expect(() =>
      validateHistoryQuery({ droneId: '  ', from: '2024-01-01T00:00:00Z', to: '2024-01-01T01:00:00Z' }),
    ).toThrow(HistoryQueryValidationError);
  });

  it('rejects unparseable timestamps', () => {
    expect(() =>
      validateHistoryQuery({ droneId: DRONE_ID, from: 'not-a-date', to: '2024-01-01T01:00:00Z' }),
    ).toThrow(/from/);
    expect(() =>
      validateHistoryQuery({ droneId: DRONE_ID, from: '2024-01-01T00:00:00Z', to: 'nope' }),
    ).toThrow(/to/);
  });

  it('rejects a non-positive or non-integer bucket count', () => {
    const base = { droneId: DRONE_ID, from: '2024-01-01T00:00:00Z', to: '2024-01-01T01:00:00Z' };
    expect(() => validateHistoryQuery({ ...base, buckets: 0 })).toThrow(HistoryQueryValidationError);
    expect(() => validateHistoryQuery({ ...base, buckets: -5 })).toThrow(HistoryQueryValidationError);
    expect(() => validateHistoryQuery({ ...base, buckets: '3.5' })).toThrow(HistoryQueryValidationError);
  });

  it('parses a numeric bucket count supplied as a string and clamps to MAX_BUCKETS', () => {
    const base = { droneId: DRONE_ID, from: '2024-01-01T00:00:00Z', to: '2024-01-01T01:00:00Z' };
    expect(validateHistoryQuery({ ...base, buckets: '24' }).buckets).toBe(24);
    expect(validateHistoryQuery({ ...base, buckets: MAX_BUCKETS + 1000 }).buckets).toBe(MAX_BUCKETS);
  });
});

describe('planQuery — downsample bucket cap & source selection (Req 10.3 / P20)', () => {
  function plan(fromIso: string, toIso: string, buckets: number) {
    return planQuery(validateHistoryQuery({ droneId: DRONE_ID, from: fromIso, to: toIso, buckets }));
  }

  it('always sets the row limit equal to the requested bucket count', () => {
    const p = plan('2024-01-01T00:00:00Z', '2024-01-01T01:00:00Z', 60);
    expect(p.limit).toBe(60);
  });

  it('chooses a bucket width so the number of buckets never exceeds the request', () => {
    const cases: Array<{ from: string; to: string; buckets: number }> = [
      { from: '2024-01-01T00:00:00Z', to: '2024-01-01T00:00:10Z', buckets: 3 }, // 10s / 3
      { from: '2024-01-01T00:00:00Z', to: '2024-01-01T00:00:09Z', buckets: 3 }, // 9s / 3
      { from: '2024-01-01T00:00:00Z', to: '2024-01-01T01:00:00Z', buckets: 7 }, // 3600s / 7
      { from: '2024-01-01T00:00:00Z', to: '2024-01-02T00:00:00Z', buckets: 100 },
    ];
    for (const c of cases) {
      const q = validateHistoryQuery({ droneId: DRONE_ID, from: c.from, to: c.to, buckets: c.buckets });
      const p = planQuery(q);
      const rangeSeconds = (q.toMs - q.fromMs) / 1000;
      const producedBuckets = Math.floor(rangeSeconds / p.bucketSeconds) + 1;
      // The width keeps the natural bucket count within request + 1; the SQL
      // LIMIT (= request) provides the hard guarantee enforced in mapping.
      expect(producedBuckets).toBeLessThanOrEqual(c.buckets + 1);
      expect(p.bucketSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it('reads from the raw hypertable for fine buckets (< 60s)', () => {
    const p = plan('2024-01-01T00:00:00Z', '2024-01-01T00:01:00Z', 60); // 60s / 60 = 1s
    expect(p.source).toBe('raw');
    expect(p.relation).toBe('telemetry_sample');
    expect(p.timeColumn).toBe('ts');
    expect(p.fromAggregate).toBe(false);
  });

  it('reads from the 1-minute continuous aggregate for minute-scale buckets', () => {
    // 1 hour over 30 buckets -> 120s width -> 1m cagg.
    const p = plan('2024-01-01T00:00:00Z', '2024-01-01T01:00:00Z', 30);
    expect(p.source).toBe('1m');
    expect(p.relation).toBe('telemetry_sample_1m');
    expect(p.timeColumn).toBe('bucket');
    expect(p.fromAggregate).toBe(true);
  });

  it('reads from the 1-hour continuous aggregate for hour-scale buckets', () => {
    // 10 days over 24 buckets -> 36000s width -> 1h cagg.
    const p = plan('2024-01-01T00:00:00Z', '2024-01-11T00:00:00Z', 24);
    expect(p.source).toBe('1h');
    expect(p.relation).toBe('telemetry_sample_1h');
    expect(p.fromAggregate).toBe(true);
  });
});

describe('buildHistorySql — range predicate, origin & limit (Req 10.1/10.2 / P21)', () => {
  it('emits a range-bounded, origin-pinned, limited downsample query for raw source', () => {
    const q = validateHistoryQuery({
      droneId: DRONE_ID,
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-01T00:00:30Z',
      buckets: 10,
    });
    const plan = planQuery(q);
    const { text, values } = buildHistorySql(q, plan);

    // Range soundness: inclusive lower & upper bound on the time column.
    expect(text).toContain('ts >= $4::timestamptz AND ts <= $5::timestamptz');
    // Bucket origin pinned to the range start so bucket labels stay >= from.
    expect(text).toContain('time_bucket(make_interval(secs => $1::double precision), ts, $2::timestamptz)');
    // Hard cap.
    expect(text).toContain('LIMIT $6');
    expect(text).toContain('FROM telemetry_sample ');

    expect(values).toEqual([plan.bucketSeconds, q.from, q.droneId, q.from, q.to, plan.limit]);
    // Origin (values[1]) equals range start (values[3]).
    expect(values[1]).toBe(values[3]);
  });

  it('aggregates pre-aggregated columns when reading a continuous aggregate', () => {
    const q = validateHistoryQuery({
      droneId: DRONE_ID,
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-01T01:00:00Z',
      buckets: 30,
    });
    const plan = planQuery(q);
    const { text } = buildHistorySql(q, plan);
    expect(text).toContain('sum(sample_count)::bigint');
    expect(text).toContain('avg(avg_altitude)');
    expect(text).toContain('min(min_altitude)');
    expect(text).toContain('FROM telemetry_sample_1m ');
    expect(text).toContain('bucket >= $4::timestamptz AND bucket <= $5::timestamptz');
  });

  it('re-buckets a continuous aggregate by the coarse output expression, not the native bucket column (Req 10.3 / P20 conservation)', () => {
    // Regression guard: a continuous aggregate relation already exposes a
    // physical `bucket` column at its native (1m/1h) granularity. Grouping by
    // the *name* `bucket` would bind to that input column (PostgreSQL resolves
    // an ambiguous GROUP BY name to the input column), so the coarse
    // time_bucket(...) re-aggregation would be ignored and LIMIT would drop
    // rows — losing samples and breaking SUM(sample_count) conservation.
    // Grouping/ordering must therefore be positional (the coarse output col).
    const q = validateHistoryQuery({
      droneId: DRONE_ID,
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-01T01:00:00Z',
      buckets: 30,
    });
    const plan = planQuery(q);
    expect(plan.fromAggregate).toBe(true);
    const { text } = buildHistorySql(q, plan);

    // Groups by the coarse output expression positionally, never by the
    // ambiguous `bucket` column name.
    expect(text).toContain('GROUP BY 1 ');
    expect(text).toContain('ORDER BY 1 ASC ');
    expect(text).not.toContain('GROUP BY bucket');
    expect(text).not.toContain('ORDER BY bucket');
    // The coarse re-bucket still aliases its output `bucket` for row mapping.
    expect(text).toContain(
      'time_bucket(make_interval(secs => $1::double precision), bucket, $2::timestamptz) AS bucket',
    );
  });
});

describe('mapRowToBucket / mapRowsToSeries', () => {
  it('coerces datastore cells (Date, numeric strings, null) into a typed bucket', () => {
    const row: HistoryRow = {
      bucket: new Date('2024-01-01T00:00:00Z'),
      sample_count: '42',
      avg_altitude: 100.5,
      min_altitude: '90',
      max_altitude: 110,
      avg_bat_remaining_pct: null,
      min_bat_remaining_pct: '12.5',
      avg_rc_signal_strength: 80,
      min_rc_signal_strength: null,
    };
    expect(mapRowToBucket(row)).toEqual({
      ts: '2024-01-01T00:00:00.000Z',
      sampleCount: 42,
      avgAltitude: 100.5,
      minAltitude: 90,
      maxAltitude: 110,
      avgBatRemainingPct: null,
      minBatRemainingPct: 12.5,
      avgRcSignalStrength: 80,
      minRcSignalStrength: null,
    });
  });

  it('reports the source, bucket width and bucket count in the series envelope', () => {
    const q = validateHistoryQuery({
      droneId: DRONE_ID,
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-01T00:00:30Z',
      buckets: 3,
    });
    const plan = planQuery(q);
    const rows: HistoryRow[] = [
      { bucket: '2024-01-01T00:00:00.000Z' },
      { bucket: '2024-01-01T00:00:10.000Z' },
    ];
    const series = mapRowsToSeries(q, plan, rows);
    expect(series.bucketCount).toBe(2);
    expect(series.source).toBe(plan.source);
    expect(series.bucketSeconds).toBe(plan.bucketSeconds);
    expect(series.points).toHaveLength(2);
  });
});

/**
 * A fake {@link HistoryQueryable} that emulates a database honouring the SQL:
 * it parses the bucket origin / width / inclusive bounds / LIMIT from the
 * generated query, then synthesizes evenly spaced buckets, applying the LIMIT.
 * This lets us assert end-to-end range soundness (P21) and the bucket cap (P20)
 * deterministically without a live TimescaleDB.
 */
function makeFakeDb(): HistoryQueryable {
  return {
    query(_text: string, values: readonly unknown[]) {
      const widthSeconds = Number(values[0]);
      const origin = Date.parse(String(values[1]));
      const toMs = Date.parse(String(values[4]));
      const limit = Number(values[5]);

      const rows: HistoryRow[] = [];
      for (let t = origin; t <= toMs && rows.length < limit; t += widthSeconds * 1000) {
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

describe('PgHistoryQuery — end-to-end query pipeline', () => {
  it('returns at most the requested number of buckets (Req 10.3 / P20)', async () => {
    const reader = new PgHistoryQuery(makeFakeDb());
    const series = await reader.queryHistory({
      droneId: DRONE_ID,
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-01T00:01:00Z', // 60s
      buckets: 5,
    });
    expect(series.bucketCount).toBeLessThanOrEqual(5);
    expect(series.points.length).toBeLessThanOrEqual(5);
  });

  it('returns only buckets whose timestamp is within [from, to] (Req 10.2 / P21)', async () => {
    const reader = new PgHistoryQuery(makeFakeDb());
    const series = await reader.queryHistory({
      droneId: DRONE_ID,
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-01T00:05:00Z',
      buckets: 50,
    });
    const fromMs = Date.parse(series.from);
    const toMs = Date.parse(series.to);
    expect(series.points.length).toBeGreaterThan(0);
    for (const point of series.points) {
      const ts = Date.parse(point.ts);
      expect(ts).toBeGreaterThanOrEqual(fromMs);
      expect(ts).toBeLessThanOrEqual(toMs);
    }
  });

  it('propagates a validation error (from > to) without touching the datastore (Req 10.4)', async () => {
    let calls = 0;
    const db: HistoryQueryable = {
      query(_text: string, _values: readonly unknown[]) {
        calls += 1;
        return Promise.resolve({ rows: [] });
      },
    };
    const reader = new PgHistoryQuery(db);
    await expect(
      reader.queryHistory({
        droneId: DRONE_ID,
        from: '2024-01-01T02:00:00Z',
        to: '2024-01-01T01:00:00Z',
      }),
    ).rejects.toBeInstanceOf(HistoryQueryValidationError);
    expect(calls).toBe(0);
  });
});
