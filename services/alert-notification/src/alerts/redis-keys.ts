/**
 * Redis key layout and data-structure contract for escalation timers and alert
 * state (Requirement 16, design "Alert & Notification (Redis + Postgres)").
 *
 * This module ONLY defines the key namespace and documents the chosen
 * structures. The escalation engine that reads/writes these keys (the due-timer
 * sweep, acknowledgement cancellation and rescheduling) is implemented later in
 * task 11.7 — no escalation behaviour is implemented here.
 *
 * ---------------------------------------------------------------------------
 * Structure 1 — Escalation timer wheel (Redis SORTED SET)
 * ---------------------------------------------------------------------------
 *   key:    `alert:escalation:due`                 (see {@link ESCALATION_DUE_ZSET})
 *   member: alert id (uuid)
 *   score:  next-escalation due time, Unix epoch milliseconds
 *
 *   Postgres is the durable source of truth for an Alert; the sorted set is the
 *   schedule index that makes "which alerts are due now?" an O(log N) range
 *   query. The escalation worker (task 11.7) atomically pops due members with a
 *   Lua script equivalent to:
 *       ZRANGEBYSCORE key -inf <now>  ->  process  ->  ZADD key <now+intervalMs>
 *   Acknowledging or closing an alert removes its member (ZREM), which is how
 *   acknowledgement cancels the timer (Requirement 16.2) and why acknowledged or
 *   closed alerts are never rescheduled (Requirement 16.4). Using a single
 *   sorted set keyed by absolute due-time means rescheduling "further in the
 *   future" (Requirement 16.5) is a monotonic score increase.
 *
 * ---------------------------------------------------------------------------
 * Structure 2 — Per-alert escalation state (Redis HASH)
 * ---------------------------------------------------------------------------
 *   key:    `alert:state:{alertId}`                (see {@link alertStateKey})
 *   fields: status            -> AlertStatus (OPEN | ACKNOWLEDGED | ESCALATED | CLOSED)
 *           escalationLevel   -> integer, 0..escalationChain.length
 *           intervalMs        -> escalationIntervalMin * 60_000 (cached from the rule)
 *           ruleId            -> owning rule uuid
 *
 *   This hash is a fast-access cache of the fields the escalation sweep needs so
 *   it can decide and reschedule without a Postgres round-trip per tick. It is
 *   kept consistent with the durable `alerts` row by the escalation service.
 *
 * ---------------------------------------------------------------------------
 * Structure 3 — Channel-failure marker (Redis SET, used by dispatch/fallback)
 * ---------------------------------------------------------------------------
 *   key:    `alert:failed-channels:{alertId}`      (see {@link failedChannelsKey})
 *   members: channel types whose delivery failed for this alert
 *
 *   Supports the dispatch retry/fallback policy (Requirement 15.5/15.6): when
 *   in-app WebSocket itself is already recorded here, the WebSocket fallback is
 *   skipped. Defined now for a single namespacing source of truth; populated by
 *   the dispatcher in task 11.5.
 */

/** Sorted set holding the next-due escalation time (epoch ms) per alert id. */
export const ESCALATION_DUE_ZSET = 'alert:escalation:due';

/** Hash key holding the cached escalation state for a single alert. */
export function alertStateKey(alertId: string): string {
  return `alert:state:${alertId}`;
}

/** Set key holding the channel types whose delivery failed for an alert. */
export function failedChannelsKey(alertId: string): string {
  return `alert:failed-channels:${alertId}`;
}

/** Field names stored inside the per-alert escalation-state hash. */
export const ALERT_STATE_FIELDS = {
  status: 'status',
  escalationLevel: 'escalationLevel',
  intervalMs: 'intervalMs',
  ruleId: 'ruleId',
} as const;
