import type { Alert, Channel, ChannelType } from '@pawaac/shared-types';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './dispatch.logic';
import { DispatchService, type DelayFn, type FailedChannelRecorder } from './dispatch.service';
import type { ChannelTransport } from '../transports/channel-transport';

/**
 * Orchestration unit tests for multi-channel dispatch (task 11.5). All three
 * transports are mocked behind the `ChannelTransport` interface and the backoff
 * sleep is a recording no-op, so these cover fan-out, partial failure, retry
 * backoff and the WS-fallback-skip rule without any network or real timers.
 */

/** A controllable mock transport whose `send` queues per-call outcomes. */
class MockTransport implements ChannelTransport {
  readonly send = jest.fn<Promise<void>, [Alert, Channel]>();

  constructor(readonly type: ChannelType) {}

  /** Always resolve. */
  alwaysSucceed(): this {
    this.send.mockResolvedValue(undefined);
    return this;
  }

  /** Always reject with the given message. */
  alwaysFail(message = `${this.type} down`): this {
    this.send.mockRejectedValue(new Error(message));
    return this;
  }
}

function buildAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: overrides.id ?? 'alert-1',
    ruleId: overrides.ruleId ?? 'rule-1',
    severity: overrides.severity ?? 'critical',
    status: overrides.status ?? 'OPEN',
    escalationLevel: overrides.escalationLevel ?? 0,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
  };
}

interface Harness {
  service: DispatchService;
  inApp: MockTransport;
  email: MockTransport;
  whatsapp: MockTransport;
  delays: number[];
  redis: { sadd: jest.Mock };
}

function makeService(policy: Partial<RetryPolicy> = {}): Harness {
  const inApp = new MockTransport('in_app');
  const email = new MockTransport('email');
  const whatsapp = new MockTransport('whatsapp');
  const delays: number[] = [];
  const delay: DelayFn = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  const redis: FailedChannelRecorder & { sadd: jest.Mock } = {
    sadd: jest.fn().mockResolvedValue(1),
  };
  const service = new DispatchService(
    inApp,
    email,
    whatsapp,
    { ...DEFAULT_RETRY_POLICY, ...policy },
    delay,
    redis,
  );
  return { service, inApp, email, whatsapp, delays, redis };
}

const inAppChannel: Channel = { type: 'in_app' };
const emailChannel: Channel = { type: 'email', target: 'ops@pawaac.io' };
const whatsappChannel: Channel = { type: 'whatsapp', target: '15550001111' };

describe('DispatchService.dispatch — fan-out (Req 15.1 / P37)', () => {
  it('delivers to exactly the configured channels and reports success', async () => {
    const { service, inApp, email, whatsapp } = makeService();
    inApp.alwaysSucceed();
    email.alwaysSucceed();
    whatsapp.alwaysSucceed();

    const result = await service.dispatch(buildAlert(), [
      inAppChannel,
      emailChannel,
      whatsappChannel,
    ]);

    expect(inApp.send).toHaveBeenCalledTimes(1);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(whatsapp.send).toHaveBeenCalledTimes(1);
    expect(result.allDelivered).toBe(true);
    expect(result.results.map((r) => r.channel).sort()).toEqual(['email', 'in_app', 'whatsapp']);
    expect(result.results.every((r) => r.status === 'delivered')).toBe(true);
  });

  it('only invokes the channels configured on the rule (no extras)', async () => {
    const { service, inApp, email, whatsapp } = makeService();
    inApp.alwaysSucceed();
    email.alwaysSucceed();
    whatsapp.alwaysSucceed();

    await service.dispatch(buildAlert(), [emailChannel]);

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(inApp.send).not.toHaveBeenCalled();
    expect(whatsapp.send).not.toHaveBeenCalled();
  });

  it('passes the alert and channel target through to the transport', async () => {
    const { service, email } = makeService();
    email.alwaysSucceed();
    const alert = buildAlert({ id: 'alert-xyz' });

    await service.dispatch(alert, [emailChannel]);

    expect(email.send).toHaveBeenCalledWith(alert, emailChannel);
  });
});

describe('DispatchService.dispatch — partial delivery + fallback (Req 15.5)', () => {
  it('treats a partial delivery as overall success (never throws)', async () => {
    const { service, inApp, email } = makeService();
    inApp.alwaysSucceed();
    email.alwaysFail();

    const result = await service.dispatch(buildAlert(), [emailChannel]);

    expect(result.allDelivered).toBe(false);
    const emailResult = result.results.find((r) => r.channel === 'email' && !r.viaFallback);
    expect(emailResult?.status).toBe('failed');
  });

  it('falls back to in-app WebSocket when a non-WS channel fails', async () => {
    const { service, inApp, whatsapp } = makeService();
    whatsapp.alwaysFail();
    inApp.alwaysSucceed();

    const result = await service.dispatch(buildAlert(), [whatsappChannel]);

    // WhatsApp failed → exactly one in-app fallback push was attempted.
    const fallback = result.results.find((r) => r.channel === 'in_app' && r.viaFallback);
    expect(fallback?.status).toBe('delivered');
    expect(inApp.send).toHaveBeenCalledTimes(1);
  });

  it('marks failed channels in the Redis failed-channel set', async () => {
    const { service, email, inApp, redis } = makeService();
    email.alwaysFail();
    inApp.alwaysSucceed();

    await service.dispatch(buildAlert({ id: 'alert-7' }), [emailChannel]);

    expect(redis.sadd).toHaveBeenCalledWith('alert:failed-channels:alert-7', 'email');
  });

  it('continues delivering other channels when one fails', async () => {
    const { service, inApp, email, whatsapp } = makeService();
    email.alwaysFail();
    whatsapp.alwaysSucceed();
    inApp.alwaysSucceed();

    const result = await service.dispatch(buildAlert(), [emailChannel, whatsappChannel]);

    expect(whatsapp.send).toHaveBeenCalledTimes(1);
    const whatsappResult = result.results.find((r) => r.channel === 'whatsapp');
    expect(whatsappResult?.status).toBe('delivered');
  });
});

