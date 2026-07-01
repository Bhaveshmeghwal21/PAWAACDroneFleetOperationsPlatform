/**
 * Unit tests for the pure path→upstream routing resolver (Requirement 20.1,
 * 20.2 — design property P43: routing totality & disjointness). Exhaustive
 * property-based coverage lives in task 13.7; these are focused examples.
 */
import {
  assertDisjointPrefixes,
  findDefinition,
  normalizePath,
  pathHasPrefix,
  resolveUpstreamId,
  UPSTREAM_DEFINITIONS,
  UPSTREAM_IDS,
  type UpstreamDefinition,
} from './upstreams';

describe('normalizePath', () => {
  it('strips query strings and fragments', () => {
    expect(normalizePath('/fleet/drones?status=active')).toBe('/fleet/drones');
    expect(normalizePath('/fleet/drones#frag')).toBe('/fleet/drones');
  });

  it('strips a trailing slash but preserves the root', () => {
    expect(normalizePath('/fleet/')).toBe('/fleet');
    expect(normalizePath('/')).toBe('/');
  });

  it('adds a leading slash and treats empty input as root', () => {
    expect(normalizePath('fleet/drones')).toBe('/fleet/drones');
    expect(normalizePath('')).toBe('/');
  });
});

describe('pathHasPrefix', () => {
  it('matches the prefix itself and nested paths only', () => {
    expect(pathHasPrefix('/fleet', '/fleet')).toBe(true);
    expect(pathHasPrefix('/fleet/drones', '/fleet')).toBe(true);
    // A path that merely shares a textual prefix is NOT a route match.
    expect(pathHasPrefix('/fleethub', '/fleet')).toBe(false);
  });
});

describe('resolveUpstreamId (totality & disjointness, P43)', () => {
  it('maps each known prefix to exactly one upstream', () => {
    expect(resolveUpstreamId('/fleet/drones')).toBe('fleet-registry');
    expect(resolveUpstreamId('/missions/123')).toBe('mission-planning');
    expect(resolveUpstreamId('/telemetry/history')).toBe('telemetry-ingestion');
    expect(resolveUpstreamId('/vision/detections')).toBe('vision-ai');
    expect(resolveUpstreamId('/alerts/1/acknowledge')).toBe('alert-notification');
  });

  it('matches the bare prefix as well as nested paths', () => {
    expect(resolveUpstreamId('/fleet')).toBe('fleet-registry');
    expect(resolveUpstreamId('/fleet/')).toBe('fleet-registry');
  });

  it('resolves to a single upstream — never more than one matches', () => {
    for (const def of UPSTREAM_DEFINITIONS) {
      const matches = UPSTREAM_DEFINITIONS.filter((d) =>
        pathHasPrefix(`${def.prefix}/sub/resource`, d.prefix),
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.id).toBe(def.id);
    }
  });

  it('returns undefined for unknown paths (→ 404, Requirement 20.2)', () => {
    expect(resolveUpstreamId('/unknown')).toBeUndefined();
    expect(resolveUpstreamId('/')).toBeUndefined();
    expect(resolveUpstreamId('/health')).toBeUndefined();
    expect(resolveUpstreamId('/docs')).toBeUndefined();
    expect(resolveUpstreamId('/fleethub')).toBeUndefined();
  });
});

describe('UPSTREAM_DEFINITIONS integrity', () => {
  it('has one definition per declared upstream id', () => {
    expect(UPSTREAM_DEFINITIONS).toHaveLength(UPSTREAM_IDS.length);
    for (const id of UPSTREAM_IDS) {
      expect(findDefinition(id)).toBeDefined();
    }
  });

  it('has pairwise-disjoint prefixes', () => {
    expect(() => assertDisjointPrefixes()).not.toThrow();
  });

  it('detects a non-disjoint routing table', () => {
    const overlapping: UpstreamDefinition[] = [
      { id: 'fleet-registry', prefix: '/api', envVar: 'A_URL', title: 'A', specPath: '/s' },
      { id: 'mission-planning', prefix: '/api/v2', envVar: 'B_URL', title: 'B', specPath: '/s' },
    ];
    expect(() => assertDisjointPrefixes(overlapping)).toThrow(/disjoint/);
  });
});
