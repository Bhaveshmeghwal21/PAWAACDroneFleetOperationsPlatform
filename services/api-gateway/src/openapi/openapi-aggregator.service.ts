/**
 * Builds the gateway's merged OpenAPI 3.0 document (Requirement 20.3, 20.4).
 *
 * Fetches each upstream's OpenAPI document through the injected
 * {@link UpstreamSpecFetcher} (offline-friendly / testable) and aggregates them
 * via the pure {@link mergeOpenApiDocuments} merger. Upstreams that are
 * unreachable are skipped so the merged document — and the single Swagger UI it
 * backs — still serves the available services.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { UpstreamRegistry } from '../routing/upstream-registry.service';
import { mergeOpenApiDocuments, type UpstreamSpecInput } from './merge-openapi';
import { UPSTREAM_SPEC_FETCHER, type UpstreamSpecFetcher } from './spec-fetcher';

@Injectable()
export class OpenApiAggregatorService {
  private readonly logger = new Logger(OpenApiAggregatorService.name);

  constructor(
    private readonly registry: UpstreamRegistry,
    @Inject(UPSTREAM_SPEC_FETCHER) private readonly fetcher: UpstreamSpecFetcher,
  ) {}

  /**
   * Fetches and merges all reachable upstream OpenAPI documents into one
   * gateway document. Always resolves (never throws) — failed upstreams are
   * simply omitted.
   */
  async buildMergedDocument(): Promise<OpenAPIObject> {
    const inputs = await Promise.all(
      this.registry.allDefinitions.map(async (def): Promise<UpstreamSpecInput> => {
        const baseUrl = this.registry.baseUrlFor(def);
        if (baseUrl === undefined) {
          this.logger.warn(`Skipping OpenAPI for '${def.id}': ${def.envVar} not configured`);
          return { id: def.id, title: def.title, prefix: def.prefix, doc: null };
        }
        const doc = await this.fetcher.fetch(`${baseUrl}${def.specPath}`);
        return { id: def.id, title: def.title, prefix: def.prefix, doc };
      }),
    );

    return mergeOpenApiDocuments(inputs);
  }
}
