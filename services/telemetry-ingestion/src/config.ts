/**
 * Runtime configuration for the Telemetry Ingestion service.
 *
 * All configuration is sourced exclusively from environment variables
 * (Requirement 31.3). This module centralizes parsing/normalization so the
 * rest of the service receives a single, typed configuration object.
 */

/** Fully-resolved, typed service configuration. */
export interface AppConfig {
  /** HTTP/WebSocket listen port. Fixed to 3003 in the container. */
  readonly port: number;
  /** Deployment environment label, e.g. `production` / `development`. */
  readonly nodeEnv: string;
  /** Log verbosity. */
  readonly logLevel: string;
  /** Header name used to propagate the distributed trace id (Requirement 34.3). */
  readonly traceHeader: string;
  /** Postgres/TimescaleDB connection string; undefined when not configured. */
  readonly databaseUrl: string | undefined;
  /**
   * Shared token a drone must present when opening the telemetry WebSocket
   * (Requirement 8.1). Undefined when not configured — in that case the WS
   * server treats every connection as unauthenticated and rejects it.
   */
  readonly droneAuthToken: string | undefined;
  /**
   * Descent rate (m/s) above which an ALTITUDE_DROP anomaly is flagged
   * (`ALT_DROP_THRESHOLD`, Req 9.3). Defaults to {@link DEFAULT_ALT_DROP_THRESHOLD}.
   */
  readonly altDropThreshold: number;
  /**
   * Battery drain rate (%/s) above which a BATTERY_DRAIN_SPIKE anomaly is
   * flagged (`BATTERY_DRAIN_THRESHOLD`, Req 9.4). Defaults to
   * {@link DEFAULT_BATTERY_DRAIN_THRESHOLD}.
   */
  readonly batteryDrainThreshold: number;
  /**
   * Alert & Notification service endpoint that detected anomaly events are
   * POSTed to (`ALERT_NOTIFICATION_URL`, Req 9.7). Undefined disables the HTTP
   * sink (anomalies are still detected and pushed to the dashboard hook).
   */
  readonly alertNotificationUrl: string | undefined;
}

/** Default container port for Telemetry Ingestion (see docker-compose.yml). */
export const DEFAULT_PORT = 3003;

/** Default trace header name (see `.env.example` / Requirement 34.3). */
export const DEFAULT_TRACE_HEADER = 'X-Trace-Id';

/** Default ALT_DROP_THRESHOLD in m/s (design Algorithm 2). */
export const DEFAULT_ALT_DROP_THRESHOLD = 10;

/** Default BATTERY_DRAIN_THRESHOLD in %/s (design Algorithm 2). */
export const DEFAULT_BATTERY_DRAIN_THRESHOLD = 1;

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric threshold value: "${raw}"`);
  }
  return parsed;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  // Port 0 is permitted: it asks the OS for an ephemeral port (used in tests).
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid PORT value: "${raw}"`);
  }
  return parsed;
}

/**
 * Normalize an optional string env var: treat unset/blank as "not configured"
 * so callers can rely on `undefined` rather than empty strings.
 */
function normalizeOptional(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Build an {@link AppConfig} from the given environment (defaults to
 * `process.env`). Pure and side-effect free so it can be unit tested.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: parsePort(env.PORT, DEFAULT_PORT),
    nodeEnv: env.NODE_ENV ?? 'development',
    logLevel: env.LOG_LEVEL ?? 'info',
    traceHeader: env.TRACE_HEADER ?? DEFAULT_TRACE_HEADER,
    databaseUrl: env.DATABASE_URL,
    droneAuthToken: normalizeOptional(env.DRONE_AUTH_TOKEN),
    altDropThreshold: parsePositiveNumber(env.ALT_DROP_THRESHOLD, DEFAULT_ALT_DROP_THRESHOLD),
    batteryDrainThreshold: parsePositiveNumber(
      env.BATTERY_DRAIN_THRESHOLD,
      DEFAULT_BATTERY_DRAIN_THRESHOLD,
    ),
    alertNotificationUrl: normalizeOptional(env.ALERT_NOTIFICATION_URL),
  };
}
