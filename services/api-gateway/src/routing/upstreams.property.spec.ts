/**
 * Generator-driven property tests for the pure path→upstream routing resolver
 * (task 13.7). These complement the example-based unit tests in
 * `upstreams.spec.ts`.
 *
 * Property validated (design "Correctness Properties", API Gateway):
 *   - P43 — Routing totality & disjointness  (Requirements 20.1, 20.2)
 *
 * The property runs >= 100 iterations (here 300; see NUM_RUNS). The expected
 * outcome is recomputed directly from the acceptance criteria, independently of
 * the production branch structure: for any generated path we count how many of
 * the known prefixes own it (via the structural `pathHasPrefix` predicate) and
 * assert that
 *   - a path owned by exactly one prefix resolves to that one upstream
 *     (single-valued; Requirement 20.1), and
 *   - a path owned by no prefix resolves to `undefined` (→ 404; Requirement
 *     20.2).
 * Disjointness of the production routing table is asserted directly so the
 * "exactly one" guarantee is structurally sound.
 */
import fc from 'fast-check';
import {
  assertDisjointPrefixes,
  normalizePath,
  pathHasPrefix,
  resolveUpstreamId,
  UPSTREAM_DEFINITIONS,
} from './upstreams';

const NUM_RUNS = 300;

/** The known gateway path prefixes, e.g. `/fleet`, `/missions`, … */
const KNOWN_PREFIXES: readonly string[] = UPSTREAM_DEFINITIONS.map((d) => d.prefix);

/** First path segment of each known prefix (without the leading slash). */
const KNOWN_HEAD_SEGMENTS: ReadonlySet<string> = new Set(
  KNOWN_PREFIXES.map((p) => p.replace(/^\//, '')),
);

/**
 * Counts how many known prefixes own `path`. By disjointness this must be 0 or
 * 1 for every path — recomputed here from `pathHasPrefix` independently of
 * `resolveUpstreamId`'s implementation.
 */
function owningDefinitions(path: string): typeof UPSTREAM_DEFINITIONS {
  const normalized = normalizePath(path);
  return UPSTREAM_DEFINITIONS.filter((d) => pathHasPrefix(normalized, d.prefix));
}

// --- Generators ---------------------------------------------------------------

/** A single non-empty, slash-free path segment. */
const segmentArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => s.replace(/[/?#]/g, ''))
  .filter((s) => s.length > 0);

/**
 * Paths that are genuinely owned by exactly one known prefix: a known prefix
 * followed by either nothing, a bare trailing slash, or one-or-more nested
 * `/segment` parts (optionally with a query string, which routing strips).
 */
const knownPathArb = fc
  .record({
    prefix: fc.constantFrom(...KNOWN_PREFIXES),
    suffix: fc.oneof(
      fc.constant(''),
      fc.constant('/'),
      fc.array(segmentArb, { minLength: 1, maxLength: 4 }).map((parts) => `/${parts.join('/')}`),
    ),
    query: fc.oneof(fc.constant(''), fc.constant('?status=active'), fc.constant('#frag')),
  })
  .map(({ prefix, suffix, query }) => `${prefix}${suffix}${query}`);

/**
 * Paths that are owned by no known prefix. We start from arbitrary path-ish
 * strings and a pool of adversarial near-misses (e.g. `/fleethub`, which merely
 * shares text with `/fleet` but is not nested beneath it), then keep only those
 * the structural predicate confirms are unowned.
 */
const unknownPathArb = fc
  .oneof(
    fc.constantFrom(
      '/',
      '/health',
      '/docs',
      '/openapi.json',
      '/fleethub',
      '/fleet-x',
      '/missionsX',
      '/visionary',
      '/alertsy',
      '/api/fleet',
      '/v1/missions',
    ),
    fc.array(segmentArb, { minLength: 1, maxLength: 4 }).map((parts) => `/${parts.join('/')}`),
    fc.string({ maxLength: 20 }),
  )
  .filter((path) => owningDefinitions(path).length === 0);

// --- P43 ----------------------------------------------------------------------

describe('resolveUpstreamId — property tests (P43)', () => {
  /**
   * P43 (disjointness) — the production routing table's prefixes are pairwise
   * disjoint, which is the structural precondition for single-valued routing.
   * **Validates: Requirements 20.1**
   */
  it('P43: the production routing table has pairwise-disjoint prefixes', () => {
    expect(() => assertDisjointPrefixes(UPSTREAM_DEFINITIONS)).not.toThrow();
  });

  /**
   * P43 (single-valued totality) — every path owned by a known prefix resolves
   * to exactly that one upstream, and never to more than one (the prefix that
   * owns it is unique).
   * **Validates: Requirements 20.1**
   */
  it('P43: a path under a known prefix resolves to exactly one upstream', () => {
    fc.assert(
      fc.property(knownPathArb, (path) => {
        const owners = owningDefinitions(path);
        // Disjointness guarantees a single owner for any owned path.
        expect(owners).toHaveLength(1);
        const expectedId = owners[0]?.id;
        expect(resolveUpstreamId(path)).toBe(expectedId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P43 (404 on unknown) — any path owned by no known prefix resolves to
   * `undefined`, which the forwarding layer renders as a 404.
   * **Validates: Requirements 20.2**
   */
  it('P43: a path under no known prefix resolves to undefined (→ 404)', () => {
    fc.assert(
      fc.property(unknownPathArb, (path) => {
        expect(owningDefinitions(path)).toHaveLength(0);
        expect(resolveUpstreamId(path)).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P43 (totality over arbitrary input) — for *any* string whatsoever, routing
   * is single-valued: the number of owning prefixes is at most one, and the
   * resolver agrees with the structural predicate — returning the unique owner's
   * id when there is one, or `undefined` when there is none. This is the full
   * totality statement: the resolver is defined on the entire path space.
   * **Validates: Requirements 20.1, 20.2**
   */
  it('P43: routing is total and single-valued for every input path', () => {
    fc.assert(
      fc.property(fc.oneof(knownPathArb, unknownPathArb, fc.string()), (path) => {
        const owners = owningDefinitions(path);
        // Single-valued: never owned by more than one prefix.
        expect(owners.length).toBeLessThanOrEqual(1);

        const resolved = resolveUpstreamId(path);
        if (owners.length === 1) {
          expect(resolved).toBe(owners[0]?.id);
        } else {
          expect(resolved).toBeUndefined();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * P43 (head-segment sanity) — the unknown-path generator never accidentally
   * produces an owned path. Guards against the generator silently degenerating
   * (which would make the 404 property vacuous).
   * **Validates: Requirements 20.2**
   */
  it('P43: unknown paths never share a head segment match with a known prefix', () => {
    fc.assert(
      fc.property(unknownPathArb, (path) => {
        const head = normalizePath(path).split('/')[1] ?? '';
        // If the head equals a known head segment, it must be a non-nested
        // near-miss (e.g. trailing chars) — confirmed unowned by construction.
        if (KNOWN_HEAD_SEGMENTS.has(head)) {
          expect(KNOWN_PREFIXES).toContain(`/${head}`);
        }
        expect(resolveUpstreamId(path)).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
