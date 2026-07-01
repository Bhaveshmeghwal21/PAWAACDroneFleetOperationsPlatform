/**
 * Typed client for the PAWAAC API Gateway.
 *
 * All dashboard data access flows through the Gateway (never directly to a
 * backend service), per the platform architecture. DTOs are imported from the
 * `@pawaac/shared-types` single source of truth so the dashboard stays in
 * lock-step with the services it consumes.
 *
 * Only the request/transport core plus typed endpoint signatures are provided
 * during bootstrap (task 15.1). The surfaces that call these methods — fleet
 * map, mission planner, telemetry panels, alert feed, replay — are built in
 * tasks 15.2–15.6.
 */
import type {
  Alert,
  Detection,
  Drone,
  Geofence,
  GeofenceConflict,
  GeoPolygon,
  Mission,
  TelemetrySample,
  Uuid,
  Waypoint,
} from '@pawaac/shared-types';

import { clientConfig } from './config';

/**
 * RFC 7807 problem+json error body returned by every PAWAAC service
 * (Requirement 34.2).
 */
export interface ProblemDetails {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

/** Error thrown when the Gateway responds with a non-2xx status. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails | undefined;

  constructor(status: number, message: string, problem?: ProblemDetails) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }
}

/**
 * Options accepted by the low-level request helper. Optional members
 * explicitly admit `undefined` to interoperate with the workspace's
 * `exactOptionalPropertyTypes` setting when callers forward optional args.
 */
export interface RequestOptions {
  method?: string | undefined;
  /** JSON-serializable request body. */
  body?: unknown;
  /** Additional query-string parameters. */
  query?: Record<string, string | number | boolean | undefined> | undefined;
  /** Bearer token for authenticated routes (JWT issued by the Gateway). */
  token?: string | undefined;
  /** Abort signal for cancellation. */
  signal?: AbortSignal | undefined;
}

/** Payload for submitting a new mission through the Gateway. */
export interface MissionSubmission {
  name: string;
  waypoints: Waypoint[];
}

/** Payload for submitting a geofence definition through the Gateway. */
export interface GeofenceSubmission {
  name: string;
  polygon: GeoPolygon;
}

/** Time range (epoch seconds) for a detection replay query. */
export interface DetectionQuery {
  droneId?: Uuid;
  from: number;
  to: number;
}

function buildUrl(baseUrl: string, path: string, query?: RequestOptions['query']): string {
  const url = new URL(path.replace(/^\//, ''), `${baseUrl.replace(/\/$/, '')}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

/**
 * A thin, strongly-typed wrapper over `fetch` targeting the API Gateway. The
 * `fetch` implementation is injectable to keep the client unit-testable without
 * a network or DOM.
 */
export class GatewayApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string = clientConfig.apiGatewayUrl, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  /** Issue a request and decode the JSON response as `T`. */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
    };
    if (options.signal) {
      init.signal = options.signal;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(buildUrl(this.baseUrl, path, options.query), init);

    if (!response.ok) {
      const problem = await this.parseProblem(response);
      const message = problem?.title ?? `Request failed (${response.status})`;
      throw new ApiError(response.status, message, problem);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async parseProblem(response: Response): Promise<ProblemDetails | undefined> {
    try {
      return (await response.json()) as ProblemDetails;
    } catch {
      return undefined;
    }
  }

  // --- Fleet Registry (via Gateway) — Requirement 21 ----------------------
  listDrones(token?: string): Promise<Drone[]> {
    return this.request<Drone[]>('/api/drones', { token });
  }

  getDrone(id: Uuid, token?: string): Promise<Drone> {
    return this.request<Drone>(`/api/drones/${id}`, { token });
  }

  // --- Mission Planning (via Gateway) — Requirement 22 --------------------
  listMissions(token?: string): Promise<Mission[]> {
    return this.request<Mission[]>('/api/missions', { token });
  }

  submitMission(input: MissionSubmission, token?: string): Promise<Mission> {
    return this.request<Mission>('/api/missions', {
      method: 'POST',
      body: input,
      token,
    });
  }

  submitGeofence(input: GeofenceSubmission, token?: string): Promise<Geofence> {
    return this.request<Geofence>('/api/geofences', {
      method: 'POST',
      body: input,
      token,
    });
  }

  checkGeofenceConflicts(input: MissionSubmission, token?: string): Promise<GeofenceConflict[]> {
    return this.request<GeofenceConflict[]>('/api/missions/geofence-check', {
      method: 'POST',
      body: input,
      token,
    });
  }

  // --- Telemetry Ingestion (via Gateway) — Requirement 23 -----------------
  getRecentTelemetry(droneId: Uuid, token?: string): Promise<TelemetrySample[]> {
    return this.request<TelemetrySample[]>(`/api/telemetry/${droneId}`, {
      token,
    });
  }

  // --- Alert & Notification (via Gateway) — Requirement 24 ----------------
  listAlerts(token?: string): Promise<Alert[]> {
    return this.request<Alert[]>('/api/alerts', { token });
  }

  acknowledgeAlert(id: Uuid, acknowledgedBy?: Uuid, token?: string): Promise<Alert> {
    return this.request<Alert>(`/api/alerts/${id}/acknowledge`, {
      method: 'POST',
      body: acknowledgedBy ? { acknowledgedBy } : {},
      token,
    });
  }

  // --- Vision AI Results (via Gateway) — Requirement 25 -------------------
  queryDetections(params: DetectionQuery, token?: string): Promise<Detection[]> {
    const query: Record<string, string | number | undefined> = {
      from: params.from,
      to: params.to,
    };
    if (params.droneId !== undefined) {
      query.droneId = params.droneId;
    }
    return this.request<Detection[]>('/api/detections', { query, token });
  }
}

/** Shared default client instance pointed at the configured Gateway. */
export const apiClient = new GatewayApiClient();
