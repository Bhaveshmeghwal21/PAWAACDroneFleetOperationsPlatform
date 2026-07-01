/**
 * Unit tests for the request-logging interceptor (Requirement 19.4).
 *
 * Covers the pure {@link formatRequestLog} line format and verifies the
 * interceptor logs a line containing the trace id for both successful and
 * failing responses.
 */
import { lastValueFrom, of, throwError } from 'rxjs';
import { HttpException, HttpStatus, Logger, type CallHandler, type ExecutionContext } from '@nestjs/common';
import {
  RequestLoggingInterceptor,
  formatRequestLog,
} from './request-logging.interceptor';
import { TRACE_ID_KEY } from './trace';

describe('formatRequestLog', () => {
  it('renders method, path, status, duration and trace id', () => {
    const line = formatRequestLog({
      method: 'GET',
      path: '/fleet/drones',
      status: 200,
      traceId: 'trace-1',
      durationMs: 12,
    });
    expect(line).toBe('GET /fleet/drones 200 12ms [trace=trace-1]');
  });
});

function contextFor(): ExecutionContext {
  const req = { method: 'GET', originalUrl: '/x', url: '/x', [TRACE_ID_KEY]: 'trace-abc' };
  const res = { statusCode: 200 };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('RequestLoggingInterceptor', () => {
  it('logs the request with its trace id on success (19.4)', async () => {
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const interceptor = new RequestLoggingInterceptor();
    const next: CallHandler = { handle: () => of('ok') };

    await lastValueFrom(interceptor.intercept(contextFor(), next));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('[trace=trace-abc]');
    spy.mockRestore();
  });

  it('logs the request (with trace id and error status) when the handler throws', async () => {
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const interceptor = new RequestLoggingInterceptor();
    const next: CallHandler = {
      handle: () => throwError(() => new HttpException('nope', HttpStatus.TOO_MANY_REQUESTS)),
    };

    await expect(lastValueFrom(interceptor.intercept(contextFor(), next))).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain('429');
    expect(line).toContain('[trace=trace-abc]');
    spy.mockRestore();
  });
});
