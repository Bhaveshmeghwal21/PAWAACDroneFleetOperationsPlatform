/**
 * Application composition for the Telemetry Ingestion service.
 *
 * Wires together a minimal Node `http` server exposing the operational
 * endpoints required by Requirement 34 — `/health` (liveness) and `/ready`
 * (readiness incl. datastore connectivity) — with RFC 7807 problem+json error
 * bodies (34.2) and `X-Trace-Id` propagation (34.3), plus the (bootstrap-empty)
 * WebSocket server for drone streams.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { WebSocketServer } from 'ws';
import {
  AlertServiceClient,
  createAnomalyEmitter,
  DashboardSink,
  type AnomalySink,
  type DashboardPublisher,
} from './anomaly/emitter.js';
import { AnomalyPipeline } from './anomaly/pipeline.js';
import type { AppConfig } from './config.js';
import type { ReadinessProbe } from './db/pool.js';
import { createProblem, writeProblem, type ProblemDetails } from './http/problem.js';
import { resolveTraceIdFromHeaders } from './http/trace.js';
import { createMetrics, type TelemetryMetrics } from './metrics.js';
import { BatchingPersister } from './persist/persister.js';
import type { TelemetryStore } from './persist/store.js';
import { HistoryQueryValidationError, type HistoryQueryReader } from './query/history.js';
import { createTelemetryWsServer, type ConnectionHandlerDeps } from './ws/server.js';

/** Options for {@link createApp}. */
export interface CreateAppOptions {
  readonly config: AppConfig;
  /**
   * Readiness probe used by `/ready`. Optional so tests and the bootstrap
   * (pre-persistence) phase can run without a live datastore; when absent the
   * service reports itself ready (liveness-equivalent).
   */
  readonly readiness?: ReadinessProbe;
  /**
   * Telemetry sink for the WebSocket ingest path. When provided, full
   * authentication + MAVLink parsing + batched persistence is wired onto the
   * WebSocket server; when omitted the server only accepts/holds connections
   * (bootstrap/HTTP-only tests).
   */
  readonly store?: TelemetryStore;
  /** Metrics registry; a fresh one is created when not supplied. */
  readonly metrics?: TelemetryMetrics;
  /**
   * Live push channel to the Ops Dashboard for detected anomalies (Req 9.7).
   * When provided, anomalies are published here in addition to the Alert
   * service HTTP sink; when omitted, only the Alert sink (if configured) runs.
   */
  readonly dashboardPublisher?: DashboardPublisher;
  /**
   * Reader serving the historical telemetry query endpoint
   * (`GET /telemetry/:droneId/history`, Requirement 10). When omitted the
   * endpoint responds 503 (no datastore configured), matching the
   * bootstrap/HTTP-only mode used by `/ready`.
   */
  readonly historyReader?: HistoryQueryReader;
}

/** A constructed but not-yet-listening application. */
export interface App {
  readonly server: Server;
  readonly wss: WebSocketServer;
  readonly metrics: TelemetryMetrics;
  /** Persister wired to the ingest path, when a store was provided. */
  readonly persister: BatchingPersister | undefined;
  /** Anomaly detection pipeline wired to the ingest path, when enabled. */
  readonly anomalyPipeline: AnomalyPipeline | undefined;
  /** Begin listening on the configured port; resolves once bound. */
  listen(): Promise<void>;
  /** Gracefully close the WebSocket and HTTP servers. */
  close(): Promise<void>;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  traceHeader: string,
  traceId: string,
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    [traceHeader]: traceId,
  });
  res.end(JSON.stringify(body));
}

async function handleReady(
  res: ServerResponse,
  options: CreateAppOptions,
  traceId: string,
): Promise<void> {
  const { traceHeader } = options.config;
  if (options.readiness === undefined) {
    sendJson(res, 200, { status: 'ready', checks: { database: 'skipped' } }, traceHeader, traceId);
    return;
  }
  try {
    await options.readiness.ping();
    sendJson(res, 200, { status: 'ready', checks: { database: 'up' } }, traceHeader, traceId);
  } catch {
    const problem: ProblemDetails = createProblem({
      status: 503,
      title: 'Service Unavailable',
      detail: 'The telemetry datastore is not reachable.',
    });
    writeProblem(res, problem, traceHeader, traceId);
  }
}

/** Pattern for `GET /telemetry/:droneId/history` (path without query string). */
const HISTORY_ROUTE = /^\/telemetry\/([^/]+)\/history$/;

/**
 * Serve the historical telemetry query (Requirement 10). Parses the time range
 * and optional `buckets` cap from the query string, delegates to the injected
 * reader (which validates `from <= to`, plans downsampling, and runs the SQL),
 * and maps a {@link HistoryQueryValidationError} to an RFC 7807 400 (Req 10.4).
 */
