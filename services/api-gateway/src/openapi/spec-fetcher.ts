/**
 * Pluggable fetcher for upstream OpenAPI documents (Requirement 20.3).
 *
 * The merged-OpenAPI aggregator depends on this abstraction rather than on
 * `axios` directly, so tests can supply an in-memory/offline fetcher and the
 * service stays deterministic and network-free under test. The default
 * implementation performs an HTTP GET against each upstream's spec URL.
 */
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/** DI token for the injectable {@link UpstreamSpecFetcher}. */
export const UPSTREAM_SPEC_FETCHER = 'UPSTREAM_SPEC_FETCHER';

/**
 * Fetches the raw OpenAPI document served at `url`. Implementations MUST resolve
 * to `null` (rather than throw) when the upstream is unreachable or returns a
 * non-spec payload, so one offline upstream cannot break the merged document.
 */
export interface UpstreamSpecFetcher {
  fetch(url: string): Promise<unknown | null>;
}

/** Default HTTP fetcher backed by `axios`. */
@Injectable()
export class HttpUpstreamSpecFetcher implements UpstreamSpecFetcher {
  private readonly logger = new Logger(HttpUpstreamSpecFetcher.name);

  /** Per-upstream request timeout (ms) so a slow upstream cannot stall startup. */
  private static readonly TIMEOUT_MS = 5000;

  async fetch(url: string): Promise<unknown | null> {
    try {
      const response = await axios.get<unknown>(url, {
        timeout: HttpUpstreamSpecFetcher.TIMEOUT_MS,
        responseType: 'json',
      });
      return response.data ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch upstream OpenAPI spec from ${url}: ${message}`);
      return null;
    }
  }
}
