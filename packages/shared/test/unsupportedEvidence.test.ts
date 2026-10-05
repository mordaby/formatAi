// "An honest unsupported is not a mismatch" - unless the app's own pair analysis (the payload's hints) found how the column is built.
import { describe, expect, it } from 'vitest';
import type { Hint, LearnPayload } from '../src/payload';
import type { LearnResult } from '../src/rules/schema';
import { evidenceByOutput, unsupportedDespiteEvidence } from '../src/unsupportedEvidence';

const input = [
  { i: 0, header: 'Cost', type: 'decimal' },
  { i: 1, header: 'Name', type: 'text' },
  { i: 2, header: 'Dept', type: 'text' },
] as const;
const output = [
  { i: 0, header: 'Unit Price', type: 'decimal' },
  { i: 1, header: 'Label', type: 'text' },
  { i: 2, header: 'Warehouse', type: 'text' },
] as const;

function payload(hints: Hint[], extra: Partial<LearnPayload> = {}): Pick<LearnPayload, 'input' | 'output' | 'hints' | 'complete'> {
  return { input: { columns: [...input] }, output: { columns: [...output] }, hints, ...extra } as never;
}

/** The answer: every column in `giveUp` is "from": null plus an unsupported entry, the others have a rule. */
function answer(giveUp: string[]): LearnResult {
  return {
    output: { columns: output.map((c) => ({ header: c.header, from: giveUp.includes(c.header) ? null : 'x' })) },
    unsupported: giveUp.map((outputColumn) => ({ outputColumn, reasonCode: 'externalData' as const })),
  } as never;
}

