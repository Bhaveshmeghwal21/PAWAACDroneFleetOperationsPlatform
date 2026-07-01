/**
 * Multi-channel dispatch orchestration (task 11.5, Requirement 15).
 *
 * `dispatch(alert, channels)` fans the alert out to *exactly* the channels
 * configured on its rule (Requirement 15.1 / property P37) and treats partial
 * delivery as success — the call never throws and always returns a per-channel
 * {@link DispatchResult}. On a channel failure it retries with exponential
 * backoff (Requirement 15.5), marks the channel failed, and falls back to an
 * in-app WebSocket push, while continuing the remaining channels. If the in-app
 * WebSocket channel has itself already failed during this dispatch, the WS
 * fallback is skipped and only the originally configured channels are retried
 * (Requirement 15.6).
 *
 * All transports are injected behind the {@link ChannelTransport} interface, and
 * both the backoff sleep and retry policy are injected, so the orchestration is
 * fully unit-testable with mock transports and a no-op delay. The pure decision
 * logic (fan-out set, backoff schedule, fallback rule) lives in
 * `dispatch.logic.ts`.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Alert, Channel, ChannelType } from '@pawaac/shared-types';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { failedChannelsKey } from '../../alerts/redis-keys';
import {
  EMAIL_TRANSPORT,
  IN_APP_TRANSPORT,
  WHATSAPP_TRANSPORT,
  type ChannelTransport,
} from '../transports/channel-transport';
import {
  backoffDelayMs,
  fanOutChannels,
  shouldFallbackToInApp,
  type RetryPolicy,
} from './dispatch.logic';
import type { ChannelDeliveryResult, DispatchResult } from './dispatch.types';

/** A sleep function; injected so tests can supply an instantaneous no-op. */
export type DelayFn = (ms: number) => Promise<void>;

/** DI token for the injected backoff sleep function. */
export const DISPATCH_DELAY = Symbol('DISPATCH_DELAY');

/** DI token for the injected per-channel retry policy. */
export const DISPATCH_RETRY_POLICY = Symbol('DISPATCH_RETRY_POLICY');

/** Minimal Redis surface used to record failed channels (best-effort). */
export interface FailedChannelRecorder {
  sadd(key: string, ...members: string[]): Promise<number>;
}

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);
  private readonly transports: Map<ChannelType, ChannelTransport>;

  constructor(
    @Inject(IN_APP_TRANSPORT) private readonly inApp: ChannelTransport,
    @Inject(EMAIL_TRANSPORT) email: ChannelTransport,
    @Inject(WHATSAPP_TRANSPORT) whatsapp: ChannelTransport,
    @Inject(DISPATCH_RETRY_POLICY) private readonly policy: RetryPolicy,
    @Inject(DISPATCH_DELAY) private readonly delay: DelayFn,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: FailedChannelRecorder,
  ) {
    this.transports = new Map<ChannelType, ChannelTransport>([
      [inApp.type, inApp],
      [email.type, email],
      [whatsapp.type, whatsapp],
    ]);
  }

  /**
   * Dispatch `alert` to exactly the configured `channels`, applying retry,
   * backoff and in-app fallback. Always resolves (partial delivery is success).
   */
  async dispatch(alert: Alert, channels: Channel[]): Promise<DispatchResult> {
    const targets = fanOutChannels(channels);
    const results: ChannelDeliveryResult[] = [];
    // In-app WebSocket is considered healthy until a delivery over it fails.
    let inAppHealthy = true;

    // Phase 1 — primary delivery to each configured channel, in order.
    for (const channel of targets) {
      const transport = this.transports.get(channel.type);
      let result: ChannelDeliveryResult;
      if (transport) {
        result = await this.deliver(transport, alert, channel, false);
      } else {
        // No transport registered for this channel type: treat as a failure
        // rather than silently dropping it.
        result = this.makeResult(channel.type, channel.target, 'failed', 0, false, {
          error: `no transport registered for channel "${channel.type}"`,
        });
      }
      results.push(result);
      if (result.status === 'failed') {
        await this.recordFailure(alert.id, channel.type);
        if (channel.type === 'in_app') {
          inAppHealthy = false;
        }
      }
    }

    // Phase 2 — in-app fallback for each failed (non-in-app) primary channel.
    const primaryFailures = results.filter((r) => r.status === 'failed' && !r.viaFallback);
    for (const failed of primaryFailures) {
      if (!shouldFallbackToInApp(failed.channel, inAppHealthy)) {
        if (failed.channel !== 'in_app') {
          this.logger.warn(
            `Skipping in-app fallback for failed channel "${failed.channel}" of alert ${alert.id}: in-app WebSocket has itself already failed`,
          );
        }
        continue;
      }
      const fallback = await this.deliver(this.inApp, alert, { type: 'in_app' }, true);
      results.push(fallback);
      if (fallback.status === 'failed') {
        inAppHealthy = false;
        await this.recordFailure(alert.id, 'in_app');
      }
    }

    const allDelivered = results.every((r) => r.status === 'delivered');
    if (!allDelivered) {
      this.logger.warn(
        `Alert ${alert.id} dispatched with partial delivery: ${results
          .filter((r) => r.status === 'failed')
          .map((r) => r.channel)
          .join(', ')} failed`,
      );
    }
    return { alertId: alert.id, results, allDelivered };
  }

  /**
   * Attempt delivery over a single transport with retry + exponential backoff.
   * Returns a delivered/failed result; never throws.
   */
  private async deliver(
    transport: ChannelTransport,
    alert: Alert,
    channel: Channel,
    viaFallback: boolean,
  ): Promise<ChannelDeliveryResult> {
    let attempts = 0;
    let lastError = 'unknown error';
    for (let attemptIndex = 0; attemptIndex < this.policy.maxAttempts; attemptIndex += 1) {
      attempts += 1;
      try {
        await transport.send(alert, channel);
        return this.makeResult(transport.type, channel.target, 'delivered', attempts, viaFallback);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const isFinalAttempt = attemptIndex === this.policy.maxAttempts - 1;
        if (!isFinalAttempt) {
          await this.delay(backoffDelayMs(attemptIndex, this.policy));
        }
      }
    }
    return this.makeResult(transport.type, channel.target, 'failed', attempts, viaFallback, {
      error: lastError,
    });
  }

  /** Build a delivery result, including optional fields only when present. */
  private makeResult(
    channel: ChannelType,
    target: string | undefined,
    status: 'delivered' | 'failed',
    attempts: number,
    viaFallback: boolean,
    extra?: { error?: string },
  ): ChannelDeliveryResult {
    return {
      channel,
      status,
      attempts,
      viaFallback,
      ...(target !== undefined ? { target } : {}),
      ...(extra?.error !== undefined ? { error: extra.error } : {}),
    };
  }

  /**
   * Best-effort record of a failed channel in Redis (design "channel-failure
   * marker" set). Never throws — a Redis hiccup must not turn partial delivery
   * into a dispatch failure.
   */
  private async recordFailure(alertId: string, channel: ChannelType): Promise<void> {
    if (!this.redis) {
      return;
    }
    try {
      await this.redis.sadd(failedChannelsKey(alertId), channel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `Could not record failed channel "${channel}" for alert ${alertId}: ${message}`,
      );
    }
  }
}
