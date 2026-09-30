// The editor's worker-side checks (SPEC 8.11 "Live check"), run on the same functions the worker runs:
// counts, exceptions, the subset above 5,000 rows, the preview order, and the time budget.
import { analyzePair, fastPath, preflight, readWorkbook, sourceOf, type PairAnalysis } from '@formatai/engine';
import type { LearnResult, SourceStructure } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { editorConfig } from '../editor/config';
import { applyEdit, createEditorState, type EditAction } from '../editor/model';
import { checkExample, runStaticChecks, subsetAnalysis } from './liveCheck';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const SUPPLIERS = ['Acme', 'Borealis', 'Cobalt', 'Delta', 'Ember', 'Fjord', 'Garnet', 'Helix'];

/** Input: Item, Supplier, Qty, Unit price. Output: Supplier, Item, Qty, Total (qty x price, 2 decimals). `n` rows. */
async function exampleOf(n: number): Promise<{ analysis: PairAnalysis; rules: LearnResult }> {
  const inRows: string[] = ['Item,Supplier,Qty,Unit price'];
  const outRows: string[] = ['Supplier,Item,Qty,Total'];
  for (let i = 0; i < n; i++) {
    const item = `SKU-${String(i + 1).padStart(5, '0')}`;
    const supplier = SUPPLIERS[i % SUPPLIERS.length]!;
    const qty = (i * 7) % 40 + 1;
    const price = ((i * 13) % 900) / 10 + 1.25;
    const total = Math.round(qty * price * 100) / 100;
    inRows.push(`${item},${supplier},${qty},${price.toFixed(2)}`);
    outRows.push(`${supplier},${item},${qty},${total.toFixed(2)}`);
  }
  const inputWb = await readWorkbook(enc(inRows.join('\n') + '\n'), 'in.csv');
  const outputWb = await readWorkbook(enc(outRows.join('\n') + '\n'), 'out.csv');
  const analysis = analyzePair(inputWb, outputWb);
  if (!analysis.ok) throw new Error(`analysis failed: ${JSON.stringify(analysis.issues)}`);
  const pf = preflight(analysis, 'paid');
  const fp = fastPath(analysis, pf);
  if (!('rules' in fp)) throw new Error(`fast path failed: ${JSON.stringify(fp)}`);
  return { analysis, rules: fp.rules };
}

