/**
 * RFC 7807 `application/problem+json` error responses (Requirement 34.2).
 *
 * Every error path in the service responds with a problem document so that
 * operators and clients see a uniform, machine-readable error shape across all
 * platform services.
 */
import type { ServerResponse } from 'node:http';

/** Media type mandated by RFC 7807 for problem documents. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * A problem document as defined by RFC 7807. Additional members are permitted
 * by the spec and are carried through via the index signature.
 */
export interface ProblemDetails {
  /** A URI reference identifying the problem type. */
  readonly type: string;
  /** A short, human-readable summary of the problem type. */
  readonly title: string;
  /** The HTTP status code. */
  readonly status: number;
  /** A human-readable explanation specific to this occurrence. */
  readonly detail?: string;
  /** A URI reference identifying the specific occurrence. */
  readonly instance?: string;
  /** RFC 7807 permits arbitrary extension members. */
  readonly [key: string]: unknown;
}

/** Input for {@link createProblem}; `type` defaults to `about:blank`. */
export interface ProblemInput {
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly type?: string;
  readonly instance?: string;
}

/**
 * Construct a {@link ProblemDetails} document, defaulting `type` to the
 * RFC 7807 sentinel `about:blank` when not provided.
 */
export function createProblem(input: ProblemInput): ProblemDetails {
  const problem: Record<string, unknown> = {
    type: input.type ?? 'about:blank',
    title: input.title,
    status: input.status,
  };
  if (input.detail !== undefined) {
    problem.detail = input.detail;
  }
  if (input.instance !== undefined) {
    problem.instance = input.instance;
  }
  return problem as ProblemDetails;
}

/**
 * Serialize a problem document onto an HTTP response with the correct status
 * code, `application/problem+json` content type, and the resolved trace id
 * echoed back on the configured header.
 */
export function writeProblem(
  res: ServerResponse,
  problem: ProblemDetails,
  traceHeader: string,
  traceId: string,
): void {
  const body = JSON.stringify(problem);
  res.writeHead(problem.status, {
    'Content-Type': PROBLEM_CONTENT_TYPE,
    [traceHeader]: traceId,
  });
  res.end(body);
}
