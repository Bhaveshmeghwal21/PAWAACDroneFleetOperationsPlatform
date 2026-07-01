import { describe, expect, it } from 'vitest';
import type { GeoPoint, GeofenceConflict, Waypoint } from '@pawaac/shared-types';

import {
  DEFAULT_WAYPOINT_PARAMS,
  DRAFT_STORAGE_KEY,
  addWaypoint,
  appendVertex,
  canTransmit,
  clearDraft,
  closeRing,
  conflictingSegmentIndices,
  emptyDraft,
  isClosedRing,
  loadDraft,
  mapConflictSegments,
  markFailed,
  markPending,
  markSubmitted,
  moveWaypoint,
  nextRetryDelayMs,
  removeLastVertex,
  removeWaypoint,
  reorderWaypoints,
  resequence,
  saveDraft,
  updateWaypoint,
  type DraftStorage,
  type MissionDraft,
  type TransmissionState,
} from './mission-planner-state';

const ZONE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ZONE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function wp(seq: number, lat: number, lon: number, overrides: Partial<Waypoint> = {}): Waypoint {
  return { seq, lat, lon, ...DEFAULT_WAYPOINT_PARAMS, ...overrides };
}

/** In-memory `DraftStorage` for persistence tests (no DOM required). */
class MemoryStorage implements DraftStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  raw(key: string): string | null {
    return this.getItem(key);
  }
}

// --- Waypoint-list reduction (Requirement 22.1) ----------------------------

describe('waypoint reduction', () => {
  it('addWaypoint appends with the next seq and default flight params', () => {
    const after = addWaypoint([], { lat: 1, lon: 2 });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ seq: 0, lat: 1, lon: 2, ...DEFAULT_WAYPOINT_PARAMS });

    const after2 = addWaypoint(after, { lat: 3, lon: 4 });
    expect(after2.map((w) => w.seq)).toEqual([0, 1]);
    expect(after2[1]).toMatchObject({ lat: 3, lon: 4 });
  });

  it('addWaypoint does not mutate the input list', () => {
    const original: Waypoint[] = [];
    addWaypoint(original, { lat: 1, lon: 1 });
    expect(original).toHaveLength(0);
  });

  it('moveWaypoint updates only the dragged waypoint position', () => {
    const list = [wp(0, 0, 0), wp(1, 1, 1)];
    const after = moveWaypoint(list, 1, { lat: 9, lon: 8 });
    expect(after[1]).toMatchObject({ seq: 1, lat: 9, lon: 8 });
    expect(after[0]).toEqual(list[0]);
    expect(list[1]).toMatchObject({ lat: 1, lon: 1 }); // input untouched
  });

  it('moveWaypoint on an unknown seq returns an equivalent list', () => {
    const list = [wp(0, 0, 0)];
    expect(moveWaypoint(list, 99, { lat: 5, lon: 5 })).toEqual(list);
  });

  it('updateWaypoint patches flight params while preserving seq', () => {
    const list = [wp(0, 0, 0), wp(1, 1, 1)];
    const after = updateWaypoint(list, 0, { altitude: 120, speed: 12 });
    expect(after[0]).toMatchObject({ seq: 0, altitude: 120, speed: 12 });
  });

  it('removeWaypoint re-indexes seq contiguously from 0', () => {
    const list = [wp(0, 0, 0), wp(1, 1, 1), wp(2, 2, 2)];
    const after = removeWaypoint(list, 1);
    expect(after.map((w) => w.seq)).toEqual([0, 1]);
    expect(after.map((w) => w.lat)).toEqual([0, 2]);
  });

  it('reorderWaypoints moves an item and re-sequences', () => {
    const list = [wp(0, 0, 0), wp(1, 1, 1), wp(2, 2, 2)];
    const after = reorderWaypoints(list, 0, 2);
    expect(after.map((w) => w.lat)).toEqual([1, 2, 0]);
    expect(after.map((w) => w.seq)).toEqual([0, 1, 2]);
  });

  it('reorderWaypoints with out-of-range indices is a no-op copy', () => {
    const list = [wp(0, 0, 0), wp(1, 1, 1)];
    expect(reorderWaypoints(list, 0, 5)).toEqual(list);
    expect(reorderWaypoints(list, -1, 1)).toEqual(list);
  });

  it('resequence enforces contiguous seq from 0 regardless of input seq', () => {
    const messy = [wp(7, 0, 0), wp(3, 1, 1), wp(99, 2, 2)];
    expect(resequence(messy).map((w) => w.seq)).toEqual([0, 1, 2]);
  });
});