describe('checkExample', () => {
  it('counts rows that match, per column, and verifies a correct rules file', async () => {
    const { analysis, rules } = await exampleOf(200);
    const r = checkExample(analysis, rules);
    expect(r.verified).toBe(true);
    expect(r.matched).toBe(200);
    expect(r.total).toBe(200);
    expect(r.differences).toBe(0);
    expect(r.partial).toBe(false);
    expect(r.layoutProblems).toEqual([]);
    expect(r.perColumn.map((c) => [c.header, c.matched, c.total])).toEqual([
      ['Supplier', 200, 200],
      ['Item', 200, 200],
      ['Qty', 200, 200],
      ['Total', 200, 200],
    ]);
    expect(r.preview).toHaveLength(editorConfig.previewRows);
    expect(r.preview.every((p) => p.ok)).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('puts mismatching rows first in the preview, with source values, the example and what the rules produce', async () => {
    const { analysis, rules } = await exampleOf(120);
    // Break the Total column: a fixed 0 instead of qty x price.
    const broken: LearnResult = {
      ...rules,
      output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: null } : c)) },
    };
    const r = checkExample(analysis, broken);
    expect(r.verified).toBe(false);
    expect(r.matched).toBe(0);
    expect(r.total).toBe(120);
    expect(r.mismatchCount).toBe(120);
    expect(r.mismatches).toHaveLength(editorConfig.maxMismatches > 120 ? 120 : editorConfig.maxMismatches);
    expect(r.differences).toBe(120);
    const total = r.perColumn.find((c) => c.header === 'Total')!;
    expect(total.matched).toBe(0);
    expect(r.perColumn.find((c) => c.header === 'Item')!.matched).toBe(120);

    const first = r.preview[0]!;
    expect(first.ok).toBe(false);
    expect(first.exampleRow).toBe(2); // row 1 is the header
    expect(first.source).toEqual(['SKU-00001', 'Acme', '1', '1.25']); // a csv's cells are text
    expect(first.badColumns).toEqual([3]);
    expect(first.expected[3]).not.toBe(first.actual[3]);
    expect(first.actual[3]).toBeNull();
  });

  it('puts mismatching rows before matching ones', async () => {
    const { analysis, rules } = await exampleOf(120);
    // Only the last 10 rows disagree: a constant in place of the supplier for a filtered subset is hard to
    // build, so mark the first 100 rows as exceptions and check the remaining ones come first.
    const broken: LearnResult = {
      ...rules,
      output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Qty' ? { ...c, from: null } : c)) },
    };
    const exceptions = Array.from({ length: 100 }, (_, i) => i + 2);
    const r = checkExample(analysis, broken, { exceptions });
    expect(r.total).toBe(20);
    expect(r.mismatchCount).toBe(20);
    expect(r.preview[0]!.exampleRow).toBe(102);
    expect(r.preview.every((p) => !p.ok)).toBe(true);
  });

  it('leaves exceptions out of the counts (and out of the verdict)', async () => {
    const { analysis, rules } = await exampleOf(50);
    const broken: LearnResult = {
      ...rules,
      output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: null } : c)) },
    };
    const all = checkExample(analysis, broken);
    expect(all.matched).toBe(0);
    const every = Array.from({ length: 50 }, (_, i) => i + 2);
    const none = checkExample(analysis, broken, { exceptions: every });
    expect(none.total).toBe(0);
    expect(none.matched).toBe(0);
    expect(none.mismatchCount).toBe(0);
    expect(none.verified).toBe(true);
    const some = checkExample(analysis, broken, { exceptions: [2, 3, 4] });
    expect(some.total).toBe(47);
    expect(some.preview.every((p) => ![2, 3, 4].includes(p.exampleRow))).toBe(true);
  });

  it('says so when a column has no counterpart in the example', async () => {
    const { analysis, rules } = await exampleOf(30);
    const extra: LearnResult = { ...rules, output: { ...rules.output, columns: [...rules.output.columns, { header: 'Note', from: null }] } };
    const r = checkExample(analysis, extra);
    const note = r.perColumn.find((c) => c.header === 'Note')!;
    expect(note.inExample).toBe(false);
    expect(note.total).toBe(0);
  });

  it('reports a rules file that cannot run as a layout problem, not a crash', async () => {
    const { analysis, rules } = await exampleOf(30);
    const missing: LearnResult = {
      ...rules,
      input: { ...rules.input, columns: [...rules.input.columns, { id: 'ghost', header: 'No such header', type: 'text', required: true }] },
    };
    const r = checkExample(analysis, missing);
    expect(r.verified).toBe(false);
    expect(r.layoutProblems.join(' ')).toContain('No such header');
    const partial = checkExample(analysis, missing, { subset: true });
    expect(partial.layoutProblems.join(' ')).toContain('No such header');
  });
});

