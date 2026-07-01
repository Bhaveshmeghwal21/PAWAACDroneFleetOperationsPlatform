/**
 * Pure merger that aggregates several upstream OpenAPI 3.0 documents into one
 * gateway document (Requirement 20.3).
 *
 * The merge is deliberately a **pure function** of its inputs so it can be unit-
 * tested offline:
 * - Every upstream path is re-based under the gateway prefix that owns the
 *   upstream (e.g. the Fleet Registry's `/drones` becomes `/fleet/drones`), so
 *   the merged document mirrors how clients actually reach each operation
 *   through the gateway.
 * - Component schemas are namespaced per upstream (`FleetRegistry_Drone`) and all
 *   local `#/components/schemas/...` `$ref`s within that upstream's document are
 *   rewritten to the namespaced name, preventing collisions between services
 *   that happen to share a schema name.
 * - Upstreams whose spec could not be fetched (null) are skipped; the merged
 *   document still serves the rest.
 */
import type { OpenAPIObject } from '@nestjs/swagger';
import type {
  ComponentsObject,
  PathItemObject,
  PathsObject,
  SchemaObject,
  ReferenceObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/** One upstream's contribution to the merged document. */
export interface UpstreamSpecInput {
  /** Stable upstream id (used to derive a schema namespace). */
  readonly id: string;
  /** Human-readable title (recorded as a tag on the upstream's operations). */
  readonly title: string;
  /** Gateway path prefix the upstream's paths are re-based under. */
  readonly prefix: string;
  /** The raw upstream OpenAPI document, or `null` when unavailable. */
  readonly doc: unknown | null;
}

/** Top-level `info` block for the merged document. */
export interface MergedInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

const DEFAULT_INFO: MergedInfo = {
  title: 'PAWAAC Drone Fleet Operations Platform — API Gateway',
  version: '1.0.0',
  description: 'Merged OpenAPI surface aggregating all upstream PAWAAC services.',
};

/** Converts an upstream id like `fleet-registry` into a `FleetRegistry` prefix. */
export function schemaNamespace(id: string): string {
  return id
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

const SCHEMA_REF_PREFIX = '#/components/schemas/';

/**
 * Recursively rewrites local schema `$ref`s in an arbitrary OpenAPI fragment,
 * mapping each old schema name to its namespaced name. Returns a new value and
 * never mutates the input.
 */
export function rewriteSchemaRefs(node: unknown, rename: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => rewriteSchemaRefs(item, rename));
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith(SCHEMA_REF_PREFIX)) {
        const oldName = value.slice(SCHEMA_REF_PREFIX.length);
        const newName = rename.get(oldName);
        out[key] = newName === undefined ? value : `${SCHEMA_REF_PREFIX}${newName}`;
      } else {
        out[key] = rewriteSchemaRefs(value, rename);
      }
    }
    return out;
  }
  return node;
}

/** Joins a gateway prefix with an upstream path, avoiding a double slash. */
export function joinPath(prefix: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (normalizedPath === '/') {
    return prefix;
  }
  return `${prefix}${normalizedPath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merges the supplied upstream documents into a single OpenAPI 3.0 document.
 *
 * @param inputs upstream contributions (in priority order)
 * @param info   overrides for the merged top-level `info` block
 */
export function mergeOpenApiDocuments(
  inputs: readonly UpstreamSpecInput[],
  info: MergedInfo = DEFAULT_INFO,
): OpenAPIObject {
  const mergedPaths: PathsObject = {};
  const mergedSchemas: Record<string, SchemaObject | ReferenceObject> = {};
  const tags: { name: string; description?: string }[] = [];

  for (const input of inputs) {
    if (!isRecord(input.doc)) {
      continue;
    }
    const namespace = schemaNamespace(input.id);
    tags.push({ name: input.title, description: `Operations served by ${input.title}.` });

    // Build the schema-rename map for this upstream.
    const rename = new Map<string, string>();
    const components = input.doc['components'];
    const schemas = isRecord(components) ? components['schemas'] : undefined;
    if (isRecord(schemas)) {
      for (const name of Object.keys(schemas)) {
        rename.set(name, `${namespace}_${name}`);
      }
    }

    // Re-base and tag each path, rewriting refs first.
    const paths = input.doc['paths'];
    if (isRecord(paths)) {
      for (const [rawPath, rawItem] of Object.entries(paths)) {
        const reboundPath = joinPath(input.prefix, rawPath);
        const rewrittenItem = rewriteSchemaRefs(rawItem, rename) as PathItemObject;
        mergedPaths[reboundPath] = tagPathItem(rewrittenItem, input.title);
      }
    }

    // Namespace and merge component schemas.
    if (isRecord(schemas)) {
      for (const [name, schema] of Object.entries(schemas)) {
        const rewritten = rewriteSchemaRefs(schema, rename) as SchemaObject | ReferenceObject;
        mergedSchemas[`${namespace}_${name}`] = rewritten;
      }
    }
  }

  const components: ComponentsObject = { schemas: mergedSchemas };
  const merged: OpenAPIObject = {
    openapi: '3.0.0',
    info:
      info.description === undefined
        ? { title: info.title, version: info.version }
        : { title: info.title, version: info.version, description: info.description },
    paths: mergedPaths,
    components,
    tags,
  };
  return merged;
}

/** Adds the upstream title as a tag to every operation in a path item. */
function tagPathItem(item: PathItemObject, tag: string): PathItemObject {
  const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const method of HTTP_METHODS) {
    const op = out[method];
    if (isRecord(op)) {
      const existingTags = Array.isArray(op['tags']) ? (op['tags'] as unknown[]) : [];
      out[method] = { ...op, tags: existingTags.length > 0 ? existingTags : [tag] };
    }
  }
  return out as PathItemObject;
}
