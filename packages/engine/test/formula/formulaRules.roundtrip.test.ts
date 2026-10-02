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

describe('formulaRulesFromWire: promptOpsOnly (the API reading an LLM answer)', () => {
  const wire = (expr: string) => ({
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'd', header: 'D', type: 'date' }] },
    transform: { computed: [{ id: 'c', type: 'integer', expr }], valueMaps: [], sort: [] },
    output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'C', from: 'c' }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  });

  it('reads every op the same way for the editor and for an LLM answer (learn-v7 documents them all: none is held back)', () => {
    const full = formulaRulesFromWire(wire('weekday(d)'));
    expect(full.problems).toEqual([]);
    expect((full.rules as { transform: { computed: { expr: unknown }[] } }).transform.computed[0]?.expr).toEqual({ op: 'weekday', arg: { col: 'd' } });

    const llm = formulaRulesFromWire(wire('weekday(d)'), { promptOpsOnly: true });
    expect(llm.problems).toEqual([]);
    expect((llm.rules as { transform: { computed: { expr: unknown }[] } }).transform.computed[0]?.expr).toEqual({ op: 'weekday', arg: { col: 'd' } });
  });

  it('also applies inside function bodies, row filters and fan-out rows', () => {
    const rules = {
      ...wire('1'),
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [], rowFilters: [{ expr: 'find(t, "x") > 0' }] },
      transform: {
        computed: [],
        valueMaps: [],
        sort: [],
        functions: [{ name: 'dow', params: [{ name: 'x', type: 'date' }], returns: 'integer', body: 'weekday(x)' }],
        expand: { mode: 'fixedFanOut', rows: [{ set: { n: 'find(t, "x")' } }] },
      },
    };
    const kinds = (r: { rules: unknown }) => {
      const j = JSON.stringify(r.rules);
      return { call: j.includes('"op":"call"'), weekday: j.includes('"op":"weekday"'), find: j.includes('"op":"find"') };
    };
    const normal = kinds(formulaRulesFromWire(rules));
    expect(normal).toEqual({ call: false, weekday: true, find: true });
    expect(kinds(formulaRulesFromWire(rules, { promptOpsOnly: true }))).toEqual(normal);
  });
});
