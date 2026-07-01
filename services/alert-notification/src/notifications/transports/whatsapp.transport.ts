/**
 * WhatsApp channel transport via the OpenWA REST gateway (Requirement 15.4).
 *
 * Delivery is a single POST to the OpenWA easy-api `/sendText` endpoint. The
 * axios instance is injected (token {@link OPENWA_HTTP}) with the base URL and
 * auth pre-configured, so unit tests inject a mocked axios client and assert on
 * the request without any real HTTP call.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { AxiosInstance } from 'axios';
import type { Alert, Channel } from '@pawaac/shared-types';
import { OPENWA_HTTP, type ChannelTransport } from './channel-transport';

/** Renders the WhatsApp message text for an alert. */
export function whatsappMessage(alert: Alert): string {
  return (
    `*${alert.severity.toUpperCase()}* alert ${alert.id}\n` +
    `Status: ${alert.status}\n` +
    `Rule: ${alert.ruleId}\n` +
    `Raised at: ${alert.createdAt}`
  );
}

@Injectable()
export class WhatsAppTransport implements ChannelTransport {
  readonly type = 'whatsapp' as const;

  constructor(@Inject(OPENWA_HTTP) private readonly http: AxiosInstance) {}

  /**
   * Send the alert via OpenWA. Requires a destination chat id on the channel; a
   * missing target rejects so the dispatcher marks the channel failed
   * (Requirement 15.5). A non-2xx response from OpenWA throws (axios default),
   * which is likewise treated as a channel failure.
   */
  async send(alert: Alert, channel: Channel): Promise<void> {
    const to = channel.target;
    if (!to || to.trim().length === 0) {
      throw new Error(`whatsapp channel for alert ${alert.id} has no target chat id`);
    }
    await this.http.post('/sendText', {
      args: { to, content: whatsappMessage(alert) },
    });
  }
}
