/**
 * Pure, database-free PX4 MAVLink mission serialization (design Algorithm 7,
 * Requirement 7). Everything in this module is a pure function over plain data
 * so it is trivially testable and so the property tests (task 5.10) can assert
 * the round-trip (P12) and determinism (P13) invariants without a NestJS app or
 * a Postgres connection.
 *
 * A validated {@link Mission} is serialized into a PX4-compatible
 * `MISSION_ITEM_INT` sequence: a single home/takeoff item followed by one item
 * per waypoint in `seq` order. Latitude/longitude are encoded as int32
 * `round(degrees * 1e7)` and altitude is carried in meters, exactly as PX4
 * expects on the wire.
 */
import type { Mission, Waypoint } from '@pawaac/shared-types';

/** Supported export encodings (Requirement 7.1). */
export type MavlinkFormat = 'json' | 'binary';

/**
 * A single PX4 `MISSION_ITEM_INT` entry. Field names, order and units mirror the
 * MAVLink common-dialect message so the JSON form is directly recognisable and
 * the binary form is byte-compatible with the on-wire payload layout.
 */
export interface MavlinkMissionItem {
  /** Sequence index within the mission, contiguous from 0 (home item is 0). */
  seq: number;
  /** Coordinate frame; `GLOBAL_RELATIVE_ALT_INT` (6) for all emitted items. */
  frame: number;
  /** MAV_CMD value: `NAV_TAKEOFF` (22) for the home item, `NAV_WAYPOINT` (16) otherwise. */
  command: number;
  /** `1` for the active (first) item, `0` otherwise. */
  current: number;
  /** Whether to auto-continue to the next item; `1` for all emitted items. */
  autocontinue: number;
  /** param1 — loiter/hold time in seconds for waypoint items. */
  param1: number;
  /** param2 — unused here (acceptance radius); always 0. */
  param2: number;
  /** param3 — unused here (pass-through radius); always 0. */
  param3: number;
  /** param4 — gimbal/yaw angle in degrees for waypoint items. */
  param4: number;
  /** Latitude encoded as int32 `round(degrees * 1e7)`. */
  x: number;
  /** Longitude encoded as int32 `round(degrees * 1e7)`. */
  y: number;
  /** Altitude in meters. */
  z: number;
  /** MAVLink target system id; fixed at 1 for deterministic output. */
  targetSystem: number;
  /** MAVLink target component id; fixed at 1 for deterministic output. */
  targetComponent: number;
  /** Mission type; `0` (the standard mission) for all emitted items. */
  missionType: number;
}

/**
 * The result of exporting a mission. `items` is always the canonical
 * `MISSION_ITEM_INT` sequence; `bytes` carries the deterministic binary
 * encoding and is present only for the `'binary'` format.
 */
export interface MavlinkMission {
  format: MavlinkFormat;
  items: MavlinkMissionItem[];
  /** Deterministic binary encoding, present only when `format === 'binary'`. */
  bytes?: Buffer;
}

/** MAV_CMD_NAV_WAYPOINT — navigate to a waypoint. */
export const MAV_CMD_NAV_WAYPOINT = 16;
/** MAV_CMD_NAV_TAKEOFF — takeoff from the home/first position. */
export const MAV_CMD_NAV_TAKEOFF = 22;
/** MAV_FRAME_GLOBAL_RELATIVE_ALT_INT — lat/lon int32, altitude relative to home. */
export const MAV_FRAME_GLOBAL_RELATIVE_ALT_INT = 6;
/** Fixed system/component id used so exports are deterministic. */
export const DEFAULT_SYSTEM_ID = 1;
export const DEFAULT_COMPONENT_ID = 1;
/** Geographic scale factor applied before int32 truncation (degrees -> 1e-7 deg). */
export const GEO_SCALE = 1e7;

/** Magic prefix for the binary container: ASCII "PMAV". */
const MAGIC = 0x564d_4150; // 'P','M','A','V' little-endian
/** Binary container format version. */
const FORMAT_VERSION = 1;
/** Fixed-size container header: magic(4) + version(1) + reserved(1) + count(2). */
const HEADER_SIZE = 8;
/** Serialized size of one MISSION_ITEM_INT payload, matching the MAVLink layout. */
const ITEM_SIZE = 38;

