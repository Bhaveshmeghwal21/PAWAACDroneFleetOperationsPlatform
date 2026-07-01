/**
 * Telemetry ingest load-test harness (task 7.10, Requirements 8.7, 32.1, 32.2).
 *
 * Simulates a fleet of drones streaming real MAVLink frames at a fixed rate to
 * the Telemetry Ingestion WebSocket server (`/ingest`) and measures the metrics
 * the performance benchmark (task 17.5) records:
 *
 * - **Throughput** — frames per second successfully written to the wire,
 *   aggregated across all simulated drones.
 * - **Ingest latency p50/p95/p99** — see the latency-proxy note below.
 * - **Dropped-frame rate** — scheduled frames that did not make it onto the
 *   wire within the run, divided by the number scheduled.
 *
 * ## Latency proxy
 *
 * The ingest protocol acknowledges the *subscription* once (Req 8.1) but does
 * not emit a per-frame application ACK, and frames are persisted in batches
 * asynchronously (see {@link BatchingPersister}). There is therefore no
 * end-to-end "frame persisted" signal the client can observe without changing
 * the server contract (which is out of scope for this task). The harness
 * instead measures the **send-completion latency**: the time from invoking
 * `ws.send(frame)` to the transport reporting the frame as flushed. Under
 * sustained load this is a faithful proxy for ingest latency because a server
 * that cannot keep up exerts TCP backpressure, which delays exactly this
 * callback. The metric is labelled `sendLatencyMs` in the result to keep the
 * proxy explicit. (A future task may add an echo/ack frame for true
 * round-trip latency.)
 *
 * The harness uses the production {@link encode} codec so every frame is a
 * valid, CRC-correct MAVLink v2 frame the server actually parses.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import type { TelemetrySample, Uuid } from '@pawaac/shared-types';
import { encode } from '../mavlink/codec.js';
import { ratio, summarizeLatency, type LatencySummary } from './stats.js';

/** Default ingest server base URL (matches the container's port 3003). */
export const DEFAULT_TARGET_URL = 'ws://127.0.0.1:3003';
/** Default WebSocket path the ingest server binds to. */
export const DEFAULT_PATH = '/ingest';
/** Default concurrent drone streams (Req 32.1 floor). */
export const DEFAULT_DRONES = 10;
/** Default per-drone send rate in Hz (Req 32.1). */
export const DEFAULT_RATE_HZ = 10;
/** Default sustained run duration in milliseconds. */
export const DEFAULT_DURATION_MS = 10_000;
/** Default grace period after the window closes to let in-flight sends settle. */
export const DEFAULT_DRAIN_MS = 1_000;

/** Tunable parameters for a load-test run. */
export interface LoadTestOptions {
  /** Base WebSocket URL of the ingest server, e.g. `ws://127.0.0.1:3003`. */
  readonly url?: string;
  /** WebSocket path; defaults to {@link DEFAULT_PATH}. */
  readonly path?: string;
  /** Shared drone auth token the server expects (Req 8.1). */
  readonly token: string;
  /** Number of concurrent simulated drone streams. */
  readonly drones?: number;
  /** Per-drone send rate in Hz. */
  readonly rateHz?: number;
  /** Sustained duration of the send window in milliseconds. */
  readonly durationMs?: number;
  /** Grace period after the window to await in-flight send callbacks. */
  readonly drainMs?: number;
  /**
   * Factory for the (UUID) id of the i-th drone. Defaults to a random UUID per
   * drone; injectable so tests can use deterministic ids.
   */
  readonly droneId?: (index: number) => Uuid;
}

