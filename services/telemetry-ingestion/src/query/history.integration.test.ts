/**
 * Integration tests for the historical telemetry query endpoint
 * (`GET /telemetry/:droneId/history`) running against a *real* TimescaleDB
 * instance provisioned by Testcontainers (task 7.9, Requirements 10.1 & 10.4).
 *
 * Unlike `app.history.test.ts` — which swaps in a fake reader to exercise
 * routing — this suite wires the production datastore path end to end:
 *
 *   • the versioned node-pg-migrate migration (`dist/migrations`, the exact
 *     artifact `npm run migrate:up` applies) builds the `telemetry_sample`
 *     hypertable and the 1-minute / 1-hour downsampling continuous aggregates;
 *   • samples are seeded through the real {@link createPgTelemetryStore} insert
 *     path (batched multi-row INSERT … ON CONFLICT);
 *   • the HTTP server is wired with the real {@link createPgHistoryQuery} reader
 *     backed by a `pg.Pool` against the container.
 *
 * It then asserts the behaviour Requirement 10 promises over a live database:
 *   - time-range filtering — only samples with `from <= ts <= to` are returned
 *     and out-of-range samples are excluded (Req 10.1, and 10.2 / P21);
 *   - downsampling — at most the requested bucket count is returned, from both
 *     the raw hypertable and a refreshed continuous aggregate (Req 10.3 / P20);
 *   - `from > to` rejection — an inverted range yields an RFC 7807 400
 *     (Req 10.4).
 *
 * The suite is skipped cleanly when no Docker daemon is reachable (e.g. the
 * local sandbox without Docker) so the rest of the test run stays green; CI,
 * where Docker is available, runs it for real. Because it drives the compiled
 * migrations, the service must be built (`pnpm --filter @pawaac/telemetry-ingestion build`)
 * before the suite runs — CI builds before testing.
 */
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { TelemetrySample } from '@pawaac/shared-types';
import { createApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import { createPgTelemetryStore } from '../persist/store.js';
import { createPgHistoryQuery } from './pg.js';
import type { TelemetrySeries } from './history.js';

const { Pool, Client } = pg;

/**
 * Best-effort, synchronous detection of a Docker daemon reachable by the
 * Testcontainers Node client. That client talks to the daemon over a Unix
 * socket (or the host named by `DOCKER_HOST`) via dockerode — NOT via the
 * `docker` CLI — so we probe exactly those, mirroring how Testcontainers
 * resolves its runtime.
 */
function isDockerAvailable(): boolean {
  if (process.env['DOCKER_HOST'] || process.env['TESTCONTAINERS_HOST_OVERRIDE']) {
    return true;
  }
  const socketCandidates = [
    '/var/run/docker.sock',
    `${process.env['HOME'] ?? ''}/.docker/run/docker.sock`,
    `${process.env['HOME'] ?? ''}/.colima/default/docker.sock`,
  ];
  return socketCandidates.some((path) => path && existsSync(path));
}

const dockerAvailable = isDockerAvailable();
const describeIntegration = dockerAvailable ? describe : describe.skip;

if (!dockerAvailable) {
  console.warn(
    '[history.integration] Docker daemon not detected — skipping Testcontainers TimescaleDB integration suite.',
  );
}

/**
 * TimescaleDB image to run the suite against. Pinned for reproducibility but
 * overridable so CI can track a specific patch. The image preloads the
 * `timescaledb` library, so `create_hypertable` and continuous aggregates work.
 */
const TIMESCALEDB_IMAGE =
  process.env['TIMESCALEDB_IMAGE'] ?? 'timescale/timescaledb:2.17.2-pg16';

/** Compiled migrations directory — the same artifact `migrate:up` applies. */
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', '..', 'dist', 'migrations');

const config = loadConfig({ PORT: '0', TRACE_HEADER: 'X-Trace-Id' });

/** Two fixed drone ids so the raw and continuous-aggregate datasets stay disjoint. */
const DRONE_RAW = '33333333-3333-3333-3333-333333333333';
const DRONE_AGG = '44444444-4444-4444-4444-444444444444';

/** Epoch anchors for each dataset (UTC). */
const BASE_RAW = Date.UTC(2024, 0, 1, 0, 0, 0);
const BASE_AGG = Date.UTC(2024, 0, 2, 0, 0, 0);

/** Build a valid, in-bounds telemetry sample at the given instant. */
function makeSample(droneId: string, tsMs: number, i: number): TelemetrySample {
  return {
    droneId,
    ts: new Date(tsMs).toISOString(),
    lat: 37.4 + i * 1e-5,
    lon: -122.1 + i * 1e-5,
    altitude: 100 + (i % 50),
    velocity: { vx: 1, vy: 0.5, vz: -0.1 },
    attitude: { roll: 0, pitch: 0, yaw: 0 },
    battery: { voltage: 22.2, current: 10, remainingPct: Math.max(0, 100 - i * 0.1) },
    ekf2: { healthy: true, flags: 0 },
    rcSignalStrength: 90,
    flightMode: 'AUTO',
    armed: true,
  };
}

function baseUrl(app: App): string {
  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function isoAt(baseMs: number, offsetSeconds: number): string {
  return new Date(baseMs + offsetSeconds * 1000).toISOString();
}

describeIntegration('GET /telemetry/:droneId/history against TimescaleDB (Req 10.1, 10.4)', () => {
  /** Generous startup budget: pulling/booting the image + applying migrations. */
  const STARTUP_TIMEOUT_MS = 240_000;

  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let app: App;

  beforeAll(async () => {
    if (!existsSync(MIGRATIONS_DIR)) {
      throw new Error(
        `Compiled migrations not found at ${MIGRATIONS_DIR}. ` +
          'Build the service before running the integration suite: ' +
          'pnpm --filter @pawaac/telemetry-ingestion build',
      );
    }

    container = await new PostgreSqlContainer(TIMESCALEDB_IMAGE).start();
    const connectionString = container.getConnectionUri();

    // Apply the production migration via node-pg-migrate against the compiled
    // `dist/migrations` (mirroring `migrate:up`). `ignorePattern` keeps the
    // loader to the emitted `.js` files (skipping `.d.ts` / `.map` siblings).
    const migrationClient = new Client({ connectionString });
    await migrationClient.connect();
    try {
      await runner({
        dbClient: migrationClient,
        migrationsTable: 'pgmigrations',
        dir: MIGRATIONS_DIR,
        ignorePattern: '.*\\.(map|d\\.ts)',
        direction: 'up',
        log: () => {},
      });
    } finally {
      await migrationClient.end();
    }

    pool = new Pool({ connectionString });

    // Seed the raw dataset: 120 samples one second apart (production insert path).
    const store = createPgTelemetryStore(pool);
    const rawSamples: TelemetrySample[] = [];
    for (let i = 0; i < 120; i += 1) {
      rawSamples.push(makeSample(DRONE_RAW, BASE_RAW + i * 1000, i));
    }
    await store.insertBatch(rawSamples);

    // Seed the aggregate dataset: 90 samples one minute apart, then refresh the
    // 1-minute continuous aggregate so a coarse-bucket query reads from it.
    const aggSamples: TelemetrySample[] = [];
    for (let i = 0; i < 90; i += 1) {
      aggSamples.push(makeSample(DRONE_AGG, BASE_AGG + i * 60_000, i));
    }
    await store.insertBatch(aggSamples);
    await pool.query("CALL refresh_continuous_aggregate('telemetry_sample_1m', NULL, NULL)");

    app = createApp({ config, historyReader: createPgHistoryQuery(pool) });
    await app.listen();
  }, STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  it('returns only samples within the requested range and excludes the rest (Req 10.1, 10.2)', async () => {
    // Sub-range [20s, 40s] of the 120s raw dataset → 21 inclusive samples.
    const from = isoAt(BASE_RAW, 20);
    const to = isoAt(BASE_RAW, 40);

    const res = await fetch(
      `${baseUrl(app)}/telemetry/${DRONE_RAW}/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as TelemetrySeries;
    expect(body.droneId).toBe(DRONE_RAW);
    expect(body.source).toBe('raw');

    // Default sub-second bucketing yields one bucket per second in range.
    expect(body.points).toHaveLength(21);

    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    for (const point of body.points) {
      const ts = Date.parse(point.ts);
      expect(ts).toBeGreaterThanOrEqual(fromMs);
      expect(ts).toBeLessThanOrEqual(toMs);
    }

    // Every in-range sample is accounted for and none from outside leaks in.
    const totalSamples = body.points.reduce((sum, p) => sum + p.sampleCount, 0);
    expect(totalSamples).toBe(21);
  });

  it('returns at most the requested number of buckets from the raw hypertable (Req 10.3 / P20)', async () => {
    const from = isoAt(BASE_RAW, 0);
    const to = isoAt(BASE_RAW, 119);
    const requestedBuckets = 10;

    const res = await fetch(
      `${baseUrl(app)}/telemetry/${DRONE_RAW}/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&buckets=${requestedBuckets}`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as TelemetrySeries;
    expect(body.source).toBe('raw');
    expect(body.bucketCount).toBeLessThanOrEqual(requestedBuckets);
    expect(body.points.length).toBeLessThanOrEqual(requestedBuckets);

    // The whole dataset is still represented across the downsampled buckets.
    const totalSamples = body.points.reduce((sum, p) => sum + p.sampleCount, 0);
    expect(totalSamples).toBe(120);

    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    for (const point of body.points) {
      const ts = Date.parse(point.ts);
      expect(ts).toBeGreaterThanOrEqual(fromMs);
      expect(ts).toBeLessThanOrEqual(toMs);
    }
  });

  it('downsamples coarse ranges from a continuous aggregate within the bucket cap (Req 10.3 / P20)', async () => {
    // ~89.5-minute span with a small bucket cap forces a >= 60s bucket width, so
    // the planner reads from the refreshed 1-minute continuous aggregate. The
    // range ends just past the last sample (not on a bucket boundary) so all 90
    // samples fall within the requested cap rather than spilling a lone bucket
    // past the LIMIT.
    const from = isoAt(BASE_AGG, 0);
    const to = isoAt(BASE_AGG, 89 * 60 + 30);
    const requestedBuckets = 30;

    const res = await fetch(
      `${baseUrl(app)}/telemetry/${DRONE_AGG}/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&buckets=${requestedBuckets}`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as TelemetrySeries;
    expect(body.source).toBe('1m');
    expect(body.bucketSeconds).toBeGreaterThanOrEqual(60);
    expect(body.bucketCount).toBeLessThanOrEqual(requestedBuckets);

    // sum(sample_count) over the aggregate rows recovers all 90 raw samples.
    const totalSamples = body.points.reduce((sum, p) => sum + p.sampleCount, 0);
    expect(totalSamples).toBe(90);

    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    for (const point of body.points) {
      const ts = Date.parse(point.ts);
      expect(ts).toBeGreaterThanOrEqual(fromMs);
      expect(ts).toBeLessThanOrEqual(toMs);
    }
  });

  it('rejects an inverted range (from > to) with an RFC 7807 400 (Req 10.4)', async () => {
    const from = isoAt(BASE_RAW, 40);
    const to = isoAt(BASE_RAW, 20);

    const res = await fetch(
      `${baseUrl(app)}/telemetry/${DRONE_RAW}/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = (await res.json()) as { status: number; title: string };
    expect(body.status).toBe(400);
    expect(body.title).toBe('Bad Request');
  });
});
