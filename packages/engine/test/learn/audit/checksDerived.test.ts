// Engine audit (2026-10-07), fix 6: in an AI code check's answer, a computed value read from a TEXT column was masked as `text`, so a number
// derived from it (the digits of a reference inside a note) was sent real. Now anything derived from a masked column - text or an identifier
// - is masked as an `identifier`, the class that hides numbers too. (AI checks are off by default.)
import type { TestAnswer } from '@formatai/shared';
import { limits, payloadRowCount } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { answerChecks } from '../../../src/learn/checks';
import { classifyColumns } from '../../../src/learn/classify';
import { createMasker } from '../../../src/learn/mask';
import { buildPayload } from '../../../src/learn/payload';
import { preflight } from '../../../src/learn/preflight';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';

const N = 30;
const codes = Array.from({ length: N }, (_, i) => 482913 + i * 7919);
const amounts = Array.from({ length: N }, (_, i) => 40 + ((i * 397) % 3000));
const input: V[][] = [['Note', 'Amount'], ...codes.map((c, i) => [`Ref ${c} ok`, amounts[i]!])];
const output: V[][] = [['Note', 'Amount'], ...codes.map((c, i) => [`Ref ${c} ok`, amounts[i]!])];
const analysis = analyzeOk(xlsx(input), xlsx(output));

describe('a number derived from a text column is masked in a check\'s answer', () => {
  const masker = createMasker(new TextEncoder().encode('checks-derived'));
  const built = buildPayload(analysis, preflight(analysis, 'paid'), { masker });
  const ctx = { analysis, masker, sent: new Set(built.sampleRows.map((s) => s.in)), rowBudget: limits.learn.loop.maxRowsTotal - payloadRowCount(built.payload) };

  it('the setup: the note is text (masked), the amount a measure', () => {
    expect(classifyColumns(analysis).input).toEqual(['text', 'measure']);
  });

  it('test: `got` (the digits of the note, as a number) carries no real code; the expected amounts stay real', () => {
    const a = answerChecks([{ check: 'test', column: 'Amount', let: [{ id: 'c', expr: 'toNumber(split(in0, " ", 2))' }], rule: 'c' }], ctx).answers[0] as TestAnswer;
    expect(a.matched).toBe(0);
    expect(a.failing.length).toBeGreaterThan(0);
    const json = JSON.stringify(a);
    for (const c of codes) expect(json).not.toContain(String(c));
    for (const f of a.failing) {
      expect(amounts).toContain(f.expected);
      expect(typeof f.got).toBe('number');
      expect(String(f.got)).toHaveLength(6);
    }
  });

  it('a number derived from a measure only stays real', () => {
    const a = answerChecks([{ check: 'test', column: 'Amount', let: [{ id: 'd', expr: 'in1 + 1' }], rule: 'd' }], ctx).answers[0] as TestAnswer;
    expect(a.failing.length).toBeGreaterThan(0);
    for (const f of a.failing) expect(f.got).toBe((f.expected as number) + 1);
  });
});
