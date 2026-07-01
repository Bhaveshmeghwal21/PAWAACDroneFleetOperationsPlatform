/**
 * Global exception filter that renders every error as an RFC 7807
 * `application/problem+json` body (Requirement 34.2) and includes the request's
 * trace id (Requirement 34.3).
 */
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getTraceId } from './trace';
import {
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
} from './problem-details';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, title, detail } = this.describe(exception);
    const traceId = getTraceId(request);

    const problem: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      ...(detail !== undefined ? { detail } : {}),
      instance: request.originalUrl,
      ...(traceId !== undefined ? { traceId } : {}),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${title} (${status}) [trace=${traceId ?? 'none'}]`, this.stackOf(exception));
    }

    response.status(status).type(PROBLEM_CONTENT_TYPE).json(problem);
  }

  private describe(exception: unknown): { status: number; title: string; detail?: string } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        return { status, title: this.titleFor(status), detail: body };
      }
      if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        const message = record['message'];
        const detail = Array.isArray(message)
          ? message.join(', ')
          : typeof message === 'string'
            ? message
            : undefined;
        const title = typeof record['error'] === 'string' ? record['error'] : this.titleFor(status);
        return detail !== undefined ? { status, title, detail } : { status, title };
      }
      return { status, title: this.titleFor(status) };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      title: this.titleFor(HttpStatus.INTERNAL_SERVER_ERROR),
      detail: 'An unexpected error occurred.',
    };
  }

  private titleFor(status: number): string {
    return HttpStatus[status] !== undefined
      ? String(HttpStatus[status]).replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
      : 'Error';
  }

  private stackOf(exception: unknown): string | undefined {
    return exception instanceof Error ? exception.stack : undefined;
  }
}