describe('unsupportedDespiteEvidence', () => {
  it('a column given up although a hint explains it is a problem: the input columns and the hint kind, no value', () => {
    const problems = unsupportedDespiteEvidence(answer(['Unit Price']), payload([{ rel: 'copy', in: [0], out: 0, coverage: 1 }]));
    expect(problems).toEqual([
      { kind: 'unsupportedDespiteEvidence', out: 0, message: 'Column "Unit Price": the app found it is built from "Cost" (copy); write a rule for it.' },
    ]);
  });

  it('never a column CODE reported as unsupported (reason overfit: its rule only copied rows, even after its one repair)', () => {
    const hints: Hint[] = [{ rel: 'copy', in: [0], out: 0, coverage: 1 }, { rel: 'dependsOn', in: [2], out: 2, coverage: 1 }];
    const byCode = { ...answer(['Unit Price', 'Warehouse']), unsupported: [{ outputColumn: 'Unit Price', reasonCode: 'overfit' as const }, { outputColumn: 'Warehouse', reasonCode: 'externalData' as const }] } as LearnResult;
    expect(unsupportedDespiteEvidence(byCode, payload(hints)).map((p) => p.kind === 'unsupportedDespiteEvidence' && p.out)).toEqual([2]);
  });

  it('a column with no hint stays an honest unsupported: no problem', () => {
    const hints: Hint[] = [{ rel: 'copy', in: [0], out: 0, coverage: 1 }];
    expect(unsupportedDespiteEvidence(answer(['Warehouse']), payload(hints))).toEqual([]);
  });

  it('only a column the answer gave up on counts: a column with a rule never does', () => {
    const hints: Hint[] = [{ rel: 'copy', in: [0], out: 0, coverage: 1 }];
    expect(unsupportedDespiteEvidence(answer([]), payload(hints))).toEqual([]);
    // from null WITHOUT an unsupported entry is the references layer's business, not this one's
    const noEntry = { ...answer(['Unit Price']), unsupported: [] } as LearnResult;
    expect(unsupportedDespiteEvidence(noEntry, payload(hints))).toEqual([]);
  });

  it('every kind of column hint is evidence (template, concat, contains, dependsOn, bands, valueMap, constant, a coverage below 1)', () => {
    const hints: Hint[] = [
      { rel: 'template', in: [1, 2], parts: [{ in: 1 }, ':', { in: 2 }], out: 0, coverage: 1 },
      { rel: 'contains', in: [2, 1], out: 1, coverage: 0.93 },
      { rel: 'dependsOn', in: [2], out: 2, coverage: 1 },
    ];
    const problems = unsupportedDespiteEvidence(answer(['Unit Price', 'Label', 'Warehouse']), payload(hints));
    expect(problems.map((p) => (p.kind === 'unsupportedDespiteEvidence' ? p.message : ''))).toEqual([
      'Column "Unit Price": the app found it is built from "Name", "Dept" (template); write a rule for it.',
      'Column "Label": the app found it is built from "Dept", "Name" (contains); write a rule for it.',
      'Column "Warehouse": the app found it is built from "Dept" (dependsOn); write a rule for it.',
    ]);
    for (const hint of [
      { rel: 'concat', in: [1, 2], separator: '-', out: 0, coverage: 1 },
      { rel: 'bands', in: [0], bands: [{ lt: 5, value: 'a' }, { gte: 5, value: 'b' }], out: 0, coverage: 1 },
      { rel: 'valueMap', in: [2], pairs: [['x', 'y']], out: 0, coverage: 1 },
    ] as Hint[]) {
      expect(unsupportedDespiteEvidence(answer(['Unit Price']), payload([hint]))).toHaveLength(1);
    }
  });

  it('a window hint names its value, group and order columns (and the function), and a constant names no column at all', () => {
    const window: Hint = { rel: 'window', fn: 'groupSum', in: [0], by: [2], order: [{ in: 1, dir: 'asc' }], out: 0, coverage: 1 };
    expect(unsupportedDespiteEvidence(answer(['Unit Price']), payload([window]))).toEqual([
      { kind: 'unsupportedDespiteEvidence', out: 0, message: 'Column "Unit Price": the app found it is built from "Cost", "Dept", "Name" (window groupSum); write a rule for it.' },
    ]);
    const rowNumber: Hint = { rel: 'window', fn: 'rowNumber', order: 'file', out: 0, coverage: 1 };
    expect(unsupportedDespiteEvidence(answer(['Unit Price']), payload([rowNumber]))).toEqual([
      { kind: 'unsupportedDespiteEvidence', out: 0, message: 'Column "Unit Price": the app found a rule for it (window rowNumber); write a rule for it.' },
    ]);
    const constant: Hint = { rel: 'constant', in: [], value: 'SECRET VALUE', out: 0, coverage: 1 };
    const [p] = unsupportedDespiteEvidence(answer(['Unit Price']), payload([constant]));
    expect(p).toMatchObject({ kind: 'unsupportedDespiteEvidence', out: 0, message: 'Column "Unit Price": the app found a rule for it (constant); write a rule for it.' });
    expect(JSON.stringify(p)).not.toContain('SECRET');
  });

  it('the columns an expand creates are covered by their expand hint; row hints (filter, dedupe) say nothing about a column', () => {
    const hints: Hint[] = [
      { rel: 'expand', mode: 'columnsToRows', in: [0, 1], labelOut: 1, valueOut: 0, skipEmpty: true, coverage: 1 },
      { rel: 'filter', in: [2], keptValues: ['a'], coverage: 1 },
      { rel: 'dedupe', in: [0], keys: 'all', keep: 'first', coverage: 1 },
    ];
    const problems = unsupportedDespiteEvidence(answer(['Unit Price', 'Label', 'Warehouse']), payload(hints));
    expect(problems.map((p) => (p.kind === 'unsupportedDespiteEvidence' ? p.out : -1))).toEqual([0, 1]);
    expect(evidenceByOutput(hints).get(2)).toBeUndefined();
  });

  it('completion mode: only a column the AI step was asked for (complete.columns) - an unsupported entry of the user\'s own rules is theirs', () => {
    const hints: Hint[] = [
      { rel: 'copy', in: [0], out: 0, coverage: 1 },
      { rel: 'copy', in: [1], out: 1, coverage: 1 },
    ];
    const complete = { fixed: {}, columns: [1], parts: [] };
    const problems = unsupportedDespiteEvidence(answer(['Unit Price', 'Label']), payload(hints, { complete } as never));
    expect(problems.map((p) => (p.kind === 'unsupportedDespiteEvidence' ? p.out : -1))).toEqual([1]);
  });

  it('bands on a computed output column (onOut) name the input columns behind it AND that output column, by header', () => {
    // A class by a total, where the total is an output column too (Qty * Price): owner amendment 2026-10-05.
    const columns = {
      input: { columns: [{ i: 0, header: 'Qty', type: 'integer' }, { i: 1, header: 'Price', type: 'decimal' }] },
      output: { columns: [{ i: 0, header: 'Total', type: 'decimal' }, { i: 1, header: 'Class', type: 'text' }] },
    };
    const bands: Hint = { rel: 'bands', in: [0, 1], onOut: 0, bands: [{ lt: 1000, value: 'SECRET LOW' }, { gte: 1000, value: 'SECRET HIGH' }], out: 1, coverage: 1 };
    const hints: Hint[] = [{ rel: 'mul', in: [0, 1], out: 0, coverage: 1 }, bands];
    const giveUp = { output: { columns: [{ header: 'Total', from: 'total' }, { header: 'Class', from: null }] }, unsupported: [{ outputColumn: 'Class', reasonCode: 'externalData' }] } as never;
    const problems = unsupportedDespiteEvidence(giveUp, payload(hints, columns as never));
    expect(problems).toEqual([
      { kind: 'unsupportedDespiteEvidence', out: 1, message: 'Column "Class": the app found it is built from "Qty", "Price" (bands on output column "Total"); write a rule for it.' },
    ]);
    expect(JSON.stringify(problems)).not.toMatch(/SECRET|1000/);
    expect(evidenceByOutput(hints).get(1)).toEqual({ kind: 'bands', inputs: [0, 1], onOut: 0 });
    // A headerless output: the column's position, as the payload numbers it.
    const headerless = { ...columns, output: { columns: [{ i: 0, header: '', type: 'decimal' }, { i: 1, header: 'Class', type: 'text' }] } };
    expect(unsupportedDespiteEvidence(giveUp, payload(hints, headerless as never))[0]).toMatchObject({
      message: 'Column "Class": the app found it is built from "Qty", "Price" (bands on output column 0); write a rule for it.',
    });
  });

  it('the first hint that names a column is the evidence for it', () => {
    const hints: Hint[] = [
      { rel: 'padLeft', in: [1], length: 6, out: 0, coverage: 1 },
      { rel: 'copy', in: [0], out: 0, coverage: 1 },
    ];
    expect(evidenceByOutput(hints).get(0)).toEqual({ kind: 'padLeft', inputs: [1] });
  });
});