/** The fully aggregated outcome of a load-test run. */
export interface LoadTestResult {
  /** Echo of the effective configuration used for the run. */
  readonly config: {
    readonly url: string;
    readonly path: string;
    readonly drones: number;
    readonly rateHz: number;
    readonly durationMs: number;
  };
  /** ISO timestamp the send window opened. */
  readonly startedAt: string;
  /** Actual measured wall-clock duration of the send window, in seconds. */
  readonly durationSec: number;
  /** Drone connections that successfully opened and acknowledged. */
  readonly connectedDrones: number;
  /** Total frames scheduled to be sent across all drones during the window. */
  readonly scheduledFrames: number;
  /** Frames the transport confirmed as written (counted toward throughput). */
  readonly sentFrames: number;
  /** Frames whose send callback reported an error. */
  readonly failedFrames: number;
  /** Frames scheduled but never confirmed as sent (= scheduled − sent). */
  readonly droppedFrames: number;
  /** {@link droppedFrames} / {@link scheduledFrames}, in `[0, 1]`. */
  readonly droppedFrameRate: number;
  /** Aggregate sustained throughput in frames per second. */
  readonly throughputFps: number;
  /** Send-completion latency summary (see module note on the latency proxy). */
  readonly sendLatencyMs: LatencySummary;
  /** Connection-level errors encountered (e.g. server unreachable). */
  readonly errors: readonly string[];
}

/** Build a single valid, in-bounds telemetry sample for the given drone/tick. */
function buildSample(droneId: Uuid, baseEpochMs: number, tick: number): TelemetrySample {
  // Strictly increasing per-drone timestamps (Req 8.5) so the server accepts
  // every frame rather than dropping it as non-monotonic.
  const ts = new Date(baseEpochMs + tick).toISOString();
  const phase = tick * 0.1;
  return {
    droneId,
    ts,
    lat: 37.4275 + Math.sin(phase) * 0.001,
    lon: -122.1697 + Math.cos(phase) * 0.001,
    altitude: 100 + Math.sin(phase) * 5,
    velocity: { vx: Math.cos(phase), vy: Math.sin(phase), vz: 0 },
    attitude: { roll: 0.01 * Math.sin(phase), pitch: 0.01 * Math.cos(phase), yaw: phase % (2 * Math.PI) },
    battery: { voltage: 22.2, current: 10, remainingPct: Math.max(0, 100 - tick * 0.001) },
    ekf2: { healthy: true, flags: 0 },
    rcSignalStrength: 95,
    flightMode: 'AUTO',
    armed: true,
  };
}

/** Mutable per-run accumulator shared by all drone workers. */
interface RunStats {
  scheduledFrames: number;
  sentFrames: number;
  failedFrames: number;
  connectedDrones: number;
  readonly latencies: number[];
  readonly errors: string[];
}

/** Compose the full connection URL for a drone. */
function buildUrl(base: string, path: string, token: string, droneId: Uuid): string {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  // `new URL('/ingest', 'ws://h:3003/')` keeps the path correctly.
  url.pathname = path;
  url.searchParams.set('token', token);
  url.searchParams.set('droneId', droneId);
  return url.toString();
}

/**
 * Drive one simulated drone: open the socket, and once it is open send a frame
 * every `periodMs` until `stop()` is called. Resolves once the socket has been
 * closed and all in-flight send callbacks have settled.
 */
function runDrone(
  index: number,
  options: Required<Omit<LoadTestOptions, 'token' | 'url' | 'path' | 'droneId'>> & {
    readonly url: string;
    readonly path: string;
    readonly token: string;
    readonly droneId: Uuid;
  },
  periodMs: number,
  baseEpochMs: number,
  stats: RunStats,
  stopSignal: { stopped: boolean },
): { socket: WebSocket; done: Promise<void> } {
  const socket = new WebSocket(buildUrl(options.url, options.path, options.token, options.droneId));
  socket.binaryType = 'nodebuffer';

  let timer: ReturnType<typeof setInterval> | undefined;
  let tick = 0;
  let inFlight = 0;

  const done = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      // Resolve only once no send callbacks remain outstanding.
      if (inFlight === 0) {
        resolve();
      } else {
        const wait = setInterval(() => {
          if (inFlight === 0) {
            clearInterval(wait);
            resolve();
          }
        }, 10);
        wait.unref?.();
      }
    };

    socket.on('open', () => {
      stats.connectedDrones += 1;
      timer = setInterval(() => {
        if (stopSignal.stopped || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        stats.scheduledFrames += 1;
        const frame = encode(buildSample(options.droneId, baseEpochMs + index, tick));
        tick += 1;
        const startedAt = performance.now();
        inFlight += 1;
        socket.send(frame, { binary: true }, (err?: Error) => {
          inFlight -= 1;
          if (err) {
            stats.failedFrames += 1;
          } else {
            stats.sentFrames += 1;
            stats.latencies.push(performance.now() - startedAt);
          }
        });
      }, periodMs);
      timer.unref?.();
    });

    socket.on('error', (err: Error) => {
      stats.errors.push(`drone[${index}]: ${err.message}`);
    });

    socket.on('close', () => {
      finish();
    });
  });

  return { socket, done };
}

