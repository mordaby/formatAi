// The engine stress test (eval/STRESS.md) on a small fixed set of seeds, as part of the eval tests: the first 30 seeds of the small
// profile, and the seeds that found the bugs fixed so far (each a regression test of its fix). Each case is generated, learned with the
// FREE engine only (no AI step, no network) and checked against the invariants; a case passes when it has no failure but the recorded
// open findings (stress/open.ts). The full run is the CLI: pnpm --filter ./eval stress --n 500.
import { describe, expect, it } from 'vitest';
import { checkCase } from '../stress/check';
import { buildCase, type SizeProfile } from '../stress/gen';
import { newFailures } from '../stress/open';

const FIRST: [SizeProfile, number][] = Array.from({ length: 30 }, (_, i) => ['small', i + 1]);
/** Seeds whose failure a fix (or a fair hold-out rule) took away: see eval/STRESS.md "Fixed". */
const REGRESSIONS: [SizeProfile, number][] = [
  ['small', 41],
  ['small', 60],
  ['small', 102],
  ['small', 125],
  ['small', 184],
  ['small', 193],
  ['small', 220],
  ['small', 231],
  ['small', 235],
  ['small', 275],
  ['small', 300],
  ['small', 458],
  ['small', 476],
  ['small', 500],
  ['mixed', 153],
];

describe('engine stress test: fixed seeds', () => {
  it.each([...FIRST, ...REGRESSIONS])('%s seed %i: no failure but the open findings', async (profile, seed) => {
    const c = await buildCase(seed, { profile });
    const r = await checkCase(c);
    expect(newFailures(r).map((f) => `[${f.invariant}:${f.kind}] ${f.detail}`)).toEqual([]);
  }, 60_000);
});
