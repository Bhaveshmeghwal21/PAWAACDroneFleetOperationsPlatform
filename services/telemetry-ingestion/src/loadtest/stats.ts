/**
 * Pure statistics helpers for the telemetry load-test harness (task 7.10,
 * Requirements 8.7, 32.1, 32.2).
 *
 * These are deliberately dependency-free and side-effect free so they can be
 * unit-tested in isolation and reused by the harness to turn a raw vector of
 * per-frame latency samples into the p50/p95/p99 percentiles and the aggregate
 * throughput / dropped-frame figures the benchmark (task 17.5) records.
 */

/**
 * Linear-interpolation percentile (a.k.a. the "inclusive"/Excel `PERCENTILE.INC`
 * method) over a vector of numeric samples.
 *
 * The input does not need to be pre-sorted — a sorted copy is taken internally.
 * `p` is a percentage in the closed range `[0, 100]`.
 *
 * Behaviour at the edges:
 * - An empty input yields `NaN` (no data to summarize).
 * - A single-element input yields that element for every `p`.
 * - `p = 0` yields the minimum, `p = 100` the maximum.
 *
 * For an in-between `p`, the rank `r = (p / 100) * (n - 1)` is computed and the
 * result is interpolated between the values at `floor(r)` and `ceil(r)`.
 *
 * @param samples Latency (or any) samples; not mutated.
 * @param p Percentile to compute, in `[0, 100]`.
 * @throws RangeError when `p` is outside `[0, 100]` or not finite.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new RangeError(`percentile p must be within [0, 100], received ${p}`);
  }
  const n = samples.length;
  if (n === 0) {
    return Number.NaN;
  }
  if (n === 1) {
    return samples[0] as number;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p / 100) * (n - 1);
  const lowIndex = Math.floor(rank);
  const highIndex = Math.ceil(rank);
  const low = sorted[lowIndex] as number;
  if (lowIndex === highIndex) {
    return low;
  }
  const high = sorted[highIndex] as number;
  const fraction = rank - lowIndex;
  return low + (high - low) * fraction;
}

/** Summary of a latency sample vector (all values in the input's unit, ms here). */
export interface LatencySummary {
  /** Number of latency samples observed. */
  readonly count: number;
  /** Smallest observed latency, or `NaN` when there are no samples. */
  readonly min: number;
  /** Largest observed latency, or `NaN` when there are no samples. */
  readonly max: number;
  /** Arithmetic mean, or `NaN` when there are no samples. */
  readonly mean: number;
  /** 50th percentile (median). */
  readonly p50: number;
  /** 95th percentile. */
  readonly p95: number;
  /** 99th percentile. */
  readonly p99: number;
}

/** Reduce a vector of latency samples to its min/max/mean and p50/p95/p99. */
export function summarizeLatency(samples: readonly number[]): LatencySummary {
  const count = samples.length;
  if (count === 0) {
    return { count: 0, min: Number.NaN, max: Number.NaN, mean: Number.NaN, p50: Number.NaN, p95: Number.NaN, p99: Number.NaN };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const value of samples) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
    sum += value;
  }
  return {
    count,
    min,
    max,
    mean: sum / count,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
  };
}

/**
 * Safe ratio helper: returns `0` when the denominator is `0` (rather than
 * `NaN`/`Infinity`), so an empty run reports a `0` dropped-frame rate instead
 * of a non-numeric value.
 */
export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
