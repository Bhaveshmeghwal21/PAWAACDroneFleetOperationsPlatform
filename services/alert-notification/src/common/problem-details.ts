/**
 * RFC 7807 `application/problem+json` representation (Requirement 34.2).
 *
 * A problem detail is a machine-readable description of an error that every
 * PAWAAC service returns in a uniform shape so operators and clients can handle
 * failures consistently.
 */

/** Media type mandated by RFC 7807 for problem responses. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** A single RFC 7807 problem document. */
export interface ProblemDetails {
  /** URI reference identifying the problem type. */
  type: string;
  /** Short, human-readable summary of the problem type. */
  title: string;
  /** HTTP status code generated for this occurrence. */
  status: number;
  /** Human-readable explanation specific to this occurrence. */
  detail?: string;
  /** URI reference identifying the specific occurrence (here: the request path). */
  instance?: string;
  /** Trace id correlating this error with server-side logs (Requirement 34.3). */
  traceId?: string;
}
