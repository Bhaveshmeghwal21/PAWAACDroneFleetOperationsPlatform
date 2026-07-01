/**
 * Alert & Notification service entrypoint.
 *
 * Sets up global request validation, the RFC 7807 problem+json error filter
 * (Requirement 34.2) and listens on the configured port (3005 by default, per
 * docker-compose.yml).
 */
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';

const DEFAULT_PORT = 3005;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);
  new Logger('Bootstrap').log(`Alert & Notification service listening on port ${port}`);
}

void bootstrap();
