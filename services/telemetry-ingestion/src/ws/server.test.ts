/**
 * Unit tests for the WebSocket ingest wiring (task 7.3):
 * connection authentication + subscription ack (Req 8.1), and per-frame
 * decode/persist with malformed-frame dropping + parse-error metric (Req 8.6).
 *
 * Uses a fake socket and an in-memory store so the handler logic is tested
 * without a live network or database.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { TelemetrySample } from '@pawaac/shared-types';
import { encode } from '../mavlink/codec.js';
import { createMetrics } from '../metrics.js';
import { BatchingPersister } from '../persist/persister.js';
import type { TelemetryStore } from '../persist/store.js';
import {
  authorizeRequest,
  handleConnection,
  toUint8Array,
  type ConnectionHandlerDeps,
  type DroneSocket,
} from './server.js';

const TOKEN = 'secret-drone-token';
const DRONE_ID = '11111111-2222-3333-4444-555555555555';

class FakeStore implements TelemetryStore {
  readonly rows: TelemetrySample[] = [];
  insertBatch(samples: readonly TelemetrySample[]): Promise<void> {
    this.rows.push(...samples);
    return Promise.resolve();
  }
}

type MessageListener = (data: Buffer) => void;

class FakeSocket implements DroneSocket {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private messageListener: MessageListener | undefined;

  on(event: 'message' | 'error' | 'close', listener: (arg: never) => void): this {
    if (event === 'message') {
      this.messageListener = listener as unknown as MessageListener;
    }
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  /** Test helper: deliver a frame as if received over the wire. */
  emit(frame: Uint8Array): void {
    this.messageListener?.(Buffer.from(frame));
  }
}

function sampleFixture(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    droneId: DRONE_ID,
    ts: '2024-01-01T00:00:00.000Z',
    lat: 1,
    lon: 2,
    altitude: 3,
    velocity: { vx: 0, vy: 0, vz: 0 },
    attitude: { roll: 0, pitch: 0, yaw: 0 },
    battery: { voltage: 12, current: 1, remainingPct: 80 },
    ekf2: { healthy: true, flags: 0 },
    rcSignalStrength: 70,
    flightMode: 'AUTO',
    armed: true,
    ...overrides,
  };
}

function makeDeps(): { deps: ConnectionHandlerDeps; store: FakeStore; persister: BatchingPersister } {
  const store = new FakeStore();
  const metrics = createMetrics();
  const persister = new BatchingPersister({ store, metrics, batchSize: 100 });
  return { deps: { expectedToken: TOKEN, persister, metrics }, store, persister };
}

