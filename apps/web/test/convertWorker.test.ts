// The worker methods of "convert a file" and "batch", run for real (the engine, the RPC runtime and client, in-process):
// what matching says about a file's headers, the review that stops BEFORE the file is written, the row decisions applied
// to the written file, and the batch's zip and summary workbook.
import { readWorkbook, readZip } from '@formatai/engine';
import { describe, expect, it } from 'vitest';
import { createEngineClient } from '../src/worker/engineClient';
import { engineMethods } from '../src/worker/engineMethods';
import { loopbackWorker } from './helpers/loopback';
import { RULES, SUPPLIER_A_CLEAN_CSV, SUPPLIER_A_CSV } from './helpers/convertKit';

const enc = (s: string): ArrayBuffer => {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};
const dec = (b: ArrayBuffer | Uint8Array): string => new TextDecoder().decode(b instanceof Uint8Array ? b : new Uint8Array(b));
const engine = () => createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });
const file = (name: string, body: string) => ({ name, bytes: enc(body) });

const SIG_A = {
  id: 'a',
  name: 'Supplier A',
  columns: [
    { header: 'Item Code', aliases: [], type: 'idLike', required: true },
    { header: 'Qty', aliases: [], type: 'integer', required: true },
    { header: 'Price', aliases: [], type: 'decimal', required: false },
  ],
};
const SIG_B = {
  id: 'b',
  name: 'Supplier B',
  columns: [
    { header: 'SKU', aliases: [], type: 'idLike', required: true },
    { header: 'Stock', aliases: [], type: 'integer', required: true },
  ],
};