// --- Geofence polygon drawing (Requirement 22.2) ---------------------------

describe('geofence polygon drawing', () => {
  it('appendVertex stores points in [lon, lat] order', () => {
    const v = appendVertex([], { lat: 10, lon: 20 });
    expect(v[0]).toEqual([20, 10]);
  });

  it('removeLastVertex undoes the most recent point', () => {
    const v: GeoPoint[] = [
      [0, 0],
      [1, 1],
    ];
    expect(removeLastVertex(v)).toEqual([[0, 0]]);
    expect(removeLastVertex([])).toEqual([]);
  });

  it('closeRing closes an open triangle into a valid ring', () => {
    const open: GeoPoint[] = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    const ring = closeRing(open);
    expect(ring).not.toBeNull();
    expect(ring).toHaveLength(4);
    expect(ring?.[0]).toEqual(ring?.[ring.length - 1]);
    expect(isClosedRing(ring as GeoPoint[])).toBe(true);
  });

  it('closeRing keeps an already-closed ring unchanged', () => {
    const closed: GeoPoint[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    expect(closeRing(closed)).toEqual(closed);
  });

  it('closeRing returns null for fewer than three vertices', () => {
    expect(closeRing([[0, 0]])).toBeNull();
    expect(
      closeRing([
        [0, 0],
        [1, 1],
      ]),
    ).toBeNull();
  });

  it('isClosedRing rejects open or too-short rings', () => {
    // Open ring (first !== last): rejected.
    expect(isClosedRing([[0, 0], [1, 0], [1, 1], [2, 2]])).toBe(false);
    // Too short (< 4 points), even though first == last: rejected.
    expect(isClosedRing([[0, 0], [1, 0], [0, 0]])).toBe(false);
    // Valid closed quad ring: accepted.
    expect(isClosedRing([[0, 0], [1, 0], [1, 1], [0, 0]])).toBe(true);
  });
});

// --- Local-storage draft persistence + retry (Requirement 22.4) ------------

describe('transmission state machine', () => {
  const idle: TransmissionState = { status: 'idle', attempts: 0, lastError: undefined };

  it('markPending clears errors and keeps the attempt count', () => {
    const failed = markFailed(idle, 'boom');
    const pending = markPending(failed);
    expect(pending.status).toBe('pending');
    expect(pending.attempts).toBe(1);
    expect(pending.lastError).toBeUndefined();
  });

  it('markFailed increments attempts and records the error', () => {
    const once = markFailed(idle, 'network down');
    expect(once).toMatchObject({ status: 'failed', attempts: 1, lastError: 'network down' });
    const twice = markFailed(once, 'still down');
    expect(twice.attempts).toBe(2);
  });

  it('markSubmitted records success and clears the error', () => {
    const done = markSubmitted(markFailed(idle, 'boom'));
    expect(done.status).toBe('submitted');
    expect(done.lastError).toBeUndefined();
  });

  it('canTransmit only from idle or failed', () => {
    expect(canTransmit({ status: 'idle', attempts: 0, lastError: undefined })).toBe(true);
    expect(canTransmit({ status: 'failed', attempts: 1, lastError: 'x' })).toBe(true);
    expect(canTransmit({ status: 'pending', attempts: 0, lastError: undefined })).toBe(false);
    expect(canTransmit({ status: 'submitted', attempts: 0, lastError: undefined })).toBe(false);
  });

  it('nextRetryDelayMs grows exponentially and caps', () => {
    expect(nextRetryDelayMs(0)).toBe(1000);
    expect(nextRetryDelayMs(1)).toBe(1000);
    expect(nextRetryDelayMs(2)).toBe(2000);
    expect(nextRetryDelayMs(3)).toBe(4000);
    expect(nextRetryDelayMs(100)).toBe(30_000);
  });
});

describe('draft persistence', () => {
  it('save then load round-trips a draft', () => {
    const storage = new MemoryStorage();
    const draft: MissionDraft = {
      ...emptyDraft('Patrol'),
      waypoints: [wp(0, 1, 2), wp(1, 3, 4)],
      geofences: [{ name: 'NFZ', polygon: [[0, 0], [1, 0], [1, 1], [0, 0]] }],
    };
    saveDraft(storage, draft);
    expect(loadDraft(storage)).toEqual(draft);
  });

  it('loadDraft returns null when nothing is stored', () => {
    expect(loadDraft(new MemoryStorage())).toBeNull();
  });

  it('loadDraft returns null on malformed JSON', () => {
    const storage = new MemoryStorage();
    storage.setItem(DRAFT_STORAGE_KEY, '{ not valid json');
    expect(loadDraft(storage)).toBeNull();
  });

  it('loadDraft returns null on structurally invalid data', () => {
    const storage = new MemoryStorage();
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ name: 'x', waypoints: 'nope' }));
    expect(loadDraft(storage)).toBeNull();
  });

  it('loadDraft normalizes an interrupted pending draft back to failed for retry', () => {
    const storage = new MemoryStorage();
    const draft: MissionDraft = {
      ...emptyDraft('Interrupted'),
      transmission: { status: 'pending', attempts: 0, lastError: undefined },
    };
    saveDraft(storage, draft);
    const loaded = loadDraft(storage);
    expect(loaded?.transmission.status).toBe('failed');
    expect(loaded?.transmission.attempts).toBe(1);
  });

  it('clearDraft removes the persisted entry', () => {
    const storage = new MemoryStorage();
    saveDraft(storage, emptyDraft());
    clearDraft(storage);
    expect(storage.raw(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('saveDraft swallows storage errors (best-effort persistence)', () => {
    const throwing: DraftStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => undefined,
    };
    expect(() => saveDraft(throwing, emptyDraft())).not.toThrow();
  });
});

// --- Conflict-segment mapping (Requirement 22.5) ---------------------------

describe('conflict-segment mapping', () => {
  const route = [wp(0, 0, 0), wp(1, 1, 1), wp(2, 2, 2)];

  it('resolves each conflict to its segment endpoints', () => {
    const conflicts: GeofenceConflict[] = [
      { segmentIndex: 0, zoneId: ZONE_A },
      { segmentIndex: 1, zoneId: ZONE_B },
    ];
    const segments = mapConflictSegments(route, conflicts);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      segmentIndex: 0,
      zoneId: ZONE_A,
      from: { lat: 0, lon: 0 },
      to: { lat: 1, lon: 1 },
    });
    expect(segments[1]?.to).toEqual({ lat: 2, lon: 2 });
  });

  it('skips conflicts whose segment index is out of range', () => {
    const conflicts: GeofenceConflict[] = [
      { segmentIndex: 2, zoneId: ZONE_A }, // segment 2->3 has no endpoint
      { segmentIndex: 5, zoneId: ZONE_B },
    ];
    expect(mapConflictSegments(route, conflicts)).toEqual([]);
  });

  it('orders by waypoint seq even if the input array is unordered', () => {
    const shuffled = [wp(2, 2, 2), wp(0, 0, 0), wp(1, 1, 1)];
    const segments = mapConflictSegments(shuffled, [{ segmentIndex: 0, zoneId: ZONE_A }]);
    expect(segments[0]?.from).toEqual({ lat: 0, lon: 0 });
    expect(segments[0]?.to).toEqual({ lat: 1, lon: 1 });
  });

  it('does not mutate the input waypoints', () => {
    const input = [wp(2, 2, 2), wp(0, 0, 0)];
    const snapshot = input.map((w) => w.seq);
    mapConflictSegments(input, [{ segmentIndex: 0, zoneId: ZONE_A }]);
    expect(input.map((w) => w.seq)).toEqual(snapshot);
  });

  it('conflictingSegmentIndices collects the flagged segment indices', () => {
    const set = conflictingSegmentIndices([
      { segmentIndex: 0, zoneId: ZONE_A },
      { segmentIndex: 2, zoneId: ZONE_B },
    ]);
    expect(set.has(0)).toBe(true);
    expect(set.has(2)).toBe(true);
    expect(set.has(1)).toBe(false);
  });
});
