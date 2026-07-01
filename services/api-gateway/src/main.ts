/**
 * API Gateway service entrypoint.
 *
 * Sets up global request validation, the RFC 7807 problem+json error filter
 * (Requirement 34.2) and listens on the configured port (3000 by default, per
 * docker-compose.yml).
 */
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { OpenApiAggregatorService } from './openapi/openapi-aggregator.service';

/** Container port for the API Gateway service (per docker-compose.yml). */
const DEFAULT_PORT = 3000;

/** Path at which the single merged Swagger UI is served (Requirement 20.4). */
const SWAGGER_UI_PATH = 'docs';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();

  // Mount the single Swagger UI backed by the merged upstream OpenAPI document
  // (Requirement 20.3, 20.4). Failure to reach an upstream must not block boot.
  try {
    const aggregator = app.get(OpenApiAggregatorService);
    const mergedDocument = await aggregator.buildMergedDocument();
    SwaggerModule.setup(SWAGGER_UI_PATH, app, mergedDocument, {
      jsonDocumentUrl: 'openapi.json',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    new Logger('Bootstrap').warn(`Merged OpenAPI document unavailable at startup: ${message}`);
  }

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`API Gateway listening on port ${port}`);
}

void bootstrap();
