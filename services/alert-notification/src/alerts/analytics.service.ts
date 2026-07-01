/**
 * Alert history + analytics application service (task 11.9, Requirement 17).
 *
 * This is the impure shell around the pure aggregation in `analytics.logic.ts`.
 * It loads alerts from Postgres (TypeORM), joining each alert to its owning rule
 * so every alert carries the zone its rule scopes (`alerts -> rules`), and feeds
 * those records to the pure bucketing functions. Because the pure layer counts
 * every alert in exactly one zone bucket (an unzoned rule falls under the stable
 * `unzoned` key) and exactly one hour bucket, the conservation invariant holds:
 * the sum of per-zone counts and the sum of per-hour counts each equal the total
 * number of alerts in the queried range (Requirement 17.2 / design property
 * P39).
 *
 * Responsibilities:
 * - `getAnalytics` — alert counts grouped by zone and by hour for `[from, to]`.
 * - `getHistory`   — a paginated, filterable history of past alerts (17.3).
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Alert } from '@pawaac/shared-types';
import { AlertEntity } from './entities/alert.entity';
import type { AnalyticsQueryDto, AlertHistoryQueryDto } from './dto';
import {
  buildAnalytics,
  DEFAULT_HISTORY_LIMIT,
  type AlertAnalytics,
  type AlertAnalyticInput,
} from './analytics.logic';
import { toAlert } from './escalation.service';

/** Raw projection returned by the analytics query (one row per alert in range). */
interface AnalyticRow {
  createdAt: Date | string;
  zoneId: string | null;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(AlertEntity)
    private readonly alerts: Repository<AlertEntity>,
  ) {}

  /**
   * Return alert counts grouped by zone and by hour for the queried range
   * (Requirement 17.1). Each alert's zone is taken from its rule (`alerts ->
   * rules` join); alerts whose rule scopes no zone are bucketed under the stable
   * `unzoned` key so the conservation invariant still holds (Requirement 17.2).
   * Rejects an inverted range (`from > to`).
   */
  async getAnalytics(query: AnalyticsQueryDto): Promise<AlertAnalytics> {
    const from = this.parseDate(query.from, 'from');
    const to = this.parseDate(query.to, 'to');
    this.assertRange(from, to);

    const rows = (await this.alerts
      .createQueryBuilder('alert')
      .leftJoin('alert.rule', 'rule')
      .select('alert.createdAt', 'createdAt')
      .addSelect('rule.zoneId', 'zoneId')
      .where('alert.createdAt >= :from', { from })
      .andWhere('alert.createdAt <= :to', { to })
      .getRawMany()) as AnalyticRow[];

    const inputs: AlertAnalyticInput[] = rows.map((row) => ({
      createdAt: row.createdAt,
      zoneId: row.zoneId ?? null,
    }));

    return buildAnalytics(inputs, from.toISOString(), to.toISOString());
  }

  /**
   * Return a paginated, newest-first history of past alerts (Requirement 17.3),
   * optionally filtered by time range, status, severity and zone. Rejects an
   * inverted range when both bounds are supplied.
   */
  async getHistory(query: AlertHistoryQueryDto): Promise<Alert[]> {
    const from = query.from ? this.parseDate(query.from, 'from') : undefined;
    const to = query.to ? this.parseDate(query.to, 'to') : undefined;
    if (from && to) {
      this.assertRange(from, to);
    }

    const qb = this.alerts.createQueryBuilder('alert');

    if (query.zoneId) {
      qb.innerJoin('alert.rule', 'rule').andWhere('rule.zoneId = :zoneId', {
        zoneId: query.zoneId,
      });
    }
    if (from) {
      qb.andWhere('alert.createdAt >= :from', { from });
    }
    if (to) {
      qb.andWhere('alert.createdAt <= :to', { to });
    }
    if (query.status) {
      qb.andWhere('alert.status = :status', { status: query.status });
    }
    if (query.severity) {
      qb.andWhere('alert.severity = :severity', { severity: query.severity });
    }

    qb.orderBy('alert.createdAt', 'DESC')
      .addOrderBy('alert.id', 'DESC')
      .take(query.limit ?? DEFAULT_HISTORY_LIMIT)
      .skip(query.offset ?? 0);

    const entities = await qb.getMany();
    return entities.map(toAlert);
  }

  /** Parse an ISO-8601 string into a `Date`, rejecting an unparseable value. */
  private parseDate(value: string, field: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`Invalid "${field}" timestamp: "${value}"`);
    }
    return date;
  }

  /** Reject an inverted query range (`from > to`) with a validation error. */
  private assertRange(from: Date, to: Date): void {
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException(
        `Invalid range: "from" (${from.toISOString()}) must not be after "to" (${to.toISOString()})`,
      );
    }
  }
}
