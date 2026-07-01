/**
 * Pure state/logic for the drag-and-drop mission planner (Requirement 22).
 *
 * Leaflet needs a DOM to render, so — exactly as the fleet map (task 15.2) does
 * — the *logic* that drives the planner is isolated here as pure,
 * framework-free functions, and the react-leaflet component
 * (`components/mission-planner.tsx`) is a thin adapter that wires map
 * interactions and the Gateway client into these reducers.
 *
 * Three concerns live here, each independently unit-tested in
 * `mission-planner-state.test.ts`:
 *   1. Waypoint-list reduction — add / drag / move / remove / reorder, always
 *      producing a contiguous `seq` from 0 (Requirement 22.1).
 *   2. Geofence polygon drawing — accumulate vertices and close them into a
 *      valid `GeoPolygon` ring for submission (Requirement 22.2).
 *   3. Local-storage draft persistence + transmission retry — survive a failed
 *      submission and keep working locally (Requirement 22.4).
 *   4. Conflict-segment mapping — turn `GeofenceConflict[]` reported by Mission
 *      Planning into drawable route segments (Requirement 22.5).
 *
 * Every function is pure: inputs are never mutated and a new value is returned,
 * so they compose with `setState(prev => reduce(prev, ...))`.
 */
import type { GeoPoint, GeoPolygon, Uuid, Waypoint } from '@pawaac/shared-types';
import type { GeofenceConflict } from '@pawaac/shared-types';

// ---------------------------------------------------------------------------
// Waypoint-list reduction (Requirement 22.1)
// ---------------------------------------------------------------------------

/** A latitude/longitude pair as produced by a Leaflet click or marker drag. */
export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Default flight parameters applied to a freshly placed waypoint. These sit
 * comfortably inside the ranges Mission Planning validates (altitude `> 0`,
 * speed `> 0`, gimbal `[-90, 90]`, loiter `>= 0`) so a just-dropped pin is
 * immediately submittable; the planner can fine-tune them afterwards.
 */
export const DEFAULT_WAYPOINT_PARAMS: Omit<Waypoint, 'seq' | 'lat' | 'lon'> = {
  altitude: 50,
  speed: 5,
  gimbalAngle: 0,
  loiterTime: 0,
};

/**
 * Re-number a list of waypoints so `seq` is contiguous starting at 0, following
 * the array order. Used after any structural edit (add/remove/reorder) to keep
 * the invariant Mission Planning expects (Requirement 4.4).
 */
export function resequence(waypoints: readonly Waypoint[]): Waypoint[] {
  return waypoints.map((wp, index) => (wp.seq === index ? wp : { ...wp, seq: index }));
}

/**
 * Append a new waypoint at the dropped position with default flight params,
 * receiving the next sequence index. Optional `overrides` let a caller seed
 * non-default params at creation time.
 */
export function addWaypoint(
  waypoints: readonly Waypoint[],
  position: LatLon,
  overrides: Partial<Omit<Waypoint, 'seq' | 'lat' | 'lon'>> = {},
): Waypoint[] {
  const waypoint: Waypoint = {
    seq: waypoints.length,
    lat: position.lat,
    lon: position.lon,
    ...DEFAULT_WAYPOINT_PARAMS,
    ...overrides,
  };
  return [...waypoints, waypoint];
}

/**
 * Move the waypoint at `seq` to a new position (a drag). Other waypoints and
 * the ordering are untouched. Unknown `seq` returns the list unchanged.
 */
export function moveWaypoint(
  waypoints: readonly Waypoint[],
  seq: number,
  position: LatLon,
): Waypoint[] {
  let found = false;
  const next = waypoints.map((wp) => {
    if (wp.seq !== seq) {
      return wp;
    }
    found = true;
    return { ...wp, lat: position.lat, lon: position.lon };
  });
  return found ? next : waypoints.slice();
}

/**
 * Update arbitrary flight parameters (altitude, speed, gimbal, loiter) of the
 * waypoint at `seq`. Position-only edits should use {@link moveWaypoint}.
 */
export function updateWaypoint(
  waypoints: readonly Waypoint[],
  seq: number,
  patch: Partial<Omit<Waypoint, 'seq'>>,
): Waypoint[] {
  let found = false;
  const next = waypoints.map((wp) => {
    if (wp.seq !== seq) {
      return wp;
    }
    found = true;
    return { ...wp, ...patch, seq: wp.seq };
  });
  return found ? next : waypoints.slice();
}

/**
 * Remove the waypoint at `seq` and re-index the remainder so `seq` stays
 * contiguous from 0. Unknown `seq` returns the list unchanged.
 */
export function removeWaypoint(waypoints: readonly Waypoint[], seq: number): Waypoint[] {
  const filtered = waypoints.filter((wp) => wp.seq !== seq);
  if (filtered.length === waypoints.length) {
    return waypoints.slice();
  }
  return resequence(filtered);
}

