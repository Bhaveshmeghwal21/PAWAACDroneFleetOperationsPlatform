/**
 * MAVLink frame codec for the Telemetry Ingestion service (Requirements 8.2,
 * 8.3 / property P15).
 *
 * `parseFrame` decodes a single, complete MAVLink frame into a normalized
 * {@link TelemetrySample}; `encode` performs the inverse, serializing a sample
 * back into a MAVLink frame. Together they satisfy the parse/serialize
 * round-trip invariant (P15): `parseFrame(encode(s)) ≈ s` within float32
 * numeric tolerance.
 *
 * ## Carrier message
 *
 * A normalized sample bundles fields that, on a real PX4 vehicle, arrive across
 * several distinct MAVLink messages (GLOBAL_POSITION_INT, ATTITUDE,
 * BATTERY_STATUS, …). The service's interface contract — `parseFrame(bytes):
 * TelemetrySample` with a single-frame round-trip property — models a 1:1
 * mapping between one frame and one sample. To honour that with a real,
 * library-supported MAVLink message we use the standard `DEBUG_FLOAT_ARRAY`
 * (msgid 350): its `float[58]` payload, `char[10]` name and `uint64` timestamp
 * give a lossless (within float32 tolerance) container for every scalar field
 * of a sample. Encoding/decoding go through `node-mavlink`'s real V2 protocol
 * implementation (header framing, CRC, payload (de)serialization).
 *
 * ## Drone identity
 *
 * `droneId` is NOT carried in the frame payload — on a real fleet it is
 * established by the authenticated WebSocket connection, not self-asserted by
 * the vehicle in every frame. `parseFrame` therefore takes the id via a small
 * {@link ParseContext}; the round-trip property is exercised as
 * `parseFrame(encode(s), { droneId: s.droneId })`.
 */
import type { TelemetrySample, Uuid } from '@pawaac/shared-types';
import { common, MavLinkProtocolV1, MavLinkProtocolV2, x25crc } from 'node-mavlink';

/** MAVLink v1/v2 frame start bytes. */
const STX_V1 = 0xfe;
const STX_V2 = 0xfd;

/** Byte offsets/lengths shared by the protocol framing (mirrors node-mavlink). */
const V1_PAYLOAD_OFFSET = 6;
const V2_PAYLOAD_OFFSET = 10;
const CHECKSUM_LENGTH = 2;
const V2_IFLAG_SIGNED = 0x01;

/** msgid of the carrier message (DEBUG_FLOAT_ARRAY). */
const CARRIER_MSG_ID = common.DebugFloatArray.MSG_ID;

/** Number of float slots available in the carrier's data array. */
const DATA_LEN = 58;

/** Max length of the carrier's `name` field, reused for `flightMode`. */
export const MAX_FLIGHT_MODE_LENGTH = 10;

/**
 * Discriminator written to the carrier's `arrayId` so the parser can recognize
 * frames produced by this service and ignore unrelated DEBUG_FLOAT_ARRAY
 * traffic. (`PA` = 0x5041 — "PAWAAC".)
 */
const TELEMETRY_ARRAY_ID = 0x5041;

/**
 * Fixed positions of each scalar field within the carrier's float[58] payload.
 * Stable ordering is what makes encode/parseFrame inverses.
 */
const Slot = {
  lat: 0,
  lon: 1,
  altitude: 2,
  vx: 3,
  vy: 4,
  vz: 5,
  roll: 6,
  pitch: 7,
  yaw: 8,
  voltage: 9,
  current: 10,
  remainingPct: 11,
  ekf2Healthy: 12,
  ekf2Flags: 13,
  rcSignalStrength: 14,
  armed: 15,
} as const;

/** Connection-supplied context required to fully reconstruct a sample. */
export interface ParseContext {
  /** Identity of the authenticated drone the frame arrived from. */
  readonly droneId: Uuid;
}

