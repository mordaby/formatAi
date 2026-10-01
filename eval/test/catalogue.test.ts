// The rule catalogue's own integrity (eval/catalogue/README.md). This is the regression suite for the LANGUAGE layer: every type that
// claims to be expressible must have a reference rule that parses, type-checks and reproduces its oracle, on the example file and on the
// "next month" file. When a new function lands, move a type from `rule: null` to a rule and this test keeps it honest.
// The FAST layer (what the free engine detects) is a measurement, not an assertion: it is reported by run-catalogue.ts, not tested here.
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../catalogue/capabilities';
import { generateRows } from '../catalogue/kit';
import { measure, measureLanguage, prepare } from '../catalogue/measure';
import { summarize, renderMarkdown, renderCsv } from '../catalogue/report';
import { CATALOGUE, selectTypes } from '../catalogue/topics';
import { TOPICS } from '../catalogue/types';

describe('catalogue definition', () => {
  it('has types in every topic, with unique ids', () => {
    expect(CATALOGUE.length).toBeGreaterThanOrEqual(50);
    expect(new Set(CATALOGUE.map((t) => t.id)).size).toBe(CATALOGUE.length);
    for (const topic of TOPICS) expect(CATALOGUE.some((t) => t.topic === topic)).toBe(true);
  });

  it('mixes Hebrew and English data', () => {
    expect(CATALOGUE.filter((t) => t.lang === 'he').length).toBeGreaterThan(10);
    expect(CATALOGUE.filter((t) => t.lang === 'en').length).toBeGreaterThan(10);
  });

  it('says what is missing for every inexpressible type, with a known capability', () => {
    for (const t of CATALOGUE) {
      if (t.rule === null) {
        expect(t.missing, t.id).toBeDefined();
        expect(Object.keys(CAPABILITIES), t.id).toContain(t.missing!.capability);
      } else expect(t.missing, t.id).toBeUndefined();
    }
  });

  it('generates 20-40 rows, deterministically, and a different next file', () => {
    for (const t of CATALOGUE) {
      const a = generateRows(t, 1, 'example');
      const b = generateRows(t, 1, 'example');
      expect(a.length, t.id).toBeGreaterThanOrEqual(20);
      expect(a.length, t.id).toBeLessThanOrEqual(40);
      expect(JSON.stringify(a), t.id).toBe(JSON.stringify(b));
      expect(JSON.stringify(generateRows(t, 1, 'next')), t.id).not.toBe(JSON.stringify(a));
      expect(JSON.stringify(generateRows(t, 2, 'example')), t.id).not.toBe(JSON.stringify(a));
    }
  });

  it('selects types by id, topic and prefix', () => {
    expect(selectTypes(['extraction.left-n']).map((t) => t.id)).toEqual(['extraction.left-n']);
    expect(selectTypes(['acrossRows']).length).toBeGreaterThan(5);
    expect(selectTypes(['dates.add-*']).map((t) => t.id)).toEqual(['dates.add-months', 'dates.add-days']);
    expect(() => selectTypes(['nope.nothing'])).toThrow();
  });
});

describe('language layer: the reference rules', () => {
  it('every expressible type has a valid reference rule that reproduces its expected output', async () => {
    const failures: string[] = [];
    for (const t of CATALOGUE.filter((x) => x.rule !== null)) {
      const { record } = await measureLanguage(await prepare(t, 1));
      if (!record.valid || !record.reproduces) failures.push(`${t.id}: ${record.problems?.join(' | ') || record.mismatch}`);
    }
    expect(failures).toEqual([]);
  }, 180_000);
});

describe('measurement records', () => {
  it('measures a solvable type, a language gap and a layout case, and renders the report', async () => {
    const records = [];
    for (const id of ['extraction.left-n', 'acrossRows.running-total', 'rowOps.sort-by-column']) {
      const t = CATALOGUE.find((x) => x.id === id)!;
      for (const seed of [1, 2]) records.push(await measure(t, seed));
    }
    const left = records.filter((r) => r.type === 'extraction.left-n');
    expect(left.every((r) => r.language.expressible && r.language.reproduces && r.fast.status === 'solved' && r.fast.holdOut === 'pass')).toBe(true);
    const running = records.filter((r) => r.type === 'acrossRows.running-total');
    expect(running.every((r) => !r.language.expressible && r.language.capability === 'runningAggregate')).toBe(true);
    expect(running.every((r) => r.fast.status === 'partial' && r.fast.unsolved.length === 1)).toBe(true);
    const sort = records.filter((r) => r.type === 'rowOps.sort-by-column');
    expect(sort.every((r) => r.fast.status === 'partial' && r.fast.needsAiParts.includes('sort'))).toBe(true);

    const summary = summarize(records);
    expect(summary.totals.types).toBe(3);
    expect(summary.gaps.map((g) => g.capability)).toEqual(['runningAggregate']);
    expect(renderMarkdown(summary)).toContain('Capability map');
    expect(renderCsv(records).split('\n')[0]).toContain('ai_model');
  }, 60_000);
});
