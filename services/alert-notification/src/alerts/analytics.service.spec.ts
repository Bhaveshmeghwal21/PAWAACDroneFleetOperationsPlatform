import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { AlertEntity } from './entities/alert.entity';
import { AnalyticsService } from './analytics.service';
import { UNZONED_KEY, sumCounts } from './analytics.logic';

/**
 * Orchestration unit tests for the analytics/history service (task 11.9). The
 * TypeORM repository and its query builder are replaced with an in-memory fake,
 * so these cover row->bucket mapping, the conservation invariant end-to-end
 * through the service, range validation and history filtering/pagination —
 * without any database. The generator-driven property test (>=100 iterations)
 * is task 11.10.
 */

/** A chainable fake of TypeORM's SelectQueryBuilder over a fixed result set. */
class FakeQueryBuilder<T> {
  readonly params: Record<string, unknown> = {};
  takeValue?: number;
  skipValue?: number;

  constructor(
    private readonly rawRows: unknown[],
    private readonly entities: T[],
  ) {}

  leftJoin(): this {
    return this;
  }
  innerJoin(): this {
    return this;
  }
  select(): this {
    return this;
  }
  addSelect(): this {
    return this;
  }
  orderBy(): this {
    return this;
  }
  addOrderBy(): this {
    return this;
  }
  where(_clause: string, params?: Record<string, unknown>): this {
    Object.assign(this.params, params ?? {});
    return this;
  }
  andWhere(_clause: string, params?: Record<string, unknown>): this {
    Object.assign(this.params, params ?? {});
    return this;
  }
  take(value: number): this {
    this.takeValue = value;
    return this;
  }
  skip(value: number): this {
    this.skipValue = value;
    return this;
  }
  getRawMany(): Promise<unknown[]> {
    return Promise.resolve(this.rawRows);
  }
  getMany(): Promise<T[]> {
    return Promise.resolve(this.entities);
  }
}

/** Build a service whose repository hands back a single fake query builder. */
function makeService(options: {
  rawRows?: unknown[];
  entities?: AlertEntity[];
}): { service: AnalyticsService; qb: FakeQueryBuilder<AlertEntity> } {
  const qb = new FakeQueryBuilder<AlertEntity>(options.rawRows ?? [], options.entities ?? []);
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
  } as unknown as Repository<AlertEntity>;
  return { service: new AnalyticsService(repo), qb };
}

describe('AnalyticsService.getAnalytics (Req 17.1/17.2 / P39)', () => {
  it('maps rows to zone/hour buckets with conservation, treating null zone as "unzoned"', async () => {
    const rawRows = [
      { createdAt: '2024-01-01T08:10:00.000Z', zoneId: 'zone-A' },
      { createdAt: '2024-01-01T08:50:00.000Z', zoneId: 'zone-A' },
      { createdAt: '2024-01-01T09:05:00.000Z', zoneId: 'zone-B' },
      { createdAt: '2024-01-01T09:45:00.000Z', zoneId: null },
    ];
    const { service } = makeService({ rawRows });

    const result = await service.getAnalytics({
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-01-01T23:59:59.999Z',
    });

    expect(result.total).toBe(4);
    expect(result.byZone).toEqual([
      { zoneId: UNZONED_KEY, count: 1 },
      { zoneId: 'zone-A', count: 2 },
      { zoneId: 'zone-B', count: 1 },
    ]);
    expect(result.byHour).toEqual([
      { hourStart: '2024-01-01T08:00:00.000Z', count: 2 },
      { hourStart: '2024-01-01T09:00:00.000Z', count: 2 },
    ]);
    // Conservation holds end-to-end through the service (P39).
    expect(sumCounts(result.byZone)).toBe(result.total);
    expect(sumCounts(result.byHour)).toBe(result.total);
  });

  it('passes the parsed range bounds to the query', async () => {
    const { service, qb } = makeService({ rawRows: [] });

    await service.getAnalytics({
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-01-02T00:00:00.000Z',
    });

    expect((qb.params.from as Date).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect((qb.params.to as Date).toISOString()).toBe('2024-01-02T00:00:00.000Z');
  });

  it('rejects an inverted range (from > to)', async () => {
    const { service } = makeService({ rawRows: [] });

    await expect(
      service.getAnalytics({
        from: '2024-01-02T00:00:00.000Z',
        to: '2024-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AnalyticsService.getHistory (Req 17.3)', () => {
  /** Seed a persisted alert entity for the history mapping. */
  function alert(id: string, overrides: Partial<AlertEntity> = {}): AlertEntity {
    return {
      id,
      ruleId: 'rule-1',
      severity: 'warning',
      status: 'OPEN',
      escalationLevel: 0,
      createdAt: new Date('2024-01-01T08:00:00.000Z'),
      acknowledgedAt: null,
      acknowledgedBy: null,
      ...overrides,
    } as AlertEntity;
  }

  it('maps persisted alerts to the shared Alert shape', async () => {
    const entities = [
      alert('a1'),
      alert('a2', {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date('2024-01-01T09:00:00.000Z'),
        acknowledgedBy: 'user-1',
      }),
    ];
    const { service } = makeService({ entities });

    const history = await service.getHistory({});

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ id: 'a1', status: 'OPEN', createdAt: '2024-01-01T08:00:00.000Z' });
    expect(history[1]).toMatchObject({
      id: 'a2',
      status: 'ACKNOWLEDGED',
      acknowledgedBy: 'user-1',
      acknowledgedAt: '2024-01-01T09:00:00.000Z',
    });
  });

  it('applies default pagination when none is supplied', async () => {
    const { service, qb } = makeService({ entities: [] });

    await service.getHistory({});

    expect(qb.takeValue).toBe(100);
    expect(qb.skipValue).toBe(0);
  });

  it('forwards explicit pagination and filter parameters', async () => {
    const { service, qb } = makeService({ entities: [] });

    await service.getHistory({ status: 'CLOSED', severity: 'critical', zoneId: 'zone-A', limit: 25, offset: 50 });

    expect(qb.takeValue).toBe(25);
    expect(qb.skipValue).toBe(50);
    expect(qb.params.status).toBe('CLOSED');
    expect(qb.params.severity).toBe('critical');
    expect(qb.params.zoneId).toBe('zone-A');
  });

  it('rejects an inverted range when both bounds are supplied', async () => {
    const { service } = makeService({ entities: [] });

    await expect(
      service.getHistory({ from: '2024-01-02T00:00:00.000Z', to: '2024-01-01T00:00:00.000Z' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
