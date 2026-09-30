// The `template` relation downstream of the pair analysis: its hint (LEARN_PROMPT §3), masking of its fixed
// text, the local fast path and partial result (a `concat` of const literals and the columns, verified by
// actually running the rules on the example), the refusals that keep it provable, and the 20,000-row
// performance check. The detector itself is tested in analyze/template.test.ts.
import { checkRules, type LearnPayload } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { typeCheck } from '../../src/check';
import { analyzePair, type PairAnalysis } from '../../src/learn/analyze';
import { fastPath, type FastPathResult } from '../../src/learn/fastPath';
import { relationsToHints } from '../../src/learn/hints';
import { createMasker } from '../../src/learn/mask';
import { partialRules } from '../../src/learn/partial';
import { buildPayload } from '../../src/learn/payload';
import { preflight } from '../../src/learn/preflight';
import { verifyAgainstExample } from '../../src/learn/verify';
import { runOk, table, values, type CellInput } from '../pipeline/helpers';
import { pick, rng, xlsx, type V } from './analyze/helpers';

const NAMES = ['Cohen', 'Levi', 'Mizrahi', 'שרה כהן', 'דוד לוי', 'Bar', 'Katz', 'נועה', 'Peretz', 'Avraham'];

function analyze(inHeaders: string[], inRows: V[][], outHeaders: string[], outRows: V[][]): PairAnalysis {
  const a = analyzePair(xlsx([inHeaders, ...inRows]), xlsx([outHeaders, ...outRows]));
  if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
  return a;
}

function cellV(v: V): string | number | boolean | null {
  return v !== null && typeof v === 'object' ? v.v : v;
}

/** Analysis, pre-flight and the strict fast path; on success the rules type-check and REPRODUCE the example when run. */
function fastPathOk(inHeaders: string[], inRows: V[][], outHeaders: string[], outRows: V[][]) {
  const a = analyze(inHeaders, inRows, outHeaders, outRows);
  const result = fastPath(a, preflight(a, 'registered'));
  if (!('rules' in result)) throw new Error(`fastPath failed: ${JSON.stringify(result)}`);
  expect(checkRules(result.rules), 'checkRules').toEqual([]);
  expect(typeCheck(result.rules), 'typeCheck').toEqual([]);
  const ran = runOk(result.rules, table(inHeaders, inRows as CellInput[][]));
  expect(values(ran.sheet), 'runRules reproduces the example output').toEqual(outRows.map((r) => r.map(cellV)));
  return { a, rules: result.rules };
}

function fastPathOf(inHeaders: string[], inRows: V[][], outHeaders: string[], outRows: V[][]): { a: PairAnalysis; result: FastPathResult } {
  const a = analyze(inHeaders, inRows, outHeaders, outRows);
  return { a, result: fastPath(a, preflight(a, 'registered')) };
}

function idNameRows(n: number, text: boolean): V[][] {
  const rows: V[][] = [];
  for (let i = 0; i < n; i++) {
    const id = i * 37 + 5;
    rows.push([text ? String(id).padStart(5, '0') : id, NAMES[i % NAMES.length]!, `n${i}`]);
  }
  return rows;
}

const IN = ['ID', 'Name', 'Note'];

describe('template: the hint', () => {
  it('is { rel: "template", in, parts, out, coverage: 1 } with no failsOn', () => {
    const rows = idNameRows(12, true);
    const a = analyze(IN, rows, ['ID', 'Label'], rows.map((r) => [r[0]!, `${r[0]}:"${r[1]}"`]));
    const hints = relationsToHints(a, preflight(a, 'registered'));
    const h = hints.find((x) => 'out' in x && x.out === 1);
    expect(h).toEqual({ rel: 'template', in: [0, 1], parts: [{ in: 0 }, ':"', { in: 1 }, '"'], out: 1, coverage: 1 });
  });

  it('is absent when two templates fit (the column then has no hint at all)', () => {
    const rows = idNameRows(10, true).map((r) => [...r, r[1]!]);
    const a = analyze(['ID', 'Name', 'Note', 'Copy'], rows, ['ID', 'Label'], rows.map((r) => [r[0]!, `${r[0]}:"${r[1]}"`]));
    const hints = relationsToHints(a, preflight(a, 'registered'));
    expect(hints.find((x) => 'out' in x && x.out === 1)).toBeUndefined();
  });
});