describe('readHeaders / matchFile', () => {
  it('reads the headers of the file table', async () => {
    const out = await engine().readHeaders({ file: file('a.csv', SUPPLIER_A_CSV) });
    expect(out).toMatchObject({ ok: true, headers: ['Item Code', 'Qty', 'Price', 'Extra'], rows: 3 });
  });

  it('a file with no table is reported, not thrown', async () => {
    const out = await engine().readHeaders({ file: file('empty.csv', '') });
    expect(out.ok).toBe(false);
  });

  it('picks one source automatically when it clearly matches, and lists the extra columns', async () => {
    const out = await engine().matchFile({ file: file('a.csv', SUPPLIER_A_CSV), signatures: [SIG_A, SIG_B] });
    if (!out.ok) throw new Error('expected a match');
    expect(out.pick.kind).toBe('auto');
    expect(out.pick.kind === 'auto' && out.pick.match.id).toBe('a');
    expect(out.ranked[0]!.extra).toEqual(['Extra']);
    expect(out.ranked.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('asks the user to choose when nothing clearly wins (never a guess)', async () => {
    const out = await engine().matchFile({ file: file('x.csv', 'Item Code,Qty\n1,2\n3,4\n'), signatures: [SIG_A, { ...SIG_A, id: 'a2', name: 'Supplier A2' }] });
    if (!out.ok) throw new Error('expected a match');
    expect(out.pick.kind).toBe('choose');
    expect(out.pick.kind === 'choose' && out.pick.options.map((o) => o.id)).toEqual(['a', 'a2']);
  });

  it('a renamed required column is a missing one, with the file header that may be it', async () => {
    const out = await engine().matchFile({ file: file('r.csv', 'Item-Code,Qty,Price\n00001,5,1\n00002,6,2\n'), signatures: [SIG_A] });
    if (!out.ok) throw new Error('expected a match');
    const m = out.ranked[0]!;
    expect(m.missingRequired).toEqual(['Item Code']);
    expect(m.renamedCandidates).toEqual([{ required: 'Item Code', candidates: ['Item-Code'] }]);
  });
});

describe('convertWithDecisions', () => {
  it('review mode stops BEFORE writing when rows are flagged, and hands back their input values', async () => {
    const out = await engine().convertWithDecisions({ rules: RULES, file: file('a.csv', SUPPLIER_A_CSV), mode: 'review', previewRows: 10 });
    if (!out.ok || out.written) throw new Error('expected a review');
    expect(out.flags.map((f) => [f.rowNumber, f.column])).toEqual(expect.arrayContaining([[3, 'c_code'], [3, 'c_qty']]));
    expect(out.flags.find((f) => f.column === 'c_code')?.suggestion).toBe('00123');
    expect(out.rowInputs[3]).toEqual([
      { columnId: 'c_code', header: 'Item Code', value: '123' },
      { columnId: 'c_qty', header: 'Qty', value: 'abc' },
      { columnId: 'c_price', header: 'Price', value: '3' },
    ]);
    expect(Object.keys(out.rowInputs)).toEqual(['3']);
    expect('bytes' in out).toBe(false);
  });

  it('review mode writes straight away when nothing is flagged', async () => {
    const out = await engine().convertWithDecisions({ rules: RULES, file: file('a.csv', SUPPLIER_A_CLEAN_CSV), mode: 'review', previewRows: 10 });
    if (!out.ok || !out.written) throw new Error('expected a written file');
    expect(dec(out.bytes)).toContain('00002');
    expect(out.summary).toMatchObject({ rowsIn: 3, rowsOut: 3 });
    expect(out.flags).toEqual([]);
  });

  it('write mode applies the decisions: skip, keep and a one-off fix, without touching the rules', async () => {
    const rules = structuredClone(RULES);
    const e = engine();
    const skipped = await e.convertWithDecisions({ rules, file: file('a.csv', SUPPLIER_A_CSV), mode: 'write', previewRows: 10, rowDecisions: { 3: { action: 'skip' } } });
    if (!skipped.ok || !skipped.written) throw new Error('expected a file');
    expect(dec(skipped.bytes)).not.toContain('abc');
    expect(skipped.summary).toMatchObject({ rowsIn: 3, rowsOut: 2, skippedByUser: [{ rowNumber: 3 }] });

    const kept = await e.convertWithDecisions({ rules, file: file('a.csv', SUPPLIER_A_CSV), mode: 'write', previewRows: 10, rowDecisions: { 3: { action: 'keep' } } });
    if (!kept.ok || !kept.written) throw new Error('expected a file');
    expect(kept.summary.acceptedByUser).toEqual([{ rowNumber: 3, flags: kept.flags.length }]);
    expect(kept.flags.every((f) => f.accepted === true)).toBe(true);

    const fixed = await e.convertWithDecisions({
      rules,
      file: file('a.csv', SUPPLIER_A_CSV),
      mode: 'write',
      previewRows: 10,
      rowDecisions: { 3: { action: 'override', values: { c_code: '00123', c_qty: '9' } } },
    });
    if (!fixed.ok || !fixed.written) throw new Error('expected a file');
    expect(dec(fixed.bytes)).toContain('00123');
    expect(fixed.flags).toEqual([]);
    expect(fixed.summary.editedByUser).toEqual([{ rowNumber: 3, columns: ['c_code', 'c_qty'] }]);
    // The saved rules are exactly what they were.
    expect(rules).toEqual(RULES);
  });

  it('missing required columns come back as an error with the exact headers', async () => {
    const out = await engine().convertWithDecisions({ rules: RULES, file: file('r.csv', 'Item Code,Quantity\n00001,5\n00002,6\n'), mode: 'review', previewRows: 5 });
    expect(out).toMatchObject({ ok: false, error: { code: 'missingRequiredColumns', missing: ['Qty'] } });
  });

  // "Same name, different meaning" (SPEC 21 v11 items 4-7): the share of rows whose used column did not parse, against limits.matching.parseFailShare.
  it('reports a used column whose values mostly did not parse (counts only), and says nothing below the share', async () => {
    const qtyCsv = (rows: number, bad: number): string =>
      `Item Code,Qty,Price\n${Array.from({ length: rows }, (_, i) => `${String(i + 1).padStart(5, '0')},${i < bad ? 'abc' : '5'},1`).join('\n')}\n`;
    const e = engine();
    const most = await e.convertWithDecisions({ rules: RULES, file: file('a.csv', qtyCsv(10, 9)), mode: 'review', previewRows: 5 });
    if (!most.ok) throw new Error('expected a run');
    expect(most.unlike).toEqual([{ id: 'c_qty', header: 'Qty', type: 'integer', rows: 9 }]);
    // Nothing but a column and counts: no value of the file is in the answer.
    expect(JSON.stringify(most.unlike)).not.toContain('abc');

    const some = await e.convertWithDecisions({ rules: RULES, file: file('a.csv', qtyCsv(10, 8)), mode: 'review', previewRows: 5 });
    if (!some.ok) throw new Error('expected a run');
    expect(some.unlike).toBeUndefined();
    // The flagged rows are still there for the row review, exactly as before.
    expect(some.flags.filter((f) => f.column === 'c_qty')).toHaveLength(8);
  });

  it('a column the rules do not use is never "different": only used columns are looked at', async () => {
    const unused = { ...RULES, input: { ...RULES.input, columns: [...RULES.input.columns, { id: 'c_notes', header: 'Notes', type: 'integer' as const }] } };
    const csv = `Item Code,Qty,Price,Notes\n${Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(5, '0')},5,1,words`).join('\n')}\n`;
    const out = await engine().convertWithDecisions({ rules: unused, file: file('a.csv', csv), mode: 'review', previewRows: 5 });
    if (!out.ok) throw new Error('expected a run');
    expect(out.unlike).toBeUndefined();
  });
});

describe('columnGaps', () => {
  it('lists, per conversion, the required columns the headers lack and the used columns that are optional - never one nothing uses', async () => {
    const unused = { ...RULES, name: 'with-notes', input: { ...RULES.input, columns: [...RULES.input.columns, { id: 'c_notes', header: 'Notes', type: 'text' as const }] } };
    const out = await engine().columnGaps({ headers: ['Item Code', 'Notes'], rules: [RULES, unused, { ...RULES, input: { ...RULES.input, columns: RULES.input.columns.slice(0, 1) }, output: { ...RULES.output, columns: [{ header: 'Code', from: 'c_code' }] } }] });
    expect(out).toEqual([
      [{ id: 'c_qty', header: 'Qty', required: true }, { id: 'c_price', header: 'Price', required: false }],
      [{ id: 'c_qty', header: 'Qty', required: true }, { id: 'c_price', header: 'Price', required: false }],
      [],
    ]);
    // A file that has them all: nothing is missing, and a declared-but-unused column is not asked for.
    expect(await engine().columnGaps({ headers: ['Item Code', 'Qty', 'Price'], rules: [unused] })).toEqual([[]]);
  });

  it('finds a column by alias and by the normalized header, as a run does', async () => {
    const aliased = { ...RULES, input: { ...RULES.input, columns: RULES.input.columns.map((c) => (c.id === 'c_qty' ? { ...c, aliases: ['Quantity'] } : c)) } };
    expect(await engine().columnGaps({ headers: [' item CODE', 'Quantity', 'PRICE'], rules: [aliased] })).toEqual([[]]);
  });
});

describe('batch (packing)', () => {
  it('makes a zip with a folder per format and a summary workbook of files and flags', async () => {
    const out = await engine().batch({
      outputs: [
        { folder: 'Load file', fileName: 'one (converted).csv', bytes: enc('a\n1\n') },
        { folder: 'Load file', fileName: 'one (converted).csv', bytes: enc('a\n2\n') },
        { folder: 'Other: format?', fileName: 'two (converted).csv', bytes: enc('b\n') },
      ],
      summary: {
        language: 'en',
        files: { sheetName: 'Files', headers: ['File', 'Status'], rows: [['one.csv', 'Converted'], ['bad.csv', "Didn't match"]] },
        flags: { sheetName: 'Flags', headers: ['File', 'Row', 'Message'], rows: [['one.csv', 3, 'Not a number']] },
      },
      summaryFileName: 'summary.xlsx',
    });
    const entries = await readZip(out.zip);
    expect(entries.map((e) => e.path)).toEqual(['Load file/one (converted).csv', 'Load file/one (converted) (2).csv', 'Other format/two (converted).csv', 'summary.xlsx']);
    expect(dec(entries[1]!.bytes as Uint8Array)).toBe('a\n2\n');

    // The summary is in the zip and also comes back alone.
    const inZip = entries[3]!.bytes as Uint8Array;
    expect(Array.from(inZip)).toEqual(Array.from(new Uint8Array(out.summary)));
    const wb = await readWorkbook(new Uint8Array(out.summary), 'summary.xlsx');
    expect(wb.sheets.map((s) => s.name)).toEqual(['Files', 'Flags']);
    const cells = (i: number) => wb.sheets[i]!.rows.map((r) => r.map((c) => c?.v ?? null));
    expect(cells(0)).toEqual([['File', 'Status'], ['one.csv', 'Converted'], ['bad.csv', "Didn't match"]]);
    expect(cells(1)).toEqual([['File', 'Row', 'Message'], ['one.csv', 3, 'Not a number']]);
  });
});
