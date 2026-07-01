import { createTransport, type Transporter } from 'nodemailer';
import type { Alert, Channel } from '@pawaac/shared-types';
import { EmailTransport, emailBody, emailSubject } from './email.transport';

/**
 * Unit tests for the Nodemailer email transport (task 11.5, Req 15.3). Uses
 * Nodemailer's built-in `jsonTransport` test transport so a real send is
 * exercised end-to-end without contacting any SMTP server.
 */

function buildAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: overrides.id ?? 'alert-1',
    ruleId: overrides.ruleId ?? 'rule-1',
    severity: overrides.severity ?? 'warning',
    status: overrides.status ?? 'OPEN',
    escalationLevel: overrides.escalationLevel ?? 0,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
  };
}

const emailChannel: Channel = { type: 'email', target: 'ops@pawaac.io' };

describe('emailSubject / emailBody', () => {
  it('renders an upper-cased severity subject', () => {
    expect(emailSubject(buildAlert({ id: 'a-9', severity: 'critical' }))).toBe(
      '[CRITICAL] Alert a-9',
    );
  });

  it('includes the key alert fields in the body', () => {
    const body = emailBody(buildAlert({ id: 'a-9', ruleId: 'r-2' }));
    expect(body).toContain('Alert a-9');
    expect(body).toContain('Rule: r-2');
    expect(body).toContain('Severity: warning');
  });
});

describe('EmailTransport', () => {
  it('sends via the Nodemailer test transport with the configured from/to', async () => {
    const transporter = createTransport({ jsonTransport: true });
    const sendSpy = jest.spyOn(transporter, 'sendMail');
    const transport = new EmailTransport(transporter, 'alerts@pawaac.local');

    await expect(transport.send(buildAlert(), emailChannel)).resolves.toBeUndefined();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const message = sendSpy.mock.calls[0]?.[0] as { from?: string; to?: string; subject?: string };
    expect(message.from).toBe('alerts@pawaac.local');
    expect(message.to).toBe('ops@pawaac.io');
    expect(message.subject).toContain('Alert alert-1');
  });

  it('rejects when the channel has no target address', async () => {
    const transporter = createTransport({ jsonTransport: true });
    const transport = new EmailTransport(transporter, 'alerts@pawaac.local');

    await expect(transport.send(buildAlert(), { type: 'email' })).rejects.toThrow(
      /no target address/,
    );
  });

  it('propagates a transporter send failure (so the dispatcher can retry)', async () => {
    const failing = {
      sendMail: jest.fn().mockRejectedValue(new Error('SMTP 421 service unavailable')),
    } as unknown as Transporter;
    const transport = new EmailTransport(failing, 'alerts@pawaac.local');

    await expect(transport.send(buildAlert(), emailChannel)).rejects.toThrow(/service unavailable/);
  });
});
