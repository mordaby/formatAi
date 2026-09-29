import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LearnResultSchema, RulesSchema } from '../src/rules/schema';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf8'));
}

describe('RulesSchema', () => {
  it('parses the SPEC 8.1 example rules file', () => {
    const fixture = loadFixture('rules-example.json');
    const result = RulesSchema.safeParse(fixture);
    expect(result.success, JSON.stringify(!result.success && result.error.issues, null, 2)).toBe(
      true,
    );
  });
});

describe('LearnResultSchema', () => {
  it('parses the LEARN_PROMPT.md example_result', () => {
    const fixture = loadFixture('learn-result-example.json');
    const result = LearnResultSchema.safeParse(fixture);
    expect(result.success, JSON.stringify(!result.success && result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('rejects an unknown expression op', () => {
    const fixture = loadFixture('learn-result-example.json') as Record<string, unknown>;
    const transform = fixture.transform as { computed: Array<{ expr: unknown }> };
    transform.computed[0]!.expr = { op: 'multiplyByTwo', arg: { col: 'amount' } };
    const result = LearnResultSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });

  it('rejects an extra (unknown) field on a strict object', () => {
    const fixture = loadFixture('learn-result-example.json') as Record<string, unknown>;
    (fixture.output as Record<string, unknown>).extraField = 'not allowed';
    const result = LearnResultSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });

  it('rejects a bad enum value (validation rule)', () => {
    const fixture = loadFixture('learn-result-example.json') as Record<string, unknown>;
    (fixture.validations as Array<Record<string, unknown>>)[0]!.rule = 'notARealRule';
    const result = LearnResultSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });

  it('rejects a bad enum value (unsupported reasonCode)', () => {
    const fixture = loadFixture('learn-result-example.json') as Record<string, unknown>;
    (fixture.unsupported as Array<Record<string, unknown>>).push({
      outputColumn: 'x',
      reasonCode: 'madeUpReason',
    });
    const result = LearnResultSchema.safeParse(fixture);
    expect(result.success).toBe(false);
  });
});
