// Deterministic, dependency-free PRNG for generating synthetic eval fixtures
// (SPEC 10). Every case seeds its own generator from its case name, so
// `pnpm --filter @formatai/eval exec tsx cases/build.ts` reproduces byte-identical
// input files on every run (same requirement the engine itself has for output,
// SPEC 2.1/18 determinism) without needing to commit a separate random seed file.

/** Small, fast string hash (djb2) used only to turn a case name into a numeric seed. */
function seedFromString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

/** mulberry32: a small, fast, deterministic PRNG. Returns a function yielding
 * floats in [0, 1), same sequence every time for the same seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

/** Creates a seeded RNG from a human-readable label (typically the case name plus
 * a suffix like "-next" for the hold-out pair, so the two are related but distinct). */
export function makeRng(label: string): Rng {
  return mulberry32(seedFromString(label));
}

/** Random integer in [min, max], inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Random element of a non-empty array. */
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('pick: empty array');
  return arr[randInt(rng, 0, arr.length - 1)] as T;
}

/** Fisher-Yates shuffle, deterministic given `rng`. Does not mutate `arr`. */
export function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Random decimal amount in [min, max], rounded to `digits` decimal places (plain
 * JS rounding is fine here: these are synthetic input values, not engine output). */
export function randAmount(rng: Rng, min: number, max: number, digits = 2): number {
  const v = rng() * (max - min) + min;
  const factor = 10 ** digits;
  return Math.round(v * factor) / factor;
}

/** True with probability `p` (0..1). */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}
