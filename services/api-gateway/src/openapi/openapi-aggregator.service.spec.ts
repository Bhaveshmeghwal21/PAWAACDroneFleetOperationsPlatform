/**
 * Unit tests for {@link OpenApiAggregatorService} (Requirement 20.3) using an
 * in-memory fetcher so the merge is deterministic and network-free.
 */
import { ConfigService } from '@nestjs/config';
import { UpstreamRegistry } from '../routing/upstream-registry.service';
import { OpenApiAggregatorService } from './openapi-aggregator.service';
import type { UpstreamSpecFetcher } from './spec-fetcher';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: <T>(key: string): T | undefined => values[key] as T | undefined } as ConfigService;
}

describe('OpenApiAggregatorService', () => {
  it('fetches each configured upstream spec and merges them', async () => {
    const registry = new UpstreamRegistry(
      configWith({
        FLEET_REGISTRY_URL: 'http://fleet:3000',
        VISION_AI_URL: 'http://vision:8000',
      }),
    );

    const fetched: string[] = [];
    const fetcher: UpstreamSpecFetcher = {
      fetch: async (url: string) => {
        fetched.push(url);
        if (url.startsWith('http://fleet')) {
          return { openapi: '3.0.0', info: { title: 'Fleet', version: '1' }, paths: { '/drones': { get: {} } } };
        }
        if (url.startsWith('http://vision')) {
          return { openapi: '3.0.0', info: { title: 'Vision', version: '1' }, paths: { '/detections': { get: {} } } };
        }
        return null;
      },
    };

    const service = new OpenApiAggregatorService(registry, fetcher);
    const doc = await service.buildMergedDocument();

    // Only configured upstreams were fetched (at their spec paths).
    expect(fetched).toEqual(
      expect.arrayContaining(['http://fleet:3000/docs-json', 'http://vision:8000/openapi.json']),
    );
    expect(doc.paths['/fleet/drones']).toBeDefined();
    expect(doc.paths['/vision/detections']).toBeDefined();
  });

  it('omits upstreams that have no configured URL without failing', async () => {
    const registry = new UpstreamRegistry(configWith({ FLEET_REGISTRY_URL: 'http://fleet:3000' }));
    const fetcher: UpstreamSpecFetcher = {
      fetch: async () => ({
        openapi: '3.0.0',
        info: { title: 'Fleet', version: '1' },
        paths: { '/drones': { get: {} } },
      }),
    };
    const service = new OpenApiAggregatorService(registry, fetcher);
    const doc = await service.buildMergedDocument();
    expect(doc.paths['/fleet/drones']).toBeDefined();
    expect(doc.openapi).toBe('3.0.0');
  });
});
