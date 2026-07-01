import type { AxiosInstance } from 'axios';
import type { Alert, Channel } from '@pawaac/shared-types';
import { WhatsAppTransport, whatsappMessage } from './whatsapp.transport';

/**
 * Unit tests for the OpenWA WhatsApp transport (task 11.5, Req 15.4). The axios
 * client is mocked, so the OpenWA REST call is asserted on without any real HTTP
 * request.
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

const whatsappChannel: Channel = { type: 'whatsapp', target: '15550001111' };

/** Build a mock axios instance exposing only the `post` method the transport uses. */
function mockHttp(): { http: AxiosInstance; post: jest.Mock } {
  const post = jest.fn().mockResolvedValue({ status: 200, data: {} });
  return { http: { post } as unknown as AxiosInstance, post };
}

describe('whatsappMessage', () => {
  it('includes severity, status and rule in the message text', () => {
    const text = whatsappMessage(buildAlert({ id: 'a-3', ruleId: 'r-1' }));
    expect(text).toContain('*CRITICAL*');
    expect(text).toContain('a-3');
    expect(text).toContain('Rule: r-1');
  });
});

describe('WhatsAppTransport', () => {
  it('POSTs to the OpenWA /sendText endpoint with the target and message', async () => {
    const { http, post } = mockHttp();
    const transport = new WhatsAppTransport(http);

    await expect(transport.send(buildAlert(), whatsappChannel)).resolves.toBeUndefined();

    expect(post).toHaveBeenCalledTimes(1);
    const [url, payload] = post.mock.calls[0] as [string, { args: { to: string; content: string } }];
    expect(url).toBe('/sendText');
    expect(payload.args.to).toBe('15550001111');
    expect(payload.args.content).toContain('alert-1');
  });

  it('rejects when the channel has no target chat id', async () => {
    const { http, post } = mockHttp();
    const transport = new WhatsAppTransport(http);

    await expect(transport.send(buildAlert(), { type: 'whatsapp' })).rejects.toThrow(
      /no target chat id/,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('propagates an OpenWA HTTP error (so the dispatcher can retry)', async () => {
    const post = jest.fn().mockRejectedValue(new Error('Request failed with status code 502'));
    const transport = new WhatsAppTransport({ post } as unknown as AxiosInstance);

    await expect(transport.send(buildAlert(), whatsappChannel)).rejects.toThrow(/status code 502/);
  });
});
