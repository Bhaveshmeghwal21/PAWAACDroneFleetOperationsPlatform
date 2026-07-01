import type { Channel } from '@pawaac/shared-types';
import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  fanOutChannels,
  isInAppFailure,
  resolveRetryPolicy,
  shouldFallbackToInApp,
  type RetryPolicy,
} from './dispatch.logic';
import type { ChannelDeliveryResult } from './dispatch.types';

/**
 * Focused unit tests for the pure dispatch decision logic (task 11.5). The
 * generator-driven property test for P37 (dispatch fan-out) is task 11.6; these
 * exercise the deterministic building blocks directly.
 */

describe('resolveRetryPolicy', () => {
  it('returns the defaults when nothing is supplied', () => {
    expect(resolveRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
  });

  it('clamps nonsensical values to safe minimums', () => {
    const policy = resolveRetryPolicy({
      maxAttempts: 0,
      baseDelayMs: -50,
      backoffFactor: 0.5,
      maxDelayMs: -1,
    });
    expect(policy.maxAttempts).toBe(1);
    expect(policy.baseDelayMs).toBe(0);
    expect(policy.backoffFactor).toBe(1);
    expect(policy.maxDelayMs).toBe(0);
  });

  it('floors a fractional attempt count', () => {
    expect(resolveRetryPolicy({ maxAttempts: 3.9 }).maxAttempts).toBe(3);
  });
});

describe('backoffDelayMs', () => {
  const policy: RetryPolicy = {
    maxAttempts: 5,
    baseDelayMs: 100,
    backoffFactor: 2,
    maxDelayMs: 1_000,
  };

  it('grows exponentially with the attempt index', () => {
    expect(backoffDelayMs(0, policy)).toBe(100);
    expect(backoffDelayMs(1, policy)).toBe(200);
    expect(backoffDelayMs(2, policy)).toBe(400);
    expect(backoffDelayMs(3, policy)).toBe(800);
  });

  it('caps the delay at maxDelayMs', () => {
    expect(backoffDelayMs(4, policy)).toBe(1_000); // 1600 capped to 1000
    expect(backoffDelayMs(10, policy)).toBe(1_000);
  });

  it('returns 0 for a negative index', () => {
    expect(backoffDelayMs(-1, policy)).toBe(0);
  });
});

describe('fanOutChannels', () => {
  const inApp: Channel = { type: 'in_app' };
  const email1: Channel = { type: 'email', target: 'a@x.io' };
  const email2: Channel = { type: 'email', target: 'b@x.io' };

  it('preserves exactly the configured channels in order', () => {
    expect(fanOutChannels([inApp, email1])).toEqual([inApp, email1]);
  });

  it('keeps distinct targets of the same channel type', () => {
    expect(fanOutChannels([email1, email2])).toEqual([email1, email2]);
  });

  it('de-duplicates byte-identical channel entries', () => {
    expect(fanOutChannels([email1, { type: 'email', target: 'a@x.io' }, email1])).toEqual([email1]);
  });

  it('does not mutate its input', () => {
    const input = [inApp, email1];
    const snapshot = JSON.stringify(input);
    fanOutChannels(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('shouldFallbackToInApp', () => {
  it('never falls back from a failed in-app channel to itself', () => {
    expect(shouldFallbackToInApp('in_app', true)).toBe(false);
  });

  it('falls back to in-app for other channels when in-app is healthy', () => {
    expect(shouldFallbackToInApp('email', true)).toBe(true);
    expect(shouldFallbackToInApp('whatsapp', true)).toBe(true);
  });

  it('skips the in-app fallback when in-app has already failed (Req 15.6)', () => {
    expect(shouldFallbackToInApp('email', false)).toBe(false);
    expect(shouldFallbackToInApp('whatsapp', false)).toBe(false);
  });
});

describe('isInAppFailure', () => {
  const base: ChannelDeliveryResult = {
    channel: 'in_app',
    status: 'failed',
    attempts: 3,
    viaFallback: false,
  };

  it('is true only for a failed in-app result', () => {
    expect(isInAppFailure(base)).toBe(true);
    expect(isInAppFailure({ ...base, status: 'delivered' })).toBe(false);
    expect(isInAppFailure({ ...base, channel: 'email' })).toBe(false);
  });
});
