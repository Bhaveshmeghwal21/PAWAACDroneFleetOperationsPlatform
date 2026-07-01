/**
 * Unit tests for the MAVLink frame codec (task 7.3).
 *
 * Covers the parse/serialize round-trip (Req 8.3 / P15) on representative
 * samples and the malformed-frame rejection paths that the ingest layer relies
 * on to drop frames and increment the parse-error metric (Req 8.6). Exhaustive
 * generated round-trip coverage is the subject of the property tests (task
 * 7.4).
 */
import type { TelemetrySample } from '@pawaac/shared-types';
import { encode, MalformedFrameError, MAX_FLIGHT_MODE_LENGTH, parseFrame } from './codec.js';

const DRONE_ID = '11111111-2222-3333-4444-555555555555';

function sampleFixture(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    droneId: DRONE_ID,
    ts: '2024-01-01T12:00:00.000Z',
    lat: 47.397742,
    lon: 8.545594,
    altitude: 123.5,
    velocity: { vx: 1.25, vy: -2.5, vz: 0.75 },
    attitude: { roll: 0.1, pitch: -0.2, yaw: 1.57 },
    battery: { voltage: 12.6, current: 5.4, remainingPct: 87 },
    ekf2: { healthy: true, flags: 0 },
    rcSignalStrength: 92,
    flightMode: 'OFFBOARD',
    armed: true,
    ...overrides,
  };
}

/** Compare two samples for round-trip equality within float32 tolerance. */
function expectRoundTrip(sample: TelemetrySample): void {
  const decoded = parseFrame(encode(sample), { droneId: sample.droneId });
  expect(decoded.droneId).toBe(sample.droneId);
  expect(decoded.ts).toBe(sample.ts);
  expect(decoded.flightMode).toBe(sample.flightMode);
  expect(decoded.armed).toBe(sample.armed);
  expect(decoded.ekf2.healthy).toBe(sample.ekf2.healthy);
  expect(decoded.ekf2.flags).toBe(sample.ekf2.flags);
  expect(decoded.lat).toBeCloseTo(sample.lat, 3);
  expect(decoded.lon).toBeCloseTo(sample.lon, 3);
  expect(decoded.altitude).toBeCloseTo(sample.altitude, 3);
  expect(decoded.velocity.vx).toBeCloseTo(sample.velocity.vx, 3);
  expect(decoded.velocity.vy).toBeCloseTo(sample.velocity.vy, 3);
  expect(decoded.velocity.vz).toBeCloseTo(sample.velocity.vz, 3);
  expect(decoded.attitude.roll).toBeCloseTo(sample.attitude.roll, 3);
  expect(decoded.attitude.pitch).toBeCloseTo(sample.attitude.pitch, 3);
  expect(decoded.attitude.yaw).toBeCloseTo(sample.attitude.yaw, 3);
  expect(decoded.battery.voltage).toBeCloseTo(sample.battery.voltage, 3);
  expect(decoded.battery.current).toBeCloseTo(sample.battery.current, 3);
  expect(decoded.battery.remainingPct).toBeCloseTo(sample.battery.remainingPct, 3);
  expect(decoded.rcSignalStrength).toBeCloseTo(sample.rcSignalStrength, 3);
}

describe('MAVLink codec round-trip (Req 8.3 / P15)', () => {
  it('reconstructs a representative sample within tolerance', () => {
    expectRoundTrip(sampleFixture());
  });

  it('round-trips negative and zero field values', () => {
    expectRoundTrip(
      sampleFixture({
        altitude: 0,
        velocity: { vx: -10.5, vy: 0, vz: -0.001 },
        attitude: { roll: -3.14, pitch: 0, yaw: -1.5 },
        battery: { voltage: 0, current: -2.1, remainingPct: 0 },
        rcSignalStrength: 0,
        armed: false,
        ekf2: { healthy: false, flags: 3 },
      }),
    );
  });

  it('round-trips the boolean and flag fields exactly', () => {
    const decoded = parseFrame(
      encode(sampleFixture({ armed: false, ekf2: { healthy: false, flags: 42 } })),
      { droneId: DRONE_ID },
    );
    expect(decoded.armed).toBe(false);
    expect(decoded.ekf2.healthy).toBe(false);
    expect(decoded.ekf2.flags).toBe(42);
  });

  it('uses the connection-supplied droneId, not a payload value', () => {
    const other = '99999999-8888-7777-6666-555555555555';
    const decoded = parseFrame(encode(sampleFixture()), { droneId: other });
    expect(decoded.droneId).toBe(other);
  });

  it('produces a MAVLink v2 frame (start byte 0xFD)', () => {
    const frame = encode(sampleFixture());
    expect(frame[0]).toBe(0xfd);
  });
});

describe('MAVLink codec encode validation', () => {
  it('rejects a flightMode longer than the carrier name field', () => {
    expect(() => encode(sampleFixture({ flightMode: 'X'.repeat(MAX_FLIGHT_MODE_LENGTH + 1) }))).toThrow(
      MalformedFrameError,
    );
  });

  it('rejects an unparseable timestamp', () => {
    expect(() => encode(sampleFixture({ ts: 'not-a-date' }))).toThrow(MalformedFrameError);
  });
});

describe('parseFrame malformed handling (Req 8.6)', () => {
  const ctx = { droneId: DRONE_ID };

  it('throws on an empty buffer', () => {
    expect(() => parseFrame(new Uint8Array(0), ctx)).toThrow(MalformedFrameError);
  });

  it('throws on an invalid start byte', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    expect(() => parseFrame(bytes, ctx)).toThrow(MalformedFrameError);
  });

  it('throws on a truncated frame', () => {
    const frame = encode(sampleFixture());
    const truncated = frame.subarray(0, 5);
    expect(() => parseFrame(truncated, ctx)).toThrow(MalformedFrameError);
  });

  it('throws on a corrupted payload (CRC mismatch)', () => {
    const frame = encode(sampleFixture());
    const corrupted = Uint8Array.from(frame);
    // Flip a byte in the middle of the payload.
    corrupted[20] = corrupted[20] ^ 0xff;
    expect(() => parseFrame(corrupted, ctx)).toThrow(MalformedFrameError);
  });

  it('throws on an unsupported message id', () => {
    const frame = encode(sampleFixture());
    const wrongMsg = Uint8Array.from(frame);
    // msgid occupies bytes 7..9 (little-endian, 3 bytes) in a v2 header.
    wrongMsg[7] = 0x00;
    wrongMsg[8] = 0x00;
    wrongMsg[9] = 0x00;
    expect(() => parseFrame(wrongMsg, ctx)).toThrow(MalformedFrameError);
  });
});
