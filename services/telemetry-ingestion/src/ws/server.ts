/**
 * WebSocket server wiring for drone telemetry streams (Requirements 8.1, 8.2,
 * 8.6).
 *
 * Responsibilities implemented here (task 7.3):
 * - Authenticate each connection against the shared drone token and reject
 *   (clean-close) unauthenticated/unattributable connections; acknowledge the
 *   subscription on success (Req 8.1).
 * - Decode each inbound frame into a normalized sample and hand it to the
 *   batching persister; drop malformed frames, increment the parse-error
 *   metric, and keep the socket open (Req 8.6).
 *
 * Anomaly detection (7.5), historical query (7.7) and the load harness (7.10)
 * are out of scope for this module.
 */
import type { IncomingHttpHeaders, Server as HttpServer } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { TelemetrySample } from '@pawaac/shared-types';
import { MalformedFrameError, parseFrame, type ParseContext } from '../mavlink/codec.js';
import type { TelemetryMetrics } from '../metrics.js';
import type { BatchingPersister } from '../persist/persister.js';

/**
 * Minimal anomaly-observer surface consumed by the ingest path. The concrete
 * {@link AnomalyPipeline} satisfies it; depending only on this keeps the WS
 * handler decoupled from detection internals and easy to unit test.
 */
export interface SampleObserver {
  observe(sample: TelemetrySample): unknown;
}

/** Path on which drones open their telemetry WebSocket. */
export const TELEMETRY_WS_PATH = '/ingest';

/** WebSocket close code for a policy violation (RFC 6455). */
const CLOSE_POLICY_VIOLATION = 1008;
/** WebSocket close code for an unexpected server-side condition. */
const CLOSE_INTERNAL_ERROR = 1011;

/** Loose UUID v1–v5 shape check used to validate the supplied drone id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Minimal socket surface used by the connection handler. `ws.WebSocket`
 * structurally satisfies it; depending only on this keeps the handler unit
 * testable with a tiny fake socket.
 */
