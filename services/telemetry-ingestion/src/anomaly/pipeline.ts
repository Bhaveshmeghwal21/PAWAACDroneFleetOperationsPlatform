/**
 * Ingest-path glue for anomaly detection (Requirement 9).
 *
 * The pure {@link detectAnomalies} function needs the recent per-drone history
 * window; this module owns that small piece of state. {@link AnomalyPipeline}
 * keeps a bounded, ascending-by-`ts` window per drone, runs detection for each
 * observed sample against the window *before* appending it, and fans any
 * detected anomalies out through an injected {@link AnomalyEmitter} (Req 9.7).
 *
 * State is intentionally minimal and isolated here so detection itself stays a
 * pure function (Req 9.2 / P16). The window is bounded to cap memory under the
 * sustained 10-drones x 10 Hz target.
 */
import type { Anomaly, TelemetrySample, Uuid } from '@pawaac/shared-types';
import {
  detectAnomalies,
  DEFAULT_ANOMALY_THRESHOLDS,
  type AnomalyThresholds,
} from './detector.js';
import type { AnomalyEmitter } from './emitter.js';

/** Default number of recent samples retained per drone for detection context. */
export const DEFAULT_WINDOW_SIZE = 64;

/** Construction options for {@link AnomalyPipeline}. */
export interface AnomalyPipelineOptions {
  /** Fan-out target for detected anomalies (Alert service + dashboard). */
  readonly emitter: AnomalyEmitter;
  /** Detection thresholds; defaults to {@link DEFAULT_ANOMALY_THRESHOLDS}. */
  readonly thresholds?: AnomalyThresholds;
  /** Max retained samples per drone. Defaults to {@link DEFAULT_WINDOW_SIZE}. */
  readonly windowSize?: number;
}

export class AnomalyPipeline {
  private readonly emitter: AnomalyEmitter;
  private readonly thresholds: AnomalyThresholds;
  private readonly windowSize: number;
  private readonly windows = new Map<Uuid, TelemetrySample[]>();

  constructor(options: AnomalyPipelineOptions) {
    this.emitter = options.emitter;
    this.thresholds = options.thresholds ?? DEFAULT_ANOMALY_THRESHOLDS;
    this.windowSize = Math.max(1, options.windowSize ?? DEFAULT_WINDOW_SIZE);
  }

  /** Number of drones currently tracked (test/diagnostic helper). */
  get trackedDrones(): number {
    return this.windows.size;
  }

  /**
   * Detect anomalies for `sample` against the drone's recent history, emit any
   * findings, then record the sample in the window. Returns the detected
   * anomalies (also useful for callers/metrics/tests).
   */
  observe(sample: TelemetrySample): Anomaly[] {
    const window = this.windows.get(sample.droneId) ?? [];
    const anomalies = detectAnomalies(sample, window, this.thresholds);

    for (const anomaly of anomalies) {
      this.emitter.emit(anomaly);
    }

    window.push(sample);
    if (window.length > this.windowSize) {
      window.shift();
    }
    this.windows.set(sample.droneId, window);

    return anomalies;
  }

  /** Drop the retained window for a drone (e.g. on disconnect). */
  reset(droneId: Uuid): void {
    this.windows.delete(droneId);
  }
}
