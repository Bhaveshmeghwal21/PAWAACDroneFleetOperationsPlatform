/**
 * Distributed-trace identifier propagation (Requirement 34.3).
 *
 * Every inbound request must carry a trace id forward: if the caller supplied
 * one via the configured header (default `X-Trace-Id`) we honour it, otherwise
 * we mint a fresh one. The id is attached to the request object (so downstream
 * handlers and the error filter can read it) and echoed back on the response so
 * a client can correlate its call with server-side logs.
 */
import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

/** Header used to carry the trace id; overridable via `TRACE_HEADER`. */
export const TRACE_HEADER = process.env.TRACE_HEADER ?? 'X-Trace-Id';

/** Property name under which the resolved trace id is stashed on the request. */
export const TRACE_ID_KEY = 'traceId';

/** Reads an existing trace id from the request or generates a new one. */
export function resolveTraceId(req: Request): string {
  const incoming = req.headers[TRACE_HEADER.toLowerCase()];
  if (typeof incoming === 'string' && incoming.trim().length > 0) {
    return incoming;
  }
  if (Array.isArray(incoming) && incoming.length > 0 && incoming[0]) {
    return incoming[0];
  }
  return randomUUID();
}

/** Returns the trace id previously resolved for this request, if any. */
export function getTraceId(req: Request): string | undefined {
  const value = (req as Request & Record<string, unknown>)[TRACE_ID_KEY];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Express-style handler that resolves and propagates the trace id. Exported on
 * its own so it can be reused directly (e.g. in tests via `app.use`).
 */
export function traceIdHandler(req: Request, res: Response, next: NextFunction): void {
  const traceId = resolveTraceId(req);
  (req as Request & Record<string, unknown>)[TRACE_ID_KEY] = traceId;
  res.setHeader(TRACE_HEADER, traceId);
  next();
}

/** NestJS middleware wrapper around {@link traceIdHandler}. */
@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    traceIdHandler(req, res, next);
  }
}
