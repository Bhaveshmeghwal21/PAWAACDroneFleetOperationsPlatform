/**
 * In-process integration tests for the API Gateway entry-point pipeline
 * (task 13.7). These exercise the real Nest application — trace middleware,
 * JWT auth guard, RBAC guard, per-role rate-limit guard, the RFC 7807 error
 * filter, the routing/proxy controller, and the merged-OpenAPI / Swagger
 * surface — over real HTTP via Supertest.
 *
 * Requirements covered:
 *   - 18.1, 18.5 — auth required: 401 without / with an invalid JWT.
 *   - 18.2, 18.3 — RBAC: 200 for a permitted (role, route); 403 for a denied one.
 *   - 19.2       — rate limiting: 429 + Retry-After once a role exceeds its budget.
 *   - 20.1, 20.2 — routing: a known path forwards to its upstream; an unknown
 *                  path 404s.
 *   - 20.3, 20.4 — merged OpenAPI 3.0 document + single Swagger UI served.
 *
 * Stubbing strategy (no live upstreams / Redis required):
 *   - REDIS_CLIENT      → an in-memory fixed-window counter store, so the
 *                         rate-limit logic (atomic INCR/PEXPIRE/PTTL Lua script)
 *                         is driven deterministically without a live Redis.
 *   - ProxyService      → a stub that performs the *real* upstream resolution
 *                         (via {@link UpstreamRegistry}) and the *real*
 *                         downstream trace-header build, then responds in-process
 *                         instead of opening a socket to a live upstream. This
 *                         keeps the full guard pipeline + routing decision live
 *                         while avoiding a network dependency. The actual byte
 *                         streaming through `http-proxy-middleware` to a *live*
 *                         upstream is therefore NOT exercised here — that path is
 *                         wired but stubbed (documented in the task report).
 *   - UPSTREAM_SPEC_FETCHER → an in-memory fetcher returning canned upstream
 *                         OpenAPI docs, so the merged document is deterministic
 *                         and network-free.
 */
import { Injectable, NotFoundException, type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SwaggerModule } from '@nestjs/swagger';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import request from 'supertest';
import type { Role } from '@pawaac/shared-types';
import { AppModule } from '../src/app.module';
import { ProblemDetailsFilter } from '../src/common/problem-details.filter';
import { buildDownstreamHeaders } from '../src/common/downstream-trace';
import { TRACE_HEADER } from '../src/common/trace';
import { OpenApiAggregatorService } from '../src/openapi/openapi-aggregator.service';
import { UPSTREAM_SPEC_FETCHER, type UpstreamSpecFetcher } from '../src/openapi/spec-fetcher';
import { ProxyService } from '../src/routing/proxy.service';
import { UpstreamRegistry } from '../src/routing/upstream-registry.service';
import { REDIS_CLIENT } from '../src/redis/redis.module';

/** Secret used to sign test JWTs; mirrors the value injected via env. */
const JWT_SECRET = 'integration-test-secret';

/**
 * In-memory stand-in for the Redis fixed-window counter. Emulates the Lua
 * script's contract: INCR the key, return `[postIncrementCount, ttlMs]`.
 */
class FakeRedis {
  private readonly counters = new Map<string, number>();
  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    windowMs: string | number,
  ): Promise<[number, number]> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return [next, Number(windowMs)];
  }
  async quit(): Promise<void> {
    /* no-op */
  }
}

/**
 * Stub proxy that keeps the real routing decision + trace-header build but
 * responds in-process instead of forwarding to a live upstream socket.
 */
@Injectable()
class StubProxyService {
  constructor(private readonly registry: UpstreamRegistry) {}

  forward(req: Request, res: Response): void {
    const target = this.registry.resolveTarget(req.path);
    if (target === undefined) {
      throw new NotFoundException(`No upstream route for ${req.method} ${req.path}`);
    }
    const headers = buildDownstreamHeaders(req);
    res.status(200).json({
      upstream: target.definition.id,
      baseUrl: target.baseUrl,
      forwardedTrace: headers[TRACE_HEADER],
      forwardedPath: req.path,
    });
  }

  use(req: Request, res: Response): void {
    this.forward(req, res);
  }
}

/** Canned upstream OpenAPI documents for the merged-document test. */
const FLEET_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Fleet Registry', version: '1.0.0' },
  paths: { '/drones': { get: { responses: { '200': { description: 'ok' } } } } },
};
const MISSIONS_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Mission Planning', version: '1.0.0' },
  paths: { '/': { get: { responses: { '200': { description: 'ok' } } } } },
};

