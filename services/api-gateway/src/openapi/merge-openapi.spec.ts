/**
 * Unit tests for the pure merged-OpenAPI builder (Requirement 20.3): path
 * re-basing under gateway prefixes, schema namespacing with `$ref` rewriting,
 * and skipping of unavailable upstreams.
 */
import {
  joinPath,
  mergeOpenApiDocuments,
  rewriteSchemaRefs,
  schemaNamespace,
  type UpstreamSpecInput,
} from './merge-openapi';

describe('schemaNamespace', () => {
  it('PascalCases a kebab/snake upstream id', () => {
    expect(schemaNamespace('fleet-registry')).toBe('FleetRegistry');
    expect(schemaNamespace('vision_ai')).toBe('VisionAi');
  });
});

describe('joinPath', () => {
  it('joins prefix and path without doubling slashes', () => {
    expect(joinPath('/fleet', '/drones')).toBe('/fleet/drones');
    expect(joinPath('/fleet', 'drones')).toBe('/fleet/drones');
    expect(joinPath('/fleet', '/')).toBe('/fleet');
  });
});

describe('rewriteSchemaRefs', () => {
  it('rewrites only local schema refs that are renamed', () => {
    const node = {
      a: { $ref: '#/components/schemas/Drone' },
      b: { $ref: '#/components/schemas/Other' },
      c: { $ref: '#/components/responses/Foo' },
    };
    const out = rewriteSchemaRefs(node, new Map([['Drone', 'FleetRegistry_Drone']])) as typeof node;
    expect(out.a.$ref).toBe('#/components/schemas/FleetRegistry_Drone');
    expect(out.b.$ref).toBe('#/components/schemas/Other');
    expect(out.c.$ref).toBe('#/components/responses/Foo');
  });

  it('does not mutate the input', () => {
    const node = { $ref: '#/components/schemas/Drone' };
    rewriteSchemaRefs(node, new Map([['Drone', 'X_Drone']]));
    expect(node.$ref).toBe('#/components/schemas/Drone');
  });
});

const fleetDoc = {
  openapi: '3.0.0',
  info: { title: 'Fleet Registry', version: '1.0.0' },
  paths: {
    '/drones': {
      get: {
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Drone' } } } },
        },
      },
    },
  },
  components: { schemas: { Drone: { type: 'object', properties: { id: { type: 'string' } } } } },
};

const visionDoc = {
  openapi: '3.0.0',
  info: { title: 'Vision AI', version: '1.0.0' },
  paths: { '/detections': { get: { responses: { '200': { description: 'ok' } } } } },
  components: { schemas: { Detection: { type: 'object' } } },
};

describe('mergeOpenApiDocuments', () => {
  const inputs: UpstreamSpecInput[] = [
    { id: 'fleet-registry', title: 'Fleet Registry', prefix: '/fleet', doc: fleetDoc },
    { id: 'vision-ai', title: 'Vision AI', prefix: '/vision', doc: visionDoc },
  ];

  it('produces a valid OpenAPI 3.0 envelope', () => {
    const merged = mergeOpenApiDocuments(inputs);
    expect(merged.openapi).toBe('3.0.0');
    expect(merged.info.title).toContain('API Gateway');
    expect(merged.info.version).toBeDefined();
  });

  it('re-bases upstream paths under their gateway prefix', () => {
    const merged = mergeOpenApiDocuments(inputs);
    expect(Object.keys(merged.paths)).toEqual(
      expect.arrayContaining(['/fleet/drones', '/vision/detections']),
    );
    expect(merged.paths['/drones']).toBeUndefined();
  });

  it('namespaces schemas and rewrites their refs', () => {
    const merged = mergeOpenApiDocuments(inputs);
    expect(merged.components?.schemas?.['FleetRegistry_Drone']).toBeDefined();
    expect(merged.components?.schemas?.['VisionAi_Detection']).toBeDefined();

    const ref = (
      merged.paths['/fleet/drones']?.get?.responses?.['200'] as unknown as {
        content: { 'application/json': { schema: { $ref: string } } };
      }
    ).content['application/json'].schema.$ref;
    expect(ref).toBe('#/components/schemas/FleetRegistry_Drone');
  });

  it('tags each upstream operation with its service title', () => {
    const merged = mergeOpenApiDocuments(inputs);
    expect(merged.paths['/fleet/drones']?.get?.tags).toEqual(['Fleet Registry']);
  });

  it('skips upstreams whose document is unavailable', () => {
    const merged = mergeOpenApiDocuments([
      { id: 'fleet-registry', title: 'Fleet Registry', prefix: '/fleet', doc: fleetDoc },
      { id: 'vision-ai', title: 'Vision AI', prefix: '/vision', doc: null },
    ]);
    expect(merged.paths['/fleet/drones']).toBeDefined();
    expect(merged.paths['/vision/detections']).toBeUndefined();
    expect(merged.components?.schemas?.['VisionAi_Detection']).toBeUndefined();
  });
});
