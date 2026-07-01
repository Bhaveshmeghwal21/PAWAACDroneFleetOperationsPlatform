/**
 * Distributed trace-id propagation (Requirement 34.3).
 *
 * Every inbound request either carries a trace id in the configured trace
 * header or is assigned a freshly generated one. The resolved id is echoed back
 * on the response so callers and downstream services can correlate logs.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Resolve the trace id for a request: reuse the incoming value when present and
 * non-empty, otherwise mint a new UUID.
 */
export function resolveTraceId(headerValue: string | string[] | undefined): string {
  if (typeof headerValue === 'string') {
    const trimmed = headerValue.trim();
    if (trimmed !== '') {
      return trimmed;
    }
  } else if (Array.isArray(headerValue)) {
    const first = headerValue.find((value) => value.trim() !== '');
    if (first !== undefined) {
      return first.trim();
    }
  }
  return randomUUID();
}

/**
 * Read the trace id from a set of incoming headers using the configured (case
 * insensitive) header name.
 */
export function resolveTraceIdFromHeaders(
  headers: IncomingHttpHeaders,
  traceHeader: string,
): string {
  return resolveTraceId(headers[traceHeader.toLowerCase()]);
}
