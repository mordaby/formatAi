// PROPERTY: for every rules.json under packages/engine/test/golden/cases/ and every
// eval/cases/*/reference.rules.json, formulaRulesFromWire(formulaRulesToWire(r)) deep-
// equals r, once normalized to canonical form (canonicalizeRules - see
// src/formula/canonicalize.ts's doc comment for exactly what that normalizes and why).
// These are REAL, hand-authored rules files (not generated through our own parser), so
// this is the strongest available check that printFormula/parseFormula together are a
// faithful, lossless encoding of every op these fixtures actually use.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Rules } from '@formatai/shared';
import { canonicalizeRules } from '../../src/formula/canonicalize';
import { formulaRulesFromWire, formulaRulesToWire } from '../../src/formula/formulaRules';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const goldenDir = path.resolve(here, '..', 'golden', 'cases');
const evalCasesDir = path.join(repoRoot, 'eval', 'cases');

function subdirsOf(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function findFixtureFiles(): string[] {
  const files: string[] = [];
  for (const name of subdirsOf(goldenDir)) {
    const f = path.join(goldenDir, name, 'rules.json');
    if (existsSync(f)) files.push(f);
  }
  for (const name of subdirsOf(evalCasesDir)) {
    const f = path.join(evalCasesDir, name, 'reference.rules.json');
    if (existsSync(f)) files.push(f);
  }
  return files;
}

const fixtureFiles = findFixtureFiles();

describe('formulaRulesToWire/FromWire round trip over real rules files', () => {
  it('found fixture files to test against', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  for (const file of fixtureFiles) {
    it(`round-trips ${path.relative(repoRoot, file)}`, () => {
      const rules = JSON.parse(readFileSync(file, 'utf8')) as Rules;
      const wire = formulaRulesToWire(rules);
      const { rules: roundTripped, problems } = formulaRulesFromWire(wire);
      expect(problems).toEqual([]);
      expect(roundTripped).toEqual(canonicalizeRules(rules));
    });
  }
});
