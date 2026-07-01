'use client';

/**
 * Drag-and-drop mission planner (Requirement 22).
 *
 * A Leaflet (react-leaflet) editor that lets a planner:
 *   - place and drag waypoints to build an ordered route (Req 22.1)
 *   - draw a geofence polygon and submit it as a Geofence definition (Req 22.2)
 *   - submit the mission through the Gateway to Mission Planning (Req 22.3)
 *   - keep working from a local-storage draft and retry on a failed
 *     transmission (Req 22.4)
 *   - see the conflicting route segments Mission Planning reports (Req 22.5)
 *
 * Following the fleet-map (task 15.2) pattern, all non-visual logic lives in the
 * pure, unit-tested `lib/mission-planner-state` module; this component is the
 * thin react-leaflet/Gateway adapter. Leaflet only runs in the browser, so this
 * module is `'use client'` and is loaded with `ssr: false` from its page route.
 */
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  TileLayer,
  Tooltip,
  useMapEvents,
} from 'react-leaflet';
import type { GeoPoint, GeofenceConflict } from '@pawaac/shared-types';

import { apiClient, ApiError, type GatewayApiClient } from '@/lib/api-client';
import {
  addWaypoint,
  appendVertex,
  canTransmit,
  clearDraft,
  closeRing,
  conflictingSegmentIndices,
  emptyDraft,
  loadDraft,
  mapConflictSegments,
  markFailed,
  markPending,
  markSubmitted,
  moveWaypoint,
  nextRetryDelayMs,
  removeLastVertex,
  removeWaypoint,
  saveDraft,
  type DraftStorage,
  type MissionDraft,
} from '@/lib/mission-planner-state';

/** Default map view used until the planner starts placing waypoints. */
const DEFAULT_CENTER: [number, number] = [20, 0];
const DEFAULT_ZOOM = 3;

/** The two map-interaction modes the planner can be in. */
type EditMode = 'waypoint' | 'geofence';

/** Slice of the Gateway client this editor depends on (eases testing). */
type PlannerClient = Pick<
  GatewayApiClient,
  'submitMission' | 'submitGeofence' | 'checkGeofenceConflicts'
>;

export interface MissionPlannerProps {
  /** Gateway client; defaults to the shared configured instance. */
  client?: PlannerClient;
  /** JWT forwarded to the Gateway for authenticated routes. */
  token?: string;
  /** Draft storage; defaults to the browser's `localStorage`. */
  storage?: DraftStorage;
  center?: [number, number];
  zoom?: number;
}

