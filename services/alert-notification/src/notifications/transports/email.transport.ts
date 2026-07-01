/**
 * Email channel transport via Nodemailer (Requirement 15.3).
 *
 * The Nodemailer `Transporter` is injected (token {@link MAIL_TRANSPORTER}) so
 * production wiring can supply a real SMTP transport while tests supply a
 * Nodemailer test transport (e.g. `jsonTransport`) or a stub — no network or
 * real mailbox required.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import type { Alert, Channel } from '@pawaac/shared-types';
import { MAIL_TRANSPORTER, type ChannelTransport } from './channel-transport';

/** Renders the human-readable subject line for an alert email. */
export function emailSubject(alert: Alert): string {
  return `[${alert.severity.toUpperCase()}] Alert ${alert.id}`;
}

/** Renders the plain-text body for an alert email. */
export function emailBody(alert: Alert): string {
  return [
    `Alert ${alert.id}`,
    `Severity: ${alert.severity}`,
    `Status: ${alert.status}`,
    `Rule: ${alert.ruleId}`,
    `Escalation level: ${alert.escalationLevel}`,
    `Raised at: ${alert.createdAt}`,
  ].join('\n');
}

@Injectable()
export class EmailTransport implements ChannelTransport {
  readonly type = 'email' as const;

  constructor(
    @Inject(MAIL_TRANSPORTER) private readonly transporter: Transporter,
    private readonly from: string,
  ) {}

  /**
   * Send the alert by email. Requires a destination address on the channel; a
   * missing target is a configuration error and rejects so the dispatcher marks
   * the channel failed (Requirement 15.5).
   */
  async send(alert: Alert, channel: Channel): Promise<void> {
    const to = channel.target;
    if (!to || to.trim().length === 0) {
      throw new Error(`email channel for alert ${alert.id} has no target address`);
    }
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: emailSubject(alert),
      text: emailBody(alert),
    });
  }
}
