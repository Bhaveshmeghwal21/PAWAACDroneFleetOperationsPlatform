import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { traceIdMiddleware } from './common/middleware/trace-id.middleware';

/** The header used to propagate the distributed trace id (Requirement 34.3). */
export const TRACE_HEADER = process.env['TRACE_HEADER'] ?? 'X-Trace-Id';

/**
 * Applies the cross-cutting HTTP concerns shared by the running service and the
 * e2e test harness: trace-id propagation, strict request validation, and the
 * RFC 7807 problem+json error filter.
 */
export function setupApp(app: INestApplication): void {
  app.use(traceIdMiddleware(TRACE_HEADER));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter(TRACE_HEADER));
}
