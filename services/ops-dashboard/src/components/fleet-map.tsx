'use client';

/**
 * Real-time fleet status map (Requirement 21).
 *
 * Renders a Leaflet map (via react-leaflet) with one marker per drone. The map
 * is seeded with the current fleet from the Gateway, then kept live by a
 * telemetry WebSocket:
 *   - `telemetry:sample` → updates each drone's position, battery and flight
 *     mode (Requirements 21.1, 21.2)
 *   - `drone:status`     → updates the affected drone's representation
 *     (Requirement 21.3)
 *
 * All state transitions are delegated to the pure reducers in
 * `lib/fleet-map-state` (unit-tested in isolation, since Leaflet needs a DOM);
 * this component is the thin React/Leaflet adapter around them.
 *
 * Leaflet only runs in the browser, so this module is `'use client'` and is
 * loaded with `ssr: false` from `app/fleet-map/page.tsx`.
 */
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useState } from 'react';
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip } from 'react-leaflet';
import type { DroneStatus } from '@pawaac/shared-types';

import { apiClient, type GatewayApiClient } from '@/lib/api-client';
import {
  createTelemetrySocket,
  type SocketAuthOptions,
  type TelemetrySocket,
} from '@/lib/ws-client';
import {
  applyStatusEvent,
  applyTelemetrySample,
  emptyFleetState,
  seedDrones,
  toMarkerList,
  type DroneMarker,
  type FleetMarkerState,
} from '@/lib/fleet-map-state';

/** Default map view (world view) used until telemetry recenters attention. */
const DEFAULT_CENTER: [number, number] = [20, 0];
const DEFAULT_ZOOM = 3;

/** Marker fill/stroke colour per lifecycle status. */
const STATUS_COLORS: Record<DroneStatus, string> = {
  active: '#22c55e',
  maintenance: '#f59e0b',
  decommissioned: '#94a3b8',
};

/** Minimal slice of the Gateway client the map depends on (eases testing). */
type FleetMapClient = Pick<GatewayApiClient, 'listDrones'>;

export interface FleetMapProps {
  /** Gateway client; defaults to the shared configured instance. */
  client?: FleetMapClient;
  /** Telemetry socket factory; defaults to `createTelemetrySocket`. */
  createSocket?: (options?: SocketAuthOptions) => TelemetrySocket;
  /** JWT forwarded to the Gateway/socket for authenticated streams. */
  token?: string;
  /** Initial map centre, `[lat, lon]`. */
  center?: [number, number];
  /** Initial zoom level. */
  zoom?: number;
}

/**
 * Subscribe to the fleet's live marker state: seed from the Gateway, then apply
 * telemetry samples and status events through the pure reducers.
 */
function useFleetMarkers(
  client: FleetMapClient,
  makeSocket: () => TelemetrySocket,
  token: string | undefined,
): FleetMarkerState {
  const [state, setState] = useState<FleetMarkerState>(emptyFleetState);

  // Seed the initial fleet from the registry (via the Gateway).
  useEffect(() => {
    let cancelled = false;
    client
      .listDrones(token)
      .then((drones) => {
        if (!cancelled) {
          // Merge the seed under any markers telemetry already produced.
          setState((prev) => ({ ...seedDrones(drones), ...prev }));
        }
      })
      .catch(() => {
        // A failed seed is non-fatal: live telemetry will still populate the
        // map as samples arrive. Surfacing seed errors in the UI is handled by
        // the dashboard-wide error boundary work (separate task).
      });
    return () => {
      cancelled = true;
    };
  }, [client, token]);

  // Keep the fleet live over the telemetry socket.
  useEffect(() => {
    const socket = makeSocket();

    socket.on('telemetry:sample', (sample) => {
      setState((prev) => applyTelemetrySample(prev, sample));
    });
    socket.on('drone:status', (event) => {
      setState((prev) => applyStatusEvent(prev, event));
    });

    socket.connect();
    return () => {
      socket.off('telemetry:sample');
      socket.off('drone:status');
      socket.disconnect();
    };
  }, [makeSocket]);

  return state;
}

function formatBattery(marker: DroneMarker): string {
  return marker.batteryPct === undefined ? '—' : `${Math.round(marker.batteryPct)}%`;
}

function FleetMarker({ marker }: { marker: DroneMarker }) {
  if (!marker.position) {
    return null;
  }
  const color = STATUS_COLORS[marker.status];
  const label = marker.serialNumber ?? marker.droneId;

  return (
    <CircleMarker
      center={[marker.position.lat, marker.position.lon]}
      radius={9}
      pathOptions={{ color, fillColor: color, fillOpacity: 0.85, weight: 2 }}
    >
      <Tooltip direction="top" offset={[0, -8]}>
        {label} · {marker.flightMode ?? 'UNKNOWN'} · {formatBattery(marker)}
      </Tooltip>
      <Popup>
        <div className="space-y-1 text-xs">
          <div className="font-semibold">{label}</div>
          {marker.model ? <div>Model: {marker.model}</div> : null}
          <div>Status: {marker.status}</div>
          <div>Flight mode: {marker.flightMode ?? 'unknown'}</div>
          <div>Battery: {formatBattery(marker)}</div>
          {marker.altitude !== undefined ? (
            <div>Altitude: {Math.round(marker.altitude)} m</div>
          ) : null}
        </div>
      </Popup>
    </CircleMarker>
  );
}

/** The real-time fleet status map. */
export function FleetMap({
  client = apiClient,
  createSocket = createTelemetrySocket,
  token,
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
}: FleetMapProps = {}) {
  // The socket factory is wrapped so its identity is stable across renders for
  // the subscription effect (callers may pass an inline default).
  const makeSocket = useMemo(
    () => () => createSocket(token ? { token } : {}),
    [createSocket, token],
  );

  const state = useFleetMarkers(client, makeSocket, token);
  const markers = useMemo(() => toMarkerList(state), [state]);
  const positioned = markers.filter((m) => m.position);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Fleet Map</h2>
        <span className="text-xs text-slate-400" data-testid="fleet-count">
          {positioned.length} live / {markers.length} known
        </span>
      </div>
      <div className="h-[70vh] overflow-hidden rounded-lg border border-slate-800">
        <MapContainer
          center={center}
          zoom={zoom}
          scrollWheelZoom
          className="h-full w-full"
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {positioned.map((marker) => (
            <FleetMarker key={marker.droneId} marker={marker} />
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

export default FleetMap;
