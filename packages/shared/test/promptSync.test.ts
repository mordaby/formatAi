import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractLearnPrompt } from '../scripts/sync-prompt';
import { LEARN_SYSTEM_PROMPT_V6 } from '../src/prompts/learnV6';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

describe('learn-v6 system prompt sync', () => {
  const expected = extractLearnPrompt(
    readFileSync(path.join(repoRoot, 'LEARN_PROMPT.md'), 'utf8'),
  );

  it('is non-trivial (extraction actually found the fenced block)', () => {
    expect(expected.length).toBeGreaterThan(1000);
    expect(expected).toContain('You write rules files for a deterministic spreadsheet');
  });

  it('matches prompts/learn-v6.txt', () => {
    const txt = readFileSync(path.join(here, '..', 'prompts', 'learn-v6.txt'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    expect(txt).toBe(expected);
  });

  it('matches the LEARN_SYSTEM_PROMPT_V6 TS constant', () => {
    expect(LEARN_SYSTEM_PROMPT_V6).toBe(expected);
  });
});
