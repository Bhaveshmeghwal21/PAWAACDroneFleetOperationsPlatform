/**
 * CLI entry point for the telemetry ingest load test (task 7.10).
 *
 * Reads its parameters from the environment so it can be driven by CI or a
 * developer shell without code changes, runs the harness against a (separately
 * started) ingest server, and prints a single JSON summary to stdout — the
 * exact figures task 17.5 transcribes into BENCHMARKS.md.
 *
 * Environment variables:
 * - `TARGET_URL`         WebSocket base URL (default `ws://127.0.0.1:3003`).
 * - `LOADTEST_PATH`      WebSocket path (default `/ingest`).
 * - `DRONE_AUTH_TOKEN`   Shared auth token the server expects (Req 8.1). Required.
 * - `LOADTEST_DRONES`    Concurrent drone streams (default 10).
 * - `LOADTEST_RATE_HZ`   Per-drone send rate in Hz (default 10).
 * - `LOADTEST_DURATION_MS` Sustained window in ms (default 10000).
 * - `LOADTEST_DRAIN_MS`  Post-window grace for in-flight sends (default 1000).
 *
 * This module requires a running ingest server. Start one in another process
 * (e.g. `DRONE_AUTH_TOKEN=secret PORT=3003 npm start`) before invoking it; the
 * harness will otherwise report zero throughput and the connection errors.
 */
import {
  DEFAULT_DRAIN_MS,
  DEFAULT_DRONES,
  DEFAULT_DURATION_MS,
  DEFAULT_PATH,
  DEFAULT_RATE_HZ,
  DEFAULT_TARGET_URL,
  runLoadTest,
  type LoadTestOptions,
} from './harness.js';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: "${raw}" (expected a positive integer)`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const token = process.env.DRONE_AUTH_TOKEN;
  if (token === undefined || token.trim() === '') {
    throw new Error('DRONE_AUTH_TOKEN must be set to the ingest server\'s shared drone auth token');
  }

  const options: LoadTestOptions = {
    url: process.env.TARGET_URL ?? DEFAULT_TARGET_URL,
    path: process.env.LOADTEST_PATH ?? DEFAULT_PATH,
    token,
    drones: intFromEnv('LOADTEST_DRONES', DEFAULT_DRONES),
    rateHz: intFromEnv('LOADTEST_RATE_HZ', DEFAULT_RATE_HZ),
    durationMs: intFromEnv('LOADTEST_DURATION_MS', DEFAULT_DURATION_MS),
    drainMs: intFromEnv('LOADTEST_DRAIN_MS', DEFAULT_DRAIN_MS),
  };

  process.stderr.write(
    `Starting telemetry load test: ${options.drones} drones @ ${options.rateHz} Hz for ${options.durationMs} ms against ${options.url}${options.path}\n`,
  );

  const result = await runLoadTest(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  // A run that connected nothing is a failed benchmark, not a successful one.
  if (result.connectedDrones === 0) {
    process.stderr.write('No drone connections succeeded; is the ingest server running and the token correct?\n');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`load test failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
