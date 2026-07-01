import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthModule } from '../src/health/health.module';
import { setupApp } from '../src/setup';

describe('Health & operational endpoints (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 with status ok (34.1)', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('propagates a supplied X-Trace-Id header (34.3)', async () => {
    const traceId = 'trace-abc-123';
    const res = await request(app.getHttpServer()).get('/health').set('X-Trace-Id', traceId);
    expect(res.headers['x-trace-id']).toBe(traceId);
  });

  it('mints an X-Trace-Id when none is supplied (34.3)', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    const traceId = res.headers['x-trace-id'];
    expect(traceId).toBeDefined();
    expect(String(traceId).length).toBeGreaterThan(0);
  });

  it('GET /ready returns an RFC 7807 problem+json 503 when the database is unavailable (34.1, 34.2)', async () => {
    const res = await request(app.getHttpServer()).get('/ready');
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 503, title: expect.any(String) });
    expect(res.body.traceId).toBeDefined();
  });

  it('renders RFC 7807 problem+json for unknown routes (34.2)', async () => {
    const res = await request(app.getHttpServer()).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, instance: '/does-not-exist' });
  });
});