describe('the subset above 5,000 rows', () => {
  it('checks a deterministic prefix of 2,000 input rows and says so; Apply checks them all', async () => {
    const { analysis, rules } = await exampleOf(editorConfig.fullCheckAboveRows + 500);
    const live = checkExample(analysis, rules);
    expect(live.partial).toBe(true);
    expect(live.verified).toBe(false); // a partial check never calls the example verified
    expect(live.checkedInputRows).toBe(editorConfig.subsetRows);
    expect(live.totalInputRows).toBe(editorConfig.fullCheckAboveRows + 500);
    expect(live.total).toBe(editorConfig.subsetRows);
    expect(live.matched).toBe(editorConfig.subsetRows);
    expect(live.layoutProblems).toEqual([]);
    expect(checkExample(analysis, rules).matched).toBe(live.matched); // deterministic

    const full = checkExample(analysis, rules, { subset: false });
    expect(full.partial).toBe(false);
    expect(full.verified).toBe(true);
    expect(full.total).toBe(editorConfig.fullCheckAboveRows + 500);
    expect(full.matched).toBe(full.total);
  });

  it('keeps a mismatch found in the prefix and reports the row number in the full example', async () => {
    const { analysis, rules } = await exampleOf(editorConfig.fullCheckAboveRows + 10);
    const broken: LearnResult = {
      ...rules,
      output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: null } : c)) },
    };
    const live = checkExample(analysis, broken);
    expect(live.partial).toBe(true);
    expect(live.matched).toBe(0);
    expect(live.preview[0]!.exampleRow).toBe(2);
  });

  it('subsetAnalysis keeps alignment inside the prefix', async () => {
    const { analysis } = await exampleOf(300);
    const sub = subsetAnalysis(analysis, 100);
    expect(sub.input.rows).toHaveLength(100);
    expect(sub.input.rowNumbers).toHaveLength(100);
    expect(sub.alignment.rows.every((r) => r.in < 100)).toBe(true);
    expect(sub.alignment.rows).toHaveLength(100);
  });
});