/**
 * Error thrown when a frame cannot be decoded into a valid sample: bad start
 * byte, truncated buffer, CRC mismatch, wrong/unknown message, or a non-finite
 * field. Callers (the WS ingest path) catch this to drop the frame, increment
 * the parse-error metric, and keep the socket open (Req 8.6).
 */
export class MalformedFrameError extends Error {
  constructor(reason: string) {
    super(`Malformed MAVLink frame: ${reason}`);
    this.name = 'MalformedFrameError';
  }
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requireFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new MalformedFrameError(`non-finite value for ${field}`);
  }
  return value;
}

/**
 * Convert an ISO-8601 timestamp to MAVLink microseconds-since-epoch. Throws
 * {@link MalformedFrameError} for an unparseable timestamp so encode failures
 * surface the same way as decode failures.
 */
function isoToMicros(ts: string): bigint {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) {
    throw new MalformedFrameError(`unparseable timestamp "${ts}"`);
  }
  return BigInt(ms) * 1000n;
}

/** Convert MAVLink microseconds-since-epoch back to a canonical ISO timestamp. */
function microsToIso(usec: bigint): string {
  const ms = Number(usec / 1000n);
  return new Date(ms).toISOString();
}

/**
 * Serialize a normalized telemetry sample into a complete MAVLink v2 frame.
 * Provided primarily so the parse/serialize round-trip (P15) can be exercised,
 * but also usable by simulators/load tooling.
 *
 * Note: `flightMode` must be at most {@link MAX_FLIGHT_MODE_LENGTH} characters
 * to round-trip without truncation (carrier `name` field limit).
 */
export function encode(sample: TelemetrySample): Uint8Array {
  if (sample.flightMode.length > MAX_FLIGHT_MODE_LENGTH) {
    throw new MalformedFrameError(
      `flightMode "${sample.flightMode}" exceeds ${MAX_FLIGHT_MODE_LENGTH} characters`,
    );
  }

  const msg = new common.DebugFloatArray();
  msg.timeUsec = isoToMicros(sample.ts);
  msg.arrayId = TELEMETRY_ARRAY_ID;
  msg.name = sample.flightMode;

  const data = new Array<number>(DATA_LEN).fill(0);
  data[Slot.lat] = sample.lat;
  data[Slot.lon] = sample.lon;
  data[Slot.altitude] = sample.altitude;
  data[Slot.vx] = sample.velocity.vx;
  data[Slot.vy] = sample.velocity.vy;
  data[Slot.vz] = sample.velocity.vz;
  data[Slot.roll] = sample.attitude.roll;
  data[Slot.pitch] = sample.attitude.pitch;
  data[Slot.yaw] = sample.attitude.yaw;
  data[Slot.voltage] = sample.battery.voltage;
  data[Slot.current] = sample.battery.current;
  data[Slot.remainingPct] = sample.battery.remainingPct;
  data[Slot.ekf2Healthy] = sample.ekf2.healthy ? 1 : 0;
  data[Slot.ekf2Flags] = sample.ekf2.flags;
  data[Slot.rcSignalStrength] = sample.rcSignalStrength;
  data[Slot.armed] = sample.armed ? 1 : 0;
  msg.data = data;

  const frame = new MavLinkProtocolV2().serialize(msg, 0);
  return Uint8Array.from(frame);
}

/**
 * Decode a single, complete MAVLink frame into a normalized telemetry sample.
 *
 * @throws {MalformedFrameError} when the frame is not a well-formed, CRC-valid
 *   carrier frame, or carries a non-finite field value.
 */
