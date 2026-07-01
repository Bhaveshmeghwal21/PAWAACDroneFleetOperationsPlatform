import fc from 'fast-check';
import type { AxiosInstance } from 'axios';
import { createTransport } from 'nodemailer';
import type { Alert, Channel, ChannelType } from '@pawaac/shared-types';
import { DEFAULT_RETRY_POLICY, fanOutChannels, type RetryPolicy } from './dispatch.logic';
import { DispatchService, type DelayFn } from './dispatch.service';
import type { ChannelTransport } from '../transports/channel-transport';
import { WhatsAppTransport } from '../transports/whatsapp.transport';
import { EmailTransport } from '../transports/email.transport';
import { InAppTransport } from '../transports/in-app.transport';
import type { AlertsGateway } from '../alerts.gateway';

/**
 * Property-based + integration tests for multi-channel dispatch (task 11.6).
 *
 * The generator-driven property below validates P37 — Dispatch fan-out
 * (Requirement 15.1): a dispatched alert reaches *exactly* the channels
 * configured on its rule (de-duplicated by type+target), no more and no less.
 *
 * The focused integration tests at the bottom wire the *real* OpenWA (axios
 * mocked), Nodemailer (`jsonTransport`) and in-app transports through the
 * dispatcher to cover the backoff and WS-fallback / fallback-skip paths end to
 * end with the concrete transports — complementing the mock-transport
 * orchestration tests in `dispatch.service.spec.ts` and the in-isolation
 * transport tests in `transports/*.spec.ts` without duplicating them.
 */

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

/** Canonical identity of a channel: same type AND target ⇒ same destination. */
function channelKey(channel: Channel): string {
  return `${channel.type}\u0000${channel.target ?? ''}`;
}

/**
 * A transport that records every channel it was asked to deliver (and always
 * succeeds), so the test can reconstruct the exact set of destinations reached.
 */
class RecordingTransport implements ChannelTransport {
  readonly received: Channel[] = [];

  constructor(readonly type: ChannelType) {}

  send(_alert: Alert, channel: Channel): Promise<void> {
    this.received.push(channel);
    return Promise.resolve();
  }
}

const NOOP_DELAY: DelayFn = () => Promise.resolve();

/**
 * The canonical channel types. Declared locally (rather than imported as a
 * runtime value from `@pawaac/shared-types`) to match the type-only import
 * convention the service uses for the shared package.
 */
const CHANNEL_TYPES = ['in_app', 'email', 'whatsapp'] as const satisfies readonly ChannelType[];

describe('DispatchService.dispatch — P37: dispatch fan-out (Req 15.1)', () => {
  // A small, fixed target pool so the generator produces byte-identical
  // duplicates (exercising de-dup) as well as distinct same-type targets.
  const targetArb = fc.constantFrom(
    undefined,
    'ops@pawaac.io',
    'team@pawaac.io',
    '15550001111',
    '15550002222',
  );

  const channelArb: fc.Arbitrary<Channel> = fc
    .record({ type: fc.constantFrom(...CHANNEL_TYPES), target: targetArb })
    .map(({ type, target }) => (target === undefined ? { type } : { type, target }));

  it('delivers to exactly the configured channels (deduped by type+target), no more, no less', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(channelArb, { maxLength: 8 }), async (channels) => {
        const inApp = new RecordingTransport('in_app');
        const email = new RecordingTransport('email');
        const whatsapp = new RecordingTransport('whatsapp');
        const service = new DispatchService(
          inApp,
          email,
          whatsapp,
          DEFAULT_RETRY_POLICY,
          NOOP_DELAY,
        );

        // The exact configured destination set, per the fan-out contract.
        const expectedKeys = new Set(fanOutChannels(channels).map(channelKey));

        const result = await service.dispatch(buildAlert(), channels);
        const deliveredChannels = [...inApp.received, ...email.received, ...whatsapp.received];
        const deliveredKeys = deliveredChannels.map(channelKey);
        const deliveredKeySet = new Set(deliveredKeys);

        // 1. Every configured destination was reached, and nothing extra was.
        expect(deliveredKeySet).toEqual(expectedKeys);
        // 2. Each destination was delivered to EXACTLY once (no duplicates, no
        //    double delivery to the same type+target).
        expect(deliveredKeys).toHaveLength(expectedKeys.size);
        // 3. With every transport succeeding, dispatch reports full success with
        //    no in-app fallback pushes.
        expect(result.allDelivered).toBe(true);
        const primaries = result.results.filter((r) => !r.viaFallback);
        const fallbacks = result.results.filter((r) => r.viaFallback);
        expect(fallbacks).toHaveLength(0);
        expect(new Set(primaries.map((r) => `${r.channel}\u0000${r.target ?? ''}`))).toEqual(
          expectedKeys,
        );
      }),
      { numRuns: 200 },
    );
  });
});

