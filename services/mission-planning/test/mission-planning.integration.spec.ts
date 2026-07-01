import { existsSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

/**
 * End-to-end integration tests for the Mission Planning REST surface running
 * against a *real* PostGIS-enabled Postgres provisioned by Testcontainers. The
 * service's TypeORM migrations run against the throwaway database on boot
 * (migrationsRun: true) — including `CREATE EXTENSION postgis` and the
 * `geometry(Polygon, 4326)` column with its GiST index — so this exercises the
 * production persistence and spatial-query paths end to end:
 *
 * - all mission CRUD endpoints (create / version-on-edit / get-latest /
 *   get-specific-version) — Requirements 4.1, 4.8;
 * - geofence persistence and validation — Requirements 5.1, 5.2;
 * - PostGIS-backed `ST_Intersects` conflict detection — Requirements 5.1, 5.2
 *   (and the conflict contract of 5.3/5.4 over the real spatial path);
 * - MAVLink export, including the validated-only precondition (Requirement 7.2)
 *   and the 409-on-conflict block (Requirement 7.7).
 *
 * Covers Requirements 4.1, 4.8, 5.1, 5.2, 7.2, 7.7.
 *
 * The suite is skipped cleanly when no Docker daemon is reachable (e.g. a local
 * sandbox without Docker) so the rest of the test run stays green; CI, where
 * Docker is available, runs it for real against `postgis/postgis:16-3.4` (the
 * same image docker-compose uses for `postgres-mission`).
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
    '[mission-planning.integration] Docker daemon not detected — skipping Testcontainers PostGIS integration suite.',
  );
}

/** The PostGIS image must match the one Mission Planning targets in production. */
const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';

/** A single valid waypoint with overridable fields, for terse fixtures. */
interface WaypointFixture {
  seq: number;
  lat: number;
  lon: number;
  altitude: number;
  speed: number;
  gimbalAngle: number;
  loiterTime: number;
}

function waypoint(overrides: Partial<WaypointFixture> = {}): WaypointFixture {
  return {
    seq: 0,
    lat: 12.34,
    lon: 56.78,
    altitude: 100,
    speed: 5,
    gimbalAngle: -30,
    loiterTime: 0,
    ...overrides,
  };
}

describeIntegration('Mission Planning REST API against real PostGIS (integration)', () => {
  jest.setTimeout(240_000);

  let container: StartedPostgreSqlContainer;
  let app: INestApplication;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();

    // The service reads its connection config from these env vars at import
    // time (see src/data-source.ts), so they MUST be set before AppModule is
    // imported. Migrations (incl. CREATE EXTENSION postgis) run on TypeORM init.
    process.env['DB_HOST'] = container.getHost();
    process.env['DB_PORT'] = String(container.getMappedPort(5432));
    process.env['DB_USER'] = container.getUsername();
    process.env['DB_PASSWORD'] = container.getPassword();
    process.env['DB_NAME'] = container.getDatabase();

    const { AppModule } = await import('../src/app.module');
    const { setupApp } = await import('../src/setup');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  // --- Mission CRUD (Requirements 4.1, 4.8) ---------------------------------

  it('creates a mission and returns 201 with a persisted version-1 record (Req 4.1)', async () => {
    const res = await request(app.getHttpServer())
      .post('/missions')
      .send({ name: 'Survey Alpha', waypoints: [waypoint({ seq: 0 }), waypoint({ seq: 1, lat: 13 })] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Survey Alpha',
      status: 'draft',
      version: 1,
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.createdAt).toEqual(expect.any(String));
    expect(res.body.waypoints).toHaveLength(2);

    // The persisted record is retrievable as the latest version.
    const latest = await request(app.getHttpServer()).get(`/missions/${res.body.id}`);
    expect(latest.status).toBe(200);
    expect(latest.body.version).toBe(1);
  });

  it('rejects a create with an out-of-range waypoint as a 400 problem+json (Req 4.1)', async () => {
    const res = await request(app.getHttpServer())
      .post('/missions')
      .send({ name: 'Bad', waypoints: [waypoint({ lat: 999 })] });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('versions a mission on edit and retrieves each specific version (Req 4.8)', async () => {
    const created = await request(app.getHttpServer())
      .post('/missions')
      .send({ name: 'Iterate', waypoints: [waypoint({ seq: 0, altitude: 100 })] });
    const id = created.body.id as string;
    expect(created.body.version).toBe(1);

    const updated = await request(app.getHttpServer())
      .put(`/missions/${id}`)
      .send({ waypoints: [waypoint({ seq: 0, altitude: 250 })] });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);

    // Version 1 is byte-identical to its original content (Req 4.7 surfaced via 4.8).
    const v1 = await request(app.getHttpServer()).get(`/missions/${id}/versions/1`);
    expect(v1.status).toBe(200);
    expect(v1.body.version).toBe(1);
    expect(v1.body.waypoints[0].altitude).toBe(100);

    const v2 = await request(app.getHttpServer()).get(`/missions/${id}/versions/2`);
    expect(v2.status).toBe(200);
    expect(v2.body.waypoints[0].altitude).toBe(250);
  });

  it('404s on an unknown mission id and an unknown version (Req 4.8)', async () => {
    const unknown = '00000000-0000-0000-0000-000000000000';
    const missing = await request(app.getHttpServer()).get(`/missions/${unknown}`);
    expect(missing.status).toBe(404);

    const created = await request(app.getHttpServer())
      .post('/missions')
      .send({ name: 'OneVersion', waypoints: [waypoint()] });
    const noSuchVersion = await request(app.getHttpServer()).get(
      `/missions/${created.body.id}/versions/99`,
    );
    expect(noSuchVersion.status).toBe(404);
  });

  // --- Geofence persistence & validation (Requirements 5.1, 5.2) ------------

  it('persists a closed geofence polygon and reads it back (Req 5.1)', async () => {
    const ring = [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
      [10, 10],
    ];
    const defined = await request(app.getHttpServer())
      .post('/geofences')
      .send({ name: 'No-Fly Central', polygon: ring });

    expect(defined.status).toBe(201);
    expect(defined.body.id).toEqual(expect.any(String));
    expect(defined.body.kind).toBe('no_fly');

    // PostGIS round-trips the geometry back to the closed [lon, lat] ring.
    const fetched = await request(app.getHttpServer()).get(`/geofences/${defined.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.polygon).toHaveLength(ring.length);
    expect(fetched.body.polygon[0]).toEqual(ring[0]);
    expect(fetched.body.polygon.at(-1)).toEqual(ring.at(-1));

    const listed = await request(app.getHttpServer()).get('/geofences');
    expect(listed.status).toBe(200);
    expect((listed.body as Array<{ id: string }>).map((g) => g.id)).toContain(defined.body.id);
  });

  it('rejects a non-closed polygon with a 400 validation error (Req 5.2)', async () => {
    const open = [
      [30, 30],
      [40, 30],
      [40, 40],
    ];
    const res = await request(app.getHttpServer())
      .post('/geofences')
      .send({ name: 'Broken', polygon: open });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  // --- PostGIS-backed conflict detection (Requirements 5.1, 5.2 / 5.3, 5.4) -

  it('detects a conflict for a route crossing a persisted no-fly zone via ST_Intersects', async () => {
    const ring = [
      [100, 10],
      [110, 10],
      [110, 20],
      [100, 20],
      [100, 10],
    ];
    const zone = await request(app.getHttpServer())
      .post('/geofences')
      .send({ name: 'Conflict Zone', polygon: ring });
    expect(zone.status).toBe(201);

    // A segment from (lon 95, lat 15) to (lon 115, lat 15) passes through the box.
    const crossing = await request(app.getHttpServer())
      .post('/geofences/detect-conflicts')
      .send({
        waypoints: [
          waypoint({ seq: 0, lat: 15, lon: 95 }),
          waypoint({ seq: 1, lat: 15, lon: 115 }),
        ],
      });
    expect(crossing.status).toBe(200);
    const zoneIds = (crossing.body as Array<{ segmentIndex: number; zoneId: string }>).map(
      (c) => c.zoneId,
    );
    expect(zoneIds).toContain(zone.body.id);
    expect(
      (crossing.body as Array<{ segmentIndex: number }>).every((c) => c.segmentIndex === 0),
    ).toBe(true);

    // A route far from every persisted zone yields no conflicts.
    const clear = await request(app.getHttpServer())
      .post('/geofences/detect-conflicts')
      .send({
        waypoints: [
          waypoint({ seq: 0, lat: -80, lon: -170 }),
          waypoint({ seq: 1, lat: -79, lon: -169 }),
        ],
      });
    expect(clear.status).toBe(200);
    expect(clear.body).toEqual([]);
  });

  // --- MAVLink export (Requirements 7.2, 7.7) -------------------------------

  it('exports a validated, conflict-free mission as JSON and binary (Req 7.2 happy path)', async () => {
    // Coordinates far from every persisted geofence so detection stays empty.
    const created = await request(app.getHttpServer())
      .post('/missions')
      .send({
        name: 'Exportable',
        status: 'validated',
        waypoints: [
          waypoint({ seq: 0, lat: 80, lon: 160 }),
          waypoint({ seq: 1, lat: 81, lon: 161 }),
        ],
      });
    const id = created.body.id as string;

    const json = await request(app.getHttpServer()).get(`/missions/${id}/export`);
    expect(json.status).toBe(200);
    expect(json.body.format).toBe('json');
    // home/takeoff item + one item per waypoint.
    expect(json.body.items).toHaveLength(3);

    const binary = await request(app.getHttpServer())
      .get(`/missions/${id}/export`)
      .query({ format: 'binary' })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(binary.status).toBe(200);
    expect(binary.headers['content-type']).toContain('application/octet-stream');
    expect((binary.body as Buffer).length).toBeGreaterThan(0);
  });

  it('rejects export of a non-validated mission with a 422 (Req 7.2)', async () => {
    const created = await request(app.getHttpServer())
      .post('/missions')
      .send({
        name: 'Draft Only',
        status: 'draft',
        waypoints: [waypoint({ seq: 0, lat: 70, lon: 150 })],
      });

    const res = await request(app.getHttpServer()).get(`/missions/${created.body.id}/export`);
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('blocks export with a 409 when the route conflicts with a geofence (Req 7.7)', async () => {
    // A no-fly zone the mission route will pass through.
    const ring = [
      [40, 40],
      [50, 40],
      [50, 50],
      [40, 50],
      [40, 40],
    ];
    const zone = await request(app.getHttpServer())
      .post('/geofences')
      .send({ name: 'Export Blocker', polygon: ring });
    expect(zone.status).toBe(201);

    const mission = await request(app.getHttpServer())
      .post('/missions')
      .send({
        name: 'Conflicting',
        status: 'validated',
        waypoints: [
          waypoint({ seq: 0, lat: 45, lon: 35 }),
          waypoint({ seq: 1, lat: 45, lon: 55 }),
        ],
      });
    expect(mission.status).toBe(201);

    const res = await request(app.getHttpServer()).get(`/missions/${mission.body.id}/export`);
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});
