import {
  UNZONED_KEY,
  buildAnalytics,
  groupByHour,
  groupByZone,
  sumCounts,
  type AlertAnalyticInput,
} from './analytics.logic';

/**
 * Focused unit tests for the pure analytics aggregation (task 11.9). They pin
 * down the zone/hour bucketing and assert the conservation invariant by example
 * (sum of per-zone counts and sum of per-hour counts each equal the total —
 * design property P39). The generator-driven property test (>=100 iterations)
 * is task 11.10.
 */

/** Convenience builder for an analytic input record. */
function rec(createdAt: string, zoneId?: string | null): AlertAnalyticInput {
  return zoneId === undefined ? { createdAt } : { createdAt, zoneId };
}

describe('groupByZone', () => {
  it('counts alerts per zone, bucketing missing zones under "unzoned"', () => {
    const alerts: AlertAnalyticInput[] = [
      rec('2024-01-01T00:00:00.000Z', 'zone-A'),
      rec('2024-01-01T00:05:00.000Z', 'zone-A'),
      rec('2024-01-01T00:10:00.000Z', 'zone-B'),
      rec('2024-01-01T00:15:00.000Z', null),
      rec('2024-01-01T00:20:00.000Z', undefined),
    ];

    expect(groupByZone(alerts)).toEqual([
      { zoneId: UNZONED_KEY, count: 2 },
      { zoneId: 'zone-A', count: 2 },
      { zoneId: 'zone-B', count: 1 },
    ]);
  });

  it('returns an empty list for no alerts', () => {
    expect(groupByZone([])).toEqual([]);
  });

  it('is deterministic and sorted by zoneId', () => {
    const alerts = [rec('2024-01-01T00:00:00.000Z', 'z2'), rec('2024-01-01T00:00:00.000Z', 'z1')];
    expect(groupByZone(alerts).map((b) => b.zoneId)).toEqual(['z1', 'z2']);
  });
});

describe('groupByHour', () => {
  it('truncates creation times to the UTC hour and counts per bucket', () => {
    const alerts: AlertAnalyticInput[] = [
      rec('2024-01-01T08:00:00.000Z'),
      rec('2024-01-01T08:59:59.999Z'),
      rec('2024-01-01T09:00:00.000Z'),
      rec('2024-01-01T23:30:00.000Z'),
    ];

    expect(groupByHour(alerts)).toEqual([
      { hourStart: '2024-01-01T08:00:00.000Z', count: 2 },
      { hourStart: '2024-01-01T09:00:00.000Z', count: 1 },
      { hourStart: '2024-01-01T23:00:00.000Z', count: 1 },
    ]);
  });

  it('accepts Date and epoch-millisecond inputs', () => {
    const epoch = Date.UTC(2024, 0, 1, 8, 15, 0);
    const alerts: AlertAnalyticInput[] = [
      { createdAt: new Date('2024-01-01T08:45:00.000Z') },
      { createdAt: epoch },
    ];
    expect(groupByHour(alerts)).toEqual([{ hourStart: '2024-01-01T08:00:00.000Z', count: 2 }]);
  });

  it('throws on an unparseable timestamp', () => {
    expect(() => groupByHour([rec('not-a-date')])).toThrow();
  });
});

describe('buildAnalytics — conservation invariant (Req 17.2 / P39)', () => {
  it('per-zone and per-hour counts each sum to the total', () => {
    const alerts: AlertAnalyticInput[] = [
      rec('2024-01-01T08:10:00.000Z', 'zone-A'),
      rec('2024-01-01T08:40:00.000Z', 'zone-A'),
      rec('2024-01-01T09:05:00.000Z', 'zone-B'),
      rec('2024-01-01T09:30:00.000Z', null),
      rec('2024-01-01T10:00:00.000Z', 'zone-B'),
      rec('2024-01-01T10:45:00.000Z', undefined),
    ];

    const analytics = buildAnalytics(alerts, '2024-01-01T00:00:00.000Z', '2024-01-01T23:59:59.999Z');

    expect(analytics.total).toBe(6);
    expect(sumCounts(analytics.byZone)).toBe(analytics.total);
    expect(sumCounts(analytics.byHour)).toBe(analytics.total);
  });

  it('holds for an empty range (all sums are zero)', () => {
    const analytics = buildAnalytics([], '2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z');

    expect(analytics.total).toBe(0);
    expect(analytics.byZone).toEqual([]);
    expect(analytics.byHour).toEqual([]);
    expect(sumCounts(analytics.byZone)).toBe(0);
    expect(sumCounts(analytics.byHour)).toBe(0);
  });

  it('holds when every alert is unzoned', () => {
    const alerts: AlertAnalyticInput[] = [
      rec('2024-01-01T08:00:00.000Z'),
      rec('2024-01-01T08:30:00.000Z'),
      rec('2024-01-01T11:00:00.000Z'),
    ];

    const analytics = buildAnalytics(alerts, '2024-01-01T00:00:00.000Z', '2024-01-01T23:59:59.999Z');

    expect(analytics.byZone).toEqual([{ zoneId: UNZONED_KEY, count: 3 }]);
    expect(sumCounts(analytics.byZone)).toBe(3);
    expect(sumCounts(analytics.byHour)).toBe(3);
  });

  it('echoes the queried range bounds', () => {
    const analytics = buildAnalytics([], '2024-03-01T00:00:00.000Z', '2024-03-02T00:00:00.000Z');
    expect(analytics.from).toBe('2024-03-01T00:00:00.000Z');
    expect(analytics.to).toBe('2024-03-02T00:00:00.000Z');
  });
});