describe('API Gateway (integration)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const savedEnv: Record<string, string | undefined> = {};

  /** Signs a JWT for the given role (and subject) using the configured secret. */
  function tokenFor(role: Role, subject = 'user-1'): string {
    return jwt.sign({ sub: subject, role }, { secret: JWT_SECRET });
  }

  beforeAll(async () => {
    // Capture + set the environment the gateway reads at module init.
    const env: Record<string, string> = {
      JWT_SECRET,
      FLEET_REGISTRY_URL: 'http://fleet-registry:3000',
      MISSION_PLANNING_URL: 'http://mission-planning:3000',
      TELEMETRY_INGESTION_URL: 'http://telemetry:3000',
      VISION_AI_URL: 'http://vision:8000',
      ALERT_NOTIFICATION_URL: 'http://alerts:3000',
      RATE_LIMIT_WINDOW_SEC: '60',
      RATE_LIMIT_VIEWER: '2', // tiny budget so the 429 path is reachable
      RATE_LIMIT_OPERATOR: '1000',
    };
    for (const [key, value] of Object.entries(env)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }

    const fetcher: UpstreamSpecFetcher = {
      fetch: async (url: string) => {
        if (url.startsWith('http://fleet-registry')) return FLEET_SPEC;
        if (url.startsWith('http://mission-planning')) return MISSIONS_SPEC;
        return null; // other upstreams "unreachable" — omitted from merge
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue(new FakeRedis())
      .overrideProvider(ProxyService)
      .useClass(StubProxyService)
      .overrideProvider(UPSTREAM_SPEC_FETCHER)
      .useValue(fetcher)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());

    // Mount the single merged Swagger UI exactly as bootstrap does.
    const aggregator = app.get(OpenApiAggregatorService);
    const merged = await aggregator.buildMergedDocument();
    SwaggerModule.setup('docs', app, merged, { jsonDocumentUrl: 'openapi.json' });

    jwt = new JwtService();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('authentication (Req 18.1, 18.5)', () => {
    it('rejects a request with no Authorization header with 401', async () => {
      const res = await request(app.getHttpServer()).get('/fleet/drones').expect(401);
      expect(res.body.status).toBe(401);
    });

    it('rejects a request with a malformed bearer token with 401', async () => {
      await request(app.getHttpServer())
        .get('/fleet/drones')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .expect(401);
    });

    it('rejects a token signed with the wrong secret with 401', async () => {
      const forged = jwt.sign({ sub: 'u', role: 'operator' }, { secret: 'wrong-secret' });
      await request(app.getHttpServer())
        .get('/fleet/drones')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });
  });

  describe('RBAC authorization (Req 18.2, 18.3)', () => {
    it('forwards a request from a permitted role (operator → GET /fleet/drones)', async () => {
      const res = await request(app.getHttpServer())
        .get('/fleet/drones')
        .set('Authorization', `Bearer ${tokenFor('operator')}`)
        .expect(200);
      expect(res.body.upstream).toBe('fleet-registry');
      expect(res.body.baseUrl).toBe('http://fleet-registry:3000');
      // Downstream trace id is non-empty (P44) and echoed on the response.
      expect(typeof res.body.forwardedTrace).toBe('string');
      expect(res.body.forwardedTrace.length).toBeGreaterThan(0);
      expect(res.headers[TRACE_HEADER.toLowerCase()]).toBeDefined();
    });

    it('denies a request from an unpermitted role with 403 (viewer → POST /fleet/drones)', async () => {
      await request(app.getHttpServer())
        .post('/fleet/drones')
        .set('Authorization', `Bearer ${tokenFor('viewer')}`)
        .send({})
        .expect(403);
    });
  });

  describe('routing (Req 20.1, 20.2)', () => {
    it('routes a known prefix to its resolved upstream', async () => {
      const res = await request(app.getHttpServer())
        .get('/missions')
        .set('Authorization', `Bearer ${tokenFor('operator')}`)
        .expect(200);
      expect(res.body.upstream).toBe('mission-planning');
    });

    it('returns 404 for a path under no known prefix', async () => {
      await request(app.getHttpServer())
        .get('/this-path-is-unknown')
        .set('Authorization', `Bearer ${tokenFor('operator')}`)
        .expect(404);
    });
  });

  describe('rate limiting (Req 19.2)', () => {
    it('responds 429 with Retry-After once the role exceeds its window budget', async () => {
      const auth = `Bearer ${tokenFor('viewer', 'rate-limit-subject')}`;
      const agent = request(app.getHttpServer());

      // Viewer budget is 2/window: first two requests pass the limiter.
      await agent.get('/fleet/drones').set('Authorization', auth).expect(200);
      await request(app.getHttpServer())
        .get('/fleet/drones')
        .set('Authorization', auth)
        .expect(200);

      // Third request in the same window is rejected with 429 + Retry-After.
      const limited = await request(app.getHttpServer())
        .get('/fleet/drones')
        .set('Authorization', auth)
        .expect(429);
      const retryAfter = limited.headers['retry-after'];
      expect(retryAfter).toBeDefined();
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    });
  });

  describe('merged OpenAPI / Swagger (Req 20.3, 20.4)', () => {
    it('serves the merged OpenAPI 3.0 JSON document with re-based upstream paths', async () => {
      const res = await request(app.getHttpServer()).get('/openapi.json').expect(200);
      expect(res.body.openapi).toBe('3.0.0');
      // Fleet's /drones is re-based under the gateway prefix /fleet.
      expect(res.body.paths['/fleet/drones']).toBeDefined();
      // Missions' root path is re-based to the bare /missions prefix.
      expect(res.body.paths['/missions']).toBeDefined();
      // Unreachable upstreams are omitted (their fetcher returned null).
      expect(res.body.paths['/telemetry/history']).toBeUndefined();
    });

    it('serves a single Swagger UI for the merged document', async () => {
      const res = await request(app.getHttpServer()).get('/docs').expect(200);
      expect(res.headers['content-type']).toContain('text/html');
    });
  });
});
