// Seeded, deterministic sampling (SPEC 6.2 "a random 2,000 aligned rows";
// non-negotiable 1: no Math.random, the same pair always gives the same sample).

/** mulberry32: a small, fast 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `size` distinct indices from [0, n), ascending. All of them when n <= size. */
export function sampleIndices(n: number, size: number, seed: number): number[] {
  if (n <= size) {
    const all: number[] = new Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return all;
  }
  const rnd = mulberry32(seed);
  // Partial Fisher-Yates over a virtual 0..n-1 array; only swapped slots are stored.
  const swapped = new Map<number, number>();
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(rnd() * (n - i));
    const vi = swapped.get(i) ?? i;
    const vj = swapped.get(j) ?? j;
    swapped.set(j, vi);
    out.push(vj);
  }
  return out.sort((a, b) => a - b);
}