const whatsappChannel: Channel = { type: 'whatsapp', target: '15550001111' };
const emailChannel: Channel = { type: 'email', target: 'ops@pawaac.io' };
const inAppChannel: Channel = { type: 'in_app' };

/** Build a recording no-op delay so backoff sleeps can be asserted on. */
function recordingDelay(): { delay: DelayFn; delays: number[] } {
  const delays: number[] = [];
  return { delay: (ms) => (delays.push(ms), Promise.resolve()), delays };
}

describe('DispatchService.dispatch — real transports, backoff + fallback (Req 15.5/15.6)', () => {
  const policy: RetryPolicy = {
    maxAttempts: 3,
    baseDelayMs: 100,
    backoffFactor: 2,
    maxDelayMs: 10_000,
  };

  it('retries a failing OpenWA (axios) send with backoff then falls back to a real in-app push', async () => {
    const post = jest.fn().mockRejectedValue(new Error('Request failed with status code 502'));
    const whatsapp = new WhatsAppTransport({ post } as unknown as AxiosInstance);
    const broadcast = jest.fn();
    const inApp = new InAppTransport({ broadcast } as unknown as AlertsGateway);
    const email = new EmailTransport(createTransport({ jsonTransport: true }), 'alerts@pawaac.local');
    const { delay, delays } = recordingDelay();

    const service = new DispatchService(inApp, email, whatsapp, policy, delay);
    const result = await service.dispatch(buildAlert(), [whatsappChannel]);

    // OpenWA retried up to maxAttempts, with exponential backoff sleeps between.
    expect(post).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
    // The failed WhatsApp channel fell back to a single real in-app push.
    expect(broadcast).toHaveBeenCalledTimes(1);
    const fallback = result.results.find((r) => r.channel === 'in_app' && r.viaFallback);
    expect(fallback?.status).toBe('delivered');
    expect(result.allDelivered).toBe(false);
  });

  it('delivers a real Nodemailer email and OpenWA WhatsApp without any fallback when both succeed', async () => {
    const post = jest.fn().mockResolvedValue({ status: 200, data: {} });
    const whatsapp = new WhatsAppTransport({ post } as unknown as AxiosInstance);
    const broadcast = jest.fn();
    const inApp = new InAppTransport({ broadcast } as unknown as AlertsGateway);
    const transporter = createTransport({ jsonTransport: true });
    const sendMail = jest.spyOn(transporter, 'sendMail');
    const email = new EmailTransport(transporter, 'alerts@pawaac.local');

    const service = new DispatchService(inApp, email, whatsapp, policy, NOOP_DELAY);
    const result = await service.dispatch(buildAlert(), [emailChannel, whatsappChannel]);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(broadcast).not.toHaveBeenCalled();
    expect(result.allDelivered).toBe(true);
  });

  it('skips the in-app fallback when the real in-app channel has itself already failed (Req 15.6)', async () => {
    const post = jest.fn().mockRejectedValue(new Error('Request failed with status code 502'));
    const whatsapp = new WhatsAppTransport({ post } as unknown as AxiosInstance);
    // Real in-app transport whose gateway broadcast always throws → in-app fails.
    const broadcast = jest.fn(() => {
      throw new Error('socket.io server not initialised');
    });
    const inApp = new InAppTransport({ broadcast } as unknown as AlertsGateway);
    const email = new EmailTransport(createTransport({ jsonTransport: true }), 'alerts@pawaac.local');

    const service = new DispatchService(inApp, email, whatsapp, policy, NOOP_DELAY);
    const result = await service.dispatch(buildAlert(), [inAppChannel, whatsappChannel]);

    // in-app attempted only as the (failing) primary — maxAttempts times — and
    // NOT again as a fallback for the failed WhatsApp channel.
    expect(broadcast).toHaveBeenCalledTimes(policy.maxAttempts);
    expect(result.results.some((r) => r.viaFallback)).toBe(false);
    expect(result.allDelivered).toBe(false);
  });
});
