/**
 * Unit tests for {@link ProxyService}'s routing decision (Requirement 20.2): an
 * unknown path is rejected with `404` before any forwarding happens.
 */
import { NotFoundException } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { ProxyService } from './proxy.service';
import type { UpstreamRegistry } from './upstream-registry.service';

function fakeRegistry(resolve: () => ReturnType<UpstreamRegistry['resolveTarget']>): UpstreamRegistry {
  return { resolveTarget: jest.fn(resolve) } as unknown as UpstreamRegistry;
}

describe('ProxyService.forward', () => {
  const req = { method: 'GET', path: '/unknown' } as Request;
  const res = {} as Response;
  const next: NextFunction = jest.fn();

  it('throws 404 NotFound for a path that maps to no upstream', () => {
    const service = new ProxyService(fakeRegistry(() => undefined));
    expect(() => service.forward(req, res, next)).toThrow(NotFoundException);
    expect(next).not.toHaveBeenCalled();
  });
});
