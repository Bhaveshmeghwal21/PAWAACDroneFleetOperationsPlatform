import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { DroneStatus } from '@pawaac/shared-types';
import {
  type DroneStatusChangedEvent,
  STATUS_CHANGED_EVENT,
} from '../src/events/event-transport';

/**
 * True end-to-end test for the Fleet Registry real-time status-change channel
 * (Requirement 3.2). Unlike the unit/property suites — which substitute an
 * in-memory {@link EventTransport} — this test exercises the *entire* production
 * path with nothing stubbed:
 *
 *   HTTP PATCH /drones/:id  ->  FleetRegistryService  ->  ResilientEventPublisher
 *                           ->  FleetGateway (real Socket.IO server)
 *                           ->  network  ->  real socket.io-client subscriber
 *
 * The NestJS app boots with its WebSocket gateway attached to a live HTTP
 * server bound to an ephemeral port, persistence runs against a *real* Postgres
 * provisioned by Testcontainers (migrations applied on boot), and a genuine
 * Socket.IO client connects over the wire to receive the broadcast.
 *
 * The suite skips cleanly when no Docker daemon is reachable (e.g. a local
 * sandbox without Docker) so the rest of the run stays green; CI, where Docker
 * is available, runs it for real.
 */

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
const describeE2E = dockerAvailable ? describe : describe.skip;

if (!dockerAvailable) {
  console.warn(
    '[fleet-registry.status-events.e2e] Docker daemon not detected — skipping live WebSocket E2E suite.',
  );
}

/** Resolves with the first matching status-change event, or rejects on timeout. */
function waitForStatusEvent(
  socket: Socket,
  predicate: (event: DroneStatusChangedEvent) => boolean,
  timeoutMs = 10_000,
): Promise<DroneStatusChangedEvent> {
  return new Promise<DroneStatusChangedEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(STATUS_CHANGED_EVENT, handler);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${STATUS_CHANGED_EVENT}`));
    }, timeoutMs);

    function handler(event: DroneStatusChangedEvent): void {
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timer);
      socket.off(STATUS_CHANGED_EVENT, handler);
      resolve(event);
    }

    socket.on(STATUS_CHANGED_EVENT, handler);
  });
}

/** Resolves once the socket reports a successful connection. */
function waitForConnect(socket: Socket, timeoutMs = 10_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for socket connect`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describeE2E('Fleet Registry status-change WebSocket event (E2E)', () => {
  jest.setTimeout(180_000);

  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let baseUrl: string;
  let client: Socket;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // src/data-source.ts reads connection config from these env vars at import
    // time, so they MUST be set before AppModule is imported. Migrations run
    // automatically on TypeORM init (migrationsRun: true).
    process.env['DB_HOST'] = container.getHost();
    process.env['DB_PORT'] = String(container.getMappedPort(5432));
    process.env['DB_USER'] = container.getUsername();
    process.env['DB_PASSWORD'] = container.getPassword();
    process.env['DB_NAME'] = container.getDatabase();

    const { AppModule } = await import('../src/app.module');
    const { setupApp } = await import('../src/setup');

    // NOTE: the real FleetGateway (Socket.IO) transport is used here — nothing
    // is overridden, so this is a genuine end-to-end exercise of the WS path.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    // Bind the HTTP + Socket.IO server to an ephemeral port.
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    client?.disconnect();
    await app?.close();
    await container?.stop();
  });

  it('delivers a status-change event to a connected client end-to-end when a drone status changes (Req 3.2)', async () => {
    // Arrange: persist a drone in the "active" state via the real REST API.
    const serialNumber = `SN-E2E-${Math.random().toString(36).slice(2, 10)}`;
    const created = await request(app.getHttpServer())
      .post('/drones')
      .send({ serialNumber, model: 'PAWAAC-X1', firmwareVersion: '1.0.0', status: 'active' });
    expect(created.status).toBe(201);
    const droneId = created.body.id as string;
    expect(created.body.status).toBe('active');

    // Connect a genuine Socket.IO client over the wire and wait for the handshake.
    client = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    await waitForConnect(client);

    // Start listening BEFORE we trigger the change to avoid a delivery race.
    const targetStatus: DroneStatus = 'maintenance';
    const received = waitForStatusEvent(
      client,
      (event) => event.droneId === droneId && event.status === targetStatus,
    );

    // Act: drive a real status change through the HTTP API.
    const updated = await request(app.getHttpServer())
      .patch(`/drones/${droneId}`)
      .send({ status: targetStatus });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe(targetStatus);

    // Assert: the broadcast arrives end-to-end with a faithful payload.
    const event = await received;
    expect(event.droneId).toBe(droneId);
    expect(event.previousStatus).toBe('active');
    expect(event.status).toBe(targetStatus);
    expect(event.version).toBe(updated.body.version);
    expect(typeof event.ts).toBe('string');
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
  });

  it('does NOT emit a status-change event when an update leaves the status unchanged (Req 3.2)', async () => {
    // A non-status edit must produce no status-change broadcast.
    const serialNumber = `SN-E2E-${Math.random().toString(36).slice(2, 10)}`;
    const created = await request(app.getHttpServer())
      .post('/drones')
      .send({ serialNumber, model: 'PAWAAC-X1', firmwareVersion: '1.0.0', status: 'active' });
    expect(created.status).toBe(201);
    const droneId = created.body.id as string;

    // Reuse the already-connected client from the prior test if present; else connect.
    if (!client || !client.connected) {
      client = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
      await waitForConnect(client);
    }

    let sawEvent = false;
    const handler = (event: DroneStatusChangedEvent): void => {
      if (event.droneId === droneId) {
        sawEvent = true;
      }
    };
    client.on(STATUS_CHANGED_EVENT, handler);

    // A metadata-only update (no status field) must not flip the status.
    const updated = await request(app.getHttpServer())
      .patch(`/drones/${droneId}`)
      .send({ firmwareVersion: '1.1.0' });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe('active');

    // Give any (erroneous) broadcast a generous window to arrive.
    await new Promise((resolve) => setTimeout(resolve, 750));
    client.off(STATUS_CHANGED_EVENT, handler);
    expect(sawEvent).toBe(false);
  });
});
