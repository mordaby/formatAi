// SPEC 8.3: "Every operation declares its argument and result types ... The signature
// table lives in packages/engine and is the single source for the type checker, the
// editor and the prompt." This test guards the "and the prompt" half of that sentence,
// for learn-v5's formula syntax: every operation `OP_SIGNATURES` knows about must be
// documented in LEARN_PROMPT.md's "# Operations" section, either as its infix symbol
// (add/sub/mul/div/eq/ne/gt/gte/lt/lte) or as its function-call form (everything
// else) - so the LLM is never asked to use an operation it hasn't been told about.
//
// Exception: an op flagged `inPrompt: false` (weekday, makeDate, toDate, date, keepChars,
// titleCase, find) is supported by the engine, the formula parser and the editor but ships
// to the prompt with a later prompt version. It is skipped here - and must really be ABSENT
// from the prompt: the day the prompt documents it, the flag has to go (otherwise the API's
// LLM-answer check would keep rejecting an op the model was told to use).
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

/** The text that names an op in the prompt: its infix symbol, or `name(` for a call form
 * (the formula's own function name, which can differ from the op's name: `dateLiteral` is
 * written `date(...)`), or the bare word for the two irregular ops (switch, call). */
function mentions(section: string, op: SigOp): boolean {
  const formula = OP_SIGNATURES[op].formula;
  if (formula.form === 'infix') return section.includes(formula.symbol);
  if (formula.form === 'call') return section.includes(`${formula.fn}(`);
  return new RegExp(`\\b${op}\\b`).test(section);
}

describe('LEARN_PROMPT.md Operations section <-> engine OP_SIGNATURES (SPEC 8.3, learn-v6 formulas)', () => {
  const section = extractOperationsSection(LEARN_SYSTEM_PROMPT_V6);
  const ops = Object.keys(OP_SIGNATURES) as SigOp[];
  const inPrompt = ops.filter((op) => OP_SIGNATURES[op].inPrompt !== false);
  const notInPrompt = ops.filter((op) => OP_SIGNATURES[op].inPrompt === false);

  it('every OP_SIGNATURES op that is meant to be in the prompt appears in the prompt formula list', () => {
    expect(inPrompt.filter((op) => !mentions(section, op))).toEqual([]);
  });

  it('every call-form op that is in the prompt is documented with its own fixed function name', () => {
    for (const op of inPrompt) {
      const formula = OP_SIGNATURES[op].formula;
      if (formula.form === 'call') {
        expect(section, `expected "${formula.fn}(" in the prompt's Operations section`).toContain(`${formula.fn}(`);
      }
    }
  });

  it('an op flagged inPrompt: false is really not in the prompt yet (drop the flag when it ships)', () => {
    expect(notInPrompt.filter((op) => mentions(section, op))).toEqual([]);
  });

  it('the ops held back from the prompt are exactly the ones added after learn-v6', () => {
    expect(notInPrompt.sort()).toEqual(['dateLiteral', 'find', 'keepChars', 'makeDate', 'titleCase', 'toDate', 'weekday']);
  });

  it('the six comparison symbols and four arithmetic symbols are all documented', () => {
    for (const symbol of ['+', '-', '*', '/', '=', '<>', '<', '>', '<=', '>=']) {
      expect(section, `expected infix symbol "${symbol}" in the prompt's Operations section`).toContain(symbol);
    }
  });
});
