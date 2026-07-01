import { describe, expect, it } from 'vitest';
import type { Detection, Obb } from '@pawaac/shared-types';

import {
  buildReplayQuery,
  clampToBounds,
  computeTimelineBounds,
  obbCornersInFrame,
  obbToMapOverlay,
  overlaysAt,
  projectFramePoint,
  scrubFractionToTime,
  selectDetectionsAt,
  timeToScrubFraction,
  type FrameGeoRef,
} from './detection-replay-state';

const DRONE_A = '11111111-1111-1111-1111-111111111111';
const DRONE_B = '22222222-2222-2222-2222-222222222222';

function makeDetection(overrides: Partial<Detection> = {}): Detection {
  return {
    id: 'det-0',
    droneId: DRONE_A,
    frameTs: 1000,
    cls: 'person',
    confidence: 0.9,
    obb: [0.5, 0.5, 0.2, 0.1, 0] as Obb,
    trackId: null,
    ...overrides,
  };
}

/** A simple unit-square frame footprint over a 10°×10° geographic box. */
const REF: FrameGeoRef = {
  north: 10,
  south: 0,
  east: 10,
  west: 0,
  frameWidth: 1,
  frameHeight: 1,
};

describe('computeTimelineBounds', () => {
  it('returns null for an empty detection set', () => {
    expect(computeTimelineBounds([])).toBeNull();
  });

  it('returns the min and max frameTs across the set, regardless of order', () => {
    const dets = [
      makeDetection({ id: 'a', frameTs: 1500 }),
      makeDetection({ id: 'b', frameTs: 1000 }),
      makeDetection({ id: 'c', frameTs: 2000 }),
    ];
    expect(computeTimelineBounds(dets)).toEqual({ from: 1000, to: 2000 });
  });

  it('handles a single detection (from === to)', () => {
    expect(computeTimelineBounds([makeDetection({ frameTs: 1234 })])).toEqual({
      from: 1234,
      to: 1234,
    });
  });

  it('does not mutate the input', () => {
    const dets = [makeDetection({ frameTs: 1000 }), makeDetection({ frameTs: 2000 })];
    const snapshot = structuredClone(dets);
    computeTimelineBounds(dets);
    expect(dets).toEqual(snapshot);
  });
});

describe('clampToBounds', () => {
  const bounds = { from: 100, to: 200 };

  it('clamps below the lower bound', () => {
    expect(clampToBounds(bounds, 50)).toBe(100);
  });

  it('clamps above the upper bound', () => {
    expect(clampToBounds(bounds, 250)).toBe(200);
  });

  it('passes through an in-range value', () => {
    expect(clampToBounds(bounds, 150)).toBe(150);
  });
});

describe('scrubFractionToTime / timeToScrubFraction (Requirement 25.1)', () => {
  const bounds = { from: 1000, to: 2000 };

  it('maps fraction 0 to the start and 1 to the end', () => {
    expect(scrubFractionToTime(bounds, 0)).toBe(1000);
    expect(scrubFractionToTime(bounds, 1)).toBe(2000);
  });

  it('maps the midpoint fraction to the midpoint time', () => {
    expect(scrubFractionToTime(bounds, 0.5)).toBe(1500);
  });

  it('clamps out-of-range fractions', () => {
    expect(scrubFractionToTime(bounds, -0.5)).toBe(1000);
    expect(scrubFractionToTime(bounds, 2)).toBe(2000);
  });

  it('round-trips time <-> fraction', () => {
    for (const t of [1000, 1250, 1500, 1750, 2000]) {
      const f = timeToScrubFraction(bounds, t);
      expect(scrubFractionToTime(bounds, f)).toBeCloseTo(t, 6);
    }
  });

  it('collapses a zero-width timeline to fraction 0', () => {
    expect(timeToScrubFraction({ from: 1000, to: 1000 }, 1000)).toBe(0);
  });
});

describe('selectDetectionsAt (Requirement 25.1)', () => {
  const dets = [
    makeDetection({ id: 'a', frameTs: 1000 }),
    makeDetection({ id: 'b', frameTs: 1000.4 }),
    makeDetection({ id: 'c', frameTs: 1002 }),
    makeDetection({ id: 'd', frameTs: 999.7 }),
  ];

  it('selects detections within the window around the instant', () => {
    const visible = selectDetectionsAt(dets, 1000, 0.5);
    expect(visible.map((d) => d.id)).toEqual(['d', 'a', 'b']);
  });

  it('excludes detections outside the window', () => {
    const visible = selectDetectionsAt(dets, 1000, 0.5);
    expect(visible.map((d) => d.id)).not.toContain('c');
  });

  it('returns an empty list when nothing falls in the window', () => {
    expect(selectDetectionsAt(dets, 5000, 0.5)).toEqual([]);
  });

  it('orders results by frameTs then id (deterministic)', () => {
    const ties = [
      makeDetection({ id: 'z', frameTs: 1000 }),
      makeDetection({ id: 'a', frameTs: 1000 }),
    ];
    expect(selectDetectionsAt(ties, 1000, 0.1).map((d) => d.id)).toEqual(['a', 'z']);
  });

  it('does not mutate the input set', () => {
    const snapshot = structuredClone(dets);
    selectDetectionsAt(dets, 1000, 0.5);
    expect(dets).toEqual(snapshot);
  });
});

