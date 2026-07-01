/**
 * Batched, validated persistence pipeline for telemetry samples.
 *
 * Composes the pure validation rules (bounds — Req 8.4/P18; strictly increasing
 * per-drone timestamps — Req 8.5/P19) with a {@link TelemetryStore} sink. The
 * ingest path offers decoded samples one at a time; accepted samples are
 * buffered and flushed to the store in batches (Req 8.2, throughput Req 8.7).
 *
 * Flush ordering is serialized through an internal promise chain so concurrent
 * triggers (size threshold, interval timer, graceful shutdown) never run
 * overlapping inserts or interleave a batch's rows.
 */
import type { TelemetrySample } from '@pawaac/shared-types';
import type { TelemetryMetrics } from '../metrics.js';
import { isWithinBounds, MonotonicTimestampGate } from './bounds.js';
import type { TelemetryStore } from './store.js';

/** Outcome of offering a single sample to the persister. */
export type PersistDecision = 'accepted' | 'rejected-bounds' | 'rejected-non-monotonic';

/** Construction dependencies for {@link BatchingPersister}. */
export interface BatchingPersisterOptions {
  readonly store: TelemetryStore;
  readonly metrics: TelemetryMetrics;
  /** Flush automatically once this many samples are buffered. Default 50. */
  readonly batchSize?: number;
  /** Optional periodic flush interval (ms); when set, partial batches drain. */
  readonly flushIntervalMs?: number;
  /** Called when a background (auto/timer) flush rejects. */
  readonly onError?: (err: unknown) => void;
}

const DEFAULT_BATCH_SIZE = 50;

export class BatchingPersister {
  private readonly store: TelemetryStore;
  private readonly metrics: TelemetryMetrics;
  private readonly batchSize: number;
  private readonly onError: (err: unknown) => void;
  private readonly gate = new MonotonicTimestampGate();

  private pending: TelemetrySample[] = [];
  private flushChain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: BatchingPersisterOptions) {
    this.store = options.store;
    this.metrics = options.metrics;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.onError = options.onError ?? ((): void => undefined);

    if (options.flushIntervalMs !== undefined && options.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush();
      }, options.flushIntervalMs);
      // Do not keep the event loop alive solely for the flush timer.
      this.timer.unref?.();
    }
  }

  /** Number of accepted-but-not-yet-flushed samples. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Validate and (if accepted) buffer a sample. Rejected samples are counted in
   * metrics and dropped. When the buffer reaches the batch size a flush is
   * scheduled in the background; await {@link flush} for backpressure/draining.
   */
  offer(sample: TelemetrySample): PersistDecision {
    if (!isWithinBounds(sample)) {
      this.metrics.incSamplesRejectedBounds();
      return 'rejected-bounds';
    }
    if (!this.gate.accept(sample)) {
      this.metrics.incSamplesRejectedNonMonotonic();
      return 'rejected-non-monotonic';
    }

    this.pending.push(sample);
    if (this.pending.length >= this.batchSize) {
      void this.flush();
    }
    return 'accepted';
  }

  /**
   * Drain the current buffer to the store. Serialized with any in-flight flush.
   * Resolves once the batch captured at call time has been written.
   */
  flush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.drain()).catch((err: unknown) => {
      this.onError(err);
    });
    return this.flushChain;
  }

  private async drain(): Promise<void> {
    if (this.pending.length === 0) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    await this.store.insertBatch(batch);
    this.metrics.incSamplesPersisted(batch.length);
  }

  /** Stop the periodic timer (if any) and flush any remaining buffered samples. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }
}
