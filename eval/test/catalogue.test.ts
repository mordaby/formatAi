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
    for (const id of ['extraction.left-n', 'acrossRows.running-total', 'extraction.after-first-sep-rest', 'rowOps.sort-by-column']) {
      const t = CATALOGUE.find((x) => x.id === id)!;
      for (const seed of [1, 2]) records.push(await measure(t, seed));
    }
    const left = records.filter((r) => r.type === 'extraction.left-n');
    expect(left.every((r) => r.language.expressible && r.language.reproduces && r.fast.status === 'solved' && r.fast.holdOut === 'pass')).toBe(true);
    const running = records.filter((r) => r.type === 'acrossRows.running-total');
    expect(running.every((r) => r.language.expressible && r.language.reproduces)).toBe(true);
    // a running total depends on the order of the rows: the free engine never builds it, and says the AI step gets it (as a window pattern)
    expect(running.every((r) => r.fast.status === 'partial' && r.fast.unsolved.length === 1 && r.fast.unsolved[0]!.hint === 'window:runningSum')).toBe(true);
    const gap = records.filter((r) => r.type === 'extraction.after-first-sep-rest');
    expect(gap.every((r) => !r.language.expressible && r.language.capability === 'positionSearch')).toBe(true);
    const sort = records.filter((r) => r.type === 'rowOps.sort-by-column');
    expect(sort.every((r) => r.fast.status === 'partial' && r.fast.needsAiParts.includes('sort'))).toBe(true);

    const summary = summarize(records);
    expect(summary.totals.types).toBe(4);
    expect(summary.gaps.map((g) => g.capability)).toEqual(['positionSearch']);
    expect(renderMarkdown(summary)).toContain('Capability map');
    expect(renderCsv(records).split('\n')[0]).toContain('ai_model');
  }, 60_000);
});

describe('language layer: the date and text operations added after learn-v6', () => {
  // type id -> the operation its reference rule must be written with (not a workaround)
  const NOW_EXPRESSIBLE: Record<string, string> = {
    'dates.weekday-name': 'dateFormat(date, "dddd")',
    'dates.days-to-fixed-date': 'date("2026-12-31")',
    'dates.parse-month-name': 'toDate(date, "D MMMM YYYY")',
    'dates.date-from-parts': 'makeDate(year, month, day)',
    'extraction.digits-only': 'keepChars(raw, "digits")',
    'cleanup.proper-case': 'titleCase(name)',
  };

  it('are expressible, with a reference rule that uses the operation', () => {
    for (const [id, formula] of Object.entries(NOW_EXPRESSIBLE)) {
      const t = CATALOGUE.find((x) => x.id === id)!;
      expect(t.rule, id).not.toBeNull();
      expect(t.missing, id).toBeUndefined();
      expect(t.outputs.some((o) => o.formula?.includes(formula)), `${id}: ${formula}`).toBe(true);
    }
  });

  it('parse, type-check and reproduce the expected output on the example and the next-month file, both seeds', async () => {
    for (const id of Object.keys(NOW_EXPRESSIBLE)) {
      const t = CATALOGUE.find((x) => x.id === id)!;
      for (const seed of [1, 2]) {
        const { record } = await measureLanguage(await prepare(t, seed));
        expect(record.problems ?? [], `${id} seed ${seed}`).toEqual([]);
        expect(record.valid, `${id} seed ${seed}`).toBe(true);
        expect(record.reproduces, `${id} seed ${seed}: ${record.mismatch}`).toBe(true);
      }
    }
  }, 60_000);

  it('"everything after the first separator" is still a gap: find gives the position but substr cannot cut at it', () => {
    const t = CATALOGUE.find((x) => x.id === 'extraction.after-first-sep-rest')!;
    expect(t.rule).toBeNull();
    expect(t.missing?.capability).toBe('positionSearch');
  });
});

describe('language layer: the across-row (window) functions', () => {
  const ACROSS = CATALOGUE.filter((x) => x.topic === 'acrossRows');

  it('every across-rows type is expressible, with a reference rule written with a window function', () => {
    expect(ACROSS.length).toBeGreaterThanOrEqual(13);
    for (const t of ACROSS) {
      expect(t.rule, t.id).not.toBeNull();
      expect(t.missing, t.id).toBeUndefined();
      expect(t.outputs.some((o) => /\b(runningSum|groupSum|groupAvg|groupMin|groupMax|groupCount|previous|next|fillDown|rowNumber|rank)\(/.test(o.formula ?? '')), t.id).toBe(true);
    }
  });

  it('the five capabilities the window functions resolved are gone', () => {
    for (const gone of ['windowAggregate', 'rowLookback', 'runningAggregate', 'rank', 'rowIndex']) expect(Object.keys(CAPABILITIES)).not.toContain(gone);
  });

  it('parse, type-check and reproduce the expected output on the example and the next-month file, both seeds', async () => {
    for (const t of ACROSS) {
      for (const seed of [1, 2]) {
        const { record } = await measureLanguage(await prepare(t, seed));
        expect(record.problems ?? [], `${t.id} seed ${seed}`).toEqual([]);
        expect(record.valid, `${t.id} seed ${seed}`).toBe(true);
        expect(record.reproduces, `${t.id} seed ${seed}: ${record.mismatch}`).toBe(true);
      }
    }
  }, 180_000);

  it('the free engine builds a group total and a count per group (also with an unseen group next month), and no order-dependent window', async () => {
    const built = ['acrossRows.group-total-each-row', 'acrossRows.count-per-group', 'acrossRows.group-total-unseen-group'];
    for (const id of built) {
      const t = CATALOGUE.find((x) => x.id === id)!;
      for (const seed of [1, 2]) {
        const record = await measure(t, seed);
        expect(record.fast.status, `${id} seed ${seed}`).toBe('solved');
        expect(record.fast.holdOut, `${id} seed ${seed}`).toBe('pass');
        expect(record.fast.how ?? '', id).toMatch(/group(Sum|Count)\(/);
      }
    }
    for (const id of ACROSS.map((t) => t.id).filter((x) => !built.includes(x))) {
      const t = CATALOGUE.find((x) => x.id === id)!;
      const record = await measure(t, 1);
      // never solved by building a window (and never "wrong"): the window column goes to the AI step
      expect(record.fast.status, id).not.toBe('overfit');
      expect(record.fast.status, id).not.toBe('unverified');
      expect(record.fast.how ?? '', id).not.toMatch(/(runningSum|rowNumber|previous|next|fillDown|rank)\(/);
    }
  }, 180_000);
});
