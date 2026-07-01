/**
 * Unit tests for the load-test statistics helpers (task 7.10). These pin the
 * percentile maths the benchmark relies on (Req 32.2: p50/p95/p99 latency) so a
 * regression in the harness's reported numbers is caught without needing a
 * running server.
 */
import { percentile, ratio, summarizeLatency } from './stats.js';

describe('percentile', () => {
  it('returns NaN for an empty sample set', () => {
    expect(percentile([], 50)).toBeNaN();
  });

  it('returns the sole value for a single-element set regardless of p', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it('returns the min at p=0 and the max at p=100', () => {
    const samples = [5, 1, 4, 2, 3];
    expect(percentile(samples, 0)).toBe(1);
    expect(percentile(samples, 100)).toBe(5);
  });

  it('computes the median (p50) of an odd-length set', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('interpolates p95 and p99 using the inclusive linear method', () => {
    // n=5 -> rank = p/100 * 4. p95 -> 3.8 -> 4 + 0.8*(5-4) = 4.8; p99 -> 3.96 -> 4.96.
    expect(percentile([1, 2, 3, 4, 5], 95)).toBeCloseTo(4.8, 10);
    expect(percentile([1, 2, 3, 4, 5], 99)).toBeCloseTo(4.96, 10);
  });

  it('does not depend on input ordering (sorts internally)', () => {
    const ascending = [10, 20, 30, 40];
    const shuffled = [30, 10, 40, 20];
    expect(percentile(shuffled, 75)).toBe(percentile(ascending, 75));
  });

  it('does not mutate the input array', () => {
    const samples = [3, 1, 2];
    percentile(samples, 50);
    expect(samples).toEqual([3, 1, 2]);
  });

  it('throws RangeError for out-of-range or non-finite p', () => {
    expect(() => percentile([1, 2, 3], -1)).toThrow(RangeError);
    expect(() => percentile([1, 2, 3], 101)).toThrow(RangeError);
    expect(() => percentile([1, 2, 3], Number.NaN)).toThrow(RangeError);
  });
});

describe('summarizeLatency', () => {
  it('reports NaN fields for an empty set', () => {
    const summary = summarizeLatency([]);
    expect(summary.count).toBe(0);
    expect(summary.min).toBeNaN();
    expect(summary.max).toBeNaN();
    expect(summary.mean).toBeNaN();
    expect(summary.p50).toBeNaN();
  });

  it('computes count/min/max/mean and percentiles together', () => {
    const summary = summarizeLatency([1, 2, 3, 4, 5]);
    expect(summary.count).toBe(5);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(5);
    expect(summary.mean).toBe(3);
    expect(summary.p50).toBe(3);
  });
});

describe('ratio', () => {
  it('returns 0 when the denominator is 0', () => {
    expect(ratio(5, 0)).toBe(0);
    expect(ratio(0, 0)).toBe(0);
  });

  it('computes a normal ratio otherwise', () => {
    expect(ratio(1, 4)).toBe(0.25);
  });
});
