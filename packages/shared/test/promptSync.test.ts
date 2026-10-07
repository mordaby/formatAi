import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECKS_SECTION_HEADING, extractLearnPrompt, withoutChecksSection } from '../scripts/sync-prompt';
import { learnPromptOf, LEARN_SYSTEM_PROMPT, REPAIR_INSTRUCTION, REPAIR_INSTRUCTION_V7 } from '../src/prompts/index';
import { LEARN_SYSTEM_PROMPT_V7 } from '../src/prompts/learnV7';
import { LEARN_SYSTEM_PROMPT_V9 } from '../src/prompts/learnV9';
import { REPAIR_INSTRUCTION_V9, RULES_NOW_INSTRUCTION_V9 } from '../src/prompts/repair';
import { PROMPT_VERSIONS, promptVersion } from '../src/config/prompts';
import { limits } from '../src/config/limits';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const read = (file: string): string => readFileSync(path.join(here, '..', 'prompts', file), 'utf8').replace(/\r\n/g, '\n');

describe('learn-v9 system prompt sync (the newest version, LEARN_PROMPT.md section 2)', () => {
  const expected = extractLearnPrompt(readFileSync(path.join(repoRoot, 'LEARN_PROMPT.md'), 'utf8'));

  it('is non-trivial (extraction actually found the fenced block)', () => {
    expect(expected.length).toBeGreaterThan(1000);
    expect(expected).toContain('You write rules files for a deterministic spreadsheet');
  });

  it('matches prompts/learn-v9.txt and the LEARN_SYSTEM_PROMPT_V9 TS constant', () => {
    expect(read('learn-v9.txt')).toBe(expected);
    expect(LEARN_SYSTEM_PROMPT_V9).toBe(expected);
  });
});

describe('the default prompt version (what every learn sends)', () => {
  it('is learn-v7 (2026-10-05: learn-v8 fitted rows at any cost on the eval); learn-v7 and learn-v9 are the versions the code can send', () => {
    expect(promptVersion).toBe('learn-v7');
    expect(LEARN_SYSTEM_PROMPT).toBe(LEARN_SYSTEM_PROMPT_V7);
    expect(learnPromptOf()).toMatchObject({ version: 'learn-v7' });
    // learn-v8, learn-v8.1 and their noE1 variants: measured, rejected (2026-10-05) and removed (2026-10-07)
    expect(PROMPT_VERSIONS).toEqual(['learn-v7', 'learn-v9']);
  });
});

describe('learn-v7 stays frozen (for the eval comparison, --prompt learn-v7)', () => {
  it('prompts/learn-v7.txt and the LEARN_SYSTEM_PROMPT_V7 constant agree, and it is sent with its own repair instruction', () => {
    expect(LEARN_SYSTEM_PROMPT_V7).toBe(read('learn-v7.txt'));
    expect(learnPromptOf('learn-v7')).toEqual({ version: 'learn-v7', system: LEARN_SYSTEM_PROMPT_V7, repair: REPAIR_INSTRUCTION_V7 });
    expect(REPAIR_INSTRUCTION_V7).toBe('Fix only what the problems require. Keep everything else identical.');
  });
});

describe('the repair instruction, per version (LEARN_PROMPT §4)', () => {
  it("each version sends its own: learn-v7 its instruction, learn-v9 learn-v7's plus 'answer with the rules'; the current one is the default version's", () => {
    expect(learnPromptOf('learn-v7').repair).toBe(REPAIR_INSTRUCTION_V7);
    expect(learnPromptOf('learn-v9').repair).toBe(REPAIR_INSTRUCTION_V9);
    expect(REPAIR_INSTRUCTION).toBe(learnPromptOf().repair);
    expect(REPAIR_INSTRUCTION).toBe(REPAIR_INSTRUCTION_V7);
  });
});

describe('learn-v9 = learn-v7 + ONE section, "Checking with code" (docs/proposals/ai-code-checks.md)', () => {
  const v9 = LEARN_SYSTEM_PROMPT_V9;
  const section = v9.slice(v9.indexOf(CHECKS_SECTION_HEADING), v9.indexOf('\n# Example\n') + 1);

  it('is learn-v7 byte for byte once that one section is taken out', () => {
    expect(withoutChecksSection(v9)).toBe(LEARN_SYSTEM_PROMPT_V7);
    expect(v9.split(CHECKS_SECTION_HEADING)).toHaveLength(2);
    expect(() => withoutChecksSection(LEARN_SYSTEM_PROMPT_V7)).toThrow(/exactly one/);
  });

  it('the section sits right before the example, and stays short', () => {
    expect(section.startsWith(CHECKS_SECTION_HEADING)).toBe(true);
    expect(v9.indexOf(CHECKS_SECTION_HEADING)).toBeGreaterThan(v9.indexOf('# Operations'));
    expect(section.length).toBeLessThan(2600);
  });

  it('names the five checks with their arguments, and the limits from config', () => {
    for (const kind of ['test', 'ranges', 'dependsOn', 'values', 'rows']) expect(section).toContain(`{"check": "${kind}"`);
    const c = limits.learn.checks;
    expect(section).toContain(`At most ${c.maxRounds} rounds of at most ${c.maxChecksPerRound} checks`);
    expect(section).toContain(`up to ${c.maxLets} helper columns`);
    expect(section).toContain(`up to ${c.maxFailingRows} rows where it does not`);
    expect(section).toContain(`more than ${c.maxRuns} runs`);
    expect(section).toContain(`[1 or ${c.maxOn} columns]`);
    expect(section).toContain(`up to ${c.maxConflicts} such pairs`);
    expect(section).toContain(`the ${c.maxValues} most common values`);
    expect(section).toContain(`"limit": 1 to ${c.maxRowsPerCheck}`);
    expect(section).toContain(`the ${limits.learn.loop.maxRowsTotal} rows one learn may show`);
  });

  it('says: masked constants as the samples show them; check only when the sample does not settle it; never to collect rows; rules after the last round', () => {
    expect(section).toContain('write constants exactly as the samples show them (masked words as they are)');
    expect(section).toContain('Ask only when the samples and hints do not settle a column; when they do, answer with the rules at once.');
    expect(section).toContain('Never use checks to collect rows to copy into your rules.');
    expect(section).toContain('After the last round you must answer with the rules.');
  });

  it("is sent with learn-v7's rules, the step schema, and learn-v7's repair instruction plus 'answer with the rules'", () => {
    expect(learnPromptOf('learn-v9')).toEqual({ version: 'learn-v9', system: v9, repair: REPAIR_INSTRUCTION_V9, checks: true });
    expect(REPAIR_INSTRUCTION_V9.startsWith(REPAIR_INSTRUCTION_V7)).toBe(true);
    expect(RULES_NOW_INSTRUCTION_V9).toContain('answer with the rules now');
    // learn-v7 stays the default
    expect(promptVersion).toBe('learn-v7');
    expect(learnPromptOf('learn-v7').checks).toBeUndefined();
  });
});
