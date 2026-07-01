/**
 * Pure timeline/overlay logic for the detection replay timeline (Requirement 25).
 *
 * Leaflet needs a DOM to render, so — exactly as with the fleet map
 * (`fleet-map-state.ts`) — the *logic* that drives the replay is isolated here
 * as pure, framework-free functions and exercised directly by
 * `detection-replay-state.test.ts`. The React/Leaflet component
 * (`detection-replay.tsx`) is the thin adapter: it fetches a detection set for
 * a selected range through the Gateway (Vision AI), then asks these functions
 * which detections are visible at the current scrub instant and where each
 * oriented bounding box lands on the map.
 *
 * Two concerns are modelled:
 *   1. Timeline scrubbing — given a fetched set of detections, derive the
 *      timeline bounds, convert a scrub fraction `[0, 1]` to a time, and select
 *      the detections visible at a given instant (Requirement 25.1).
 *   2. OBB → map overlay — project an oriented bounding box `[cx, cy, w, h,
 *      angle]` (in frame/image coordinates) onto geographic coordinates so the
 *      component can draw it as a polygon overlay (Requirement 25.1).
 *
 * All functions are pure: they never mutate their inputs and are deterministic
 * for fixed inputs.
 */
import type { Detection, EpochSeconds, Obb, Uuid } from '@pawaac/shared-types';

import type { DetectionQuery } from './api-client';

/** Inclusive `[from, to]` time span (epoch seconds) covered by a detection set. */
export interface TimelineBounds {
  /** Earliest `frameTs` in the set. */
  from: EpochSeconds;
  /** Latest `frameTs` in the set. */
  to: EpochSeconds;
}

/** A geographic coordinate produced when projecting frame coordinates. */
export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * The geographic footprint a camera frame maps onto, used to project frame
 * (image) coordinates into latitude/longitude. `frameWidth`/`frameHeight` are
 * the coordinate-space extents the OBB values are expressed in (use `1` for
 * normalized `[0, 1]` coordinates, or the pixel dimensions for pixel
 * coordinates). Image rows increase downward, so frame `y = 0` maps to `north`
 * and `y = frameHeight` maps to `south`.
 */
export interface FrameGeoRef {
  north: number;
  south: number;
  east: number;
  west: number;
  frameWidth: number;
  frameHeight: number;
}

/** A detection projected to a drawable map overlay (Requirement 25.1). */
export interface DetectionOverlay {
  detectionId: Uuid;
  trackId: Uuid | null;
  cls: string;
  confidence: number;
  /** Frame timestamp (epoch seconds) of the underlying detection. */
  frameTs: EpochSeconds;
  /** Projected OBB centre on the map. */
  center: LatLon;
  /**
   * The four OBB corners projected onto the map, in order
   * (top-left, top-right, bottom-right, bottom-left of the unrotated box,
   * rotated by `angle`). Suitable for a Leaflet `Polygon`.
   */
  corners: LatLon[];
}

/** Default half-width (seconds) of the "visible at this instant" window. */
export const DEFAULT_WINDOW_SECONDS = 0.5;

/**
 * Compute the inclusive time bounds of a detection set, or `null` when the set
 * is empty (no timeline to scrub). Pure; does not mutate the input.
 */
export function computeTimelineBounds(
  detections: readonly Detection[],
): TimelineBounds | null {
  if (detections.length === 0) {
    return null;
  }
  let from = detections[0]!.frameTs;
  let to = detections[0]!.frameTs;
  for (const d of detections) {
    if (d.frameTs < from) {
      from = d.frameTs;
    }
    if (d.frameTs > to) {
      to = d.frameTs;
    }
  }
  return { from, to };
}

/** Clamp a time to the inclusive `[from, to]` timeline bounds. */
export function clampToBounds(bounds: TimelineBounds, t: EpochSeconds): EpochSeconds {
  if (t < bounds.from) {
    return bounds.from;
  }
  if (t > bounds.to) {
    return bounds.to;
  }
  return t;
}

/**
 * Convert a scrub-handle fraction `[0, 1]` into an absolute time within the
 * timeline. `0` maps to `bounds.from`, `1` maps to `bounds.to`; out-of-range
 * fractions are clamped. Deterministic and pure.
 */
