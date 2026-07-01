'use client';

/**
 * Detection replay timeline (Requirement 25).
 *
 * An analyst selects a time range (and optionally a drone); the component
 * queries detections for that range through the Gateway from Vision AI
 * (Requirement 25.2). A timeline slider then scrubs through the mission window
 * and the detections visible at the selected instant are overlaid on a Leaflet
 * map as oriented bounding boxes (Requirement 25.1).
 *
 * All timeline/projection logic is delegated to the pure functions in
 * `lib/detection-replay-state` (unit-tested in isolation, since Leaflet needs a
 * DOM); this component is the thin React/Leaflet adapter around them. Leaflet
 * only runs in the browser, so this module is `'use client'` and is loaded with
 * `ssr: false` from `app/replay/page.tsx`.
 */
import 'leaflet/dist/leaflet.css';
import { useCallback, useMemo, useState } from 'react';
import { MapContainer, Polygon, Popup, TileLayer, Tooltip } from 'react-leaflet';
import type { Detection } from '@pawaac/shared-types';

import { apiClient, ApiError, type GatewayApiClient } from '@/lib/api-client';
import {
  buildReplayQuery,
  computeTimelineBounds,
  overlaysAt,
  scrubFractionToTime,
  type DetectionOverlay,
  type FrameGeoRef,
  type TimelineBounds,
} from '@/lib/detection-replay-state';

/** Default map view (world view). */
const DEFAULT_CENTER: [number, number] = [20, 0];
const DEFAULT_ZOOM = 3;

/**
 * Default frame footprint used to project OBB coordinates onto the map. OBB
 * coordinates are treated as normalized `[0, 1]` frame fractions; the footprint
 * is a small demo box centred near the default view. A production deployment
 * would derive this per-frame from the drone's pose/camera model.
 */
const DEFAULT_FRAME_REF: FrameGeoRef = {
  north: 20.01,
  south: 19.99,
  east: 0.01,
  west: -0.01,
  frameWidth: 1,
  frameHeight: 1,
};

/** Resolution of the scrub slider (number of discrete steps). */
const SCRUB_STEPS = 1000;

/** Outline/fill colour per detection class (falls back to a default). */
const CLASS_COLORS: Record<string, string> = {
  person: '#38bdf8',
  vehicle: '#f97316',
  animal: '#a3e635',
};

function colorForClass(cls: string): string {
  return CLASS_COLORS[cls] ?? '#e879f9';
}

/** Minimal slice of the Gateway client the replay depends on (eases testing). */
type ReplayClient = Pick<GatewayApiClient, 'queryDetections'>;

export interface DetectionReplayProps {
  /** Gateway client; defaults to the shared configured instance. */
  client?: ReplayClient;
  /** JWT forwarded to the Gateway for authenticated queries. */
  token?: string;
  /** Frame geographic footprint used to project OBBs onto the map. */
  frameRef?: FrameGeoRef;
  /** Initial map centre, `[lat, lon]`. */
  center?: [number, number];
  /** Initial zoom level. */
  zoom?: number;
}

/** Format an epoch-seconds instant as an ISO 8601 string for display. */
function formatInstant(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/** Convert an ISO 8601 `datetime-local` value to epoch seconds. */
function isoToEpochSeconds(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

function OverlayPolygon({ overlay }: { overlay: DetectionOverlay }) {
  const color = colorForClass(overlay.cls);
  const positions = overlay.corners.map((c) => [c.lat, c.lon] as [number, number]);

  return (
    <Polygon
      positions={positions}
      pathOptions={{ color, fillColor: color, fillOpacity: 0.25, weight: 2 }}
    >
      <Tooltip direction="top" sticky>
        {overlay.cls} · {(overlay.confidence * 100).toFixed(0)}%
      </Tooltip>
      <Popup>
        <div className="space-y-1 text-xs">
          <div className="font-semibold">{overlay.cls}</div>
          <div>Detection: {overlay.detectionId}</div>
          <div>Track: {overlay.trackId ?? 'unassigned'}</div>
          <div>Confidence: {(overlay.confidence * 100).toFixed(1)}%</div>
          <div>Frame: {formatInstant(overlay.frameTs)}</div>
        </div>
      </Popup>
    </Polygon>
  );
}

/** The detection replay timeline surface. */
export function DetectionReplay({
  client = apiClient,
  token,
  frameRef = DEFAULT_FRAME_REF,
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
}: DetectionReplayProps = {}) {
  const [droneId, setDroneId] = useState('');
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');

  const [detections, setDetections] = useState<Detection[]>([]);
  const [bounds, setBounds] = useState<TimelineBounds | null>(null);
  const [scrub, setScrub] = useState(0); // [0, 1]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load detections for the selected range through the Gateway (Req 25.2).
  const loadRange = useCallback(async () => {
    const from = isoToEpochSeconds(fromInput);
    const to = isoToEpochSeconds(toInput);
    if (from === null || to === null) {
      setError('Enter a valid from/to time range.');
      return;
    }

    const trimmedDrone = droneId.trim();
    const query = buildReplayQuery(from, to, trimmedDrone === '' ? undefined : trimmedDrone);

    setLoading(true);
    setError(null);
    try {
      const result = await client.queryDetections(query, token);
      setDetections(result);
      setBounds(computeTimelineBounds(result));
      setScrub(0);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Failed to query detections from the Gateway.';
      setError(message);
      setDetections([]);
      setBounds(null);
    } finally {
      setLoading(false);
    }
  }, [client, droneId, fromInput, toInput, token]);

  // Current scrub instant and the overlays visible there (Req 25.1).
  const currentTime = useMemo(
    () => (bounds ? scrubFractionToTime(bounds, scrub) : null),
    [bounds, scrub],
  );
  const overlays = useMemo(
    () => (currentTime === null ? [] : overlaysAt(detections, currentTime, frameRef)),
    [detections, currentTime, frameRef],
  );

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold">Detection Replay</h2>
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-slate-400">Drone (optional)</span>
            <input
              aria-label="Drone id"
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
              placeholder="all drones"
              value={droneId}
              onChange={(e) => setDroneId(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-400">From</span>
            <input
              aria-label="From time"
              type="datetime-local"
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-400">To</span>
            <input
              aria-label="To time"
              type="datetime-local"
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="rounded bg-sky-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
            onClick={() => void loadRange()}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Load range'}
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-rose-400" data-testid="replay-error">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 rounded-lg border border-slate-800 p-3">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span data-testid="replay-summary">
            {detections.length} detection{detections.length === 1 ? '' : 's'} ·{' '}
            {overlays.length} visible now
          </span>
          <span data-testid="replay-instant">
            {currentTime === null ? 'no range loaded' : formatInstant(currentTime)}
          </span>
        </div>
        <input
          aria-label="Timeline scrubber"
          data-testid="replay-scrubber"
          type="range"
          min={0}
          max={SCRUB_STEPS}
          step={1}
          value={Math.round(scrub * SCRUB_STEPS)}
          disabled={bounds === null}
          onChange={(e) => setScrub(Number(e.target.value) / SCRUB_STEPS)}
          className="w-full"
        />
      </div>

      <div className="h-[60vh] overflow-hidden rounded-lg border border-slate-800">
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
          {overlays.map((overlay) => (
            <OverlayPolygon key={overlay.detectionId} overlay={overlay} />
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

export default DetectionReplay;
