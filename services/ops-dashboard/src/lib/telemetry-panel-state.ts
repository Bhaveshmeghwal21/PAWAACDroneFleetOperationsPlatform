/**
 * Pure state reduction for the live telemetry panels (Requirement 23).
 *
 * The telemetry panels (attitude indicator, battery graph, EKF2 health,
 * altitude chart) are driven entirely by the live telemetry stream. Rendering
 * the panels needs a DOM, but the *logic* that turns a stream of
 * `telemetry:sample` events into render-ready panel data — keeping the latest
 * attitude/battery/EKF2 snapshot plus a bounded rolling series for the battery
 * and altitude charts — is isolated here as pure, framework-free functions.
 *
 * The React component (`telemetry-panels.tsx`) is a thin adapter that feeds
 * socket/HTTP data into these reducers and renders the panels; this module is
 * what the unit tests in `telemetry-panel-state.test.ts` exercise directly.
 *
 * All functions are pure: they never mutate their inputs and always return new
 * objects for the entries they touch, so they compose cleanly with React's
 * `setState(prev => reduce(prev, event))`.
 */
import type { Attitude, BatteryState, Ekf2State, TelemetrySample, Uuid } from '@pawaac/shared-types';

/** A single timestamped point in a rolling chart series. */
export interface SeriesPoint {
  /** Sample timestamp (ISO 8601). */
  ts: string;
  /** Numeric value at that instant (battery percentage or altitude in meters). */
  value: number;
}

/**
 * Render-ready panel data for one drone.
 *
 * `latest` carries the most recent full sample (used by the attitude, battery
 * and EKF2 panels); `batterySeries` and `altitudeSeries` are bounded rolling
 * histories powering the battery graph and altitude chart.
 */
export interface DronePanelData {
  droneId: Uuid;
  /** Most recent sample applied, or `undefined` before the first sample. */
  latest: TelemetrySample | undefined;
  /** Rolling battery remaining-percentage history (oldest → newest). */
  batterySeries: SeriesPoint[];
  /** Rolling altitude (meters) history (oldest → newest). */
  altitudeSeries: SeriesPoint[];
  /** Timestamp of the most recent applied sample (ISO 8601). */
  lastTs: string | undefined;
}

/** Telemetry-panel state: one entry per drone seen, keyed by drone id. */
export type TelemetryPanelState = Record<Uuid, DronePanelData>;

/**
 * Default maximum number of points retained per rolling series. At 10Hz this is
 * ~12s of history; enough for a readable trend without unbounded growth.
 */
export const DEFAULT_SERIES_CAPACITY = 120;

/** An empty telemetry-panel state. */
export function emptyPanelState(): TelemetryPanelState {
  return {};
}

/**
 * Whether `candidateTs` is newer than the last applied timestamp. Telemetry
 * timestamps are strictly increasing per drone, so a lexicographic compare of
 * ISO 8601 strings is equivalent to a chronological compare.
 */
function isFreshSample(previousTs: string | undefined, candidateTs: string): boolean {
  return previousTs === undefined || candidateTs > previousTs;
}

/** Append a point to a series and trim it (from the front) to `capacity`. */
function pushBounded(series: readonly SeriesPoint[], point: SeriesPoint, capacity: number): SeriesPoint[] {
  const next = [...series, point];
  if (capacity > 0 && next.length > capacity) {
    return next.slice(next.length - capacity);
  }
  return next;
}

/**
 * Apply a live telemetry sample to the panel state (Requirements 23.1, 23.3).
 *
 * - Updates the drone's `latest` snapshot (attitude, battery, EKF2, altitude).
 * - Appends the battery percentage and altitude to their rolling series,
 *   trimming each to `capacity`.
 * - Creates an entry on the fly for a drone not seen before.
 * - Ignores stale/out-of-order samples (older than the last applied one),
 *   returning the input state unchanged so React can skip a re-render.
 */
export function applyPanelSample(
  state: TelemetryPanelState,
  sample: TelemetrySample,
  capacity: number = DEFAULT_SERIES_CAPACITY,
): TelemetryPanelState {
  const existing = state[sample.droneId];

  if (existing && !isFreshSample(existing.lastTs, sample.ts)) {
    return state;
  }

  const batteryPoint: SeriesPoint = { ts: sample.ts, value: sample.battery.remainingPct };
  const altitudePoint: SeriesPoint = { ts: sample.ts, value: sample.altitude };

  const updated: DronePanelData = {
    droneId: sample.droneId,
    latest: sample,
    batterySeries: pushBounded(existing?.batterySeries ?? [], batteryPoint, capacity),
    altitudeSeries: pushBounded(existing?.altitudeSeries ?? [], altitudePoint, capacity),
    lastTs: sample.ts,
  };

  return { ...state, [sample.droneId]: updated };
}

