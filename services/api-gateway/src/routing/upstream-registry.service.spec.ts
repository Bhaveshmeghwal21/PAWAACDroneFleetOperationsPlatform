/**
 * Unit tests for {@link UpstreamRegistry} (Requirement 20.1, 20.2): resolving a
 * path to a concrete upstream target using environment base URLs.
 */
import { ConfigService } from '@nestjs/config';
import { UpstreamRegistry } from './upstream-registry.service';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

const FULL_ENV: Record<string, string> = {
  FLEET_REGISTRY_URL: 'http://fleet:3000',
  MISSION_PLANNING_URL: 'http://missions:3000/',
  TELEMETRY_INGESTION_URL: 'http://telemetry:3000',
  VISION_AI_URL: 'http://vision:8000',
  ALERT_NOTIFICATION_URL: 'http://alerts:3000',
};

describe('UpstreamRegistry.resolveTarget', () => {
  it('resolves a known path to its configured base URL', () => {
    const registry = new UpstreamRegistry(configWith(FULL_ENV));
    const target = registry.resolveTarget('/fleet/drones');
    expect(target?.definition.id).toBe('fleet-registry');
    expect(target?.baseUrl).toBe('http://fleet:3000');
  });

  it('trims a trailing slash from the configured base URL', () => {
    const registry = new UpstreamRegistry(configWith(FULL_ENV));
    expect(registry.resolveTarget('/missions/1')?.baseUrl).toBe('http://missions:3000');
  });

  it('returns undefined for an unknown path', () => {
    const registry = new UpstreamRegistry(configWith(FULL_ENV));
    expect(registry.resolveTarget('/nope')).toBeUndefined();
  });

  it('returns undefined when the matched upstream has no configured URL', () => {
    const registry = new UpstreamRegistry(configWith({ ...FULL_ENV, VISION_AI_URL: undefined }));
    expect(registry.resolveTarget('/vision/detections')).toBeUndefined();
    // Other upstreams remain resolvable.
    expect(registry.resolveTarget('/fleet/drones')?.baseUrl).toBe('http://fleet:3000');
  });

  it('exposes all definitions', () => {
    const registry = new UpstreamRegistry(configWith(FULL_ENV));
    expect(registry.allDefinitions.length).toBeGreaterThan(0);
  });
});
