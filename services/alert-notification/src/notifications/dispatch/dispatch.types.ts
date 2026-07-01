/**
 * Result types for multi-channel dispatch (task 11.5, Requirement 15).
 */
import type { ChannelType } from '@pawaac/shared-types';

/** Outcome of attempting delivery to a single channel (primary or fallback). */
export interface ChannelDeliveryResult {
  /** Channel type that was attempted. */
  channel: ChannelType;
  /** Destination target attempted, when the channel carried one. */
  target?: string;
  /** Whether delivery ultimately succeeded after any retries. */
  status: 'delivered' | 'failed';
  /** Number of send attempts made (>= 1). */
  attempts: number;
  /** True when this attempt was an in-app fallback for a failed channel. */
  viaFallback: boolean;
  /** Failure message, present only when `status === 'failed'`. */
  error?: string;
}

/**
 * Aggregate result of a `dispatch` call. Dispatch treats partial delivery as
 * success (Requirement 15.1), so this object is always returned (the call never
 * throws). `allDelivered` reports whether every attempted channel succeeded.
 */
export interface DispatchResult {
  alertId: string;
  /** Per-channel outcomes in the order they were attempted (primaries then fallbacks). */
  results: ChannelDeliveryResult[];
  /** True iff no result has `status === 'failed'`. */
  allDelivered: boolean;
}
