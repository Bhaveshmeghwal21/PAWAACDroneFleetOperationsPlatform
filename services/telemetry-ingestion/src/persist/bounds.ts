/**
 * Pure validation rules applied to telemetry samples before they are persisted
 * (Requirements 8.4 / property P18, and 8.5 / property P19).
 *
 * These functions are deliberately side-effect free so they can be exhaustively
 * property-tested (task 7.4) and reused by both the live ingest path and any
 * batch/backfill tooling. The persistence layer composes them to decide whether
 * a decoded sample is admitted.
 */
import type { TelemetrySample, Uuid } from '@pawaac/shared-types';

/** Inclusive lower/upper bounds shared by percentage fields. */
export const PERCENT_MIN = 0;
export const PERCENT_MAX = 100;

/** Why a sample was rejected, for metrics/diagnostics. */
export type RejectionReason = 'bounds' | 'non-monotonic';

/** True iff `value` is a finite number within the inclusive `[0, 100]` range. */
export function isPercentInRange(value: number): boolean {
  return Number.isFinite(value) && value >= PERCENT_MIN && value <= PERCENT_MAX;
}

/**
 * Validate the bounded fields of a sample (P18): battery `remainingPct` and
 * `rcSignalStrength` must both lie within `[0, 100]`.
 */
export function isWithinBounds(sample: TelemetrySample): boolean {
  return (
    isPercentInRange(sample.battery.remainingPct) && isPercentInRange(sample.rcSignalStrength)
  );
}

/**
 * Parse an ISO timestamp to epoch milliseconds, or `null` when unparseable.
 * Exposed so the monotonic check and tests share one interpretation of `ts`.
 */
export function tsToMillis(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Tracks the last accepted timestamp per drone to enforce strictly increasing
 * per-drone ordering (P19). A new sample is admitted only when its `ts` is
 * strictly greater than the previously accepted `ts` for the same drone;
 * equal-or-earlier (and unparseable) timestamps are rejected.
 *
 * This is intentionally a tiny stateful helper rather than a pure function: the
 * "strictly increasing" property is inherently about a sequence, so the state
 * is the previously seen timestamp. The decision logic itself is deterministic.
 */
export class MonotonicTimestampGate {
  private readonly lastMillisByDrone = new Map<Uuid, number>();

  /** The last accepted epoch-ms for `droneId`, or `undefined` if none yet. */
  lastAccepted(droneId: Uuid): number | undefined {
    return this.lastMillisByDrone.get(droneId);
  }

  /**
   * Decide whether `sample` may be accepted without mutating state. Useful for
   * tests and for composing with other checks before committing.
   */
  wouldAccept(sample: TelemetrySample): boolean {
    const ms = tsToMillis(sample.ts);
    if (ms === null) {
      return false;
    }
    const last = this.lastMillisByDrone.get(sample.droneId);
    return last === undefined || ms > last;
  }

  /**
   * Accept `sample` if its timestamp strictly increases the per-drone series,
   * recording it as the new high-water mark. Returns whether it was accepted.
   */
  accept(sample: TelemetrySample): boolean {
    const ms = tsToMillis(sample.ts);
    if (ms === null) {
      return false;
    }
    const last = this.lastMillisByDrone.get(sample.droneId);
    if (last !== undefined && ms <= last) {
      return false;
    }
    this.lastMillisByDrone.set(sample.droneId, ms);
    return true;
  }
}
