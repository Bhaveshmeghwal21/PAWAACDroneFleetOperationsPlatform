/**
 * Unit tests for downstream trace-id propagation (Requirement 19.3 — design
 * property P44).
 *
 * Confirms the gateway always forwards a non-empty trace id, whether the inbound
 * request was annotated by the trace middleware, supplied an incoming header, or
 * neither.
 */
import type { Request } from 'express';
import { TRACE_HEADER, TRACE_ID_KEY } from './trace';
import { buildDownstreamHeaders, downstreamTraceId } from './downstream-trace';

function reqWith(overrides: Partial<Record<string, unknown>> & { headers?: Record<string, unknown> }): Request {
  return { headers: {}, ...overrides } as Request;
}

describe('downstreamTraceId', () => {
  it('uses the trace id resolved by the inbound middleware', () => {
    const req = reqWith({ [TRACE_ID_KEY]: 'trace-from-middleware' });
    expect(downstreamTraceId(req)).toBe('trace-from-middleware');
  });

  it('falls back to the incoming trace header when the middleware did not run', () => {
    const req = reqWith({ headers: { [TRACE_HEADER.toLowerCase()]: 'trace-from-client' } });
    expect(downstreamTraceId(req)).toBe('trace-from-client');
  });

  it('mints a non-empty trace id when none is present (P44)', () => {
    const req = reqWith({});
    const traceId = downstreamTraceId(req);
    expect(typeof traceId).toBe('string');
    expect(traceId.trim().length).toBeGreaterThan(0);
  });
});

describe('buildDownstreamHeaders', () => {
  it('injects a non-empty trace id under the trace header (P44)', () => {
    const req = reqWith({ [TRACE_ID_KEY]: 'abc-123' });
    const headers = buildDownstreamHeaders(req, { 'content-type': 'application/json' });
    expect(headers[TRACE_HEADER]).toBe('abc-123');
    expect(headers['content-type']).toBe('application/json');
  });

  it('overrides any trace header already present in the base headers', () => {
    const req = reqWith({ [TRACE_ID_KEY]: 'authoritative' });
    const headers = buildDownstreamHeaders(req, { [TRACE_HEADER]: 'stale' });
    expect(headers[TRACE_HEADER]).toBe('authoritative');
  });

  it('does not mutate the provided base headers', () => {
    const req = reqWith({ [TRACE_ID_KEY]: 'xyz' });
    const base = {};
    buildDownstreamHeaders(req, base);
    expect(base).toEqual({});
  });
});
