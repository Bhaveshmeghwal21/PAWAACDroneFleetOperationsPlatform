import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupApp } from './setup';

/** Container port for the Mission Planning service (per docker-compose.yml). */
const DEFAULT_PORT = 3002;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  await app.listen(port, '0.0.0.0');
  Logger.log(`Mission Planning listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