describe('DispatchService.dispatch — retry with backoff (Req 15.5)', () => {
  it('retries a failing channel up to maxAttempts with exponential backoff', async () => {
    const { service, email, inApp, delays } = makeService({
      maxAttempts: 3,
      baseDelayMs: 100,
      backoffFactor: 2,
      maxDelayMs: 10_000,
    });
    email.alwaysFail();
    inApp.alwaysSucceed();

    const result = await service.dispatch(buildAlert(), [emailChannel]);

    expect(email.send).toHaveBeenCalledTimes(3);
    const emailResult = result.results.find((r) => r.channel === 'email' && !r.viaFallback);
    expect(emailResult?.attempts).toBe(3);
    // Two backoff sleeps between the three attempts: 100ms then 200ms.
    expect(delays).toEqual([100, 200]);
  });

  it('succeeds on a later attempt without exhausting retries', async () => {
    const { service, email, delays } = makeService({ maxAttempts: 3, baseDelayMs: 50 });
    email.send.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce(undefined);

    const result = await service.dispatch(buildAlert(), [emailChannel]);

    expect(email.send).toHaveBeenCalledTimes(2);
    const emailResult = result.results.find((r) => r.channel === 'email');
    expect(emailResult?.status).toBe('delivered');
    expect(emailResult?.attempts).toBe(2);
    expect(delays).toEqual([50]); // one backoff before the successful retry
  });
});

describe('DispatchService.dispatch — WS fallback skip (Req 15.6)', () => {
  it('skips the in-app fallback when the in-app channel has itself already failed', async () => {
    const { service, inApp, email } = makeService();
    inApp.alwaysFail();
    email.alwaysFail();

    const result = await service.dispatch(buildAlert(), [inAppChannel, emailChannel]);

    // in_app attempted only as the (failing) primary — maxAttempts times, no
    // extra fallback push.
    expect(inApp.send).toHaveBeenCalledTimes(DEFAULT_RETRY_POLICY.maxAttempts);
    const fallback = result.results.find((r) => r.viaFallback);
    expect(fallback).toBeUndefined();
    expect(result.allDelivered).toBe(false);
  });

  it('retries only the originally configured channels when WS is down', async () => {
    const { service, inApp, email, whatsapp } = makeService({ maxAttempts: 2 });
    inApp.alwaysFail();
    email.alwaysFail();
    whatsapp.alwaysFail();

    await service.dispatch(buildAlert(), [inAppChannel, emailChannel, whatsappChannel]);

    // Each configured channel retried maxAttempts times; no fallback pushes.
    expect(inApp.send).toHaveBeenCalledTimes(2);
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(whatsapp.send).toHaveBeenCalledTimes(2);
  });

  it('skips later fallbacks once a fallback push has itself failed', async () => {
    const { service, inApp, email, whatsapp } = makeService({ maxAttempts: 1 });
    // in-app not configured; both other channels fail. The first fallback push
    // fails (marking in-app unhealthy), so the second failed channel skips it.
    email.alwaysFail();
    whatsapp.alwaysFail();
    inApp.alwaysFail();

    const result = await service.dispatch(buildAlert(), [emailChannel, whatsappChannel]);

    // Only one in-app fallback push attempted (for the first failed channel).
    expect(inApp.send).toHaveBeenCalledTimes(1);
    const fallbacks = result.results.filter((r) => r.viaFallback);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.status).toBe('failed');
  });
});

describe('DispatchService.dispatch — robustness', () => {
  it('does not throw when Redis failure-recording errors', async () => {
    const { service, email, inApp, redis } = makeService();
    email.alwaysFail();
    inApp.alwaysSucceed();
    redis.sadd.mockRejectedValue(new Error('redis unavailable'));

    await expect(service.dispatch(buildAlert(), [emailChannel])).resolves.toMatchObject({
      allDelivered: false,
    });
  });

  it('reports an unknown channel type as a failed delivery', async () => {
    const { service } = makeService();
    const result = await service.dispatch(buildAlert(), [
      { type: 'carrier-pigeon' as ChannelType },
    ]);
    const unknown = result.results.find((r) => !r.viaFallback);
    expect(unknown?.status).toBe('failed');
  });
});
