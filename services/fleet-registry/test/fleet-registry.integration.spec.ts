import { existsSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { EVENT_TRANSPORT, type EventTransport } from '../src/events/event-transport';

/**
 * End-to-end integration tests for the Fleet Registry REST surface running
 * against a *real* Postgres instance provisioned by Testcontainers. The
 * service's TypeORM migrations are executed against the throwaway database on
 * boot (migrationsRun: true), so this exercises the production persistence path
 * — entities, unique constraints, optimistic-lock version columns and all.
 *
 * Covers Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.9, 1.10 and 2.1, 2.3.
 *
 * The suite is skipped cleanly when no Docker daemon is reachable (e.g. a local
 * sandbox without Docker) so the rest of the test run stays green; CI, where
 * Docker is available, runs it for real.
 */

/**
 * Best-effort, synchronous detection of a Docker daemon reachable by the
 * Testcontainers Node client. That client talks to the daemon over a Unix
 * socket (or the host named by `DOCKER_HOST`) via dockerode — NOT via the
 * `docker` CLI — so we probe exactly those, mirroring how Testcontainers
 * resolves its runtime. A present `docker` CLI is deliberately not treated as
 * proof, because the CLI can reach a daemon (e.g. a remote context) that the
 * in-process client cannot.
 */
function isDockerAvailable(): boolean {
  // An explicitly configured remote/Testcontainers host is good enough.
  if (process.env['DOCKER_HOST'] || process.env['TESTCONTAINERS_HOST_OVERRIDE']) {
    return true;
  }
  // Common local daemon socket locations (Linux / Docker Desktop / Colima).
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
  // Surface the reason in the test output without failing the run.
  console.warn(
    '[fleet-registry.integration] Docker daemon not detected — skipping Testcontainers Postgres integration suite.',
  );
}

/** In-memory transport so the suite never depends on a live WebSocket server. */
class RecordingTransport implements EventTransport {
  public readonly events: Array<{ eventName: string; payload: unknown }> = [];

  async emit(eventName: string, payload: unknown): Promise<void> {
    this.events.push({ eventName, payload });
  }
}

describeIntegration('Fleet Registry REST API against real Postgres (integration)', () => {
  jest.setTimeout(180_000);

  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let transport: RecordingTransport;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // The service reads its connection config from these env vars at import
    // time (see src/data-source.ts), so they must be set BEFORE AppModule is
    // imported. Migrations run automatically on TypeORM init.
    process.env['DB_HOST'] = container.getHost();
    process.env['DB_PORT'] = String(container.getMappedPort(5432));
    process.env['DB_USER'] = container.getUsername();
    process.env['DB_PASSWORD'] = container.getPassword();
    process.env['DB_NAME'] = container.getDatabase();

    const { AppModule } = await import('../src/app.module');
    const { setupApp } = await import('../src/setup');

    transport = new RecordingTransport();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EVENT_TRANSPORT)
      .useValue(transport)
      .compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  const validDrone = () => ({
    serialNumber: `SN-${Math.random().toString(36).slice(2, 10)}`,
    model: 'PAWAAC-X1',
    firmwareVersion: '1.0.0',
    hardwareConfig: { camera: 'YOLOv11x' },
  });

  it('creates a drone and returns 201 with a persisted record (Req 1.1)', async () => {
    const body = validDrone();
    const res = await request(app.getHttpServer()).post('/drones').send(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      serialNumber: body.serialNumber,
      model: body.model,
      firmwareVersion: body.firmwareVersion,
      status: 'active',
      version: 1,
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.createdAt).toEqual(expect.any(String));
  });

  it('rejects an empty serial number with a 400 validation error (Req 1.2)', async () => {
    const res = await request(app.getHttpServer())
      .post('/drones')
      .send({ ...validDrone(), serialNumber: '' });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects a duplicate serial number with a 409 and creates no duplicate (Req 1.3 / P6)', async () => {
    const body = validDrone();
    const first = await request(app.getHttpServer()).post('/drones').send(body);
    expect(first.status).toBe(201);

    const dup = await request(app.getHttpServer()).post('/drones').send(body);
    expect(dup.status).toBe(409);

    const list = await request(app.getHttpServer())
      .get('/drones')
      .query({ model: body.model });
    const matches = (list.body as Array<{ serialNumber: string }>).filter(
      (d) => d.serialNumber === body.serialNumber,
    );
    expect(matches).toHaveLength(1);
  });

  it('fetches a drone by id (Req 1.4) and 404s on unknown ids', async () => {
    const created = await request(app.getHttpServer()).post('/drones').send(validDrone());
    const id = created.body.id as string;

    const got = await request(app.getHttpServer()).get(`/drones/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(id);

    const missing = await request(app.getHttpServer()).get(
      '/drones/00000000-0000-0000-0000-000000000000',
    );
    expect(missing.status).toBe(404);
  });

  it('lists drones filtered by status (Req 1.5)', async () => {
    const created = await request(app.getHttpServer())
      .post('/drones')
      .send({ ...validDrone(), status: 'maintenance' });
    const id = created.body.id as string;

    const res = await request(app.getHttpServer()).get('/drones').query({ status: 'maintenance' });
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string; status: string }>).map((d) => d.id);
    expect(ids).toContain(id);
    expect((res.body as Array<{ status: string }>).every((d) => d.status === 'maintenance')).toBe(
      true,
    );
  });

  it('updates a drone, bumps the version, and emits a status-change event (Req 1.6, 1.7, 1.8 / P1, P2, P5)', async () => {
    const created = await request(app.getHttpServer()).post('/drones').send(validDrone());
    const id = created.body.id as string;
    expect(created.body.version).toBe(1);

    const before = transport.events.length;
    const updated = await request(app.getHttpServer())
      .patch(`/drones/${id}`)
      .send({ status: 'maintenance', firmwareVersion: '1.1.0' });

    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe('maintenance');
    expect(updated.body.firmwareVersion).toBe('1.1.0');
    expect(updated.body.version).toBeGreaterThan(created.body.version);
    expect(transport.events.length).toBe(before + 1);
    expect(transport.events.at(-1)).toMatchObject({ eventName: 'drone.status-changed' });
  });

  it('rejects a stale optimistic-lock version with 409 (Req 1.9)', async () => {
    const created = await request(app.getHttpServer()).post('/drones').send(validDrone());
    const id = created.body.id as string;

    // Move the version forward once.
    const firstUpdate = await request(app.getHttpServer())
      .patch(`/drones/${id}`)
      .send({ model: 'PAWAAC-X2' });
    expect(firstUpdate.status).toBe(200);

    // Re-submit with the now-stale original version.
    const stale = await request(app.getHttpServer())
      .patch(`/drones/${id}`)
      .send({ model: 'PAWAAC-X3', version: created.body.version });
    expect(stale.status).toBe(409);
  });

  it('decommissions a drone (Req 1.10)', async () => {
    const created = await request(app.getHttpServer()).post('/drones').send(validDrone());
    const id = created.body.id as string;

    const res = await request(app.getHttpServer()).post(`/drones/${id}/decommission`);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('decommissioned');

    const got = await request(app.getHttpServer()).get(`/drones/${id}`);
    expect(got.body.status).toBe('decommissioned');
  });

  it('records component usage and persists lifecycle counters (Req 2.1)', async () => {
    const created = await request(app.getHttpServer()).post('/drones').send(validDrone());
    const id = created.body.id as string;

    const res = await request(app.getHttpServer())
      .post(`/drones/${id}/component-usage`)
      .send({ batteryCyclesDelta: 120, motorHoursDelta: 45.5, propellerReplacementsDelta: 2 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      droneId: id,
      batteryCycles: 120,
      motorHours: 45.5,
      propellerReplacements: 2,
    });
  });

  it('evaluates maintenance and returns alerts when a counter reaches its threshold (Req 2.3 / P4)', async () => {
    const created = await request(app.getHttpServer()).post('/drones').send(validDrone());
    const id = created.body.id as string;

    // Default battery threshold is 500 cycles; push beyond it.
    await request(app.getHttpServer())
      .post(`/drones/${id}/component-usage`)
      .send({ batteryCyclesDelta: 600 });

    const res = await request(app.getHttpServer()).get(`/drones/${id}/maintenance`);
    expect(res.status).toBe(200);
    const components = (res.body as Array<{ component: string; status: string }>).map(
      (a) => a.component,
    );
    expect(components).toContain('battery');
    const battery = (res.body as Array<{ component: string; status: string }>).find(
      (a) => a.component === 'battery',
    );
    expect(battery?.status).toBe('overdue');
  });

  it('returns an empty maintenance list for a drone with no usage recorded (Req 2.3 / P4)', async () => {
    const created = await request(app.getHttpServer()).post('/drones').send(validDrone());
    const id = created.body.id as string;

    const res = await request(app.getHttpServer()).get(`/drones/${id}/maintenance`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
