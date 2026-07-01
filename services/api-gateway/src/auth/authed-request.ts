/**
 * Express request augmented with the authenticated principal resolved by the
 * gateway's JWT guard, plus a helper to derive a {@link RouteMeta} from an
 * inbound request.
 */
import type { Request } from 'express';
import type { AuthContext } from '@pawaac/shared-types';
import type { RouteMeta } from './route-permissions';

/** A request that may have been annotated with an {@link AuthContext}. */
export type AuthedRequest = Request & { authContext?: AuthContext };

/**
 * Derives the {@link RouteMeta} (method + concrete request path, without query
 * string) used for the RBAC decision.
 *
 * The RBAC guard runs only on the reverse-proxy catch-all controller, whose
 * Express route is always a wildcard (e.g. `/fleet/*`); matching against that
 * pattern would never line up with the declarative permission table. We
 * therefore use the *concrete* request path here and let the authorization layer
 * resolve it to the matching permission pattern (including `:param` segments).
 */
export function resolveRouteMeta(req: Request): RouteMeta {
  const rawPath = req.path ?? req.url;
  const queryIndex = rawPath.indexOf('?');
  const path = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
  return { method: req.method, path };
}
