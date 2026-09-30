// SPEC 8.3: "Every operation declares its argument and result types ... The signature
// table lives in packages/engine and is the single source for the type checker, the
// editor and the prompt." This test guards the "and the prompt" half of that sentence,
// for learn-v5's formula syntax: every operation `OP_SIGNATURES` knows about must be
// documented in LEARN_PROMPT.md's "# Operations" section, either as its infix symbol
// (add/sub/mul/div/eq/ne/gt/gte/lt/lte) or as its function-call form `name(` (everything
// else) - so the LLM is never asked to use an operation it hasn't been told about.
import { describe, expect, it } from 'vitest';
import { LEARN_SYSTEM_PROMPT_V6 } from '@formatai/shared';
import { OP_SIGNATURES, type SigOp } from '../../src/check/signatures';

/** The "# Operations" section of LEARN_PROMPT §2 (learn-v6): from "# Operations" to the
 * "# Example" heading that follows it. Also documents functions/tables/rowFilters/
 * dedupe/expand/valueMaps/sort/group/titleRows/validations/output.file - this test only
 * checks that every OP_SIGNATURES op is mentioned somewhere in it. */
function extractOperationsSection(prompt: string): string {
  const match = prompt.match(/# Operations\n([\s\S]*?)\n# Example/);
  if (!match) throw new Error('Could not find the "# Operations" section in the prompt');
  return match[1] as string;
}

describe('LEARN_PROMPT.md Operations section <-> engine OP_SIGNATURES (SPEC 8.3, learn-v6 formulas)', () => {
  const section = extractOperationsSection(LEARN_SYSTEM_PROMPT_V6);
  const ops = Object.keys(OP_SIGNATURES) as SigOp[];

  it('every OP_SIGNATURES op appears in the prompt formula list', () => {
    const missing = ops.filter((op) => {
      const formula = OP_SIGNATURES[op].formula;
      if (formula.form === 'infix') return !section.includes(formula.symbol);
      if (formula.form === 'call') return !section.includes(`${op}(`);
      // 'special' (switch, call): documented by name, not a fixed call form.
      return !new RegExp(`\\b${op}\\b`).test(section);
    });
    expect(missing).toEqual([]);
  });

  it('every call-form op is documented with its own fixed function name', () => {
    for (const op of ops) {
      const formula = OP_SIGNATURES[op].formula;
      if (formula.form === 'call') {
        expect(section, `expected "${op}(" in the prompt's Operations section`).toContain(`${op}(`);
      }
    }
  });

  it('the six comparison symbols and four arithmetic symbols are all documented', () => {
    for (const symbol of ['+', '-', '*', '/', '=', '<>', '<', '>', '<=', '>=']) {
      expect(section, `expected infix symbol "${symbol}" in the prompt's Operations section`).toContain(symbol);
    }
  });
});