/** A small numbered pin so waypoints are draggable without external icon assets. */
function waypointIcon(seq: number, conflicted: boolean): L.DivIcon {
  const bg = conflicted ? '#ef4444' : '#2563eb';
  return L.divIcon({
    className: 'pawaac-waypoint-pin',
    html: `<div style="background:${bg};color:#fff;border:2px solid #fff;border-radius:9999px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.4)">${seq + 1}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

/** Resolve the browser `localStorage` lazily and safely (SSR/test friendly). */
function defaultStorage(): DraftStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Captures map clicks and routes them to the active edit mode. */
function MapClickHandler({
  mode,
  onWaypoint,
  onVertex,
}: {
  mode: EditMode;
  onWaypoint: (point: { lat: number; lon: number }) => void;
  onVertex: (point: { lat: number; lon: number }) => void;
}) {
  useMapEvents({
    click(event) {
      const point = { lat: event.latlng.lat, lon: event.latlng.lng };
      if (mode === 'waypoint') {
        onWaypoint(point);
      } else {
        onVertex(point);
      }
    },
  });
  return null;
}

export function MissionPlanner({
  client = apiClient,
  token,
  storage,
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
}: MissionPlannerProps = {}) {
  const store = useMemo<DraftStorage | null>(
    () => storage ?? defaultStorage(),
    [storage],
  );

  const [draft, setDraft] = useState<MissionDraft>(() => emptyDraft());
  const [mode, setMode] = useState<EditMode>('waypoint');
  const [drawing, setDrawing] = useState<GeoPoint[]>([]);
  const [conflicts, setConflicts] = useState<GeofenceConflict[]>([]);
  const [status, setStatus] = useState<string>('');
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Rehydrate any persisted draft on mount so work survives a reload or an
  // interrupted submission (Requirement 22.4).
  useEffect(() => {
    if (!store) {
      return;
    }
    const restored = loadDraft(store);
    if (restored) {
      setDraft(restored);
      if (restored.transmission.status === 'failed') {
        setStatus('Restored an unsent mission draft — you can retry submission.');
      }
    }
  }, [store]);

  // Persist on every draft change (best-effort).
  useEffect(() => {
    if (store) {
      saveDraft(store, draft);
    }
  }, [store, draft]);

  // Clear any pending retry timer on unmount.
  useEffect(() => {
    return () => {
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
      }
    };
  }, []);

  const handleAddWaypoint = useCallback(
    (point: { lat: number; lon: number }) => {
      setDraft((prev) => ({ ...prev, waypoints: addWaypoint(prev.waypoints, point) }));
      setConflicts([]);
    },
    [],
  );

  const handleVertex = useCallback((point: { lat: number; lon: number }) => {
    setDrawing((prev) => appendVertex(prev, point));
  }, []);

  const handleDragWaypoint = useCallback((seq: number, lat: number, lon: number) => {
    setDraft((prev) => ({ ...prev, waypoints: moveWaypoint(prev.waypoints, seq, { lat, lon }) }));
    setConflicts([]);
  }, []);

  const handleRemoveWaypoint = useCallback((seq: number) => {
    setDraft((prev) => ({ ...prev, waypoints: removeWaypoint(prev.waypoints, seq) }));
    setConflicts([]);
  }, []);

  const submitGeofence = useCallback(async () => {
    const ring = closeRing(drawing);
    if (!ring) {
      setStatus('Draw at least three points before submitting a geofence.');
      return;
    }
    const name = `${draft.name} NFZ ${draft.geofences.length + 1}`;
    try {
      await client.submitGeofence({ name, polygon: ring }, token);
      setDraft((prev) => ({
        ...prev,
        geofences: [...prev.geofences, { name, polygon: ring }],
      }));
      setDrawing([]);
      setStatus(`Geofence "${name}" submitted.`);
    } catch (error) {
      setStatus(`Geofence submission failed: ${describeError(error)}`);
    }
  }, [client, draft.geofences.length, draft.name, drawing, token]);

  const transmitMission = useCallback(async () => {
    const submission = { name: draft.name, waypoints: draft.waypoints };
    setDraft((prev) => ({ ...prev, transmission: markPending(prev.transmission) }));
    setStatus('Submitting mission…');

    try {
      // Surface any geofence conflicts Mission Planning reports (Req 22.5).
      const reported = await client.checkGeofenceConflicts(submission, token);
      setConflicts(reported);
      if (reported.length > 0) {
        setDraft((prev) => ({
          ...prev,
          transmission: markFailed(prev.transmission, 'Mission has geofence conflicts.'),
        }));
        setStatus(`Mission has ${reported.length} geofence conflict(s); see highlighted segments.`);
        return;
      }

      await client.submitMission(submission, token);
      setConflicts([]);
      setDraft((prev) => ({ ...prev, transmission: markSubmitted(prev.transmission) }));
      setStatus('Mission submitted to Mission Planning.');
      if (store) {
        clearDraft(store);
      }
    } catch (error) {
      // Transmission failure: keep the draft locally and schedule a retry
      // (Requirement 22.4). The draft is already persisted by the effect above.
      setDraft((prev) => {
        const transmission = markFailed(prev.transmission, describeError(error));
        const delay = nextRetryDelayMs(transmission.attempts);
        if (retryTimer.current) {
          clearTimeout(retryTimer.current);
        }
        retryTimer.current = setTimeout(() => {
          void transmitMission();
        }, delay);
        setStatus(
          `Transmission failed (${describeError(error)}); saved locally, retrying in ${Math.round(
            delay / 1000,
          )}s.`,
        );
        return { ...prev, transmission };
      });
    }
  }, [client, draft.name, draft.waypoints, store, token]);

  const conflictSegments = useMemo(
    () => mapConflictSegments(draft.waypoints, conflicts),
    [draft.waypoints, conflicts],
  );
  const conflictedSet = useMemo(() => conflictingSegmentIndices(conflicts), [conflicts]);

  const routeLine = draft.waypoints.map((w) => [w.lat, w.lon] as [number, number]);
  const drawingLine = drawing.map(([lon, lat]) => [lat, lon] as [number, number]);
  const canSubmit = draft.waypoints.length >= 2 && canTransmit(draft.transmission);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Mission Planner</h2>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setMode('waypoint')}
            className={`rounded px-2 py-1 ${mode === 'waypoint' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300'}`}
            data-testid="mode-waypoint"
          >
            Waypoints
          </button>
          <button
            type="button"
            onClick={() => setMode('geofence')}
            className={`rounded px-2 py-1 ${mode === 'geofence' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300'}`}
            data-testid="mode-geofence"
          >
            Draw geofence
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
        <span data-testid="waypoint-count">{draft.waypoints.length} waypoints</span>
        <span>·</span>
        <span data-testid="geofence-count">{draft.geofences.length} geofences</span>
        {mode === 'geofence' ? (
          <>
            <button
              type="button"
              onClick={() => setDrawing((prev) => removeLastVertex(prev))}
              className="rounded bg-slate-800 px-2 py-1"
              disabled={drawing.length === 0}
            >
              Undo point
            </button>
            <button
              type="button"
              onClick={() => void submitGeofence()}
              className="rounded bg-emerald-600 px-2 py-1 text-white"
              disabled={drawing.length < 3}
              data-testid="submit-geofence"
            >
              Submit geofence
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => void transmitMission()}
          className="rounded bg-emerald-600 px-2 py-1 text-white disabled:opacity-40"
          disabled={!canSubmit}
          data-testid="submit-mission"
        >
          {draft.transmission.status === 'failed' ? 'Retry submit' : 'Submit mission'}
        </button>
      </div>

      {status ? (
        <p className="text-xs text-amber-300" data-testid="planner-status" role="status">
          {status}
        </p>
      ) : null}

      {conflictSegments.length > 0 ? (
        <p className="text-xs text-red-400" data-testid="conflict-summary">
          Conflicting segments:{' '}
          {conflictSegments.map((s) => `#${s.segmentIndex + 1}`).join(', ')}
        </p>
      ) : null}

      <div className="h-[65vh] overflow-hidden rounded-lg border border-slate-800">
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

          <MapClickHandler mode={mode} onWaypoint={handleAddWaypoint} onVertex={handleVertex} />

          {/* Base route line. */}
          {routeLine.length >= 2 ? (
            <Polyline positions={routeLine} pathOptions={{ color: '#2563eb', weight: 3 }} />
          ) : null}

          {/* Conflicting segments highlighted in red (Requirement 22.5). */}
          {conflictSegments.map((seg) => (
            <Polyline
              key={`${seg.segmentIndex}-${seg.zoneId}`}
              positions={[
                [seg.from.lat, seg.from.lon],
                [seg.to.lat, seg.to.lon],
              ]}
              pathOptions={{ color: '#ef4444', weight: 5, opacity: 0.9 }}
            >
              <Tooltip sticky>Conflict with zone {seg.zoneId}</Tooltip>
            </Polyline>
          ))}

          {/* Draggable waypoint pins (Requirement 22.1). */}
          {draft.waypoints.map((wp) => (
            <Marker
              key={wp.seq}
              position={[wp.lat, wp.lon]}
              draggable
              icon={waypointIcon(
                wp.seq,
                conflictedSet.has(wp.seq) || conflictedSet.has(wp.seq - 1),
              )}
              eventHandlers={{
                dragend: (event) => {
                  const { lat, lng } = event.target.getLatLng();
                  handleDragWaypoint(wp.seq, lat, lng);
                },
                contextmenu: () => handleRemoveWaypoint(wp.seq),
              }}
            >
              <Tooltip direction="top" offset={[0, -12]}>
                WP {wp.seq + 1} · {wp.altitude} m · {wp.speed} m/s (right-click to remove)
              </Tooltip>
            </Marker>
          ))}

          {/* In-progress geofence drawing + already-drawn zones (Requirement 22.2). */}
          {drawingLine.length >= 2 ? (
            <Polyline positions={drawingLine} pathOptions={{ color: '#f59e0b', dashArray: '4' }} />
          ) : null}
          {draft.geofences.map((gf, index) => (
            <Polygon
              key={`${gf.name}-${index}`}
              positions={gf.polygon.map(([lon, lat]) => [lat, lon] as [number, number])}
              pathOptions={{ color: '#f59e0b', fillOpacity: 0.15 }}
            >
              <Tooltip sticky>{gf.name}</Tooltip>
            </Polygon>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

/** Format an unknown thrown value into a concise, user-facing message. */
function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problem?.detail ?? error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'unknown error';
}

export default MissionPlanner;
