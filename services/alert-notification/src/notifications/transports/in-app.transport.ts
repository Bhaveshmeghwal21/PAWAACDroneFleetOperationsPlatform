/**
 * In-app WebSocket channel transport (Requirement 15.2).
 *
 * Pushes the raised alert to every connected Ops Dashboard subscriber via the
 * Socket.IO {@link AlertsGateway}. This transport doubles as the fallback medium
 * for the dispatcher (Requirement 15.5): a failed email/WhatsApp delivery falls
 * back to an in-app push, unless the in-app channel has itself already failed
 * (Requirement 15.6).
 */
import { Injectable } from '@nestjs/common';
import type { Alert, Channel } from '@pawaac/shared-types';
import { AlertsGateway } from '../alerts.gateway';
import type { ChannelTransport } from './channel-transport';

@Injectable()
export class InAppTransport implements ChannelTransport {
  readonly type = 'in_app' as const;

  constructor(private readonly gateway: AlertsGateway) {}

  /**
   * Broadcast the alert to connected subscribers. `broadcast` is synchronous;
   * we wrap it so any failure (e.g. the Socket.IO server not yet initialised)
   * surfaces as a rejected promise the dispatcher can treat as a channel
   * failure.
   */
  async send(alert: Alert, _channel: Channel): Promise<void> {
    this.gateway.broadcast(alert);
  }
}
