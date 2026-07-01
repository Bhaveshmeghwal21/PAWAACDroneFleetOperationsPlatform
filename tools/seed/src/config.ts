/**
 * Resolves per-service database connection settings from environment variables.
 *
 * The seed script runs from the host (outside the Docker network), so it
 * targets the host-published datastore ports documented in `.env.example`
 * rather than the in-network container hostnames. Each service connection can
 * be overridden wholesale with a `<SERVICE>_DATABASE_URL`, otherwise it is
 * assembled from the same `*_DB_*` variables the services themselves consume,
 * falling back to the non-secret local-dev defaults from `.env.example`.
 */
import type { PoolConfig } from 'pg';

/** The five datastore-owning backend services the seed writes to. */
export type ServiceKey = 'fleet' | 'mission' | 'vision' | 'alert' | 'telemetry';

interface ServiceEnvSpec {
  urlVar: string;
  prefix: string;
  defaultPort: number;
  defaultUser: string;
  defaultDb: string;
}

const SERVICE_ENV: Record<ServiceKey, ServiceEnvSpec> = {
  fleet: { urlVar: 'FLEET_DATABASE_URL', prefix: 'FLEET', defaultPort: 5432, defaultUser: 'fleet_registry', defaultDb: 'fleet_registry' },
  mission: { urlVar: 'MISSION_DATABASE_URL', prefix: 'MISSION', defaultPort: 5433, defaultUser: 'mission_planning', defaultDb: 'mission_planning' },
  vision: { urlVar: 'VISION_DATABASE_URL', prefix: 'VISION', defaultPort: 5434, defaultUser: 'vision_ai', defaultDb: 'vision_ai' },
  alert: { urlVar: 'ALERT_DATABASE_URL', prefix: 'ALERT', defaultPort: 5435, defaultUser: 'alert_notification', defaultDb: 'alert_notification' },
  telemetry: { urlVar: 'TELEMETRY_DATABASE_URL', prefix: 'TELEMETRY', defaultPort: 5436, defaultUser: 'telemetry', defaultDb: 'telemetry' },
};

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

/** Build a `pg` PoolConfig for one service from the environment. */
export function connectionFor(service: ServiceKey): PoolConfig {
  const spec = SERVICE_ENV[service];

  const url = env(spec.urlVar);
  if (url) {
    return { connectionString: url };
  }

  return {
    host: env(`${spec.prefix}_DB_HOST`) ?? 'localhost',
    port: Number(env(`${spec.prefix}_DB_HOST_PORT`) ?? env(`${spec.prefix}_DB_PORT`) ?? spec.defaultPort),
    user: env(`${spec.prefix}_DB_USER`) ?? spec.defaultUser,
    password: env(`${spec.prefix}_DB_PASSWORD`) ?? '',
    database: env(`${spec.prefix}_DB_NAME`) ?? spec.defaultDb,
  };
}

/** Telemetry sample cadence override (seconds), if provided in the env. */
export function telemetryIntervalSecondsFromEnv(): number | undefined {
  const raw = env('SEED_TELEMETRY_INTERVAL_SECONDS');
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