describe('projectFramePoint', () => {
  it('maps the frame centre to the geographic centre', () => {
    expect(projectFramePoint(0.5, 0.5, REF)).toEqual({ lat: 5, lon: 5 });
  });

  it('maps the top-left frame corner to the north-west geographic corner', () => {
    // y = 0 -> north; x = 0 -> west
    expect(projectFramePoint(0, 0, REF)).toEqual({ lat: 10, lon: 0 });
  });

  it('maps the bottom-right frame corner to the south-east geographic corner', () => {
    expect(projectFramePoint(1, 1, REF)).toEqual({ lat: 0, lon: 10 });
  });

  it('guards against a zero-size frame', () => {
    const degenerate: FrameGeoRef = { ...REF, frameWidth: 0, frameHeight: 0 };
    expect(projectFramePoint(5, 5, degenerate)).toEqual({ lat: 10, lon: 0 });
  });
});

describe('obbCornersInFrame', () => {
  it('returns axis-aligned corners for a zero-angle box', () => {
    const corners = obbCornersInFrame([0.5, 0.5, 0.2, 0.1, 0]);
    expect(corners[0]![0]).toBeCloseTo(0.4, 6); // top-left x
    expect(corners[0]![1]).toBeCloseTo(0.45, 6); // top-left y
    expect(corners[2]![0]).toBeCloseTo(0.6, 6); // bottom-right x
    expect(corners[2]![1]).toBeCloseTo(0.55, 6); // bottom-right y
  });

  it('rotates corners by 90 degrees about the centre', () => {
    const corners = obbCornersInFrame([0, 0, 2, 0, Math.PI / 2]);
    // A 2-wide, 0-tall box rotated 90° becomes vertical: corners at (0, ±1).
    expect(corners[0]![0]).toBeCloseTo(0, 6);
    expect(corners[0]![1]).toBeCloseTo(-1, 6);
    expect(corners[1]![0]).toBeCloseTo(0, 6);
    expect(corners[1]![1]).toBeCloseTo(1, 6);
  });

  it('keeps the centroid of the corners at the box centre', () => {
    const corners = obbCornersInFrame([3, 7, 1.5, 0.8, 0.6]);
    const cx = corners.reduce((s, c) => s + c[0], 0) / 4;
    const cy = corners.reduce((s, c) => s + c[1], 0) / 4;
    expect(cx).toBeCloseTo(3, 6);
    expect(cy).toBeCloseTo(7, 6);
  });
});

describe('obbToMapOverlay (Requirement 25.1)', () => {
  it('projects the OBB centre and four corners onto the map', () => {
    const overlay = obbToMapOverlay(makeDetection({ obb: [0.5, 0.5, 0.2, 0.2, 0] as Obb }), REF);
    expect(overlay.center).toEqual({ lat: 5, lon: 5 });
    expect(overlay.corners).toHaveLength(4);
    // Box [0.4..0.6] x [0.4..0.6] -> lat/lon [4..6].
    expect(overlay.corners[0]!.lon).toBeCloseTo(4, 6);
    expect(overlay.corners[0]!.lat).toBeCloseTo(6, 6); // y=0.4 -> lat 6 (north-ish)
    expect(overlay.corners[2]!.lon).toBeCloseTo(6, 6);
    expect(overlay.corners[2]!.lat).toBeCloseTo(4, 6);
  });

  it('carries detection identity and metadata through', () => {
    const det = makeDetection({ id: 'det-7', trackId: 'trk-1', cls: 'vehicle', confidence: 0.42 });
    const overlay = obbToMapOverlay(det, REF);
    expect(overlay).toMatchObject({
      detectionId: 'det-7',
      trackId: 'trk-1',
      cls: 'vehicle',
      confidence: 0.42,
      frameTs: 1000,
    });
  });

  it('does not mutate the detection', () => {
    const det = makeDetection();
    const snapshot = structuredClone(det);
    obbToMapOverlay(det, REF);
    expect(det).toEqual(snapshot);
  });
});

describe('overlaysAt (Requirement 25.1)', () => {
  it('projects only the detections visible at the instant', () => {
    const dets = [
      makeDetection({ id: 'a', frameTs: 1000 }),
      makeDetection({ id: 'b', frameTs: 1005 }),
    ];
    const overlays = overlaysAt(dets, 1000, REF, 0.5);
    expect(overlays.map((o) => o.detectionId)).toEqual(['a']);
  });
});

describe('buildReplayQuery (Requirement 25.2)', () => {
  it('builds a query for a forward range', () => {
    expect(buildReplayQuery(1000, 2000)).toEqual({ from: 1000, to: 2000 });
  });

  it('normalizes a reversed range so from <= to', () => {
    expect(buildReplayQuery(2000, 1000)).toEqual({ from: 1000, to: 2000 });
  });

  it('includes the drone id when scoping to a single aircraft', () => {
    expect(buildReplayQuery(1000, 2000, DRONE_B)).toEqual({
      from: 1000,
      to: 2000,
      droneId: DRONE_B,
    });
  });

  it('omits droneId entirely when not provided', () => {
    const q = buildReplayQuery(1000, 2000);
    expect('droneId' in q).toBe(false);
  });
});
