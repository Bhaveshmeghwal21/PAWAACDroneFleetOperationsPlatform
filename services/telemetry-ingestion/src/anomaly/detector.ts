/**
 * Real-time telemetry anomaly detection (Requirement 9, design Algorithm 2).
 *
 * {@link detectAnomalies} is a **pure** function of `(sample, history)` — given
 * a new {@link TelemetrySample} and a recent, ascending-by-`ts` sliding window
 * of prior samples for the *same* drone, it returns one {@link Anomaly} per
 * threshold breach (Req 9.1) and `[]` when the sample is within all thresholds.
 * It performs no I/O, reads no clocks, and never mutates its inputs, so it is
 * deterministic for identical inputs (Req 9.2 / property P16) and can be
 * exhaustively property-tested in task 7.6.
 *
 * Detected kinds (Req 9.3–9.6, design Algorithm 2 thresholds):
 * - **ALTITUDE_DROP** — descent rate `(prev.altitude - sample.altitude) / dt`
 *   exceeds {@link AnomalyThresholds.altDropThreshold} (m/s).
 * - **BATTERY_DRAIN_SPIKE** — drain rate
 *   `(prev.battery.remainingPct - sample.battery.remainingPct) / dt` exceeds
 *   {@link AnomalyThresholds.batteryDrainThreshold} (%/s).
 * - **EKF2_DEGRADED** — `ekf2.healthy` transitions `true -> false`, or the
 *   sample reports non-zero unhealthy `ekf2.flags`.
 * - **GPS_ACCURACY_LOSS** — see the field-modeling note below.
 *
 * ## GPS accuracy modeling decision
 *
 * The normalized {@link TelemetrySample} (owned by `@pawaac/shared-types`)
 * carries **no** dedicated horizontal-accuracy (`hAcc`) or GPS-fix field, and
 * the shared type must not be changed for this task. Real PX4 vehicles surface
 * GPS quality/fault checks *inside* the EKF2 estimator status bitmask, so we
 * adopt that same convention here: a reserved bit of `ekf2.flags`
 * ({@link GPS_FAULT_FLAG}) is treated as the "GPS horizontal accuracy degraded
 * / fix lost" indicator. `GPS_ACCURACY_LOSS` is **edge-triggered**: it fires on
 * the worsening transition where the GPS-fault bit is set in `sample` but was
 * clear in `prev` (i.e. accuracy newly worsened / fix newly lost). Edge — not
 * level — triggering avoids re-emitting the same anomaly on every 10 Hz frame
 * while a fault persists, matching the "worsens beyond threshold" phrasing of
 * Req 9.6.
 *
 * Because the GPS indicator lives in `ekf2.flags`, a sample with the GPS-fault
 * bit set also satisfies the EKF2 "non-zero flags" condition. Emitting **both**
 * `GPS_ACCURACY_LOSS` and `EKF2_DEGRADED` for such a sample is intentional and
 * spec-faithful: Req 9.1 calls for "an Anomaly for each threshold breach", and
 * these are two distinct breaches (the estimator is degraded *and* GPS accuracy
 * specifically was lost).
 */
import type { Anomaly, AnomalyKind, TelemetrySample } from '@pawaac/shared-types';

/**
 * A recent, ascending-by-`ts` window of prior samples for one drone. Only the
 * most recent entry (`prev`) participates in rate computations, but the full
 * window is accepted to honour the design contract and leave room for
 * multi-sample heuristics without changing the signature.
 */
export type SampleWindow = readonly TelemetrySample[];

/** Configurable detection thresholds (design Algorithm 2 "configurable defaults"). */
export interface AnomalyThresholds {
  /** Descent rate (m/s) strictly above which ALTITUDE_DROP is flagged. */
  readonly altDropThreshold: number;
  /** Battery drain rate (%/s) strictly above which BATTERY_DRAIN_SPIKE is flagged. */
  readonly batteryDrainThreshold: number;
}

/** Design default: descent faster than 10 m/s is an altitude drop. */
export const DEFAULT_ALT_DROP_THRESHOLD = 10;

/**
 * Default battery drain spike threshold (%/s). A healthy heavy-discharge drone
 * draining 100% over ~10 min is ~0.17 %/s; 1 %/s (a full pack in <2 min) is a
 * conservative "spike" boundary. Override via `BATTERY_DRAIN_THRESHOLD`.
 */
export const DEFAULT_BATTERY_DRAIN_THRESHOLD = 1;

/** Frozen default thresholds used when configuration supplies none. */
export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = Object.freeze({
  altDropThreshold: DEFAULT_ALT_DROP_THRESHOLD,
  batteryDrainThreshold: DEFAULT_BATTERY_DRAIN_THRESHOLD,
});

/**
 * Reserved bit within `ekf2.flags` modeling a GPS horizontal-accuracy / fix
 * fault (see the module-level "GPS accuracy modeling decision"). Bit 0.
 */
