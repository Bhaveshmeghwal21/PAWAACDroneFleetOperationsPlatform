import { describe, expect, it, vi } from 'vitest';
import type { Drone } from '@pawaac/shared-types';

import { ApiError, GatewayApiClient } from './api-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GatewayApiClient', () => {
  it('builds the correct URL and parses a typed JSON response', async () => {
    const drones: Drone[] = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        serialNumber: 'SN-1',
        model: 'X',
        firmwareVersion: '1.0.0',
        hardwareConfig: {},
        status: 'active',
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(drones));
    const client = new GatewayApiClient('http://gw.test', fetchMock);

    const result = await client.listDrones();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gw.test/api/drones');
    expect(result).toEqual(drones);
  });

  it('serializes a JSON body and sets the content-type on writes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'm1' }, 200));
    const client = new GatewayApiClient('http://gw.test', fetchMock);

    await client.submitMission({ name: 'Patrol', waypoints: [] });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'Patrol', waypoints: [] }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('appends defined query parameters and omits undefined ones', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = new GatewayApiClient('http://gw.test', fetchMock);

    await client.queryDetections({ from: 100, to: 200 });

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('from=100');
    expect(calledUrl).toContain('to=200');
    expect(calledUrl).not.toContain('droneId');
  });

  it('throws a typed ApiError carrying the problem+json body on failure', async () => {
    const problem = { title: 'Not Found', status: 404 };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(problem, 404));
    const client = new GatewayApiClient('http://gw.test', fetchMock);

    await expect(client.getDrone('missing')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
    });

    fetchMock.mockResolvedValue(jsonResponse(problem, 404));
    const error = await client.getDrone('missing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).problem?.title).toBe('Not Found');
  });

  it('returns undefined for 204 No Content responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new GatewayApiClient('http://gw.test', fetchMock);

    const result = await client.request<void>('/api/noop', { method: 'POST' });
    expect(result).toBeUndefined();
  });
});
