import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/** RFC 7807 problem+json document shape. */
export interface ProblemDetails {
  /** A URI reference identifying the problem type. */
  type: string;
  /** A short, human-readable summary of the problem type. */
  title: string;
  /** The HTTP status code. */
  status: number;
  /** A human-readable explanation specific to this occurrence. */
  detail?: string;
  /** A URI reference identifying the specific occurrence (the request path). */
  instance?: string;
  /** The distributed trace identifier for correlation. */
  traceId?: string;
  /** Optional field-level validation errors. */
  errors?: unknown;
}

/**
 * Global exception filter that renders every error as an RFC 7807
 * `application/problem+json` body (Requirement 34.2) and echoes the request's
 * trace identifier (Requirement 34.3).
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly traceHeader: string) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { traceId?: string }>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const { title, detail, errors } = this.describe(exception, status);
    const headerTrace = req.header(this.traceHeader) ?? undefined;
    const traceId = req.traceId ?? headerTrace;

    const problem: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      instance: req.originalUrl,
      ...(detail !== undefined ? { detail } : {}),
      ...(errors !== undefined ? { errors } : {}),
      ...(traceId !== undefined ? { traceId } : {}),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${req.method} ${req.originalUrl} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.setHeader('Content-Type', 'application/problem+json');
    res.status(status).json(problem);
  }

  private describe(
    exception: unknown,
    status: number,
  ): { title: string; detail?: string; errors?: unknown } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return { title: exception.name, detail: response };
      }
      if (typeof response === 'object' && response !== null) {
        const body = response as Record<string, unknown>;
        const message = body['message'];
        const title = typeof body['error'] === 'string' ? body['error'] : exception.name;
        if (Array.isArray(message)) {
          return { title, detail: 'Validation failed', errors: message };
        }
        if (typeof message === 'string') {
          return { title, detail: message };
        }
        return { title };
      }
      return { title: exception.name };
    }

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      return { title: 'Internal Server Error' };
    }
    return { title: 'Error' };
  }
}