/** Encodes a coordinate in degrees as the PX4 int32 `round(deg * 1e7)` value. */
export function encodeDegrees(deg: number): number {
  // `+ 0` normalizes the negative-zero that `Math.round` yields for small
  // negative inputs (e.g. round(-1e-8 * 1e7) === -0) back to `+0`. The int32
  // binary encoding has a single canonical zero, so without this the canonical
  // form (`canonicalize`) would carry `-0` while the binary round-trip yields
  // `+0`, breaking the P12 deep-equality round-trip for coordinates near 0.
  return Math.round(deg * GEO_SCALE) + 0;
}

/** Quantizes a value to 32-bit float so encode/decode round-trips exactly. */
function f32(value: number): number {
  return Math.fround(value);
}

/**
 * Builds the canonical `MISSION_ITEM_INT` sequence for a mission (design
 * Algorithm 7): a home/takeoff item derived from the first waypoint, followed by
 * one `NAV_WAYPOINT` item per waypoint in `seq` order. Float-valued fields are
 * pre-quantized to 32-bit precision so this canonical form is exactly what a
 * binary round-trip reproduces.
 *
 * Pure: it neither mutates `mission` nor depends on any external state.
 *
 * @throws {Error} when the mission has no waypoints (a validated mission always
 * has at least one).
 */
export function buildMissionItems(mission: Mission): MavlinkMissionItem[] {
  const waypoints = [...mission.waypoints].sort((a, b) => a.seq - b.seq);
  const first = waypoints[0];
  if (first === undefined) {
    throw new Error('cannot export a mission with no waypoints');
  }

  const items: MavlinkMissionItem[] = [];
  items.push(makeHomeItem(first));
  waypoints.forEach((wp, index) => {
    items.push(makeWaypointItem(wp, index + 1));
  });
  return items;
}

/** Builds the leading home/takeoff item from the first waypoint. */
function makeHomeItem(first: Waypoint): MavlinkMissionItem {
  return {
    seq: 0,
    frame: MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
    command: MAV_CMD_NAV_TAKEOFF,
    current: 1,
    autocontinue: 1,
    param1: 0,
    param2: 0,
    param3: 0,
    param4: 0,
    x: encodeDegrees(first.lat),
    y: encodeDegrees(first.lon),
    z: f32(first.altitude),
    targetSystem: DEFAULT_SYSTEM_ID,
    targetComponent: DEFAULT_COMPONENT_ID,
    missionType: 0,
  };
}

/** Builds a NAV_WAYPOINT item for `wp` at the given overall sequence index. */
function makeWaypointItem(wp: Waypoint, seq: number): MavlinkMissionItem {
  return {
    seq,
    frame: MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
    command: MAV_CMD_NAV_WAYPOINT,
    current: 0,
    autocontinue: 1,
    param1: f32(wp.loiterTime),
    param2: 0,
    param3: 0,
    param4: f32(wp.gimbalAngle),
    x: encodeDegrees(wp.lat),
    y: encodeDegrees(wp.lon),
    z: f32(wp.altitude),
    targetSystem: DEFAULT_SYSTEM_ID,
    targetComponent: DEFAULT_COMPONENT_ID,
    missionType: 0,
  };
}

/**
 * Encodes a `MISSION_ITEM_INT` sequence into a deterministic little-endian byte
 * buffer. The output depends only on the items, so the same mission always
 * yields identical bytes (P13). The per-item layout matches the MAVLink
 * common-dialect `MISSION_ITEM_INT` payload field order.
 */
