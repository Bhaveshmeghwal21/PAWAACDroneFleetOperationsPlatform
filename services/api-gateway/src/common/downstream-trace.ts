/**
 * Trace-id propagation into downstream/proxied requests (Requirement 19.3 —
 * design property P44).
 *
 * Building on the inbound {@link TraceIdMiddleware} (which resolves or mints a
 * trace id and stashes it on the request), this module derives the header set
 * the gateway must attach when it proxies a request to an upstream service. The
 * key guarantee — captured here as a **pure, testable function** so task 13.5's
 * property tests can quantify P44 — is that the forwarded headers always carry a
 * **non-empty** trace id, whether the inbound request supplied one or not.
 */
import type { Request } from 'express';
import { getTraceId, resolveTraceId, TRACE_HEADER } from './trace';

/** An outbound header map for a downstream request. */
export type OutboundHeaders = Record<string, string>;

/**
 * Returns the trace id to forward downstream for a request: the one resolved by
 * the inbound middleware if present, otherwise a freshly resolved/minted id.
 * Guaranteed non-empty.
 */
export function downstreamTraceId(req: Request): string {
  const existing = getTraceId(req);
  if (typeof existing === 'string' && existing.trim().length > 0) {
    return existing;
  }
  // Defensive fallback: if the middleware did not run (e.g. a direct proxy
  // path), resolve/mint one now so we never forward an empty trace id.
  return resolveTraceId(req);
}

/**
 * Builds the header set for a downstream request by copying `base` and injecting
 * the (non-empty) trace id under the configured trace header. The trace header
 * always wins over any value already present in `base`.
 *
 * @param req  the inbound gateway request
 * @param base headers to start from (e.g. selected inbound headers); defaults to
 *             an empty map. Not mutated.
 */
export function buildDownstreamHeaders(req: Request, base: OutboundHeaders = {}): OutboundHeaders {
  return { ...base, [TRACE_HEADER]: downstreamTraceId(req) };
}
