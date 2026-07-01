/**
 * Minimal end-to-end test for the liveness endpoint and trace-id propagation.
 *
 * The liveness probe (`/health`) deliberately has no datastore dependencies, so
 * this test exercises the real HTTP stack (controller + trace middleware) with a
 * lightweight stub for the readiness indicators — no Redis required. Datastore-
 * backed readiness is covered separately by integration specs in later tasks.
 */
import { HealthCheckService } from '@nestjs/terminus';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { HealthController } from '../src/health/health.controller';
import { RedisHealthIndicator } from '../src/health/redis.health';
import { TRACE_HEADER, traceIdHandler } from '../src/common/trace';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: {
            check: jest
              .fn()
              .mockResolvedValue({ status: 'ok', info: {}, error: {}, details: {} }),
          },
        },
        { provide: RedisHealthIndicator, useValue: { isHealthy: jest.fn() } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(traceIdHandler);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 with liveness payload', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'api-gateway' });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('GET /health echoes a generated trace id when none is supplied', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    const traceHeader = res.headers[TRACE_HEADER.toLowerCase()];
    expect(typeof traceHeader).toBe('string');
    expect((traceHeader as string).length).toBeGreaterThan(0);
  });

  it('GET /health propagates a caller-supplied trace id', async () => {
    const traceId = 'trace-abc-123';
    const res = await request(app.getHttpServer())
      .get('/health')
      .set(TRACE_HEADER, traceId)
      .expect(200);
    expect(res.headers[TRACE_HEADER.toLowerCase()]).toBe(traceId);
  });
});
