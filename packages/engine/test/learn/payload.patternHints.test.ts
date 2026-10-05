// The eval's `--no-pattern-hints` (docs/proposals/ai-code-checks.md section 8): the payload leaves out the pattern hints - `bands`,
// `dependsOn`, `contains`, what the pair analysis guesses about a column it could not explain - and keeps every other hint (the facts code
// proved). It measures the AI code checks against those hints.
import { describe, expect, it } from 'vitest';
import { buildPayload, PATTERN_HINT_RELS } from '../../src/learn/payload';
import { preflight } from '../../src/learn/preflight';
import { aiReadiness } from '../../src/learn/readiness';
import { analyzeOk, xlsx } from './analyze/helpers';
import { classPair } from './checksFixtures';

describe('payload: patternHints false', () => {
  const pair = classPair(60);
  const analysis = analyzeOk(xlsx(pair.input), xlsx(pair.output));
  const pf = preflight(analysis, 'paid');

  it('leaves out bands / dependsOn / contains and keeps the proven facts (the total is Qty x Price)', () => {
    const rels = (hints: readonly { rel: string }[]): string[] => hints.map((h) => h.rel);
    const withHints = rels(buildPayload(analysis, pf).payload.hints);
    expect(withHints).toContain('bands');
    expect(withHints).toContain('mul');
    const without = rels(buildPayload(analysis, pf, { patternHints: false }).payload.hints);
    for (const rel of PATTERN_HINT_RELS) expect(without).not.toContain(rel);
    expect(without).toEqual(withHints.filter((r) => !(PATTERN_HINT_RELS as readonly string[]).includes(r)));
  });

  it('the readiness gate builds the same payload (what learnFromExamples sends)', () => {
    const r = aiReadiness(analysis, pf, { patternHints: false });
    expect(r.ready && r.built?.payload.hints.some((h) => h.rel === 'bands')).toBe(false);
  });
});
