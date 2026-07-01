/**
 * Wires the merged-OpenAPI aggregator (Requirement 20.3, 20.4).
 *
 * Provides the {@link OpenApiAggregatorService} and the default HTTP
 * {@link UpstreamSpecFetcher}; the {@link UpstreamRegistry} (for base URLs and
 * spec paths) is reused from {@link RoutingModule}. The single Swagger UI for the
 * merged document is mounted during bootstrap (see `main.ts`).
 */
import { Module } from '@nestjs/common';
import { RoutingModule } from '../routing/routing.module';
import { OpenApiAggregatorService } from './openapi-aggregator.service';
import { HttpUpstreamSpecFetcher, UPSTREAM_SPEC_FETCHER } from './spec-fetcher';

@Module({
  imports: [RoutingModule],
  providers: [
    OpenApiAggregatorService,
    { provide: UPSTREAM_SPEC_FETCHER, useClass: HttpUpstreamSpecFetcher },
  ],
  exports: [OpenApiAggregatorService],
})
export class OpenApiModule {}
