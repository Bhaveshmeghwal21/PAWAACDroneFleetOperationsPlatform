/**
 * Resolves request paths to concrete upstream forwarding targets
 * (Requirement 20.1, 20.2 — design property P43).
 *
 * Wraps the pure {@link resolveUpstreamId} resolver with the runtime concern of
 * mapping each upstream to its configured base URL (from the environment, e.g.
 * `FLEET_REGISTRY_URL`). The pure routing decision stays in {@link upstreams};
 * this service only adds environment lookup so it can be injected into the proxy
 * layer.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  findDefinition,
  resolveUpstreamId,
  UPSTREAM_DEFINITIONS,
  assertDisjointPrefixes,
  type UpstreamDefinition,
  type UpstreamId,
  type UpstreamTarget,
} from './upstreams';

@Injectable()
export class UpstreamRegistry {
  private readonly logger = new Logger(UpstreamRegistry.name);

  constructor(
    private readonly config: ConfigService,
    @Optional()
    private readonly definitions: readonly UpstreamDefinition[] = UPSTREAM_DEFINITIONS,
  ) {
    // Fail fast if the routing table is ever made non-disjoint (P43 precondition).
    assertDisjointPrefixes(this.definitions);
  }

  /** All known upstream definitions backing this registry. */
  get allDefinitions(): readonly UpstreamDefinition[] {
    return this.definitions;
  }

  /**
   * Resolves a request path to its forwarding {@link UpstreamTarget}, or
   * `undefined` when the path is unknown (→ 404) or the matched upstream has no
   * configured base URL.
   */
  resolveTarget(rawPath: string): UpstreamTarget | undefined {
    const id = resolveUpstreamId(rawPath, this.definitions);
    if (id === undefined) {
      return undefined;
    }
    const definition = findDefinition(id, this.definitions);
    if (definition === undefined) {
      return undefined;
    }
    const baseUrl = this.baseUrlFor(definition);
    if (baseUrl === undefined) {
      this.logger.error(
        `Upstream '${id}' matched path '${rawPath}' but ${definition.envVar} is not configured`,
      );
      return undefined;
    }
    return { definition, baseUrl };
  }

  /** Reads (and trims a trailing slash from) the base URL for an upstream. */
  baseUrlFor(definition: UpstreamDefinition): string | undefined {
    const raw = this.config.get<string>(definition.envVar);
    if (raw === undefined || raw.trim().length === 0) {
      return undefined;
    }
    return raw.trim().replace(/\/+$/, '');
  }

  /** Convenience lookup of a base URL by upstream id. */
  baseUrlForId(id: UpstreamId): string | undefined {
    const definition = findDefinition(id, this.definitions);
    return definition === undefined ? undefined : this.baseUrlFor(definition);
  }
}
