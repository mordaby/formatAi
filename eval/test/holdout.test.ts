// checkHoldOut (SPEC 10): convertFile(rules, next.input) must equal next.output - cell
// values for xlsx (a cosmetically different but value-equivalent xlsx must still pass),
// byte-for-byte for csv/txt (the file IS the wire format).
import { describe, expect, it } from 'vitest';
import { convertFile, writeXlsx } from '@formatai/engine';
import type { OutRow, OutputSheet } from '@formatai/engine';
import type { LearnResult } from '@formatai/shared';
import { checkHoldOut } from '../lib/holdout.js';

function xlsxSheet(headers: string[], rows: (string | number | null)[][], opts: { width?: number } = {}): OutputSheet {
  return {
    name: 'Sheet1',
    direction: 'ltr',
    language: 'en',
    columns: headers.map((h) => ({ header: h, ...(opts.width ? { width: opts.width } : {}) })),
    rows: [
      { kind: 'header', cells: headers.map((h) => ({ v: h })) } as OutRow,
      ...rows.map((r): OutRow => ({ kind: 'data', cells: r.map((v) => ({ v })) })),
    ],
    merges: [],
  };
}

const copyIdRules: LearnResult = {
  schemaVersion: 1,
  input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'id', header: 'ID', type: 'integer' }, { id: 'name', header: 'Name', type: 'text' }] },
  transform: { computed: [], valueMaps: [], sort: [] },
  output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'ID', from: 'id' }, { header: 'Name', from: 'name' }] },
  validations: [],
  unsupported: [],
  assumptions: [],
};

const csvRules: LearnResult = { ...copyIdRules, output: { ...copyIdRules.output, file: { type: 'csv' } } };

async function nextInputBytes(): Promise<Uint8Array> {
  return writeXlsx(
    xlsxSheet(
      ['ID', 'Name'],
      [
        [201, 'Ada'],
        [202, 'Bo'],
        [203, 'Cy'],
      ],
    ),
  );
}

describe('checkHoldOut: xlsx (cell-value compare)', () => {
  it('passes when the rules reproduce next.output exactly', async () => {
    const nextInput = { fileName: 'next.input.xlsx', bytes: await nextInputBytes() };
    const nextOutputBytes = await writeXlsx(
      xlsxSheet(
        ['ID', 'Name'],
        [
          [201, 'Ada'],
          [202, 'Bo'],
          [203, 'Cy'],
        ],
      ),
    );
    const result = await checkHoldOut(copyIdRules, { input: nextInput, output: { fileName: 'next.output.xlsx', bytes: nextOutputBytes } });
    expect(result.ok).toBe(true);
  });

  it('passes on a cosmetically different but value-equal xlsx (different column width)', async () => {
    const nextInput = { fileName: 'next.input.xlsx', bytes: await nextInputBytes() };
    const nextOutputBytes = await writeXlsx(
      xlsxSheet(
        ['ID', 'Name'],
        [
          [201, 'Ada'],
          [202, 'Bo'],
          [203, 'Cy'],
        ],
        { width: 40 },
      ),
    );
    const result = await checkHoldOut(copyIdRules, { input: nextInput, output: { fileName: 'next.output.xlsx', bytes: nextOutputBytes } });
    expect(result.ok).toBe(true);
  });

  it('fails when a value differs', async () => {
    const nextInput = { fileName: 'next.input.xlsx', bytes: await nextInputBytes() };
    const nextOutputBytes = await writeXlsx(
      xlsxSheet(
        ['ID', 'Name'],
        [
          [201, 'Ada'],
          [202, 'WRONG'],
          [203, 'Cy'],
        ],
      ),
    );
    const result = await checkHoldOut(copyIdRules, { input: nextInput, output: { fileName: 'next.output.xlsx', bytes: nextOutputBytes } });
    expect(result.ok).toBe(false);
  });

  it('fails when convertFile itself fails (e.g. a required header missing from next.input)', async () => {
    const nextInput = { fileName: 'next.input.xlsx', bytes: await writeXlsx(xlsxSheet(['Other'], [['x'], ['y'], ['z']])) };
    const requiredRules: LearnResult = {
      ...copyIdRules,
      input: { ...copyIdRules.input, columns: copyIdRules.input.columns.map((c) => ({ ...c, required: true })) },
    };
    const nextOutputBytes = await writeXlsx(xlsxSheet(['ID', 'Name'], [[1, 'a']]));
    const result = await checkHoldOut(requiredRules, { input: nextInput, output: { fileName: 'next.output.xlsx', bytes: nextOutputBytes } });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

describe('checkHoldOut: csv/txt (byte compare)', () => {
  it('passes when the bytes are identical', async () => {
    const nextInput = { fileName: 'next.input.xlsx', bytes: await nextInputBytes() };
    const converted = await convertFile(csvRules, nextInput.bytes, nextInput.fileName);
    if (!converted.ok) throw new Error('setup: convertFile failed');
    const result = await checkHoldOut(csvRules, { input: nextInput, output: { fileName: 'next.output.csv', bytes: converted.bytes } });
    expect(result.ok).toBe(true);
  });

  it('fails on any byte difference, even a trailing space', async () => {
    const nextInput = { fileName: 'next.input.xlsx', bytes: await nextInputBytes() };
    const converted = await convertFile(csvRules, nextInput.bytes, nextInput.fileName);
    if (!converted.ok) throw new Error('setup: convertFile failed');
    const perturbed = new Uint8Array([...converted.bytes, 0x20]);
    const result = await checkHoldOut(csvRules, { input: nextInput, output: { fileName: 'next.output.csv', bytes: perturbed } });
    expect(result.ok).toBe(false);
  });
});
