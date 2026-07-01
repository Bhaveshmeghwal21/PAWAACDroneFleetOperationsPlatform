/**
 * Minimal HTTP-layer tests for the Telemetry Ingestion bootstrap (task 7.1):
 * liveness/readiness endpoints, RFC 7807 problem+json errors, and `X-Trace-Id`
 * propagation (Requirements 34.1, 34.2, 34.3).
 */
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config.js';
import { createApp, type App } from './app.js';
import type { ReadinessProbe } from './db/pool.js';

const config = loadConfig({ PORT: '0', TRACE_HEADER: 'X-Trace-Id' });

function baseUrl(app: App): string {
  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('Telemetry Ingestion HTTP bootstrap', () => {
  let app: App;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns 200 ok from GET /health (liveness, Req 34.1)', async () => {
    app = createApp({ config });
    await app.listen();

    const res = await fetch(`${baseUrl(app)}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });

  it('echoes back a provided X-Trace-Id (Req 34.3)', async () => {
    app = createApp({ config });
    await app.listen();

    const res = await fetch(`${baseUrl(app)}/health`, {
      headers: { 'X-Trace-Id': 'trace-abc-123' },
    });
    expect(res.headers.get('x-trace-id')).toBe('trace-abc-123');
  });

  it('generates an X-Trace-Id when none is provided (Req 34.3)', async () => {
    app = createApp({ config });
    await app.listen();

    const res = await fetch(`${baseUrl(app)}/health`);
    const traceId = res.headers.get('x-trace-id');
    expect(traceId).toBeTruthy();
    expect(traceId).toMatch(/[0-9a-f-]{36}/i);
  });

  it('reports ready when the datastore probe succeeds (Req 34.1)', async () => {
    const readiness: ReadinessProbe = { ping: () => Promise.resolve() };
    app = createApp({ config, readiness });
    await app.listen();

    const res = await fetch(`${baseUrl(app)}/ready`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ready',
      checks: { database: 'up' },
    });
  });

  it('returns 503 problem+json when the datastore probe fails (Req 34.1, 34.2)', async () => {
    const readiness: ReadinessProbe = {
      ping: () => Promise.reject(new Error('connection refused')),
    };
    app = createApp({ config, readiness });
    await app.listen();

    const res = await fetch(`${baseUrl(app)}/ready`);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.status).toBe(503);
    expect(body.title).toBe('Service Unavailable');
    expect(body.type).toBe('about:blank');
  });

  it('returns 404 problem+json for unknown routes (Req 34.2)', async () => {
    app = createApp({ config });
    await app.listen();

    const res = await fetch(`${baseUrl(app)}/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { status: number; instance: string };
    expect(body.status).toBe(404);
    expect(body.instance).toBe('/does-not-exist');
  });
});