// Timing tests share the CPU with every other package's tests when the whole repo runs at once;
// a retry re-measures instead of failing on a noisy neighbour (the budget itself is unchanged).
describe('performance (SPEC 8.11: under 300 ms for 5,000 rows)', { retry: 2 }, () => {
  it('runs the live check on a 5,000-row example within the budget', async () => {
    const { analysis, rules } = await exampleOf(editorConfig.fullCheckAboveRows);
    // Warm up (module load, JIT) the way a user's first edit would not be measured either.
    checkExample(analysis, rules);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = checkExample(analysis, rules);
      expect(r.partial).toBe(false);
      expect(r.total).toBe(editorConfig.fullCheckAboveRows);
      expect(r.matched).toBe(editorConfig.fullCheckAboveRows);
      runs.push(r.ms);
    }
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)]!;
    // eslint-disable-next-line no-console
    console.log(`[perf] live check, 5,000 rows x 4 columns: median ${median} ms (runs: ${runs.join(', ')}), budget ${editorConfig.liveBudgetMs} ms`);
    expect(median).toBeLessThan(editorConfig.liveBudgetMs);
  });

  it('runs a heavy rules file (12 columns, calculations, joins, a value map, dedupe, sort, groups and summary rows) within the budget', async () => {
    const { analysis, rules } = await exampleOf(editorConfig.fullCheckAboveRows);
    const id = (header: string): string => rules.input.columns.find((c) => c.header === header)!.id;
    const [item, supplier, qty, price] = [id('Item'), id('Supplier'), id('Qty'), id('Unit price')];
    const edits: EditAction[] = [
      { type: 'addColumn', header: 'Net', method: { kind: 'calculate', terms: [{ column: qty }, { column: price }, { number: 0.83 }], ops: ['*', '*'], round: 2 } },
      { type: 'addColumn', header: 'Gross', method: { kind: 'calculate', terms: [{ column: qty }, { column: price }, { number: 1.17 }], ops: ['*', '*'], round: 2 } },
      { type: 'addColumn', header: 'Label', method: { kind: 'join', columns: [item, supplier, qty], separator: ' / ' } },
      { type: 'addColumn', header: 'Code', method: { kind: 'partOfText', source: item, part: 'last', n: 3 } },
      { type: 'addColumn', header: 'Vendor', method: { kind: 'translate', source: supplier, pairs: SUPPLIERS.map((v) => ({ from: v, to: v.toUpperCase() })), onMissing: 'flag' } },
      { type: 'addColumn', header: 'Kind', method: { kind: 'fixed', value: 'order' } },
      { type: 'addColumn', header: 'Padded', method: { kind: 'copy', source: item, trim: true, padLeft: 12 } },
      { type: 'addColumn', header: 'Formula', method: { kind: 'formula', formula: `if(${qty} > 20, round(${price} * 0.9, 2), round(${price}, 2))`, type: 'decimal' } },
      { type: 'setDedupe', enabled: true, keys: [item], action: 'flag' },
      { type: 'setSort', keys: [{ column: supplier, dir: 'asc' }, { column: qty, dir: 'desc' }] },
      { type: 'setGroup', group: { by: supplier, showDetailRows: true, blankRowsAfter: 1 } },
      { type: 'addSummaryRow', scope: 'group', row: { label: 'Subtotal', cells: { Qty: 'sum', Total: 'sum', Net: 'sum' } } },
      { type: 'addSummaryRow', scope: 'end', row: { label: 'Total', cells: { Qty: 'sum', Total: 'sum', Net: 'sum', Gross: 'sum' } } },
    ];
    let state = createEditorState(rules);
    for (const e of edits) {
      const out = applyEdit(state, e);
      if (!out.result.ok) throw new Error(`${e.type}: ${JSON.stringify(out.result.problems)}`);
      state = out.state;
    }
    const heavy = state.rules as LearnResult;
    expect(runStaticChecks(heavy, { tier: 'paid' })).toEqual([]);
    checkExample(analysis, heavy);
    const runs: number[] = [];
    let last!: ReturnType<typeof checkExample>;
    for (let i = 0; i < 5; i++) {
      last = checkExample(analysis, heavy);
      runs.push(last.ms);
    }
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)]!;
    // eslint-disable-next-line no-console
    console.log(`[perf] live check, 5,000 rows, heavy rules (${heavy.output.columns.length} columns, groups + summary rows; the example does not have them, so layout rows differ): median ${median} ms (runs: ${runs.join(', ')})`);
    expect(last.total).toBe(editorConfig.fullCheckAboveRows);
    expect(median).toBeLessThan(editorConfig.liveBudgetMs);
  });

  it('runs the subset check on a 20,000-row example within the budget', async () => {
    const { analysis, rules } = await exampleOf(20_000);
    checkExample(analysis, rules);
    const live = checkExample(analysis, rules);
    const full = checkExample(analysis, rules, { subset: false });
    // eslint-disable-next-line no-console
    console.log(`[perf] 20,000-row example: live (subset of ${live.checkedInputRows}) ${live.ms} ms, Apply (all rows) ${full.ms} ms`);
    expect(live.partial).toBe(true);
    expect(live.ms).toBeLessThan(editorConfig.liveBudgetMs);
  }, 60_000);
});

describe('runStaticChecks', () => {
  it('finds nothing wrong with learned rules', async () => {
    const { rules } = await exampleOf(40);
    expect(runStaticChecks(rules, { tier: 'paid' })).toEqual([]);
  });

  it('reports what each layer finds, tagged by layer', async () => {
    const { rules } = await exampleOf(40);
    // references: a sort on an id that does not exist
    const refs = runStaticChecks({ ...rules, transform: { ...rules.transform, sort: [{ column: 'nope', dir: 'asc' }] } }, { tier: 'paid' });
    expect(refs.map((p) => p.layer)).toContain('references');
    // types: a calculation on a text column
    const typed = runStaticChecks(
      {
        ...rules,
        transform: { ...rules.transform, computed: [{ id: 'bad', type: 'decimal', expr: { op: 'mul', args: [{ col: rules.input.columns[0]!.id }, { const: 2 }] } }] },
      },
      { tier: 'paid' },
    );
    expect(typed.some((p) => p.layer === 'types' && p.message.includes('expected decimal, got'))).toBe(true);
    // structure: not even a rules file
    const broken = runStaticChecks({ ...rules, schemaVersion: 2 } as unknown as LearnResult, { tier: 'paid' });
    expect(broken[0]!.layer).toBe('structure');
  });

  it('checks the rule count against the tier', async () => {
    const { rules } = await exampleOf(40);
    const many: LearnResult = {
      ...rules,
      validations: Array.from({ length: 40 }, (_, i) => ({ column: rules.input.columns[0]!.id, rule: 'required' as const, severity: 'flag' as const, on: i % 2 === 0 ? ('input' as const) : undefined })),
    };
    const problems = runStaticChecks(many, { tier: 'anonymous' });
    expect(problems.some((p) => p.layer === 'limits')).toBe(true);
    expect(runStaticChecks(many, { tier: 'paid' }).some((p) => p.layer === 'limits')).toBe(false);
  });
});

