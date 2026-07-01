/**
 * Reverse-proxy forwarding to upstream services (Requirement 20.1, 20.2; and
 * trace propagation Requirement 19.3 — property P44).
 *
 * For each resolved {@link UpstreamTarget} this service lazily builds a
 * `http-proxy-middleware` proxy bound to the upstream base URL. When forwarding
 * it:
 * - strips the gateway path prefix (e.g. `/fleet/drones` → `/drones`) so the
 *   upstream sees its own native path,
 * - injects the downstream headers built by {@link buildDownstreamHeaders},
 *   guaranteeing a non-empty `X-Trace-Id` on every proxied request (P44), and
 * - returns `404` for any unknown path (Requirement 20.2).
 *
 * The pure path→upstream decision lives in {@link UpstreamRegistry}; this class
 * only owns the I/O of forwarding.
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  type NestMiddleware,
} from '@nestjs/common';
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware';
import type { Request, Response, NextFunction } from 'express';
import { buildDownstreamHeaders } from '../common/downstream-trace';
import { UpstreamRegistry } from './upstream-registry.service';
import type { UpstreamId, UpstreamTarget } from './upstreams';

@Injectable()
export class ProxyService implements NestMiddleware {
  private readonly logger = new Logger(ProxyService.name);
  /** One memoised proxy handler per upstream id. */
  private readonly proxies = new Map<UpstreamId, RequestHandler>();

  constructor(private readonly registry: UpstreamRegistry) {}

  /**
   * Express/Nest middleware entrypoint: resolve the upstream for the request
   * path and forward, or raise `404` for an unknown path.
   */
  use(req: Request, res: Response, next: NextFunction): void {
    this.forward(req, res, next);
  }

  /**
   * Forwards the request to its resolved upstream. Throws
   * {@link NotFoundException} (404) when the path maps to no upstream
   * (property P43 / Requirement 20.2).
   */
  forward(req: Request, res: Response, next: NextFunction): void {
    const target = this.registry.resolveTarget(req.path);
    if (target === undefined) {
      throw new NotFoundException(`No upstream route for ${req.method} ${req.path}`);
    }
    const proxy = this.proxyFor(target);
    proxy(req, res, next);
  }

  /** Builds (once) and returns the proxy handler for a target upstream. */
  private proxyFor(target: UpstreamTarget): RequestHandler {
    const { id, prefix } = { id: target.definition.id, prefix: target.definition.prefix };
    const existing = this.proxies.get(id);
    if (existing !== undefined) {
      return existing;
    }

    const handler = createProxyMiddleware({
      target: target.baseUrl,
      changeOrigin: true,
      // Strip the gateway-owned prefix so the upstream receives its native path.
      pathRewrite: (path: string): string => {
        const rewritten = path.replace(new RegExp(`^${escapeRegExp(prefix)}`), '');
        return rewritten.length === 0 ? '/' : rewritten;
      },
      // Inject the non-empty downstream trace id (and any base headers) — P44.
      onProxyReq: (proxyReq, req): void => {
        const headers = buildDownstreamHeaders(req as Request);
        for (const [name, value] of Object.entries(headers)) {
          proxyReq.setHeader(name, value);
        }
      },
      onError: (err, _req, res): void => {
        this.logger.error(`Proxy error to upstream '${id}': ${err.message}`);
        const response = res as Response;
        if (!response.headersSent) {
          response.status(502).json({
            type: 'about:blank',
            title: 'Bad Gateway',
            status: 502,
            detail: `Upstream '${id}' is unavailable`,
          });
        }
      },
      logLevel: 'silent',
    });

    this.proxies.set(id, handler);
    return handler;
  }
}

/** Escapes a string for safe use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
