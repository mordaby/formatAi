// SPEC 21 "M0 amendments": schemaVersion stays 1 and every new field is optional,
// so every rules file written before these v3 amendments keeps loading unchanged.
// This reads the engine's own M0 golden fixtures (packages/engine is out of this
// package's scope to modify, but its rules.json files are the real backward-
// compatibility test) and checks each still parses with the current RulesSchema.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RulesSchema } from '../src/rules/schema';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, '..', '..', 'engine', 'test', 'golden', 'cases');

function listCaseDirs(): string[] {
  return readdirSync(casesDir).filter((name) => statSync(path.join(casesDir, name)).isDirectory());
}

describe('RulesSchema backward compatibility with M0 golden fixtures', () => {
  const caseDirs = listCaseDirs();

  it('finds at least one golden case (sanity check for the path above)', () => {
    expect(caseDirs.length).toBeGreaterThan(0);
  });

  it.each(caseDirs)('packages/engine/test/golden/cases/%s/rules.json still parses', (name) => {
    const rulesPath = path.join(casesDir, name, 'rules.json');
    const fixture = JSON.parse(readFileSync(rulesPath, 'utf8'));
    const result = RulesSchema.safeParse(fixture);
    expect(result.success, JSON.stringify(!result.success && result.error.issues, null, 2)).toBe(
      true,
    );
  });
});