describe('template: masking of the fixed text', () => {
  const inRows = idNameRows(10, true);
  const outRows = inRows.map((r) => [r[0]!, `Dept ${r[0]}:"${r[1]}"`]);
  const a = analyze(IN, inRows, ['ID', 'Label'], outRows);
  const pf = preflight(a, 'registered');
  const hintOf = (p: LearnPayload) => p.hints.find((h) => h.rel === 'template');

  it('unmasked, the fixed text is sent as it is', () => {
    const { payload } = buildPayload(a, pf);
    expect(hintOf(payload)).toMatchObject({ parts: ['Dept ', { in: 0 }, ':"', { in: 1 }, '"'] });
  });

  it('masked, a word of the fixed text gets the same fake word as in the samples; punctuation stays real', () => {
    const masker = createMasker(new TextEncoder().encode('template-session'));
    const { payload } = buildPayload(a, pf, { masker });
    const h = hintOf(payload);
    expect(h).toBeDefined();
    if (h?.rel !== 'template') throw new Error('unreachable');
    const fake = masker.maskText('Dept ');
    expect(fake).not.toBe('Dept ');
    expect(fake).toMatch(/^[A-Za-z]{4} $/); // same shape: 4 letters and the space
    expect(h.parts).toEqual([fake, { in: 0 }, ':"', { in: 1 }, '"']);
    // the samples show the very same fake word at the start of the label
    const labels = payload.samples.map((s) => (s.out as unknown[])[1]);
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(String(l).startsWith(fake)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('Dept');
  });
});

describe('template: the local fast path builds concat(const, column, ...) and the rules reproduce the example', () => {
  it('<id>:"<name>" with numeric ids and Hebrew and English names', () => {
    const rows = idNameRows(12, false);
    const { rules } = fastPathOk(IN, rows, ['ID', 'Label'], rows.map((r) => [r[0]!, `${r[0]}:"${r[1]}"`]));
    const computed = rules.transform.computed[0]!;
    expect(computed.type).toBe('text');
    expect(computed.expr).toEqual({
      op: 'concat',
      args: [{ op: 'toText', arg: { col: 'id' } }, { const: ':"' }, { col: 'name' }, { const: '"' }],
    });
  });

  it('<id>:"<name>" with ids that have leading zeros (kept as text)', () => {
    const rows = idNameRows(12, true);
    const { rules } = fastPathOk(IN, rows, ['ID', 'Label'], rows.map((r) => [r[0]!, `${r[0]}:"${r[1]}"`]));
    expect(rules.transform.computed[0]!.expr).toEqual({ op: 'concat', args: [{ col: 'id' }, { const: ':"' }, { col: 'name' }, { const: '"' }] });
  });

  it('a prefix (INV-<n>), a suffix (<n> ILS) and the same column twice, in one file', () => {
    const inRows: V[][] = [];
    for (let i = 0; i < 12; i++) inRows.push([`K${i}`, 1001 + i * 13, `A${i * 3 + 1}`]);
    const outRows = inRows.map((r) => [r[0]!, `INV-${r[1]}`, `${r[1]} ILS`, `${r[2]}#${r[2]}`]);
    const { rules } = fastPathOk(['Key', 'N', 'Code'], inRows, ['Key', 'Doc', 'Amount', 'Twice'], outRows);
    expect(rules.output.columns.map((c) => c.header)).toEqual(['Key', 'Doc', 'Amount', 'Twice']);
    expect(rules.transform.computed).toHaveLength(3);
  });

  it('values with stray spaces around them: the column is trimmed exactly like the analysis compared it', () => {
    const rows = idNameRows(12, true).map((r, i) => [r[0]!, i % 2 === 0 ? ` ${r[1]} ` : r[1]!, r[2]!] as V[]);
    const { rules } = fastPathOk(IN, rows, ['ID', 'Label'], rows.map((r) => [r[0]!, `${r[0]}:"${String(r[1]).trim()}"`]));
    expect(JSON.stringify(rules.transform.computed[0]!.expr)).toContain('"op":"trim"');
  });
});

describe('template: the fast path refuses what it cannot prove', () => {
  it('a template whose columns take fewer than 3 different values is thin evidence (it may be a value map)', () => {
    const inRows: V[][] = [];
    for (let i = 0; i < 12; i++) inRows.push([`K${i}`, i % 2 === 0 ? 'open' : 'done']);
    const { result } = fastPathOf(['Key', 'Status'], inRows, ['Key', 'Tag'], inRows.map((r) => [r[0]!, `ST-${r[1]}`]));
    expect(result).toEqual({ reason: 'thinEvidence', params: { column: 1, relation: 'template' } });
  });

  it('two templates that fit: no relation, so the column is not fully explained', () => {
    const rows = idNameRows(10, true).map((r) => [...r, r[1]!]);
    const { result } = fastPathOf(['ID', 'Name', 'Note', 'Copy'], rows, ['ID', 'Label'], rows.map((r) => [r[0]!, `${r[0]}:"${r[1]}"`]));
    expect(result).toEqual({ reason: 'columnNotFullyExplained', params: { column: 1 } });
  });

  it('numbers written as text with a thousands separator (the engine would read 1234)', () => {
    const inRows: V[][] = [];
    for (let i = 0; i < 10; i++) inRows.push([`K${i}`, `${1 + i},${String(100 + i * 17)}`]);
    const { a, result } = fastPathOf(['Key', 'Amount'], inRows, ['Key', 'Text'], inRows.map((r) => [r[0]!, `${r[1]} ILS`]));
    expect(a.columns[1]!.relations[0]).toMatchObject({ rel: 'template', coverage: 1 });
    expect(result).toEqual({ reason: 'columnNotFullyExplained', params: { column: 'Text' } });
  });

  it.each([
    ['the padded column first', true],
    ['the template first', false],
  ])('an id another column pads with zeros (%s): the two rules would read the column differently', (_name, paddedFirst) => {
    const inRows: V[][] = [];
    for (let i = 0; i < 12; i++) inRows.push([`K${i}`, 5 + i * 13]);
    const padded = (r: V[]): string => String(r[1]).padStart(6, '0');
    const label = (r: V[]): string => `#${r[1]}`;
    const outHeaders = paddedFirst ? ['Key', 'Padded', 'Label'] : ['Key', 'Label', 'Padded'];
    const outRows = inRows.map((r) => (paddedFirst ? [r[0]!, padded(r), label(r)] : [r[0]!, label(r), padded(r)]));
    const { result } = fastPathOf(['Key', 'Id'], inRows, outHeaders, outRows);
    expect(result).toEqual({ reason: 'columnNotFullyExplained', params: { column: paddedFirst ? 'Label' : 'Padded' } });
  });
});

describe('template: the local partial result', () => {
  it('solves the template column, and the rules reproduce it on the example', () => {
    const inRows = idNameRows(12, true);
    const r = rng(3);
    const outRows = inRows.map((row) => [row[0]!, `${row[0]}:"${row[1]}"`, `W${100 + Math.floor(r() * 800)}`]);
    const a = analyze(IN, inRows, ['ID', 'Label', 'Warehouse'], outRows);
    const pf = preflight(a, 'registered');
    const p = partialRules(a, pf);
    if ('reason' in p) throw new Error(`partialRules failed: ${p.reason}`);
    expect(p.solved).toEqual(['ID', 'Label']);
    expect(p.external).toEqual(['Warehouse']);
    const v = verifyAgainstExample(p.rules, a, { onlyColumns: p.solvedColumns });
    expect(v.verified).toBe(true);
  });
});

describe('template: performance on a 20,000-row pair', () => {
  it('unexplained text columns and a template column cost next to nothing', () => {
    const N = 20000;
    const r = rng(99);
    const inRows: V[][] = [];
    const outRows: V[][] = [];
    for (let i = 0; i < N; i++) {
      const id = 100000 + i * 3;
      const name = `${pick(r, NAMES)}${i % 97}`;
      const note = `note ${Math.floor(r() * 1e6)} ${pick(r, NAMES)}`;
      inRows.push([id, name, note, `c${i % 13}`]);
      outRows.push([
        id,
        `${id}:"${name}"`,
        `${pick(r, NAMES)} ${Math.floor(r() * 1e6)}`, // unrelated text: nothing explains it, the template search finds nothing
        `${Math.floor(r() * 1e6)}-${pick(r, NAMES)}`, // unrelated text
        `[${name}]`, // a template of one column
      ]);
    }
    const t0 = performance.now();
    const a = analyze(['Id', 'Name', 'Note', 'Grp'], inRows, ['Id', 'Label', 'X1', 'X2', 'Tag'], outRows);
    const ms = performance.now() - t0;
    console.log(`[perf] template pair analysis: ${N} rows x 4 columns (2 unexplained text, 2 template) in ${ms.toFixed(0)} ms`);
    expect(a.columns[1]!.relations[0]).toMatchObject({ rel: 'template', in: [0, 1], coverage: 1 });
    expect(a.columns[4]!.relations[0]).toMatchObject({ rel: 'template', in: [1], parts: ['[', { in: 1 }, ']'], coverage: 1 });
    expect(a.columns[2]!.unknown).toBe(true);
    expect(a.columns[3]!.unknown).toBe(true);
    expect(ms).toBeLessThan(15000);
  }, 60000);
});
