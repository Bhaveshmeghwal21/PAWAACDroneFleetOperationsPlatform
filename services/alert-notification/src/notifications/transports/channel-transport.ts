/**
 * Channel transport abstraction (task 11.5, Requirement 15.2–15.4).
 *
 * Every delivery medium — in-app WebSocket, email (Nodemailer), WhatsApp
 * (OpenWA REST) — is hidden behind this single, narrow interface. The dispatcher
 * (`DispatchService`) depends only on `ChannelTransport`, never on Nodemailer or
 * axios directly, so the concrete transports are trivially mockable in unit
 * tests and swappable in production wiring.
 *
 * A transport's `send` MUST reject (throw) when delivery fails so the dispatcher
 * can apply its retry/backoff/fallback policy (Requirement 15.5/15.6); it MUST
 * resolve when the alert was handed off to the underlying medium successfully.
 */
import type { Alert, Channel, ChannelType } from '@pawaac/shared-types';

/** A single-medium delivery transport for raised alerts. */
export interface ChannelTransport {
  /** The channel type this transport serves (in_app | email | whatsapp). */
  readonly type: ChannelType;

  /**
   * Deliver `alert` over this transport using the (optional) destination
   * `target` carried by `channel`. Resolves on success; rejects on failure.
   */
  send(alert: Alert, channel: Channel): Promise<void>;
}

/** DI token for the in-app WebSocket transport. */
export const IN_APP_TRANSPORT = Symbol('IN_APP_TRANSPORT');

/** DI token for the email (Nodemailer) transport. */
export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT');

/** DI token for the WhatsApp (OpenWA REST) transport. */
export const WHATSAPP_TRANSPORT = Symbol('WHATSAPP_TRANSPORT');

/** DI token for the configured Nodemailer transporter instance. */
export const MAIL_TRANSPORTER = Symbol('MAIL_TRANSPORTER');

/** DI token for the configured OpenWA axios HTTP client. */
export const OPENWA_HTTP = Symbol('OPENWA_HTTP');
