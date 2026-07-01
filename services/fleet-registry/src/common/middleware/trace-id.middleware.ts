import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Request augmented with the resolved distributed-trace identifier. */
export interface TracedRequest extends Request {
  traceId?: string;
}

/**
 * Express middleware that propagates a distributed trace identifier
 * (Requirement 34.3).
 *
 * It reads the configured trace header from the incoming request; if absent it
 * mints a fresh UUID. The resolved value is attached to the request (so error
 * responses can echo it) and written back on the response header so the trace
 * survives the full round-trip and onward calls.
 */
export function traceIdMiddleware(headerName: string) {
  const key = headerName.toLowerCase();
  return (req: TracedRequest, res: Response, next: NextFunction): void => {
    const incoming = req.headers[key];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    const traceId = candidate && candidate.trim().length > 0 ? candidate.trim() : randomUUID();
    req.traceId = traceId;
    res.setHeader(headerName, traceId);
    next();
  };
}
