import type { Response } from 'express';
import {
  type TracedRequest,
  traceIdMiddleware,
} from '../src/common/middleware/trace-id.middleware';

const HEADER = 'X-Trace-Id';

interface Harness {
  req: TracedRequest;
  setHeaders: Record<string, string>;
  next: jest.Mock;
}

function run(headers: Record<string, string | string[] | undefined> = {}): Harness {
  const setHeaders: Record<string, string> = {};
  const req = { headers } as unknown as TracedRequest;
  const res = {
    setHeader: (name: string, value: string | number | readonly string[]): Response => {
      setHeaders[name] = String(value);
      return res;
    },
  } as unknown as Response;
  const next = jest.fn();

  traceIdMiddleware(HEADER)(req, res, next);

  return { req, setHeaders, next };
}

describe('traceIdMiddleware', () => {
  it('generates a trace id when none is supplied and calls next (Req 34.3)', () => {
    const { req, setHeaders, next } = run();

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.traceId).toBeDefined();
    expect(setHeaders[HEADER]).toBe(req.traceId);
    expect(String(setHeaders[HEADER]).length).toBeGreaterThan(0);
  });

  it('propagates an inbound trace id unchanged (Req 34.3)', () => {
    const { req, setHeaders } = run({ 'x-trace-id': 'inbound-trace-42' });

    expect(req.traceId).toBe('inbound-trace-42');
    expect(setHeaders[HEADER]).toBe('inbound-trace-42');
  });

  it('mints a fresh id when the inbound header is blank', () => {
    const { req } = run({ 'x-trace-id': '   ' });

    expect(req.traceId).toBeDefined();
    expect(req.traceId?.trim().length ?? 0).toBeGreaterThan(0);
  });
});
