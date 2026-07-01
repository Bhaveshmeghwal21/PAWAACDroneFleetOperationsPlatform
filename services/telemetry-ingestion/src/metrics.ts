/**
 * Lightweight in-process metrics counters for the Telemetry Ingestion service.
 *
 * Requirement 8.6 mandates that malformed MAVLink frames be dropped while a
 * parse-error metric is incremented (and the socket kept open). Rather than
 * pulling in a full metrics backend at this stage, this module exposes a tiny,
 * dependency-free counter registry that the ingest path increments and that a
 * later metrics-exposition task can read from. Keeping it self-contained makes
 * the counting behaviour trivially unit-testable.
 */

/** Named counters tracked by the ingest pipeline. */
export interface TelemetryMetricsSnapshot {
  /** Frames that could not be decoded into a valid sample (Req 8.6). */
  readonly parseErrors: number;
  /** Frames successfully decoded into a normalized sample. */
  readonly framesParsed: number;
  /** Samples accepted for persistence after passing all validation. */
  readonly samplesPersisted: number;
  /** Samples rejected by bounds validation (Req 8.4). */
  readonly samplesRejectedBounds: number;
  /** Samples rejected for non-increasing per-drone timestamps (Req 8.5). */
  readonly samplesRejectedNonMonotonic: number;
  /** Drone WebSocket connections accepted after successful authentication. */
  readonly connectionsAccepted: number;
  /** Drone WebSocket connections rejected for a missing/invalid token (Req 8.1). */
  readonly connectionsRejected: number;
}

/** Mutable counter set with increment helpers and an immutable snapshot view. */
export interface TelemetryMetrics {
  incParseErrors(delta?: number): void;
  incFramesParsed(delta?: number): void;
  incSamplesPersisted(delta?: number): void;
  incSamplesRejectedBounds(delta?: number): void;
  incSamplesRejectedNonMonotonic(delta?: number): void;
  incConnectionsAccepted(delta?: number): void;
  incConnectionsRejected(delta?: number): void;
  /** Return an immutable point-in-time copy of all counters. */
  snapshot(): TelemetryMetricsSnapshot;
}

/**
 * Create a fresh metrics registry with all counters at zero. A factory (rather
 * than a module-level singleton) keeps tests isolated and lets the composition
 * root own the instance's lifetime.
 */
export function createMetrics(): TelemetryMetrics {
  let parseErrors = 0;
  let framesParsed = 0;
  let samplesPersisted = 0;
  let samplesRejectedBounds = 0;
  let samplesRejectedNonMonotonic = 0;
  let connectionsAccepted = 0;
  let connectionsRejected = 0;

  return {
    incParseErrors(delta = 1): void {
      parseErrors += delta;
    },
    incFramesParsed(delta = 1): void {
      framesParsed += delta;
    },
    incSamplesPersisted(delta = 1): void {
      samplesPersisted += delta;
    },
    incSamplesRejectedBounds(delta = 1): void {
      samplesRejectedBounds += delta;
    },
    incSamplesRejectedNonMonotonic(delta = 1): void {
      samplesRejectedNonMonotonic += delta;
    },
    incConnectionsAccepted(delta = 1): void {
      connectionsAccepted += delta;
    },
    incConnectionsRejected(delta = 1): void {
      connectionsRejected += delta;
    },
    snapshot(): TelemetryMetricsSnapshot {
      return {
        parseErrors,
        framesParsed,
        samplesPersisted,
        samplesRejectedBounds,
        samplesRejectedNonMonotonic,
        connectionsAccepted,
        connectionsRejected,
      };
    },
  };
}
