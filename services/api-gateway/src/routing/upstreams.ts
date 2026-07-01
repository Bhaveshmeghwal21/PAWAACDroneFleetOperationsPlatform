/**
 * Upstream service registry and the **pure** path-to-upstream routing resolver
 * (Requirement 20.1, 20.2 — design property P43: routing totality &
 * disjointness).
 *
 * The gateway fronts five domain backend services. Every public API path is
 * owned by exactly one of them, distinguished by a leading path prefix
 * (`/fleet`, `/missions`, `/telemetry`, `/vision`, `/alerts`). The prefixes are
 * pairwise disjoint (none is a prefix of another), so {@link resolveUpstreamId}
 * maps any known path to **exactly one** upstream and returns `undefined` for
 * any unknown path — the runtime forwarding layer renders that `undefined` as a
 * `404` (Requirement 20.2).
 *
 * This module is deliberately free of NestJS/HTTP/Redis dependencies so the
 * resolver can be unit- and property-tested in isolation (task 13.7 quantifies
 * P43 over generated paths).
 */

/** Canonical identifiers for the five upstream domain services. */
export const UPSTREAM_IDS = [
  'fleet-registry',
  'mission-planning',
  'telemetry-ingestion',
  'vision-ai',
  'alert-notification',
] as const;

/** Union of the known upstream service identifiers. */
export type UpstreamId = (typeof UPSTREAM_IDS)[number];

/**
 * Static metadata describing how the gateway reaches one upstream service:
 * the gateway-facing path `prefix` it owns, the environment variable holding
 * its base URL, a human-readable `title`, and the path on the upstream where its
 * OpenAPI document is served (used by the merged-OpenAPI aggregator).
 */
export interface UpstreamDefinition {
  /** Stable upstream identifier. */
  readonly id: UpstreamId;
  /** Gateway path prefix owned by this upstream, without a trailing slash. */
  readonly prefix: string;
  /** Environment variable holding the upstream base URL. */
  readonly envVar: string;
  /** Human-readable service title (used in the merged OpenAPI document). */
  readonly title: string;
  /** Path on the upstream that serves its OpenAPI 3.0 JSON document. */
  readonly specPath: string;
}

/**
 * The gateway's routing table: each known path prefix maps to exactly one
 * upstream. The prefixes are pairwise disjoint (verified by
 * {@link assertDisjointPrefixes}), which is what makes {@link resolveUpstreamId}
 * a total, single-valued function over the path space (property P43).
 */
export const UPSTREAM_DEFINITIONS: readonly UpstreamDefinition[] = [
  {
    id: 'fleet-registry',
    prefix: '/fleet',
    envVar: 'FLEET_REGISTRY_URL',
    title: 'Fleet Registry',
    specPath: '/docs-json',
  },
  {
    id: 'mission-planning',
    prefix: '/missions',
    envVar: 'MISSION_PLANNING_URL',
    title: 'Mission Planning',
    specPath: '/docs-json',
  },
  {
    id: 'telemetry-ingestion',
    prefix: '/telemetry',
    envVar: 'TELEMETRY_INGESTION_URL',
    title: 'Telemetry Ingestion',
    specPath: '/docs-json',
  },
  {
    id: 'vision-ai',
    prefix: '/vision',
    envVar: 'VISION_AI_URL',
    title: 'Vision AI Results',
    // FastAPI serves its schema at /openapi.json by default.
    specPath: '/openapi.json',
  },
  {
    id: 'alert-notification',
    prefix: '/alerts',
    envVar: 'ALERT_NOTIFICATION_URL',
    title: 'Alert & Notification',
    specPath: '/docs-json',
  },
];

/** A resolved forwarding target: an upstream and the base URL to proxy to. */
export interface UpstreamTarget {
  /** The matched upstream definition. */
  readonly definition: UpstreamDefinition;
  /** The upstream base URL (origin) requests are proxied to. */
  readonly baseUrl: string;
}

/**
 * Normalises a raw request path for routing: strips any query string / fragment
 * and any trailing slash (except for the root), and guarantees a single leading
 * slash. Returns `/` for empty input.
 */
export function normalizePath(rawPath: string): string {
  let path = rawPath;
  const queryIndex = path.search(/[?#]/);
  if (queryIndex >= 0) {
    path = path.slice(0, queryIndex);
  }
  if (path.length === 0) {
    return '/';
  }
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  // Collapse a trailing slash so '/fleet/' matches the '/fleet' prefix.
  if (path.length > 1 && path.endsWith('/')) {
    path = path.replace(/\/+$/, '');
  }
  return path.length === 0 ? '/' : path;
}

/** True iff `path` is owned by `prefix` (equal to it or nested beneath it). */
export function pathHasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Resolves a request path to the single upstream that owns it, or `undefined`
 * when no known prefix matches (unknown path → 404).
 *
 * Totality & disjointness (P43): because the prefixes in `definitions` are
 * pairwise disjoint, at most one can match, so the result is single-valued; an
 * unmatched path yields `undefined`.
 */
export function resolveUpstreamId(
  rawPath: string,
  definitions: readonly UpstreamDefinition[] = UPSTREAM_DEFINITIONS,
): UpstreamId | undefined {
  const path = normalizePath(rawPath);
  for (const def of definitions) {
    if (pathHasPrefix(path, def.prefix)) {
      return def.id;
    }
  }
  return undefined;
}

/** Looks up a definition by id, or `undefined` when unknown. */
export function findDefinition(
  id: UpstreamId,
  definitions: readonly UpstreamDefinition[] = UPSTREAM_DEFINITIONS,
): UpstreamDefinition | undefined {
  return definitions.find((d) => d.id === id);
}

/**
 * Verifies that no prefix in `definitions` is a path-prefix of another — the
 * structural precondition for {@link resolveUpstreamId} to be single-valued
 * (property P43 disjointness). Throws when the invariant is violated so the
 * misconfiguration fails fast at startup / in tests.
 */
export function assertDisjointPrefixes(
  definitions: readonly UpstreamDefinition[] = UPSTREAM_DEFINITIONS,
): void {
  for (let i = 0; i < definitions.length; i++) {
    const a = definitions[i];
    if (a === undefined) {
      continue;
    }
    for (let j = 0; j < definitions.length; j++) {
      if (i === j) {
        continue;
      }
      const b = definitions[j];
      if (b === undefined) {
        continue;
      }
      if (a.prefix === b.prefix || pathHasPrefix(a.prefix, b.prefix)) {
        throw new Error(
          `Upstream routing prefixes must be disjoint, but '${a.prefix}' (${a.id}) ` +
            `overlaps '${b.prefix}' (${b.id})`,
        );
      }
    }
  }
}
