/**
 * Unit tests for anomaly fan-out (task 7.5, Requirement 9.7).
 *
 * The Alert HTTP call and dashboard transport sit behind injectable
 * interfaces, so these tests use in-memory fakes — no real network/sockets.
 */
import type { Anomaly } from '@pawaac/shared-types';
import {
  AlertServiceClient,
  DashboardSink,
  createAnomalyEmitter,
  toAnomalyEvent,
  type AnomalySink,
  type DashboardPublisher,
  type HttpPost,
} from './emitter.js';

const DRONE_A = 'aaaaaaaa-0000-0000-0000-000000000001';

function anomalyFixture(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    kind: 'ALTITUDE_DROP',
    droneId: DRONE_A,
    ts: '2024-01-01T00:00:01.000Z',
    detail: 'descent rate 20 m/s exceeds 10 m/s',
    ...overrides,
  };
}

describe('toAnomalyEvent', () => {
  it('wraps an anomaly in an anomaly domain-event envelope', () => {
    const anomaly = anomalyFixture();
    expect(toAnomalyEvent(anomaly)).toEqual({
      kind: 'anomaly',
      ts: anomaly.ts,
      droneId: anomaly.droneId,
      payload: anomaly,
    });
  });
});

describe('AlertServiceClient', () => {
  it('POSTs the anomaly event to the configured URL as JSON', async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const post: HttpPost = (url, body, headers) => {
      calls.push({ url, body, headers });
      return Promise.resolve();
    };
    const client = new AlertServiceClient({ url: 'http://alert.local/events', post });

    const anomaly = anomalyFixture();
    client.emit(anomaly);
    // Allow the detached promise to settle.
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://alert.local/events');
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(toAnomalyEvent(anomaly));
  });

  it('routes delivery failures to onError without throwing on the hot path', async () => {
    const errors: unknown[] = [];
    const post: HttpPost = () => Promise.reject(new Error('alert service down'));
    const client = new AlertServiceClient({
      url: 'http://alert.local/events',
      post,
      onError: (err) => errors.push(err),
    });

    expect(() => client.emit(anomalyFixture())).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('alert service down');
  });

  it('merges custom headers with the default content type', async () => {
    const calls: Record<string, string>[] = [];
    const post: HttpPost = (_url, _body, headers) => {
      calls.push(headers);
      return Promise.resolve();
    };
    const client = new AlertServiceClient({
      url: 'http://alert.local/events',
      post,
      headers: { 'X-Trace-Id': 'trace-123' },
    });
    client.emit(anomalyFixture());
    await Promise.resolve();
    expect(calls[0]).toMatchObject({ 'Content-Type': 'application/json', 'X-Trace-Id': 'trace-123' });
  });
});

describe('DashboardSink', () => {
  it('publishes the anomaly to the dashboard publisher', () => {
    const published: Anomaly[] = [];
    const publisher: DashboardPublisher = { publish: (a) => published.push(a) };
    const sink = new DashboardSink(publisher);

    const anomaly = anomalyFixture({ kind: 'GPS_ACCURACY_LOSS' });
    sink.emit(anomaly);

    expect(published).toEqual([anomaly]);
  });

  it('isolates publisher errors via onError', () => {
    const errors: unknown[] = [];
    const publisher: DashboardPublisher = {
      publish: () => {
        throw new Error('socket closed');
      },
    };
    const sink = new DashboardSink(publisher, (err) => errors.push(err));

    expect(() => sink.emit(anomalyFixture())).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});

describe('createAnomalyEmitter', () => {
  it('fans one anomaly out to every sink', () => {
    const a: Anomaly[] = [];
    const b: Anomaly[] = [];
    const sinkA: AnomalySink = { emit: (x) => a.push(x) };
    const sinkB: AnomalySink = { emit: (x) => b.push(x) };
    const emitter = createAnomalyEmitter([sinkA, sinkB]);

    const anomaly = anomalyFixture();
    emitter.emit(anomaly);

    expect(a).toEqual([anomaly]);
    expect(b).toEqual([anomaly]);
  });

  it('keeps fanning out even when one sink throws', () => {
    const delivered: Anomaly[] = [];
    const throwing: AnomalySink = {
      emit: () => {
        throw new Error('boom');
      },
    };
    const healthy: AnomalySink = { emit: (x) => delivered.push(x) };
    const emitter = createAnomalyEmitter([throwing, healthy]);

    expect(() => emitter.emit(anomalyFixture())).not.toThrow();
    expect(delivered).toHaveLength(1);
  });

  it('is a no-op with no sinks configured', () => {
    const emitter = createAnomalyEmitter([]);
    expect(() => emitter.emit(anomalyFixture())).not.toThrow();
  });
});
