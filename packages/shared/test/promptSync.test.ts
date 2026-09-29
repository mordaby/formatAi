import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractLearnV3Prompt } from '../scripts/sync-prompt';
import { LEARN_SYSTEM_PROMPT_V3 } from '../src/prompts/learnV3';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

describe('learn-v3 system prompt sync', () => {
  const expected = extractLearnV3Prompt(
    readFileSync(path.join(repoRoot, 'LEARN_PROMPT.md'), 'utf8'),
  );

  it('is non-trivial (extraction actually found the fenced block)', () => {
    expect(expected.length).toBeGreaterThan(1000);
    expect(expected).toContain('You write rules files for a deterministic spreadsheet');
  });

  it('matches prompts/learn-v3.txt', () => {
    const txt = readFileSync(path.join(here, '..', 'prompts', 'learn-v3.txt'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    expect(txt).toBe(expected);
  });

  it('matches the LEARN_SYSTEM_PROMPT_V3 TS constant', () => {
    expect(LEARN_SYSTEM_PROMPT_V3).toBe(expected);
  });
});