async function handleHistory(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateAppOptions,
  traceId: string,
  droneId: string,
  instance: string,
): Promise<void> {
  const { traceHeader } = options.config;
  if (options.historyReader === undefined) {
    writeProblem(
      res,
      createProblem({
        status: 503,
        title: 'Service Unavailable',
        detail: 'Historical telemetry query is unavailable: no datastore is configured.',
        instance,
      }),
      traceHeader,
      traceId,
    );
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  const buckets = url.searchParams.get('buckets') ?? undefined;

  try {
    const series = await options.historyReader.queryHistory({ droneId, from, to, buckets });
    sendJson(res, 200, series, traceHeader, traceId);
  } catch (err) {
    if (err instanceof HistoryQueryValidationError) {
      writeProblem(
        res,
        createProblem({
          status: err.status,
          title: 'Bad Request',
          detail: err.message,
          instance,
        }),
        traceHeader,
        traceId,
      );
      return;
    }
    throw err;
  }
}

function createRequestHandler(options: CreateAppOptions) {
  const { traceHeader } = options.config;

  return (req: IncomingMessage, res: ServerResponse): void => {
    const traceId = resolveTraceIdFromHeaders(req.headers, traceHeader);
    // Strip any query string for routing purposes.
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const method = req.method ?? 'GET';

    void (async () => {
      try {
        if (method === 'GET' && path === '/health') {
          sendJson(res, 200, { status: 'ok' }, traceHeader, traceId);
          return;
        }
        if (method === 'GET' && path === '/ready') {
          await handleReady(res, options, traceId);
          return;
        }
        const historyMatch = HISTORY_ROUTE.exec(path);
        if (method === 'GET' && historyMatch?.[1] !== undefined) {
          await handleHistory(
            req,
            res,
            options,
            traceId,
            decodeURIComponent(historyMatch[1]),
            path,
          );
          return;
        }
        writeProblem(
          res,
          createProblem({
            status: 404,
            title: 'Not Found',
            detail: `No route for ${method} ${path}.`,
            instance: path,
          }),
          traceHeader,
          traceId,
        );
      } catch {
        if (!res.headersSent) {
          writeProblem(
            res,
            createProblem({
              status: 500,
              title: 'Internal Server Error',
              detail: 'An unexpected error occurred while handling the request.',
            }),
            traceHeader,
            traceId,
          );
        }
      }
    })();
  };
}

/**
 * Build the Telemetry Ingestion application: an HTTP server with operational
 * endpoints and an attached WebSocket server. The returned object is not yet
 * listening — call {@link App.listen}.
 */
export function createApp(options: CreateAppOptions): App {
  const metrics = options.metrics ?? createMetrics();
  const server = createServer(createRequestHandler(options));

  // Wire full ingest (auth + parse + persist + anomaly detection) only when a
  // store is available; otherwise fall back to the bootstrap accept-and-hold
  // WebSocket server.
  let persister: BatchingPersister | undefined;
  let anomalyPipeline: AnomalyPipeline | undefined;
  let wss: WebSocketServer;
  if (options.store !== undefined) {
    persister = new BatchingPersister({
      store: options.store,
      metrics,
      onError: (err: unknown) => {
        console.error(
          JSON.stringify({ level: 'error', msg: 'telemetry persist flush failed', err: String(err) }),
        );
      },
    });

    // Assemble anomaly sinks: Alert service (when a URL is configured) and the
    // dashboard publisher (when provided). The pipeline is always created so
    // detection runs even if no sink is configured (anomalies are still
    // counted/observable); an empty emitter is a harmless no-op.
    const sinks: AnomalySink[] = [];
    if (options.config.alertNotificationUrl !== undefined) {
      sinks.push(
        new AlertServiceClient({
          url: options.config.alertNotificationUrl,
          onError: (err: unknown) => {
            console.error(
              JSON.stringify({ level: 'error', msg: 'anomaly alert dispatch failed', err: String(err) }),
            );
          },
        }),
      );
    }
    if (options.dashboardPublisher !== undefined) {
      sinks.push(
        new DashboardSink(options.dashboardPublisher, (err: unknown) => {
          console.error(
            JSON.stringify({ level: 'error', msg: 'anomaly dashboard push failed', err: String(err) }),
          );
        }),
      );
    }
    anomalyPipeline = new AnomalyPipeline({
      emitter: createAnomalyEmitter(sinks),
      thresholds: {
        altDropThreshold: options.config.altDropThreshold,
        batteryDrainThreshold: options.config.batteryDrainThreshold,
      },
    });

    const deps: ConnectionHandlerDeps = {
      expectedToken: options.config.droneAuthToken,
      persister,
      metrics,
      anomalies: anomalyPipeline,
    };
    wss = createTelemetryWsServer(server, { deps });
  } else {
    wss = createTelemetryWsServer(server);
  }

  const { port } = options.config;

  return {
    server,
    wss,
    metrics,
    persister,
    anomalyPipeline,
    listen(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        server.listen(port, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const finalizeClose = (): void => {
          wss.close((wssErr?: Error) => {
            server.close((srvErr?: Error) => {
              const err = wssErr ?? srvErr;
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          });
        };
        // Flush any buffered samples before tearing down the servers.
        if (persister !== undefined) {
          persister.stop().then(finalizeClose, finalizeClose);
        } else {
          finalizeClose();
        }
      });
    },
  };
}