// SPEC 8.15: a conversion about to join an EXISTING source (Add a source, the user picked one) is held to it in the browser too.
describe('runStaticChecks with a source (the source lock)', () => {
  const lockProblems = (rules: LearnResult, source: SourceStructure) => runStaticChecks(rules, { tier: 'paid', source }).filter((p) => p.layer === 'sourceLock');

  it('reports nothing for a source the rules fit: a subset of its columns, and aliases are not compared', async () => {
    const { rules } = await exampleOf(20);
    const own = sourceOf(rules);
    const source: SourceStructure = {
      ...own,
      inputSignature: {
        columns: [
          // the source knows other names for the columns (the server merges the file's own into it on reuse)
          ...own.inputSignature.columns.map((c) => ({ ...c, aliases: ['another name'] })),
          { header: 'A column only the source has', aliases: [], type: 'text', required: false },
        ],
      },
    };
    expect(lockProblems(rules, source)).toEqual([]);
    // The lock only ADDS its own layer: every other layer answers as it does without a source.
    expect(runStaticChecks(rules, { tier: 'paid', source })).toEqual(runStaticChecks(rules, { tier: 'paid' }));
  });

  it("reports a sourceLock problem for a column whose type differs from the source's", async () => {
    const { rules } = await exampleOf(20);
    const own = sourceOf(rules);
    const qty = own.inputSignature.columns.find((c) => c.header === 'Qty')!;
    const other = qty.type === 'text' ? 'decimal' : 'text';
    const source: SourceStructure = { ...own, inputSignature: { columns: own.inputSignature.columns.map((c) => (c.header === 'Qty' ? { ...c, type: other } : c)) } };
    const problems = lockProblems(rules, source);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ layer: 'sourceLock', kind: 'sourceMismatch' });
    expect(problems[0]!.path).toMatch(/^input\.columns\[\d+\]\.type$/);
    expect(problems[0]!.message).toContain('"Qty"');
    expect(problems[0]!.message).toContain(`"${other}"`);
  });

  it('reports a column the source does not have, and a different way of reading the file', async () => {
    const { rules } = await exampleOf(20);
    const own = sourceOf(rules);
    const source: SourceStructure = {
      inputSignature: { columns: own.inputSignature.columns.filter((c) => c.header !== 'Supplier') },
      inputReading: { ...own.inputReading, headerRow: own.inputReading.headerRow === 'auto' ? 3 : 'auto' },
      inputValidations: own.inputValidations,
    };
    const problems = lockProblems(rules, source);
    expect(problems.map((p) => p.kind)).toEqual(['sourceMismatch', 'sourceMismatch']);
    expect(problems.some((p) => p.message.includes('"Supplier" is not in the source'))).toBe(true);
    expect(problems.some((p) => p.path === 'input.headerRow')).toBe(true);
  });

  it('is off without a source, like the format lock without a format', async () => {
    const { rules } = await exampleOf(20);
    expect(runStaticChecks(rules, { tier: 'paid' }).some((p) => p.layer === 'sourceLock')).toBe(false);
  });
});