export function scrubFractionToTime(bounds: TimelineBounds, fraction: number): EpochSeconds {
  const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  return bounds.from + clamped * (bounds.to - bounds.from);
}

/**
 * Inverse of {@link scrubFractionToTime}: map a time to its fraction `[0, 1]`
 * along the timeline. A zero-width timeline (`from === to`) collapses to `0`.
 */
export function timeToScrubFraction(bounds: TimelineBounds, t: EpochSeconds): number {
  const span = bounds.to - bounds.from;
  if (span <= 0) {
    return 0;
  }
  const clamped = clampToBounds(bounds, t);
  return (clamped - bounds.from) / span;
}

/**
 * Select the detections visible at scrub instant `t` (Requirement 25.1): those
 * whose `frameTs` is within `windowSeconds` of `t`. Results are returned in a
 * deterministic order (ascending `frameTs`, then `id`) and the input is never
 * mutated.
 */
export function selectDetectionsAt(
  detections: readonly Detection[],
  t: EpochSeconds,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
): Detection[] {
  const halfWindow = Math.abs(windowSeconds);
  const visible = detections.filter((d) => Math.abs(d.frameTs - t) <= halfWindow);
  return [...visible].sort(
    (a, b) => a.frameTs - b.frameTs || a.id.localeCompare(b.id),
  );
}

/**
 * Project a frame/image coordinate onto the map using the frame's geographic
 * footprint. Frame `x` runs left→right onto `west`→`east`; frame `y` runs
 * top→bottom onto `north`→`south` (image rows increase downward).
 */
export function projectFramePoint(x: number, y: number, ref: FrameGeoRef): LatLon {
  const fx = ref.frameWidth === 0 ? 0 : x / ref.frameWidth;
  const fy = ref.frameHeight === 0 ? 0 : y / ref.frameHeight;
  return {
    lon: ref.west + fx * (ref.east - ref.west),
    lat: ref.north - fy * (ref.north - ref.south),
  };
}

/**
 * Compute the four corners of an oriented bounding box in frame coordinates.
 * Corners are ordered: top-left, top-right, bottom-right, bottom-left of the
 * unrotated box, each rotated by `angle` (radians) about the box centre.
 */
export function obbCornersInFrame(obb: Obb): Array<[number, number]> {
  const [cx, cy, w, h, angle] = obb;
  const hw = w / 2;
  const hh = h / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const local: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return local.map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);
}

/**
 * Project a detection's OBB onto the map as a drawable overlay (Requirement
 * 25.1). The OBB centre and its four (rotated) corners are mapped through the
 * frame's geographic footprint. Pure; does not mutate the detection.
 */
export function obbToMapOverlay(detection: Detection, ref: FrameGeoRef): DetectionOverlay {
  const [cx, cy] = detection.obb;
  const center = projectFramePoint(cx, cy, ref);
  const corners = obbCornersInFrame(detection.obb).map(([x, y]) =>
    projectFramePoint(x, y, ref),
  );
  return {
    detectionId: detection.id,
    trackId: detection.trackId,
    cls: detection.cls,
    confidence: detection.confidence,
    frameTs: detection.frameTs,
    center,
    corners,
  };
}

/**
 * Project every detection visible at instant `t` into map overlays
 * (Requirement 25.1), preserving the deterministic ordering of
 * {@link selectDetectionsAt}.
 */
export function overlaysAt(
  detections: readonly Detection[],
  t: EpochSeconds,
  ref: FrameGeoRef,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
): DetectionOverlay[] {
  return selectDetectionsAt(detections, t, windowSeconds).map((d) => obbToMapOverlay(d, ref));
}

/**
 * Build a {@link DetectionQuery} for the Gateway from a selected time range
 * (Requirement 25.2), normalizing reversed ranges so `from <= to`. An optional
 * drone id scopes the query to a single aircraft.
 */
export function buildReplayQuery(
  from: EpochSeconds,
  to: EpochSeconds,
  droneId?: Uuid,
): DetectionQuery {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return droneId === undefined ? { from: lo, to: hi } : { from: lo, to: hi, droneId };
}