describe('authorizeRequest (Req 8.1)', () => {
  const headers: IncomingHttpHeaders = {};

  it('accepts a valid token + droneId via query string', () => {
    const result = authorizeRequest({
      url: `/ingest?token=${TOKEN}&droneId=${DRONE_ID}`,
      headers,
      expectedToken: TOKEN,
    });
    expect(result).toEqual({ ok: true, droneId: DRONE_ID });
  });

  it('accepts a bearer token header with x-drone-id header', () => {
    const result = authorizeRequest({
      url: '/ingest',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-drone-id': DRONE_ID },
      expectedToken: TOKEN,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a missing token', () => {
    const result = authorizeRequest({ url: `/ingest?droneId=${DRONE_ID}`, headers, expectedToken: TOKEN });
    expect(result.ok).toBe(false);
  });

  it('rejects an incorrect token', () => {
    const result = authorizeRequest({
      url: `/ingest?token=wrong&droneId=${DRONE_ID}`,
      headers,
      expectedToken: TOKEN,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing/invalid droneId', () => {
    expect(authorizeRequest({ url: `/ingest?token=${TOKEN}`, headers, expectedToken: TOKEN }).ok).toBe(
      false,
    );
    expect(
      authorizeRequest({ url: `/ingest?token=${TOKEN}&droneId=nope`, headers, expectedToken: TOKEN }).ok,
    ).toBe(false);
  });

  it('rejects when no token is configured', () => {
    const result = authorizeRequest({
      url: `/ingest?token=${TOKEN}&droneId=${DRONE_ID}`,
      headers,
      expectedToken: undefined,
    });
    expect(result.ok).toBe(false);
  });
});

describe('handleConnection authentication (Req 8.1)', () => {
  it('acknowledges the subscription for a valid connection', () => {
    const { deps } = makeDeps();
    const socket = new FakeSocket();
    handleConnection(socket, {}, `/ingest?token=${TOKEN}&droneId=${DRONE_ID}`, deps);

    expect(socket.closed).toBeUndefined();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'subscription_ack', droneId: DRONE_ID });
    expect(deps.metrics.snapshot().connectionsAccepted).toBe(1);
  });

  it('rejects and clean-closes a connection with an invalid token', () => {
    const { deps } = makeDeps();
    const socket = new FakeSocket();
    handleConnection(socket, {}, `/ingest?token=bad&droneId=${DRONE_ID}`, deps);

    expect(socket.sent).toHaveLength(0);
    expect(socket.closed).toBeDefined();
    expect(socket.closed?.code).toBe(1008);
    expect(deps.metrics.snapshot().connectionsRejected).toBe(1);
  });
});

describe('handleConnection frame ingest (Req 8.2, 8.6)', () => {
  it('parses a valid frame and forwards it to the persister', async () => {
    const { deps, store } = makeDeps();
    const socket = new FakeSocket();
    handleConnection(socket, {}, `/ingest?token=${TOKEN}&droneId=${DRONE_ID}`, deps);

    socket.emit(encode(sampleFixture({ ts: '2024-01-01T00:00:01.000Z' })));
    await deps.persister.flush();

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.droneId).toBe(DRONE_ID);
    expect(deps.metrics.snapshot().framesParsed).toBe(1);
    expect(deps.metrics.snapshot().parseErrors).toBe(0);
  });

  it('drops a malformed frame, increments parse-errors, and keeps the socket open', async () => {
    const { deps, store } = makeDeps();
    const socket = new FakeSocket();
    handleConnection(socket, {}, `/ingest?token=${TOKEN}&droneId=${DRONE_ID}`, deps);

    socket.emit(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    await deps.persister.flush();

    expect(store.rows).toHaveLength(0);
    expect(deps.metrics.snapshot().parseErrors).toBe(1);
    // Socket remains open (never closed) after a bad frame.
    expect(socket.closed).toBeUndefined();
  });

  it('keeps processing good frames after a malformed one', async () => {
    const { deps, store } = makeDeps();
    const socket = new FakeSocket();
    handleConnection(socket, {}, `/ingest?token=${TOKEN}&droneId=${DRONE_ID}`, deps);

    socket.emit(new Uint8Array([0xfd, 0x00])); // truncated/garbage
    socket.emit(encode(sampleFixture({ ts: '2024-01-01T00:00:02.000Z' })));
    await deps.persister.flush();

    expect(store.rows).toHaveLength(1);
    expect(deps.metrics.snapshot().parseErrors).toBe(1);
    expect(deps.metrics.snapshot().framesParsed).toBe(1);
  });
});

describe('toUint8Array', () => {
  it('normalizes a Buffer', () => {
    const buf = Buffer.from([1, 2, 3]);
    expect(Array.from(toUint8Array(buf))).toEqual([1, 2, 3]);
  });

  it('normalizes an array of Buffers', () => {
    const arr = [Buffer.from([1]), Buffer.from([2, 3])];
    expect(Array.from(toUint8Array(arr))).toEqual([1, 2, 3]);
  });

  it('normalizes an ArrayBuffer', () => {
    const ab = new Uint8Array([4, 5, 6]).buffer;
    expect(Array.from(toUint8Array(ab))).toEqual([4, 5, 6]);
  });
});