/**
 * Sleep for `ms` milliseconds. The timer is intentionally *not* `unref`'d: it
 * must keep the event loop alive for the full window/drain even if every socket
 * dies early (e.g. the server is unreachable), so the run always produces a
 * result rather than letting the process exit prematurely.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run a sustained ingest load test and return the aggregated metrics. Opens
 * `drones` authenticated WebSocket connections, streams encoded MAVLink frames
 * at `rateHz` for `durationMs`, then closes the connections and reports
 * throughput, send-completion latency percentiles, and the dropped-frame rate.
 *
 * The function never throws on connection failure: an unreachable server simply
 * yields zero throughput, an empty latency summary, and the connection errors
 * surfaced in {@link LoadTestResult.errors}.
 */
export async function runLoadTest(options: LoadTestOptions): Promise<LoadTestResult> {
  const url = options.url ?? DEFAULT_TARGET_URL;
  const path = options.path ?? DEFAULT_PATH;
  const drones = options.drones ?? DEFAULT_DRONES;
  const rateHz = options.rateHz ?? DEFAULT_RATE_HZ;
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  const droneIdFactory = options.droneId ?? ((): Uuid => randomUUID());

  if (rateHz <= 0) {
    throw new RangeError(`rateHz must be positive, received ${rateHz}`);
  }
  if (drones <= 0) {
    throw new RangeError(`drones must be positive, received ${drones}`);
  }

  const periodMs = 1000 / rateHz;
  const baseEpochMs = Date.now();
  const stats: RunStats = {
    scheduledFrames: 0,
    sentFrames: 0,
    failedFrames: 0,
    connectedDrones: 0,
    latencies: [],
    errors: [],
  };
  const stopSignal = { stopped: false };

  const startedAtMs = Date.now();
  const workers = Array.from({ length: drones }, (_unused, index) =>
    runDrone(
      index,
      { url, path, token: options.token, droneId: droneIdFactory(index), drones, rateHz, durationMs, drainMs },
      periodMs,
      baseEpochMs,
      stats,
      stopSignal,
    ),
  );

  // Let the window run for the requested duration, then stop scheduling.
  await delay(durationMs);
  stopSignal.stopped = true;
  const measuredDurationSec = (Date.now() - startedAtMs) / 1000;

  // Allow in-flight sends to settle, then close every socket.
  await delay(drainMs);
  for (const worker of workers) {
    if (worker.socket.readyState === WebSocket.OPEN || worker.socket.readyState === WebSocket.CONNECTING) {
      worker.socket.close(1000, 'load-test complete');
    }
  }
  await Promise.all(workers.map((worker) => worker.done));

  const droppedFrames = stats.scheduledFrames - stats.sentFrames;
  return {
    config: { url, path, drones, rateHz, durationMs },
    startedAt: new Date(startedAtMs).toISOString(),
    durationSec: measuredDurationSec,
    connectedDrones: stats.connectedDrones,
    scheduledFrames: stats.scheduledFrames,
    sentFrames: stats.sentFrames,
    failedFrames: stats.failedFrames,
    droppedFrames,
    droppedFrameRate: ratio(droppedFrames, stats.scheduledFrames),
    throughputFps: ratio(stats.sentFrames, measuredDurationSec),
    sendLatencyMs: summarizeLatency(stats.latencies),
    errors: stats.errors,
  };
}
