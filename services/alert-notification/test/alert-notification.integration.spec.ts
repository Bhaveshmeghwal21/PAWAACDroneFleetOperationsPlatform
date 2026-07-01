import { existsSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { createTransport, type Transporter } from 'nodemailer';
import type { AxiosInstance } from 'axios';
import type { Alert, Channel } from '@pawaac/shared-types';

import {
  MAIL_TRANSPORTER,
  OPENWA_HTTP,
} from '../src/notifications/transports/channel-transport';
import { DispatchService } from '../src/notifications/dispatch/dispatch.service';
import { AlertsGateway } from '../src/notifications/alerts.gateway';
import { RulesService } from '../src/alerts/rules.service';
import { EscalationService } from '../src/alerts/escalation.service';
import { AnalyticsService } from '../src/alerts/analytics.service';
import { sumCounts, UNZONED_KEY } from '../src/alerts/analytics.logic';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import { ESCALATION_DUE_ZSET, failedChannelsKey } from '../src/alerts/redis-keys';
import type { UpsertRuleDto } from '../src/alerts/dto';

/**
 * End-to-end integration tests for the Alert & Notification service (task
 * 11.10) running against *real* Postgres and Redis instances provisioned by
 * Testcontainers. They exercise the production persistence and dispatch paths:
 *
 *  - rule/alert persistence against Postgres (TypeORM migrations run on boot),
 *  - escalation-timer state in Redis (sorted set + failed-channel sets),
 *  - multi-channel dispatch through the *concrete* transports with the external
 *    dependencies stubbed: OpenWA via a mocked axios client (Req 15.4) and email
 *    via Nodemailer's built-in `jsonTransport` test transport (Req 15.3); the
 *    in-app WebSocket transport (Req 15.2) is driven through a fake Socket.IO
 *    server so no real WS server is needed,
 *  - the analytics conservation invariant end-to-end through Postgres (Req 17.1,
 *    17.2 / design property P39) and the queryable alert history (Req 17.3).
 *
 * Covers Requirements 15.2, 15.3, 15.4, 17.1, 17.3.
 *
 * The whole suite is skipped cleanly when no Docker daemon is reachable (e.g. a
 * local sandbox without Docker) so the rest of the test run stays green; CI,
 * where Docker is available, runs it for real. The fast-check analytics property
 * (P39) in `src/alerts/analytics.property.spec.ts` always runs regardless.
 */

/**
 * Best-effort, synchronous detection of a Docker daemon reachable by the
 * Testcontainers Node client (which talks to the daemon over a Unix socket, or
 * the host named by `DOCKER_HOST`, via dockerode — not the `docker` CLI). We
 * probe exactly those, mirroring how Testcontainers resolves its runtime.
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
    '[alert-notification.integration] Docker daemon not detected — skipping Testcontainers Postgres+Redis integration suite.',
  );
}

/** Recording mock of the OpenWA axios client (Req 15.4) — captures every POST. */
function mockOpenWa(): { http: AxiosInstance; post: jest.Mock } {
  const post = jest.fn().mockResolvedValue({ status: 200, data: { success: true } });
  return { http: { post } as unknown as AxiosInstance, post };
}

/** Minimal rule body for the upsert path; callers override what they care about. */
function ruleDto(overrides: Partial<UpsertRuleDto> = {}): UpsertRuleDto {
  return {
    name: 'integration-rule',
    enabled: true,
    eventKind: 'anomaly',
    severity: 'critical',
    conditions: [{ field: 'payload.kind', operator: 'eq', value: 'battery_low' }],
    channels: [{ type: 'in_app' }],
    escalationChain: [],
    escalationIntervalMin: 5,
    ...overrides,
  } as UpsertRuleDto;
}

describeIntegration('Alert & Notification against real Postgres + Redis (integration)', () => {
  jest.setTimeout(240_000);

  let postgres: StartedTestContainer;
  let redisContainer: StartedTestContainer;
  let app: INestApplication;

  let rules: RulesService;
  let escalation: EscalationService;
  let analytics: AnalyticsService;
  let dispatch: DispatchService;
  let redis: {
    zscore(key: string, member: string): Promise<string | null>;
    smembers(key: string): Promise<string[]>;
    flushall(): Promise<unknown>;
  };

  // Stubbed external dependencies kept in scope so individual tests can assert
  // on / re-program them.
  let openWaPost: jest.Mock;
  let mailTransporter: Transporter;
  let inAppEmit: jest.Mock;

  beforeAll(async () => {
    postgres = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'alert_notification',
        POSTGRES_PASSWORD: 'alert_notification',
        POSTGRES_DB: 'alert_notification',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();

    // The service reads connection config from these env vars at import time
    // (src/data-source.ts, app.module.ts), so set them BEFORE importing AppModule.
    process.env['DB_HOST'] = postgres.getHost();
    process.env['DB_PORT'] = String(postgres.getMappedPort(5432));
    process.env['DB_USER'] = 'alert_notification';
    process.env['DB_PASSWORD'] = 'alert_notification';
    process.env['DB_NAME'] = 'alert_notification';
    process.env['REDIS_HOST'] = redisContainer.getHost();
    process.env['REDIS_PORT'] = String(redisContainer.getMappedPort(6379));

    const { AppModule } = await import('../src/app.module');

    const openWa = mockOpenWa();
    openWaPost = openWa.post;
    // A real Nodemailer transport with no network — the JSON test transport.
    mailTransporter = createTransport({ jsonTransport: true });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OPENWA_HTTP)
      .useValue(openWa.http)
      .overrideProvider(MAIL_TRANSPORTER)
      .useValue(mailTransporter)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    // Drive the in-app WebSocket transport through a fake Socket.IO server so no
    // real WS server is required for the in-app channel (Req 15.2).
    inAppEmit = jest.fn();
    app.get(AlertsGateway).server = { emit: inAppEmit } as never;

    rules = app.get(RulesService);
    escalation = app.get(EscalationService);
    analytics = app.get(AnalyticsService);
    dispatch = app.get(DispatchService);
    redis = app.get(REDIS_CLIENT);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await redisContainer?.stop();
  });

  beforeEach(async () => {
    await redis.flushall();
    jest.clearAllMocks();
  });

  // A fresh, unique zone uuid per call so zone-scoped tests don't collide.
  let zoneSeq = 0;
  const nextZoneId = (): string =>
    `00000000-0000-4000-8000-${String(++zoneSeq).padStart(12, '0')}`;

  describe('rule + alert persistence (Postgres)', () => {
    it('persists a rule via upsert and round-trips it through evaluation', async () => {
      const created = await rules.upsertRule(ruleDto({ name: 'persist-me' }));

      expect(created.id).toEqual(expect.any(String));
      expect(created.name).toBe('persist-me');
      expect(created.conditions).toEqual([
        { field: 'payload.kind', operator: 'eq', value: 'battery_low' },
      ]);

      // A matching event is matched by the freshly persisted, enabled rule.
      const matched = await rules.evaluateEvent({
        kind: 'anomaly',
        payload: { kind: 'battery_low' },
      } as never);
      expect(matched.map((r) => r.id)).toContain(created.id);
    });

    it('replaces a rule (and its conditions) in place on a keyed upsert', async () => {
      const created = await rules.upsertRule(ruleDto({ name: 'v1' }));
      const updated = await rules.upsertRule(
        ruleDto({
          id: created.id,
          name: 'v2',
          conditions: [{ field: 'payload.score', operator: 'gte', value: 0.9 }],
        }),
      );

      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe('v2');
      expect(updated.conditions).toEqual([
        { field: 'payload.score', operator: 'gte', value: 0.9 },
      ]);
    });

    it('persists a new alert OPEN at level 0 and arms its Redis escalation timer', async () => {
      const rule = await rules.upsertRule(ruleDto({ escalationIntervalMin: 10 }));
      const now = new Date('2024-01-01T00:00:00.000Z');

      const alert = await escalation.createAlert(
        { ruleId: rule.id, severity: 'critical', escalationIntervalMin: 10 },
        now,
      );

      expect(alert.status).toBe('OPEN');
      expect(alert.escalationLevel).toBe(0);

      // Durable history reflects the persisted alert (Req 17.3).
      const history = await analytics.getHistory({});
      expect(history.map((a) => a.id)).toContain(alert.id);

      // The escalation timer was scheduled one interval out in the Redis zset.
      const score = await redis.zscore(ESCALATION_DUE_ZSET, alert.id);
      expect(score).not.toBeNull();
      expect(Number(score)).toBe(now.getTime() + 10 * 60_000);
    });

    it('acknowledging an alert cancels its Redis timer (Req 16 persistence path)', async () => {
      const rule = await rules.upsertRule(ruleDto());
      const alert = await escalation.createAlert({
        ruleId: rule.id,
        severity: 'warning',
        escalationIntervalMin: 5,
      });
      expect(await redis.zscore(ESCALATION_DUE_ZSET, alert.id)).not.toBeNull();

      const acked = await escalation.acknowledge(alert.id, '00000000-0000-4000-8000-0000000000aa');
      expect(acked.status).toBe('ACKNOWLEDGED');
      expect(await redis.zscore(ESCALATION_DUE_ZSET, alert.id)).toBeNull();
    });
  });

  describe('analytics over real Postgres (Req 17.1/17.2 / P39)', () => {
    it('groups persisted alerts by zone and hour with conservation holding', async () => {
      const zone = nextZoneId();
      const zonedRule = await rules.upsertRule(ruleDto({ name: 'zoned', zoneId: zone }));
      const fleetRule = await rules.upsertRule(ruleDto({ name: 'fleet-wide' }));

      // Two alerts in one hour for the zoned rule, one for the fleet-wide rule.
      const h8 = new Date('2024-06-01T08:15:00.000Z');
      const h9 = new Date('2024-06-01T09:30:00.000Z');
      await escalation.createAlert(
        { ruleId: zonedRule.id, severity: 'critical', escalationIntervalMin: 5 },
        h8,
      );
      await escalation.createAlert(
        { ruleId: zonedRule.id, severity: 'critical', escalationIntervalMin: 5 },
        h8,
      );
      await escalation.createAlert(
        { ruleId: fleetRule.id, severity: 'warning', escalationIntervalMin: 5 },
        h9,
      );

      const result = await analytics.getAnalytics({
        from: '2024-06-01T00:00:00.000Z',
        to: '2024-06-01T23:59:59.999Z',
      });

      expect(result.total).toBe(3);
      // Conservation (P39): each grouping sums back to the total.
      expect(sumCounts(result.byZone)).toBe(3);
      expect(sumCounts(result.byHour)).toBe(3);

      const zoneBucket = result.byZone.find((b) => b.zoneId === zone);
      const unzonedBucket = result.byZone.find((b) => b.zoneId === UNZONED_KEY);
      expect(zoneBucket?.count).toBe(2);
      expect(unzonedBucket?.count).toBe(1);
      expect(result.byHour).toEqual(
        expect.arrayContaining([
          { hourStart: '2024-06-01T08:00:00.000Z', count: 2 },
          { hourStart: '2024-06-01T09:00:00.000Z', count: 1 },
        ]),
      );
    });

    it('history filters by status and paginates (Req 17.3)', async () => {
      const rule = await rules.upsertRule(ruleDto());
      const a1 = await escalation.createAlert({
        ruleId: rule.id,
        severity: 'info',
        escalationIntervalMin: 5,
      });
      await escalation.createAlert({
        ruleId: rule.id,
        severity: 'info',
        escalationIntervalMin: 5,
      });
      await escalation.acknowledge(a1.id, '00000000-0000-4000-8000-0000000000bb');

      const acknowledged = await analytics.getHistory({ status: 'ACKNOWLEDGED' });
      expect(acknowledged.every((a) => a.status === 'ACKNOWLEDGED')).toBe(true);
      expect(acknowledged.map((a) => a.id)).toContain(a1.id);

      const firstPage = await analytics.getHistory({ limit: 1, offset: 0 });
      expect(firstPage).toHaveLength(1);
    });
  });

  describe('multi-channel dispatch through concrete transports', () => {
    const alert: Alert = {
      id: 'alert-int-1',
      ruleId: 'rule-int-1',
      severity: 'critical',
      status: 'OPEN',
      escalationLevel: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    it('delivers email via the Nodemailer test transport (Req 15.3)', async () => {
      const sendMail = jest.spyOn(mailTransporter, 'sendMail');
      const channels: Channel[] = [{ type: 'email', target: 'ops@pawaac.io' }];

      const result = await dispatch.dispatch(alert, channels);

      expect(sendMail).toHaveBeenCalledTimes(1);
      const message = sendMail.mock.calls[0]?.[0] as { to?: string };
      expect(message.to).toBe('ops@pawaac.io');
      expect(result.allDelivered).toBe(true);
    });

    it('delivers WhatsApp via the mocked OpenWA REST client (Req 15.4)', async () => {
      const channels: Channel[] = [{ type: 'whatsapp', target: '15550001111' }];

      const result = await dispatch.dispatch(alert, channels);

      expect(openWaPost).toHaveBeenCalledTimes(1);
      const [url, payload] = openWaPost.mock.calls[0] as [
        string,
        { args: { to: string; content: string } },
      ];
      expect(url).toBe('/sendText');
      expect(payload.args.to).toBe('15550001111');
      expect(result.allDelivered).toBe(true);
    });

    it('delivers the in-app channel through the WebSocket gateway (Req 15.2)', async () => {
      const channels: Channel[] = [{ type: 'in_app' }];

      const result = await dispatch.dispatch(alert, channels);

      expect(inAppEmit).toHaveBeenCalledTimes(1);
      const [event, payload] = inAppEmit.mock.calls[0] as [string, Alert];
      expect(event).toBe('alert');
      expect(payload.id).toBe(alert.id);
      expect(result.allDelivered).toBe(true);
    });

    it('records a failed channel in Redis and falls back to in-app (Req 15.4/15.5)', async () => {
      // Re-program the mocked OpenWA client to fail this dispatch.
      openWaPost.mockRejectedValue(new Error('Request failed with status code 502'));
      const channels: Channel[] = [{ type: 'whatsapp', target: '15550001111' }];

      const result = await dispatch.dispatch({ ...alert, id: 'alert-int-fail' }, channels);

      expect(result.allDelivered).toBe(false);
      // The failed whatsapp channel was marked in the real Redis failed-channel set.
      const failed = await redis.smembers(failedChannelsKey('alert-int-fail'));
      expect(failed).toContain('whatsapp');
      // ...and it fell back to a real in-app push.
      expect(inAppEmit).toHaveBeenCalledTimes(1);
      const fallback = result.results.find((r) => r.channel === 'in_app' && r.viaFallback);
      expect(fallback?.status).toBe('delivered');
    });

    it('fans out to exactly the configured channels in one dispatch (Req 15.2/15.3/15.4)', async () => {
      const sendMail = jest.spyOn(mailTransporter, 'sendMail');
      const channels: Channel[] = [
        { type: 'in_app' },
        { type: 'email', target: 'ops@pawaac.io' },
        { type: 'whatsapp', target: '15550001111' },
      ];

      const result = await dispatch.dispatch({ ...alert, id: 'alert-int-fanout' }, channels);

      expect(inAppEmit).toHaveBeenCalledTimes(1);
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(openWaPost).toHaveBeenCalledTimes(1);
      expect(result.allDelivered).toBe(true);
      expect(result.results.filter((r) => r.viaFallback)).toHaveLength(0);
    });
  });
});