/**
 * Move a waypoint from one ordinal position to another (e.g. a list re-order
 * drag) and re-index so `seq` matches the new order. Out-of-range indices
 * return the list unchanged.
 */
export function reorderWaypoints(
  waypoints: readonly Waypoint[],
  fromIndex: number,
  toIndex: number,
): Waypoint[] {
  const size = waypoints.length;
  if (
    fromIndex < 0 ||
    fromIndex >= size ||
    toIndex < 0 ||
    toIndex >= size ||
    fromIndex === toIndex
  ) {
    return waypoints.slice();
  }
  const copy = waypoints.slice();
  const [moved] = copy.splice(fromIndex, 1);
  if (!moved) {
    return waypoints.slice();
  }
  copy.splice(toIndex, 0, moved);
  return resequence(copy);
}

// ---------------------------------------------------------------------------
// Geofence polygon drawing (Requirement 22.2)
// ---------------------------------------------------------------------------

/**
 * Append a vertex to an in-progress polygon ring. Vertices are stored as
 * `GeoPoint` (`[lon, lat]`, GeoJSON axis order) to match the shared geometry
 * types and Mission Planning's polygon contract.
 */
export function appendVertex(vertices: readonly GeoPoint[], point: LatLon): GeoPoint[] {
  return [...vertices, [point.lon, point.lat] as GeoPoint];
}

/** Remove the most recently added vertex (an "undo" while drawing). */
export function removeLastVertex(vertices: readonly GeoPoint[]): GeoPoint[] {
  return vertices.slice(0, Math.max(0, vertices.length - 1));
}

function pointsEqual(a: GeoPoint, b: GeoPoint): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Whether a polygon is a valid closed ring for submission: at least four points
 * with the first and last identical (a closed triangle is the minimal case).
 */
export function isClosedRing(polygon: readonly GeoPoint[]): boolean {
  if (polygon.length < 4) {
    return false;
  }
  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  return first !== undefined && last !== undefined && pointsEqual(first, last);
}

/**
 * Close an in-progress vertex list into a submittable `GeoPolygon` ring by
 * appending the first point if necessary. Returns `null` when there are too few
 * distinct vertices to form a polygon (fewer than three).
 */
export function closeRing(vertices: readonly GeoPoint[]): GeoPolygon | null {
  if (vertices.length < 3) {
    return null;
  }
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  const ring: GeoPolygon = pointsEqual(first, last)
    ? vertices.slice()
    : [...vertices, first];
  return isClosedRing(ring) ? ring : null;
}

// ---------------------------------------------------------------------------
// Local-storage draft persistence + transmission retry (Requirement 22.4)
// ---------------------------------------------------------------------------

/** Status of the attempt to transmit a mission to Mission Planning. */
export type TransmissionStatus = 'idle' | 'pending' | 'failed' | 'submitted';

/** Tracks the in-flight/last transmission so the UI can retry deterministically. */
export interface TransmissionState {
  status: TransmissionStatus;
  /** Number of failed attempts recorded so far. */
  attempts: number;
  /** Human-readable detail of the most recent failure, if any. */
  lastError: string | undefined;
}

/** A geofence the planner has drawn but not necessarily submitted yet. */
export interface DraftGeofence {
  name: string;
  polygon: GeoPolygon;
}

/**
 * The full, serializable planner draft. Persisted to local storage so a planner
 * can keep working — and retry transmission — across a failed submission or a
 * page reload (Requirement 22.4).
 */
export interface MissionDraft {
  name: string;
  waypoints: Waypoint[];
  geofences: DraftGeofence[];
  transmission: TransmissionState;
}

/** Minimal `Storage`-like surface so the persistence logic is testable in Node. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Local-storage key under which the working draft is persisted. */
export const DRAFT_STORAGE_KEY = 'pawaac:mission-planner:draft';

/** A fresh, empty transmission state. */
export function idleTransmission(): TransmissionState {
  return { status: 'idle', attempts: 0, lastError: undefined };
}

/** A fresh, empty mission draft. */
export function emptyDraft(name = 'Untitled Mission'): MissionDraft {
  return {
    name,
    waypoints: [],
    geofences: [],
    transmission: idleTransmission(),
  };
}

/** Mark a draft as mid-transmission (request in flight). */
export function markPending(state: TransmissionState): TransmissionState {
  return { status: 'pending', attempts: state.attempts, lastError: undefined };
}

/**
 * Record a failed transmission: increment the attempt counter, capture the
 * error, and move to `failed` so the UI can offer a retry (Requirement 22.4).
 */
export function markFailed(state: TransmissionState, error: string): TransmissionState {
  return { status: 'failed', attempts: state.attempts + 1, lastError: error };
}

/** Record a successful transmission (clears any prior error). */
export function markSubmitted(state: TransmissionState): TransmissionState {
  return { status: 'submitted', attempts: state.attempts, lastError: undefined };
}

/** Whether a transmission may be (re)attempted from the current state. */
export function canTransmit(state: TransmissionState): boolean {
  return state.status === 'idle' || state.status === 'failed';
}

