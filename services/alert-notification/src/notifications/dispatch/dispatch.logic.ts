/**
 * Pure decision logic for multi-channel dispatch (task 11.5, Requirement 15).
 *
 * Everything in this module is a side-effect-free, deterministic function of its
 * arguments — no transports, clock, network or I/O. The retry-backoff schedule,
 * the fan-out target set and the in-app fallback rule all live here so they can
 * be unit-tested in isolation, while the impure orchestration (invoking
 * transports, sleeping, recording failures) lives in `dispatch.service.ts`.
 */
import type { Channel, ChannelType } from '@pawaac/shared-types';
import type { ChannelDeliveryResult } from './dispatch.types';

/** Tunable retry/backoff policy applied per channel (Requirement 15.5). */
export interface RetryPolicy {
  /** Total send attempts per channel before it is marked failed (>= 1). */
  maxAttempts: number;
  /** Delay before the first retry, in milliseconds (>= 0). */
  baseDelayMs: number;
  /** Multiplicative growth factor between successive retry delays (>= 1). */
  backoffFactor: number;
  /** Upper bound applied to any single backoff delay, in milliseconds. */
  maxDelayMs: number;
}

/** Conservative default policy: 3 attempts, 100ms base, exponential x2, 5s cap. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  backoffFactor: 2,
  maxDelayMs: 5_000,
};

/**
 * Normalise a possibly-undefined/partial policy into a complete, sane policy.
 * Values are clamped so a misconfiguration can never produce a negative delay
 * or zero attempts (which would skip the channel entirely).
 */
export function resolveRetryPolicy(partial?: Partial<RetryPolicy>): RetryPolicy {
  const merged = { ...DEFAULT_RETRY_POLICY, ...(partial ?? {}) };
  return {
    maxAttempts: Math.max(1, Math.floor(merged.maxAttempts)),
    baseDelayMs: Math.max(0, merged.baseDelayMs),
    backoffFactor: Math.max(1, merged.backoffFactor),
    maxDelayMs: Math.max(0, merged.maxDelayMs),
  };
}

/**
 * Backoff delay (ms) to wait *before* the retry that follows attempt index
 * `attemptIndex` (0-based: 0 = the delay between the first and second attempt).
 * Exponential growth `base * factor^attemptIndex`, capped at `maxDelayMs`.
 */
export function backoffDelayMs(attemptIndex: number, policy: RetryPolicy): number {
  if (attemptIndex < 0) {
    return 0;
  }
  const raw = policy.baseDelayMs * policy.backoffFactor ** attemptIndex;
  return Math.min(raw, policy.maxDelayMs);
}

/**
 * The exact set of channels to fan out to (Requirement 15.1 / property P37):
 * precisely the channels configured on the rule, in configured order. Entries
 * that are byte-identical (same type AND target) are de-duplicated so a rule is
 * never double-delivered to the same destination, while distinct targets of the
 * same type (e.g. two email recipients) are preserved.
 */
export function fanOutChannels(channels: Channel[]): Channel[] {
  const seen = new Set<string>();
  const out: Channel[] = [];
  for (const channel of channels) {
    const key = `${channel.type}\u0000${channel.target ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(channel);
  }
  return out;
}

/**
 * Decide whether a failed channel should fall back to an in-app WebSocket push
 * (Requirement 15.5/15.6).
 *
 * - A failed in-app channel never falls back to itself.
 * - Any other failed channel falls back to in-app, UNLESS the in-app channel is
 *   known to have already failed in this dispatch (`inAppHealthy === false`), in
 *   which case the WS fallback is skipped.
 */
export function shouldFallbackToInApp(failed: ChannelType, inAppHealthy: boolean): boolean {
  if (failed === 'in_app') {
    return false;
  }
  return inAppHealthy;
}

/** True iff a delivery result records an in-app channel that failed. */
export function isInAppFailure(result: ChannelDeliveryResult): boolean {
  return result.channel === 'in_app' && result.status === 'failed';
}