export function encodeBinary(items: readonly MavlinkMissionItem[]): Buffer {
  const buffer = Buffer.alloc(HEADER_SIZE + items.length * ITEM_SIZE);
  buffer.writeUInt32LE(MAGIC, 0);
  buffer.writeUInt8(FORMAT_VERSION, 4);
  buffer.writeUInt8(0, 5); // reserved
  buffer.writeUInt16LE(items.length, 6);

  let offset = HEADER_SIZE;
  for (const item of items) {
    buffer.writeFloatLE(item.param1, offset + 0);
    buffer.writeFloatLE(item.param2, offset + 4);
    buffer.writeFloatLE(item.param3, offset + 8);
    buffer.writeFloatLE(item.param4, offset + 12);
    buffer.writeInt32LE(item.x, offset + 16);
    buffer.writeInt32LE(item.y, offset + 20);
    buffer.writeFloatLE(item.z, offset + 24);
    buffer.writeUInt16LE(item.seq, offset + 28);
    buffer.writeUInt16LE(item.command, offset + 30);
    buffer.writeUInt8(item.targetSystem, offset + 32);
    buffer.writeUInt8(item.targetComponent, offset + 33);
    buffer.writeUInt8(item.frame, offset + 34);
    buffer.writeUInt8(item.current, offset + 35);
    buffer.writeUInt8(item.autocontinue, offset + 36);
    buffer.writeUInt8(item.missionType, offset + 37);
    offset += ITEM_SIZE;
  }
  return buffer;
}

/**
 * Parses a binary MAVLink mission produced by {@link encodeBinary} back into its
 * `MISSION_ITEM_INT` sequence. This is the inverse used by the round-trip
 * property (P12): `parseMavlink(encodeBinary(items))` deep-equals `items`.
 *
 * @throws {Error} when the buffer is too short, has the wrong magic/version, or
 * its declared item count does not match its length.
 */
export function parseMavlink(buffer: Buffer): MavlinkMissionItem[] {
  if (buffer.length < HEADER_SIZE) {
    throw new Error('mavlink buffer too small to contain a header');
  }
  if (buffer.readUInt32LE(0) !== MAGIC) {
    throw new Error('mavlink buffer has an unexpected magic prefix');
  }
  if (buffer.readUInt8(4) !== FORMAT_VERSION) {
    throw new Error('unsupported mavlink binary format version');
  }
  const count = buffer.readUInt16LE(6);
  if (buffer.length !== HEADER_SIZE + count * ITEM_SIZE) {
    throw new Error('mavlink buffer length does not match its declared item count');
  }

  const items: MavlinkMissionItem[] = [];
  let offset = HEADER_SIZE;
  for (let i = 0; i < count; i += 1) {
    items.push({
      param1: buffer.readFloatLE(offset + 0),
      param2: buffer.readFloatLE(offset + 4),
      param3: buffer.readFloatLE(offset + 8),
      param4: buffer.readFloatLE(offset + 12),
      x: buffer.readInt32LE(offset + 16),
      y: buffer.readInt32LE(offset + 20),
      z: buffer.readFloatLE(offset + 24),
      seq: buffer.readUInt16LE(offset + 28),
      command: buffer.readUInt16LE(offset + 30),
      targetSystem: buffer.readUInt8(offset + 32),
      targetComponent: buffer.readUInt8(offset + 33),
      frame: buffer.readUInt8(offset + 34),
      current: buffer.readUInt8(offset + 35),
      autocontinue: buffer.readUInt8(offset + 36),
      missionType: buffer.readUInt8(offset + 37),
    });
    offset += ITEM_SIZE;
  }
  return items;
}

/**
 * Canonical, format-independent view of a mission used by the round-trip
 * property (P12). It is exactly the `MISSION_ITEM_INT` sequence the binary
 * encoder serializes, so `parseMavlink(encodeBinary(canonicalize(m)))` equals
 * `canonicalize(m)`.
 */
export function canonicalize(mission: Mission): MavlinkMissionItem[] {
  return buildMissionItems(mission);
}

/**
 * Exports a validated mission to a {@link MavlinkMission} in the requested
 * format (design Algorithm 7). Callers are responsible for the precondition
 * that the mission is validated and conflict-free; this function performs the
 * pure serialization only.
 */
export function exportMavlink(mission: Mission, format: MavlinkFormat): MavlinkMission {
  const items = buildMissionItems(mission);
  if (format === 'binary') {
    return { format, items, bytes: encodeBinary(items) };
  }
  return { format, items };
}
