/**
 * Pure marker-state reduction for the real-time fleet map (Requirement 21).
 *
 * Leaflet itself needs a DOM/browser to render, so the *logic* that drives the
 * map — turning the initial drone list, live telemetry samples, and
 * status-change events into a per-drone marker map — is deliberately isolated
 * here as a set of pure, framework-free functions. The React component
 * (`fleet-map.tsx`) is a thin adapter that feeds socket/HTTP data into these
 * reducers and renders the resulting markers; this module is what the unit
 * tests in `fleet-map-state.test.ts` exercise directly.
 *
 * All functions are pure: they never mutate their inputs and always return a
 * new state object (and new marker objects for the entries they touch), so they
 * compose cleanly with React's `setState(prev => reduce(prev, event))`.
 */
import type { Drone, DroneStatus, TelemetrySample, Uuid } from '@pawaac/shared-types';

import type { DroneStatusEvent } from './ws-client';

/**
 * The render-ready view of a single drone on the fleet map.
 *
 * Telemetry-derived fields (`position`, `batteryPct`, `flightMode`,
 * `altitude`, `lastTelemetryTs`) are `undefined` until the first
 * `telemetry:sample` for the drone arrives — a drone can be known to the fleet
 * (seeded from the registry) before it starts streaming telemetry.
 */
export interface DroneMarker {
  droneId: Uuid;
  /** Registry metadata, present when the drone was seeded from Fleet Registry. */
  serialNumber: string | undefined;
  model: string | undefined;
  /** Lifecycle status; updated by `drone:status` events (Requirement 21.3). */
  status: DroneStatus;
  /** Latest known position (Requirement 21.1); `undefined` before first sample. */
  position: { lat: number; lon: number } | undefined;
  /** Latest battery remaining percentage, `[0, 100]` (Requirement 21.2). */
  batteryPct: number | undefined;
  /** Latest flight mode string (Requirement 21.2). */
  flightMode: string | undefined;
  /** Latest altitude in meters. */
  altitude: number | undefined;
  /** Timestamp of the most recent applied telemetry sample (ISO 8601). */
  lastTelemetryTs: string | undefined;
}

/** The full fleet-map state: one marker per known drone, keyed by drone id. */
export type FleetMarkerState = Record<Uuid, DroneMarker>;

/** Default lifecycle status assumed for a drone first seen via telemetry. */
const DEFAULT_DISCOVERED_STATUS: DroneStatus = 'active';

/** An empty fleet-map state. */
export function emptyFleetState(): FleetMarkerState {
  return {};
}

/**
 * Build the initial marker state from the drone list returned by the Gateway.
 *
 * Seeded markers carry registry metadata and status but no telemetry yet; live
 * position/battery/flight-mode fill in as samples arrive. If the same drone id
 * appears more than once, the last occurrence wins (deterministic).
 */
export function seedDrones(drones: readonly Drone[]): FleetMarkerState {
  const next: FleetMarkerState = {};
  for (const drone of drones) {
    next[drone.id] = {
      droneId: drone.id,
      serialNumber: drone.serialNumber,
      model: drone.model,
      status: drone.status,
      position: undefined,
      batteryPct: undefined,
      flightMode: undefined,
      altitude: undefined,
      lastTelemetryTs: undefined,
    };
  }
  return next;
}

/**
 * Whether `candidateTs` is newer than (or equal to, when there is no prior)
 * the marker's last applied telemetry timestamp. Telemetry timestamps are
 * strictly increasing per drone, so comparing ISO 8601 strings lexicographically
 * is equivalent to comparing them chronologically.
 */
function isFreshSample(previousTs: string | undefined, candidateTs: string): boolean {
  return previousTs === undefined || candidateTs > previousTs;
}

/**
 * Apply a live telemetry sample to the fleet state (Requirements 21.1, 21.2).
 *
 * - Updates the drone's position, battery percentage, flight mode and altitude.
 * - Creates a marker on the fly if the sample is for a drone not yet seeded
 *   (defaulting its status to `active`); the registry seed simply pre-populates
 *   metadata when available.
 * - Ignores stale/out-of-order samples (older than the last applied one),
 *   returning the input state unchanged so React can skip a re-render.
 */
export function applyTelemetrySample(
  state: FleetMarkerState,
  sample: TelemetrySample,
): FleetMarkerState {
  const existing = state[sample.droneId];

  if (existing && !isFreshSample(existing.lastTelemetryTs, sample.ts)) {
    return state;
  }

  const updated: DroneMarker = {
    droneId: sample.droneId,
    serialNumber: existing?.serialNumber,
    model: existing?.model,
    status: existing?.status ?? DEFAULT_DISCOVERED_STATUS,
    position: { lat: sample.lat, lon: sample.lon },
    batteryPct: sample.battery.remainingPct,
    flightMode: sample.flightMode,
    altitude: sample.altitude,
    lastTelemetryTs: sample.ts,
  };

  return { ...state, [sample.droneId]: updated };
}

/**
 * Apply a drone status-change event to the fleet state (Requirement 21.3).
 *
 * - Updates the affected drone's status while preserving its live telemetry.
 * - Creates a marker if the status arrives for an unknown drone (so the fleet
 *   map can represent it immediately, before telemetry/registry data lands).
 * - Returns the input state unchanged when the status is already current, to
 *   avoid a redundant re-render.
 */
export function applyStatusEvent(
  state: FleetMarkerState,
  event: DroneStatusEvent,
): FleetMarkerState {
  const existing = state[event.droneId];

  if (existing) {
    if (existing.status === event.status) {
      return state;
    }
    return { ...state, [event.droneId]: { ...existing, status: event.status } };
  }

  const created: DroneMarker = {
    droneId: event.droneId,
    serialNumber: undefined,
    model: undefined,
    status: event.status,
    position: undefined,
    batteryPct: undefined,
    flightMode: undefined,
    altitude: undefined,
    lastTelemetryTs: undefined,
  };
  return { ...state, [event.droneId]: created };
}

/**
 * Stable, render-friendly list of markers derived from the state map, sorted by
 * drone id so React keys and ordering stay deterministic across updates.
 */
export function toMarkerList(state: FleetMarkerState): DroneMarker[] {
  return Object.values(state).sort((a, b) => a.droneId.localeCompare(b.droneId));
}