/**
 * Seed (or replace) a drone's panel data from a batch of historical samples,
 * e.g. the result of `GatewayApiClient.getRecentTelemetry`.
 *
 * Samples are sorted by timestamp ascending and the most recent `capacity`
 * points are retained, so the rolling charts start populated rather than empty.
 * An empty batch leaves the state unchanged.
 */
export function seedPanelSamples(
  state: TelemetryPanelState,
  droneId: Uuid,
  samples: readonly TelemetrySample[],
  capacity: number = DEFAULT_SERIES_CAPACITY,
): TelemetryPanelState {
  if (samples.length === 0) {
    return state;
  }

  const ordered = [...samples].sort((a, b) => a.ts.localeCompare(b.ts));
  const trimmed = capacity > 0 && ordered.length > capacity ? ordered.slice(ordered.length - capacity) : ordered;
  const latest = trimmed[trimmed.length - 1]!;

  const seeded: DronePanelData = {
    droneId,
    latest,
    batterySeries: trimmed.map((s) => ({ ts: s.ts, value: s.battery.remainingPct })),
    altitudeSeries: trimmed.map((s) => ({ ts: s.ts, value: s.altitude })),
    lastTs: latest.ts,
  };

  return { ...state, [droneId]: seeded };
}

/** The panel data for a drone, or `undefined` when it has no samples yet. */
export function getDronePanel(
  state: TelemetryPanelState,
  droneId: Uuid | undefined,
): DronePanelData | undefined {
  if (droneId === undefined) {
    return undefined;
  }
  return state[droneId];
}

/** Drone ids present in the state, sorted for deterministic rendering. */
export function listPanelDroneIds(state: TelemetryPanelState): Uuid[] {
  return Object.keys(state).sort((a, b) => a.localeCompare(b));
}

/** A point in normalized SVG coordinate space for a rendered sparkline. */
export interface SparklinePoint {
  x: number;
  y: number;
}

/** Geometry for an inline SVG sparkline derived purely from a series. */
export interface Sparkline {
  /** Points mapped into the `width`×`height` box (y is flipped for SVG). */
  points: SparklinePoint[];
  /** `points` rendered as an SVG polyline `points` attribute string. */
  polyline: string;
  /** Minimum value across the series (0 for an empty series). */
  min: number;
  /** Maximum value across the series (0 for an empty series). */
  max: number;
}

/**
 * Project a numeric series into SVG sparkline geometry (pure; powers the
 * battery graph and altitude chart). The newest point maps to the right edge.
 *
 * - An empty series yields no points and a `0..0` range.
 * - A flat or single-point series is drawn along the vertical midline so it
 *   reads as a clear horizontal trend rather than collapsing to an edge.
 */
export function buildSparkline(
  series: readonly SeriesPoint[],
  width: number,
  height: number,
  padding = 2,
): Sparkline {
  if (series.length === 0) {
    return { points: [], polyline: '', min: 0, max: 0 };
  }

  const values = series.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  const innerWidth = Math.max(0, width - padding * 2);
  const innerHeight = Math.max(0, height - padding * 2);
  const lastIndex = series.length - 1;

  const points: SparklinePoint[] = series.map((point, index) => {
    const x = lastIndex === 0 ? padding + innerWidth : padding + (innerWidth * index) / lastIndex;
    // Flat series → midline; otherwise normalize into [0, 1] and flip for SVG.
    const normalized = span === 0 ? 0.5 : (point.value - min) / span;
    const y = padding + innerHeight * (1 - normalized);
    return { x, y };
  });

  const polyline = points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');

  return { points, polyline, min, max };
}

/** Round to 2 decimals to keep generated SVG strings compact and stable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Convert radians to degrees (attitude is reported in radians per PX4). */
export function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** Latest attitude for a panel, or `undefined` before the first sample. */
export function latestAttitude(panel: DronePanelData | undefined): Attitude | undefined {
  return panel?.latest?.attitude;
}

/** Latest battery snapshot for a panel, or `undefined` before the first sample. */
export function latestBattery(panel: DronePanelData | undefined): BatteryState | undefined {
  return panel?.latest?.battery;
}

/** Latest EKF2 snapshot for a panel, or `undefined` before the first sample. */
export function latestEkf2(panel: DronePanelData | undefined): Ekf2State | undefined {
  return panel?.latest?.ekf2;
}