export const GPS_FAULT_FLAG = 0x01;

/** True iff the sample's EKF2 flags indicate a GPS-fault condition. */
function hasGpsFault(sample: TelemetrySample): boolean {
  return (sample.ekf2.flags & GPS_FAULT_FLAG) !== 0;
}

/** Parse an ISO timestamp to epoch ms, or `null` when unparseable. */
function tsToMillis(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** Build an anomaly record attributed to the sample. */
function makeAnomaly(kind: AnomalyKind, sample: TelemetrySample, detail: string): Anomaly {
  return { kind, droneId: sample.droneId, ts: sample.ts, detail };
}

/**
 * EKF2 degradation predicate (Req 9.5): the estimator transitions from healthy
 * to unhealthy, or the sample reports any non-zero unhealthy flags. `prev` is
 * optional so the empty-history path can reuse the same logic.
 */
function isEkf2Degraded(sample: TelemetrySample, prev?: TelemetrySample): boolean {
  const transitioned = prev !== undefined && prev.ekf2.healthy && !sample.ekf2.healthy;
  const unhealthyNow = !sample.ekf2.healthy || sample.ekf2.flags !== 0;
  // With history, "degraded" is the healthy->unhealthy transition OR non-zero
  // flags; without history we can only judge the sample in isolation.
  return prev === undefined ? unhealthyNow : transitioned || sample.ekf2.flags !== 0;
}

/**
 * Detect anomalies for `sample` given the recent per-drone `history`.
 *
 * Pure and deterministic (Req 9.2 / P16): no side effects, no clock/network
 * reads, inputs never mutated. Anomalies are returned in a stable order
 * (altitude, battery, EKF2, GPS).
 *
 * @param sample  the new telemetry sample
 * @param history ascending-by-`ts` window of prior samples for the same drone
 * @param thresholds configurable detection thresholds (defaults applied)
 */
export function detectAnomalies(
  sample: TelemetrySample,
  history: SampleWindow,
  thresholds: AnomalyThresholds = DEFAULT_ANOMALY_THRESHOLDS,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // No prior sample: rate-based detections are undefined; only the EKF2 health
  // of the sample in isolation can be judged (design empty-history branch).
  if (history.length === 0) {
    if (isEkf2Degraded(sample)) {
      anomalies.push(
        makeAnomaly(
          'EKF2_DEGRADED',
          sample,
          `EKF2 unhealthy on first sample (healthy=${String(sample.ekf2.healthy)}, flags=${sample.ekf2.flags})`,
        ),
      );
    }
    return anomalies;
  }

  const prev = history[history.length - 1] as TelemetrySample;

  // dt in seconds. The precondition guarantees sample.ts > prev.ts, but we
  // guard defensively: a non-positive/unparseable dt makes rates undefined, so
  // rate-based detections are skipped (health/GPS checks still run).
  const prevMs = tsToMillis(prev.ts);
  const sampleMs = tsToMillis(sample.ts);
  const dt =
    prevMs === null || sampleMs === null ? Number.NaN : (sampleMs - prevMs) / 1000;
  const dtUsable = Number.isFinite(dt) && dt > 0;

  if (dtUsable) {
    const descentRate = (prev.altitude - sample.altitude) / dt;
    if (descentRate > thresholds.altDropThreshold) {
      anomalies.push(
        makeAnomaly(
          'ALTITUDE_DROP',
          sample,
          `descent rate ${descentRate.toFixed(2)} m/s exceeds ${thresholds.altDropThreshold} m/s`,
        ),
      );
    }

    const drainRate = (prev.battery.remainingPct - sample.battery.remainingPct) / dt;
    if (drainRate > thresholds.batteryDrainThreshold) {
      anomalies.push(
        makeAnomaly(
          'BATTERY_DRAIN_SPIKE',
          sample,
          `battery drain ${drainRate.toFixed(2)} %/s exceeds ${thresholds.batteryDrainThreshold} %/s`,
        ),
      );
    }
  }

  if (isEkf2Degraded(sample, prev)) {
    anomalies.push(
      makeAnomaly(
        'EKF2_DEGRADED',
        sample,
        `EKF2 degraded (healthy ${String(prev.ekf2.healthy)}->${String(sample.ekf2.healthy)}, flags=${sample.ekf2.flags})`,
      ),
    );
  }

  // GPS accuracy loss: edge-triggered worsening transition (clear -> set).
  if (hasGpsFault(sample) && !hasGpsFault(prev)) {
    anomalies.push(
      makeAnomaly(
        'GPS_ACCURACY_LOSS',
        sample,
        'GPS horizontal accuracy degraded / fix lost (EKF2 GPS-fault flag set)',
      ),
    );
  }

  return anomalies;
}
