/**
 * Telemetry Ingestion service entrypoint.
 *
 * Loads configuration, constructs the application (HTTP + WebSocket), wires a
 * datastore readiness probe when a database URL is configured, starts
 * listening, and installs graceful-shutdown handlers.
 */
import { ANOMALY_KINDS } from '@pawaac/shared-types';
import { loadConfig } from './config.js';
import { createApp, type App } from './app.js';
import { createPool, createReadinessProbe } from './db/pool.js';
import { createPgTelemetryStore } from './persist/store.js';
import { createPgHistoryQuery } from './query/pg.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Only attach a real datastore (readiness probe + telemetry store) when a
  // connection string is configured; the bootstrap phase can run without one.
  let app: App;
  if (config.databaseUrl !== undefined) {
    const pool = createPool(config.databaseUrl);
    app = createApp({
      config,
      readiness: createReadinessProbe(pool),
      store: createPgTelemetryStore(pool),
      historyReader: createPgHistoryQuery(pool),
    });
  } else {
    app = createApp({ config });
  }

  await app.listen();

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'telemetry-ingestion listening',
      port: config.port,
      env: config.nodeEnv,
      anomalyKinds: ANOMALY_KINDS,
    }),
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(JSON.stringify({ level: 'error', msg: 'shutdown failed', err: String(err) }));
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'error', msg: 'fatal startup error', err: String(err) }));
  process.exit(1);
});
