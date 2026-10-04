import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractLearnPrompt } from '../scripts/sync-prompt';
import { learnPromptOf, LEARN_SYSTEM_PROMPT } from '../src/prompts/index';
import { LEARN_SYSTEM_PROMPT_V7 } from '../src/prompts/learnV7';
import { LEARN_SYSTEM_PROMPT_V8 } from '../src/prompts/learnV8';
import { promptVersion } from '../src/config/prompts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const read = (file: string): string => readFileSync(path.join(here, '..', 'prompts', file), 'utf8').replace(/\r\n/g, '\n');

describe('learn-v8 system prompt sync (the current version)', () => {
  const expected = extractLearnPrompt(readFileSync(path.join(repoRoot, 'LEARN_PROMPT.md'), 'utf8'));

  it('is non-trivial (extraction actually found the fenced block)', () => {
    expect(expected.length).toBeGreaterThan(1000);
    expect(expected).toContain('You write rules files for a deterministic spreadsheet');
  });

  it('matches prompts/learn-v8.txt', () => {
    expect(read('learn-v8.txt')).toBe(expected);
  });

  it('matches the LEARN_SYSTEM_PROMPT_V8 TS constant, which is the current prompt', () => {
    expect(LEARN_SYSTEM_PROMPT_V8).toBe(expected);
    expect(promptVersion).toBe('learn-v8');
    expect(LEARN_SYSTEM_PROMPT).toBe(LEARN_SYSTEM_PROMPT_V8);
    expect(learnPromptOf()).toMatchObject({ version: 'learn-v8', alternatives: true });
  });
});

describe('learn-v7 stays frozen (for the eval comparison, --prompt learn-v7)', () => {
  it('prompts/learn-v7.txt and the LEARN_SYSTEM_PROMPT_V7 constant agree, and it is sent without alternatives', () => {
    expect(LEARN_SYSTEM_PROMPT_V7).toBe(read('learn-v7.txt'));
    expect(learnPromptOf('learn-v7')).toEqual({ version: 'learn-v7', system: LEARN_SYSTEM_PROMPT_V7, alternatives: false });
    expect(LEARN_SYSTEM_PROMPT_V7).not.toContain('alternatives');
  });

  it('learn-v8 is learn-v7 plus ONE short section, "Alternatives"', () => {
    const section = LEARN_SYSTEM_PROMPT_V8.match(/\n# Alternatives\n\n[^\n]+\n/)?.[0];
    expect(section).toBeDefined();
    expect(LEARN_SYSTEM_PROMPT_V8.replace(section!, '')).toBe(LEARN_SYSTEM_PROMPT_V7);
    // Short: one paragraph that names the field, says code tests both, the caps, and not to invent one.
    expect(section!.length).toBeLessThan(500);
    expect(section).toContain('Code tests both on the full data');
    expect(section).toContain("Don't invent one when only one rule fits");
  });
});
