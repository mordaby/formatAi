// SPEC 8.3: "Every operation declares its argument and result types ... The signature
// table lives in packages/engine and is the single source for the type checker, the
// editor and the prompt." This test guards the "and the prompt" half of that sentence:
// every operation `OP_SIGNATURES` knows about must be documented in LEARN_PROMPT.md's
// "# Operations" section (so the LLM is told about it), and the prompt must never
// mention an operation the engine doesn't implement (so it can't promise something the
// engine would reject). Either direction drifting - a new op added to one side and
// forgotten on the other - fails this test instead of silently reaching the LLM or
// silently going unused.
import { describe, expect, it } from 'vitest';
import { LEARN_SYSTEM_PROMPT_V4 } from '@formatai/shared';
import { OP_SIGNATURES, type SigOp } from '../../src/check/signatures';

/**
 * The expression-operations paragraph of LEARN_PROMPT §2's "# Operations" section:
 * from "Expressions (expr) are trees." to the blank line before "functions:". The
 * "# Operations" section as a whole also documents other rule-language constructs
 * (functions, tables, rowFilters, dedupe, expand, valueMaps, sort, group, titleRows,
 * validations, output.file) that aren't expression operations at all, so this test
 * only ever looks at the sub-paragraph that actually lists `OP_SIGNATURES` ops.
 */
function extractExprOpsParagraph(prompt: string): string {
  const opsMatch = prompt.match(/# Operations\n([\s\S]*?)\n# Example/);
  if (!opsMatch) throw new Error('Could not find the "# Operations" section in the prompt');
  const section = opsMatch[1] as string;
  const start = section.indexOf('Expressions (expr) are trees.');
  const end = section.indexOf('\n\nfunctions:');
  if (start < 0 || end < 0) {
    throw new Error('Could not find the expression-operations paragraph inside "# Operations"');
  }
  return section.slice(start, end);
}

/**
 * Every op name mentioned in `section`. An op is introduced there either alone or in a
 * comma-separated list, always immediately followed by ":" (its field list) or "("
 * (a parenthetical, e.g. "not (\"arg\")") - e.g. "add, sub, mul, div, min, max: ..." or
 * "isEmpty, notEmpty (\"arg\"), oneOf (\"arg\", \"values\")".
 */
function mentionedOps(section: string): Set<string> {
  const re = /((?:[a-zA-Z][a-zA-Z0-9]*)(?:,\s*[a-zA-Z][a-zA-Z0-9]*)*)\s*(?=:|\()/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(section))) {
    for (const word of (m[1] as string).split(',')) found.add(word.trim());
  }
  return found;
}

/** Bare words that appear in the same comma-list-before-":"/"(" position as an op name,
 * but are category/type labels rather than operations themselves. Anything found in
 * the paragraph that is neither a known op nor in this list is exactly the drift this
 * test exists to catch (a new word the prompt introduces that the engine doesn't know,
 * or a rename this list wasn't updated for). */
const NON_OP_WORDS: ReadonlySet<string> = new Set([
  'Expressions',
  'Leaves',
  'Nodes',
  'Types',
  'Results',
  'Limits',
  'conditions',
  'decimal',
]);

describe('LEARN_PROMPT.md Operations section <-> engine OP_SIGNATURES (SPEC 8.3)', () => {
  const paragraph = extractExprOpsParagraph(LEARN_SYSTEM_PROMPT_V4);
  const mentioned = mentionedOps(paragraph);
  const ops = Object.keys(OP_SIGNATURES) as SigOp[];

  it('every OP_SIGNATURES op is mentioned in the prompt', () => {
    const missing = ops.filter((op) => !mentioned.has(op));
    expect(missing).toEqual([]);
  });

  it('every op-like word in the prompt is a known OP_SIGNATURES op', () => {
    const known = new Set<string>(ops);
    const unknown = [...mentioned].filter((word) => !known.has(word) && !NON_OP_WORDS.has(word));
    expect(unknown).toEqual([]);
  });
});
