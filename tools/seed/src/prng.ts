/**
 * Deterministic pseudo-random number generation for the seed script
 * (Requirement 29.2). Every value the generator produces derives solely from a
 * fixed integer seed, so repeated runs yield a byte-identical dataset.
 *
 * The core is `mulberry32` — a tiny, fast, well-distributed 32-bit PRNG. It is
 * intentionally NOT cryptographically secure; reproducibility, not
 * unpredictability, is the goal here.
 */

/**
 * Construct a `mulberry32` generator from a 32-bit seed. Returns a function
 * that yields successive floats in the half-open interval `[0, 1)`.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A small, convenience wrapper around `mulberry32` exposing typed helpers for
 * the kinds of values the generators need (bounded floats/ints, choices,
 * booleans). All helpers advance the same underlying deterministic stream, so
 * the *order* of calls is what makes a dataset reproducible — never call into
 * an `Rng` from non-deterministic code paths.
 */
export class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** Next float in `[0, 1)`. */
  unit(): number {
    return this.next();
  }

  /** Float in `[min, max)`. */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /**
   * Float in `[min, max)` rounded to `decimals` places. Rounding keeps the
   * persisted/asserted values stable and free of float-formatting noise.
   */
  floatFixed(min: number, max: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round(this.float(min, max) * factor) / factor;
  }

  /** Integer in `[min, max]` (both inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniformly pick one element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Rng.pick: cannot pick from an empty array');
    }
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Boolean that is `true` with probability `p` (default 0.5). */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}