export function parseFrame(bytes: Uint8Array, context: ParseContext): TelemetrySample {
  const buffer = toBuffer(bytes);

  if (buffer.length < 1) {
    throw new MalformedFrameError('empty buffer');
  }

  const stx = buffer.readUInt8(0);
  if (stx !== STX_V1 && stx !== STX_V2) {
    throw new MalformedFrameError(`invalid start byte 0x${stx.toString(16)}`);
  }

  const isV2 = stx === STX_V2;
  const payloadOffset = isV2 ? V2_PAYLOAD_OFFSET : V1_PAYLOAD_OFFSET;

  // The frame must at least contain a full header.
  if (buffer.length < payloadOffset + CHECKSUM_LENGTH) {
    throw new MalformedFrameError('buffer shorter than minimum frame');
  }

  const protocol = isV2 ? new MavLinkProtocolV2() : new MavLinkProtocolV1();

  let header;
  try {
    header = protocol.header(buffer);
  } catch (err) {
    throw new MalformedFrameError(err instanceof Error ? err.message : 'header read failed');
  }

  // V2 signed frames append 13 signature bytes; we only emit/accept unsigned
  // frames, so reject signed traffic rather than mis-validate its CRC.
  if (isV2 && (header.incompatibilityFlags & V2_IFLAG_SIGNED) !== 0) {
    throw new MalformedFrameError('signed frames are not supported');
  }

  const frameLength = payloadOffset + header.payloadLength + CHECKSUM_LENGTH;
  if (buffer.length < frameLength) {
    throw new MalformedFrameError('declared payload length exceeds buffer');
  }

  if (header.msgid !== CARRIER_MSG_ID) {
    throw new MalformedFrameError(`unsupported message id ${header.msgid}`);
  }

  // Validate the x25 CRC over the framed bytes (start byte excluded, trailing
  // checksum excluded) seeded with the message's CRC_EXTRA magic number.
  const expectedCrc = x25crc(buffer.subarray(0, frameLength), 1, 2, common.DebugFloatArray.MAGIC_NUMBER);
  const actualCrc = buffer.readUInt16LE(payloadOffset + header.payloadLength);
  if (expectedCrc !== actualCrc) {
    throw new MalformedFrameError('checksum mismatch');
  }

  let decoded: common.DebugFloatArray;
  try {
    const payload = protocol.payload(buffer);
    decoded = protocol.data(payload, common.DebugFloatArray);
  } catch (err) {
    throw new MalformedFrameError(err instanceof Error ? err.message : 'payload decode failed');
  }

  if (decoded.arrayId !== TELEMETRY_ARRAY_ID) {
    throw new MalformedFrameError(`unexpected array id ${decoded.arrayId}`);
  }

  const data = decoded.data;
  if (!Array.isArray(data) || data.length < DATA_LEN) {
    throw new MalformedFrameError('truncated data array');
  }

  const at = (slot: number, field: string): number => requireFinite(data[slot] ?? Number.NaN, field);

  return {
    droneId: context.droneId,
    ts: microsToIso(decoded.timeUsec),
    lat: at(Slot.lat, 'lat'),
    lon: at(Slot.lon, 'lon'),
    altitude: at(Slot.altitude, 'altitude'),
    velocity: {
      vx: at(Slot.vx, 'velocity.vx'),
      vy: at(Slot.vy, 'velocity.vy'),
      vz: at(Slot.vz, 'velocity.vz'),
    },
    attitude: {
      roll: at(Slot.roll, 'attitude.roll'),
      pitch: at(Slot.pitch, 'attitude.pitch'),
      yaw: at(Slot.yaw, 'attitude.yaw'),
    },
    battery: {
      voltage: at(Slot.voltage, 'battery.voltage'),
      current: at(Slot.current, 'battery.current'),
      remainingPct: at(Slot.remainingPct, 'battery.remainingPct'),
    },
    ekf2: {
      healthy: at(Slot.ekf2Healthy, 'ekf2.healthy') !== 0,
      flags: Math.round(at(Slot.ekf2Flags, 'ekf2.flags')),
    },
    rcSignalStrength: at(Slot.rcSignalStrength, 'rcSignalStrength'),
    flightMode: decoded.name,
    armed: at(Slot.armed, 'armed') !== 0,
  };
}