/**
 * Exponential backoff (capped) for the next retry, based on prior attempts.
 * Pure and deterministic so it is unit-testable: 1s, 2s, 4s, … up to 30s.
 */
export function nextRetryDelayMs(attempts: number, baseMs = 1000, capMs = 30_000): number {
  if (attempts <= 0) {
    return baseMs;
  }
  const delay = baseMs * 2 ** (attempts - 1);
  return Math.min(delay, capMs);
}

/** Serialize and persist the working draft. Never throws on a bad storage. */
export function saveDraft(storage: DraftStorage, draft: MissionDraft): void {
  try {
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Persistence is best-effort; a full/disabled storage must not break the
    // editor. The in-memory draft remains the source of truth.
  }
}

function isLatLonNumberPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  );
}

function isWaypoint(value: unknown): value is Waypoint {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const wp = value as Record<string, unknown>;
  return (
    typeof wp.seq === 'number' &&
    typeof wp.lat === 'number' &&
    typeof wp.lon === 'number' &&
    typeof wp.altitude === 'number' &&
    typeof wp.speed === 'number' &&
    typeof wp.gimbalAngle === 'number' &&
    typeof wp.loiterTime === 'number'
  );
}

function isDraftGeofence(value: unknown): value is DraftGeofence {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const gf = value as Record<string, unknown>;
  return (
    typeof gf.name === 'string' &&
    Array.isArray(gf.polygon) &&
    gf.polygon.every(isLatLonNumberPair)
  );
}

function isTransmissionState(value: unknown): value is TransmissionState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const t = value as Record<string, unknown>;
  return (
    (t.status === 'idle' ||
      t.status === 'pending' ||
      t.status === 'failed' ||
      t.status === 'submitted') &&
    typeof t.attempts === 'number' &&
    (t.lastError === undefined || typeof t.lastError === 'string')
  );
}

/**
 * Load and validate a persisted draft. Returns `null` when nothing is stored or
 * the stored value is malformed (so a corrupt entry can never crash the
 * editor). A draft that was left `pending` is normalized back to `failed` so
 * the planner is prompted to retry after an interrupted submission.
 */
export function loadDraft(storage: DraftStorage): MissionDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.name !== 'string' ||
    !Array.isArray(candidate.waypoints) ||
    !candidate.waypoints.every(isWaypoint) ||
    !Array.isArray(candidate.geofences) ||
    !candidate.geofences.every(isDraftGeofence) ||
    !isTransmissionState(candidate.transmission)
  ) {
    return null;
  }

  const transmission =
    candidate.transmission.status === 'pending'
      ? markFailed(candidate.transmission, 'Submission was interrupted; please retry.')
      : candidate.transmission;

  return {
    name: candidate.name,
    waypoints: resequence(candidate.waypoints),
    geofences: candidate.geofences,
    transmission,
  };
}

/** Clear the persisted draft (e.g. after a confirmed successful submission). */
export function clearDraft(storage: DraftStorage): void {
  try {
    storage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Best-effort: nothing to do if the storage rejects removal.
  }
}

// ---------------------------------------------------------------------------
// Conflict-segment mapping (Requirement 22.5)
// ---------------------------------------------------------------------------

/**
 * A route segment that Mission Planning flagged as conflicting with a geofence,
 * resolved to drawable endpoints so the planner can highlight it on the map.
 */
export interface ConflictSegment {
  /** Index of the route segment (waypoint `segmentIndex` -> `segmentIndex + 1`). */
  segmentIndex: number;
  /** The conflicting geofence zone. */
  zoneId: Uuid;
  from: LatLon;
  to: LatLon;
}

/**
 * Resolve each reported {@link GeofenceConflict} to the coordinates of the route
 * segment it refers to (waypoint `i` -> `i + 1`), ordered by waypoint `seq`.
 * Conflicts whose `segmentIndex` falls outside the current route are skipped
 * defensively (the route may have been edited since the check), so the result
 * only ever contains drawable segments. Pure: inputs are not mutated.
 */
export function mapConflictSegments(
  waypoints: readonly Waypoint[],
  conflicts: readonly GeofenceConflict[],
): ConflictSegment[] {
  const ordered = [...waypoints].sort((a, b) => a.seq - b.seq);
  const segments: ConflictSegment[] = [];

  for (const conflict of conflicts) {
    const from = ordered[conflict.segmentIndex];
    const to = ordered[conflict.segmentIndex + 1];
    if (from === undefined || to === undefined) {
      continue;
    }
    segments.push({
      segmentIndex: conflict.segmentIndex,
      zoneId: conflict.zoneId,
      from: { lat: from.lat, lon: from.lon },
      to: { lat: to.lat, lon: to.lon },
    });
  }

  return segments;
}

/** Set of segment indices in conflict, for quick "is this segment red?" lookups. */
export function conflictingSegmentIndices(conflicts: readonly GeofenceConflict[]): Set<number> {
  return new Set(conflicts.map((c) => c.segmentIndex));
}