export interface DroneSocket {
  on(event: 'message', listener: (data: RawData) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Successful authentication yields the attributed drone id. */
export interface AuthSuccess {
  readonly ok: true;
  readonly droneId: string;
}

/** Failed authentication carries the close code/reason to send to the client. */
export interface AuthFailure {
  readonly ok: false;
  readonly closeCode: number;
  readonly reason: string;
}

export type AuthResult = AuthSuccess | AuthFailure;

/** Inputs for the pure authorization decision. */
export interface AuthorizeInput {
  /** Raw request URL (e.g. `/ingest?token=...&droneId=...`). */
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  /** Configured shared token; `undefined` means auth is not configured. */
  readonly expectedToken: string | undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/** Extract a bearer/token credential from headers or the query string. */
function extractToken(url: URL, headers: IncomingHttpHeaders): string | undefined {
  const authHeader = firstHeader(headers.authorization);
  if (authHeader !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match && match[1] !== undefined) {
      return match[1].trim();
    }
  }
  const queryToken = url.searchParams.get('token');
  return queryToken === null ? undefined : queryToken;
}

/**
 * Pure authorization decision for an incoming WebSocket upgrade (Req 8.1):
 * requires a configured token, a matching presented token, and a well-formed
 * `droneId` so every persisted sample can be attributed to a drone.
 */
export function authorizeRequest(input: AuthorizeInput): AuthResult {
  if (input.expectedToken === undefined) {
    return { ok: false, closeCode: CLOSE_INTERNAL_ERROR, reason: 'drone authentication not configured' };
  }

  // A base is required to parse a relative request URL.
  let url: URL;
  try {
    url = new URL(input.url ?? '/', 'http://telemetry.local');
  } catch {
    return { ok: false, closeCode: CLOSE_POLICY_VIOLATION, reason: 'invalid request' };
  }

  const token = extractToken(url, input.headers);
  if (token === undefined || token !== input.expectedToken) {
    return { ok: false, closeCode: CLOSE_POLICY_VIOLATION, reason: 'invalid drone token' };
  }

  const droneId = url.searchParams.get('droneId') ?? firstHeader(input.headers['x-drone-id']);
  if (droneId === undefined || droneId === null || !UUID_RE.test(droneId)) {
    return { ok: false, closeCode: CLOSE_POLICY_VIOLATION, reason: 'missing or invalid drone id' };
  }

  return { ok: true, droneId };
}

/** Normalize the various `ws` payload shapes into a single `Uint8Array`. */
export function toUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  // ArrayBuffer
  return new Uint8Array(data);
}

/** Dependencies for the per-connection handler. */
export interface ConnectionHandlerDeps {
  readonly expectedToken: string | undefined;
  readonly persister: BatchingPersister;
  readonly metrics: TelemetryMetrics;
  /**
   * Optional anomaly detector run against the recent per-drone history window
   * for each successfully parsed sample (Req 9). Omitted in bootstrap/HTTP-only
   * wiring; detection failures must never disrupt the ingest stream.
   */
  readonly anomalies?: SampleObserver;
}

/**
 * Decode one frame and forward it to the persister. Malformed frames are
 * dropped: the parse-error metric is incremented and the socket stays open
 * (Req 8.6). Any unexpected decode error is treated the same way so a single
 * bad frame can never tear down a healthy stream.
 */
export function handleFrame(
  data: RawData,
  context: ParseContext,
  deps: ConnectionHandlerDeps,
): void {
  let sample;
  try {
    sample = parseFrame(toUint8Array(data), context);
  } catch (err) {
    if (err instanceof MalformedFrameError) {
      deps.metrics.incParseErrors();
      return;
    }
    // Defensive: never let an unexpected decode error propagate to the socket.
    deps.metrics.incParseErrors();
    return;
  }
  deps.metrics.incFramesParsed();
  // Run anomaly detection against the recent per-drone window (Req 9) before
  // persistence (design sequence: parse -> detect -> insert). A detector fault
  // must never tear down a healthy stream, so it is isolated defensively.
  if (deps.anomalies !== undefined) {
    try {
      deps.anomalies.observe(sample);
    } catch {
      /* detection is best-effort; never disrupt ingest on a detector error */
    }
  }
  deps.persister.offer(sample);
}

/**
 * Handle a freshly opened drone connection: authenticate, acknowledge the
 * subscription, and wire frame handling. Exported (separately from the WS
 * server) so it can be unit tested with a fake socket.
 */
export function handleConnection(
  socket: DroneSocket,
  headers: IncomingHttpHeaders,
  url: string | undefined,
  deps: ConnectionHandlerDeps,
): void {
  // Swallow socket-level errors so one misbehaving client cannot crash us.
  socket.on('error', () => {
    /* intentionally ignored */
  });

  const auth = authorizeRequest({ url, headers, expectedToken: deps.expectedToken });
  if (!auth.ok) {
    deps.metrics.incConnectionsRejected();
    socket.close(auth.closeCode, auth.reason);
    return;
  }

  deps.metrics.incConnectionsAccepted();
  const context: ParseContext = { droneId: auth.droneId };

  // Acknowledge the subscription (Req 8.1).
  socket.send(JSON.stringify({ type: 'subscription_ack', droneId: auth.droneId }));

  socket.on('message', (data: RawData) => {
    handleFrame(data, context, deps);
  });
}

/** Options for {@link createTelemetryWsServer}. */
export interface TelemetryWsOptions {
  /** Path to bind the WebSocket server to. Defaults to {@link TELEMETRY_WS_PATH}. */
  readonly path?: string;
  /**
   * Ingest dependencies. When omitted the server only accepts and holds
   * connections open (used by bootstrap/HTTP-only tests); when provided, full
   * authentication + frame ingest is wired up.
   */
  readonly deps?: ConnectionHandlerDeps;
}

/**
 * Attach a WebSocket server to an existing HTTP server. Returning the
 * `WebSocketServer` lets callers close it during graceful shutdown.
 */
export function createTelemetryWsServer(
  server: HttpServer,
  options: TelemetryWsOptions = {},
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: options.path ?? TELEMETRY_WS_PATH,
  });

  const deps = options.deps;

  wss.on('connection', (socket: WebSocket, request) => {
    if (deps === undefined) {
      // Bootstrap mode: keep the socket open, swallow socket-level errors.
      socket.on('error', () => {
        /* intentionally ignored */
      });
      return;
    }
    handleConnection(socket, request.headers, request.url, deps);
  });

  return wss;
}
