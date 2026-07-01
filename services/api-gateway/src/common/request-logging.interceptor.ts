/**
 * Request-logging interceptor (Requirement 19.4).
 *
 * Logs one structured line per handled request that includes the HTTP method,
 * path, resolved response status, elapsed time, and — crucially — the request's
 * trace id (Requirement 34.3 / 19.4), so every log entry can be correlated with
 * upstream and client-side traces. Both success and error completions are logged
 * (the latter still carry the trace id, matching the RFC 7807 filter output).
 *
 * The line-formatting is factored into the pure {@link formatRequestLog} helper
 * so it can be unit-tested without standing up the Nest pipeline.
 */
import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { getTraceId } from './trace';

/** Fields captured for a single request log line. */
export interface RequestLogFields {
  method: string;
  path: string;
  status: number;
  traceId: string;
  durationMs: number;
}

/** Formats a request log line deterministically from its fields. */
export function formatRequestLog(fields: RequestLogFields): string {
  return (
    `${fields.method} ${fields.path} ${fields.status} ` +
    `${fields.durationMs}ms [trace=${fields.traceId}]`
  );
}

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Request');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const start = Date.now();

    const log = (status: number): void => {
      this.logger.log(
        formatRequestLog({
          method: req.method,
          path: req.originalUrl ?? req.url,
          status,
          traceId: getTraceId(req) ?? 'none',
          durationMs: Date.now() - start,
        }),
      );
    };

    return next.handle().pipe(
      tap({
        next: () => log(res.statusCode),
        // On error the status may not yet be set on the response; fall back to
        // the exception's status when present, else 500.
        error: (err: unknown) => log(statusFromError(err)),
      }),
    );
  }
}

/** Best-effort extraction of an HTTP status from a thrown error. */
function statusFromError(err: unknown): number {
  if (err && typeof err === 'object' && 'getStatus' in err) {
    const getStatus = (err as { getStatus: unknown }).getStatus;
    if (typeof getStatus === 'function') {
      const status = (getStatus as () => unknown).call(err);
      if (typeof status === 'number') {
        return status;
      }
    }
  }
  return 500;
}
