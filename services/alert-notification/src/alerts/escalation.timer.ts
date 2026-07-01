/**
 * Escalation timer port + Redis adapter (task 11.7, Requirement 16; design
 * "Structure 1 — Escalation timer wheel").
 *
 * The escalation engine schedules, cancels and sweeps due timers exclusively
 * through the narrow {@link EscalationTimerPort} interface, so the service can be
 * unit-tested against an in-memory fake with zero Redis. The production wiring
 * binds the port to {@link RedisEscalationTimer}, which stores next-due times in
 * the `alert:escalation:due` sorted set (member = alert id, score = next-due
 * epoch ms). Scheduling is a `ZADD` (idempotent overwrite of the score),
 * cancellation is a `ZREM`, and the due sweep is a `ZRANGEBYSCORE -inf <now>`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ESCALATION_DUE_ZSET } from './redis-keys';

/** DI token for the escalation timer port. */
export const ESCALATION_TIMER = Symbol('ESCALATION_TIMER');

/** A single due timer entry: an alert id and the epoch-ms time it became due. */
export interface DueTimer {
  alertId: string;
  /** The score stored in the sorted set: this alert's current next-due time. */
  dueAt: number;
}

/**
 * Schedule index for per-alert escalation timers. Implementations MUST treat
 * {@link schedule} as an upsert (a later call replaces the stored due time) so
 * rescheduling further into the future is a monotonic score increase.
 */
export interface EscalationTimerPort {
  /** Set/replace the next-due time (epoch ms) for an alert. */
  schedule(alertId: string, dueAtMs: number): Promise<void>;
  /** Remove an alert's timer entry (acknowledgement/closure/terminal). */
  cancel(alertId: string): Promise<void>;
  /** All entries whose due time is `<= nowMs`, each with its stored due score. */
  dueEntries(nowMs: number): Promise<DueTimer[]>;
}

/** The subset of the ioredis client surface the timer adapter relies on. */
export interface RedisZsetClient {
  zadd(key: string, score: number | string, member: string): Promise<number | string>;
  zrem(key: string, member: string): Promise<number>;
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    withScores: 'WITHSCORES',
  ): Promise<string[]>;
}

/**
 * Redis-backed {@link EscalationTimerPort} over the `alert:escalation:due`
 * sorted set. All operations are O(log N) (range query is O(log N + M)).
 */
@Injectable()
export class RedisEscalationTimer implements EscalationTimerPort {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisZsetClient) {}

  async schedule(alertId: string, dueAtMs: number): Promise<void> {
    await this.redis.zadd(ESCALATION_DUE_ZSET, dueAtMs, alertId);
  }

  async cancel(alertId: string): Promise<void> {
    await this.redis.zrem(ESCALATION_DUE_ZSET, alertId);
  }

  async dueEntries(nowMs: number): Promise<DueTimer[]> {
    // WITHSCORES yields a flat [member, score, member, score, ...] array.
    const flat = await this.redis.zrangebyscore(ESCALATION_DUE_ZSET, '-inf', nowMs, 'WITHSCORES');
    const entries: DueTimer[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      entries.push({ alertId: flat[i] as string, dueAt: Number(flat[i + 1]) });
    }
    return entries;
  }
}
