import type { Mission, Waypoint } from '@pawaac/shared-types';
import {
  buildMissionItems,
  canonicalize,
  encodeBinary,
  encodeDegrees,
  exportMavlink,
  GEO_SCALE,
  MAV_CMD_NAV_TAKEOFF,
  MAV_CMD_NAV_WAYPOINT,
  MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
  parseMavlink,
} from '../src/export/mavlink';
import { validWaypoint } from './helpers';

/** Builds a Mission fixture from a list of waypoints (no store required). */
function mission(waypoints: Waypoint[]): Mission {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    version: 1,
    name: 'Fixture',
    waypoints,
    status: 'validated',
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('MAVLink serialization — Algorithm 7 (Requirement 7)', () => {
  describe('buildMissionItems — home + per-waypoint sequence (7.3)', () => {
    it('emits a home/takeoff item followed by one item per waypoint, in order', () => {
      const wps = [
        validWaypoint({ seq: 0, lat: 1, lon: 2 }),
        validWaypoint({ seq: 1, lat: 3, lon: 4 }),
        validWaypoint({ seq: 2, lat: 5, lon: 6 }),
      ];
      const items = buildMissionItems(mission(wps));

      // 1 home item + 3 waypoint items.
      expect(items).toHaveLength(4);

      const home = items[0]!;
      expect(home.command).toBe(MAV_CMD_NAV_TAKEOFF);
      expect(home.seq).toBe(0);
      expect(home.current).toBe(1);
      // Home item derives its position from the first waypoint.
      expect(home.x).toBe(encodeDegrees(1));
      expect(home.y).toBe(encodeDegrees(2));

      // Waypoint items: NAV_WAYPOINT, contiguous seq 1..N, preserving order.
      expect(items.slice(1).map((i) => i.command)).toEqual([
        MAV_CMD_NAV_WAYPOINT,
        MAV_CMD_NAV_WAYPOINT,
        MAV_CMD_NAV_WAYPOINT,
      ]);
      expect(items.map((i) => i.seq)).toEqual([0, 1, 2, 3]);
      expect(items.every((i) => i.frame === MAV_FRAME_GLOBAL_RELATIVE_ALT_INT)).toBe(true);
    });

    it('sorts waypoints by seq before serializing', () => {
      const wps = [
        validWaypoint({ seq: 1, lat: 3, lon: 4 }),
        validWaypoint({ seq: 0, lat: 1, lon: 2 }),
      ];
      const items = buildMissionItems(mission(wps));
      // First waypoint item (index 1) must be the seq-0 waypoint at (1, 2).
      expect(items[1]!.x).toBe(encodeDegrees(1));
      expect(items[1]!.y).toBe(encodeDegrees(2));
    });

    it('maps param1=loiterTime and param4=gimbalAngle onto waypoint items', () => {
      const wps = [validWaypoint({ seq: 0, loiterTime: 7, gimbalAngle: -45 })];
      const items = buildMissionItems(mission(wps));
      const waypointItem = items[1]!;
      expect(waypointItem.param1).toBeCloseTo(7, 5);
      expect(waypointItem.param4).toBeCloseTo(-45, 5);
    });

    it('throws when the mission has no waypoints', () => {
      expect(() => buildMissionItems(mission([]))).toThrow();
    });
  });

  describe('encodeDegrees — int32 1e7 encoding (7.4)', () => {
    it('encodes degrees as round(degrees * 1e7)', () => {
      expect(encodeDegrees(12.3456789)).toBe(123456789);
      expect(encodeDegrees(-45.5)).toBe(-455000000);
      expect(encodeDegrees(0)).toBe(0);
      expect(GEO_SCALE).toBe(1e7);
    });

    it('keeps extreme valid coordinates within the int32 range', () => {
      expect(encodeDegrees(90)).toBe(900000000);
      expect(encodeDegrees(-180)).toBe(-1800000000);
      expect(encodeDegrees(180)).toBeLessThan(2 ** 31);
      expect(encodeDegrees(-180)).toBeGreaterThan(-(2 ** 31));
    });

    it('rounds to the nearest 1e-7 degree', () => {
      // 1.00000005 deg * 1e7 = 10000000.5 -> rounds to 10000001.
      expect(encodeDegrees(1.00000005)).toBe(10000001);
    });
  });

  describe('encodeBinary — deterministic bytes (7.6 / P13)', () => {
    it('produces identical bytes across repeated runs of a fixed mission', () => {
      const m = mission([
        validWaypoint({ seq: 0, lat: 10.123, lon: 20.456, loiterTime: 3, gimbalAngle: -10 }),
        validWaypoint({ seq: 1, lat: 11.5, lon: 21.5, loiterTime: 0, gimbalAngle: 0 }),
      ]);
      const a = exportMavlink(m, 'binary').bytes!;
      const b = exportMavlink(m, 'binary').bytes!;
      expect(a.equals(b)).toBe(true);
    });

    it('encodes lat/lon as little-endian int32 degrees*1e7 in the payload', () => {
      const m = mission([validWaypoint({ seq: 0, lat: 12.3456789, lon: -98.7654321 })]);
      const bytes = encodeBinary(buildMissionItems(m));
      // Header is 8 bytes; first item's x is at offset 8 + 16, y at 8 + 20.
      expect(bytes.readInt32LE(8 + 16)).toBe(123456789);
      expect(bytes.readInt32LE(8 + 20)).toBe(-987654321);
    });
  });

  describe('parseMavlink — round-trip (7.5 / P12)', () => {
    it('parse(export(m)) reconstructs the canonical mission items', () => {
      const m = mission([
        validWaypoint({ seq: 0, lat: -33.86, lon: 151.2, altitude: 120, loiterTime: 5, gimbalAngle: -30 }),
        validWaypoint({ seq: 1, lat: -33.87, lon: 151.21, altitude: 90, loiterTime: 0, gimbalAngle: 15 }),
      ]);
      const exported = exportMavlink(m, 'binary');
      expect(parseMavlink(exported.bytes!)).toEqual(canonicalize(m));
    });

    it('round-trips an arbitrary item list exactly', () => {
      const m = mission([validWaypoint({ seq: 0 })]);
      const items = buildMissionItems(m);
      expect(parseMavlink(encodeBinary(items))).toEqual(items);
    });

    it('rejects a buffer with a bad magic prefix', () => {
      const bad = Buffer.alloc(8);
      expect(() => parseMavlink(bad)).toThrow();
    });

    it('rejects a buffer whose length disagrees with its item count', () => {
      const m = mission([validWaypoint({ seq: 0 })]);
      const good = encodeBinary(buildMissionItems(m));
      const truncated = good.subarray(0, good.length - 1);
      expect(() => parseMavlink(truncated)).toThrow();
    });
  });

  describe('exportMavlink — format handling (7.1)', () => {
    it('returns items without bytes for the json format', () => {
      const m = mission([validWaypoint({ seq: 0 })]);
      const result = exportMavlink(m, 'json');
      expect(result.format).toBe('json');
      expect(result.bytes).toBeUndefined();
      expect(result.items).toHaveLength(2);
    });

    it('returns both items and bytes for the binary format', () => {
      const m = mission([validWaypoint({ seq: 0 })]);
      const result = exportMavlink(m, 'binary');
      expect(result.format).toBe('binary');
      expect(Buffer.isBuffer(result.bytes)).toBe(true);
    });
  });
});
