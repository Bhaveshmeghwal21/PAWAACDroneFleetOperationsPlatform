/**
 * Anomaly fan-out (Requirement 9.7): when an anomaly is detected the service
 * must (a) emit an anomaly *event* to the Alert & Notification service and
 * (b) push the anomaly live to the Ops Dashboard.
 *
 * Both destinations sit behind small **injectable interfaces** so the detection
 * pipeline never touches `fetch`/sockets directly and stays fully unit-testable
 * with in-memory fakes:
 * - {@link AlertServiceClient} — POSTs an {@link AnomalyDomainEvent} to the
 *   Alert service (`ALERT_NOTIFICATION_URL`). The actual HTTP call is provided
 *   by an injected {@link HttpPost}, defaulting to a `fetch`-based poster.
 * - {@link DashboardPublisher} — pushes an {@link Anomaly} to connected
 *   dashboard clients. The transport (WS broadcast, SSE, …) is supplied by the
 *   composition root; this module only defines the hook.
 *
 * {@link createAnomalyEmitter} composes any number of sinks into a single
 * `emit(anomaly)` call used by the ingest path.
 */
import type { Anomaly, AnomalyDomainEvent } from '@pawaac/shared-types';

/** A destination for detected anomalies. Implementations must not throw. */
export interface AnomalySink {
  /** Deliver one anomaly. Errors are handled internally (logged), never thrown. */
  emit(anomaly: Anomaly): void;
}

/** Wrap a detected {@link Anomaly} in the cross-service domain-event envelope. */
export function toAnomalyEvent(anomaly: Anomaly): AnomalyDomainEvent {
  return {
    kind: 'anomaly',
    ts: anomaly.ts,
    droneId: anomaly.droneId,
    payload: anomaly,
  };
}

/**
 * Minimal HTTP POST abstraction. Returning a settled promise (resolve on 2xx,
 * reject otherwise) is all the Alert client needs; the default implementation
 * uses the global `fetch`, but tests inject a fake.
 */
export type HttpPost = (url: string, body: string, headers: Record<string, string>) => Promise<void>;

/** Default {@link HttpPost} backed by the global `fetch` (Node >= 20). */
export const fetchHttpPost: HttpPost = async (url, body, headers) => {
  const res = await fetch(url, { method: 'POST', body, headers });
  if (!res.ok) {
    throw new Error(`Alert service responded ${res.status} ${res.statusText}`);
  }
};

/** Construction options for {@link AlertServiceClient}. */
export interface AlertServiceClientOptions {
  /** Alert service notification endpoint (`ALERT_NOTIFICATION_URL`). */
  readonly url: string;
  /** Injectable POST implementation; defaults to {@link fetchHttpPost}. */
  readonly post?: HttpPost;
  /** Called when delivery fails so a flaky Alert service never breaks ingest. */
  readonly onError?: (err: unknown, anomaly: Anomaly) => void;
  /** Extra headers (e.g. trace id) merged into each request. */
  readonly headers?: Record<string, string>;
}

/**
 * {@link AnomalySink} that POSTs anomaly events to the Alert service. Delivery
 * is fire-and-forget: a rejected POST is routed to `onError` and never
 * propagates into the (synchronous, hot-path) `emit` caller.
 */
export class AlertServiceClient implements AnomalySink {
  private readonly url: string;
  private readonly post: HttpPost;
  private readonly onError: (err: unknown, anomaly: Anomaly) => void;
  private readonly headers: Record<string, string>;

  constructor(options: AlertServiceClientOptions) {
    this.url = options.url;
    this.post = options.post ?? fetchHttpPost;
    this.onError = options.onError ?? ((): void => undefined);
    this.headers = { 'Content-Type': 'application/json', ...options.headers };
  }

  emit(anomaly: Anomaly): void {
    const body = JSON.stringify(toAnomalyEvent(anomaly));
    // Detach the network call from the hot path; surface failures via onError.
    void this.post(this.url, body, this.headers).catch((err: unknown) => {
      this.onError(err, anomaly);
    });
  }
}

/** A live push channel to the Ops Dashboard (WS broadcast, SSE, …). */
export interface DashboardPublisher {
  publish(anomaly: Anomaly): void;
}

/**
 * {@link AnomalySink} adapter over a {@link DashboardPublisher} callback. Keeps
 * the dashboard transport pluggable while shielding the hot path from throws.
 */
export class DashboardSink implements AnomalySink {
  private readonly publisher: DashboardPublisher;
  private readonly onError: (err: unknown, anomaly: Anomaly) => void;

  constructor(
    publisher: DashboardPublisher,
    onError: (err: unknown, anomaly: Anomaly) => void = (): void => undefined,
  ) {
    this.publisher = publisher;
    this.onError = onError;
  }

  emit(anomaly: Anomaly): void {
    try {
      this.publisher.publish(anomaly);
    } catch (err) {
      this.onError(err, anomaly);
    }
  }
}

/** A composed emitter: fans one anomaly out to every configured sink. */
export interface AnomalyEmitter {
  emit(anomaly: Anomaly): void;
}

/**
 * Compose `sinks` into a single {@link AnomalyEmitter}. Each sink is invoked
 * independently; one misbehaving sink never blocks the others (sinks are
 * contractually non-throwing, but we still isolate them defensively).
 */
export function createAnomalyEmitter(sinks: readonly AnomalySink[]): AnomalyEmitter {
  return {
    emit(anomaly: Anomaly): void {
      for (const sink of sinks) {
        try {
          sink.emit(anomaly);
        } catch {
          /* sinks own their errors; never let one sink break the fan-out */
        }
      }
    },
  };
}
