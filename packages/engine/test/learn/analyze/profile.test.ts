import { describe, expect, it } from 'vitest';
import { profileColumns, shapeOf, toPayloadColumn } from '../../../src/learn/analyze';
import { makeValidIsraeliId } from '../../../src/values/israeliId';
import { cell, date, num, type V } from './helpers';

function table(headers: string[], rows: V[][], colWidths?: (number | undefined)[]) {
  return { headers, rows: rows.map((r) => r.map(cell)), ...(colWidths ? { colWidths } : {}) };
}

describe('profileColumns (SPEC 7.1)', () => {
  const ids = ['01234567', '00456789', '12345678', '00000042', '98765432', '10000001'];
  const israeli = ['3012345', '40217763', '203948576', '55120934', '123456782', '87654329'].map((s) =>
    makeValidIsraeliId(s.padStart(9, '0').slice(0, 8)).replace(/^0+/, ''),
  );
  const rows: V[][] = ids.map((id, i) => [
    id,
    ['AB-1234', 'CD-5678', 'EF-9012', 'GH-3456', 'IJ-7890', 'KL-1122'][i]!,
    i + 1,
    [10.5, 3.25, 99, 1200.75, 0.5, 7][i]!,
    num([0.17, 0.2, 0.17, 0.05, 0.1, 0.17][i]!, '0%'),
    num([100, 250.5, 80, 1999.99, 45, 60][i]!, '₪#,##0.00'),
    date(2024, 1 + i, 10 + i),
    `${String(13 + i).padStart(2, '0')}/0${1 + i}/2024`,
    i % 2 === 0,
    i === 2 ? null : `note ${i}`,
    null,
    Number(israeli[i]),
    ['1,234.50', '99', '18,000', '0.75', '250.25', '7'][i]!,
    ['שלום', 'עולם', 'שלום', 'אבג', 'שלום', 'עולם'][i]!,
  ]);
  const headers = ['Id', 'Code', 'Seq', 'Amount', 'Rate', 'Price', 'Start', 'Due', 'Flag', 'Note', 'Blank', 'IdNo', 'Text num', 'מילה'];
  const p = profileColumns(table(headers, rows, [10, 12]), { output: true });

  it('types', () => {
    expect(p.map((c) => c.type)).toEqual([
      'idLike', 'text', 'integer', 'decimal', 'percent', 'currency', 'date', 'date', 'boolean', 'text', 'empty', 'idLike',
      'decimal', 'text',
    ]);
  });

  it('shape signatures, lengths, ranges', () => {
    expect(p[0]).toMatchObject({ shape: 'DDDDDDDD', len: [8, 8] });
    expect(p[1]).toMatchObject({ shape: 'AA-DDDD' });
    expect(p[2]).toMatchObject({ range: [1, 6], key: true });
    expect(p[3]).toMatchObject({ range: [0.5, 1200.75] });
    expect(p[6]).toMatchObject({ range: ['2024-01-10', '2024-06-15'], dateFormat: 'excel' });
    expect(p[7]).toMatchObject({ range: ['2024-01-13', '2024-06-18'], dateFormat: 'DD/MM/YYYY' });
    expect(p[7]!.dayMonthAmbiguous).toBeUndefined();
    expect(p[13]).toMatchObject({ shape: 'HHH|HHHH' });
    expect(shapeOf('ת.ז. 12-ab')).toBe('H.H. DD-AA');
  });

  it('empty rate, distinct count and ratio, key', () => {
    expect(p[9]).toMatchObject({ emptyRate: 1 / 6, distinctCount: 5, distinctRatio: 1, key: false });
    expect(p[10]).toMatchObject({ emptyRate: 1, nonEmpty: 0, type: 'empty' });
    expect(p[13]).toMatchObject({ distinctCount: 3, distinctRatio: 0.5 });
    expect(p[0]!.key).toBe(true);
  });

  it('Israeli ids with lost leading zeros; numbers stored as text', () => {
    expect(p[11]).toMatchObject({ israeliId: true, leadingZerosLost: true, type: 'idLike' });
    expect(p[0]).toMatchObject({ israeliId: false, leadingZerosLost: false });
    expect(p[12]).toMatchObject({ numbersAsText: true, range: [0.75, 18000] });
  });

  it('output columns: number format and width', () => {
    expect(p[4]).toMatchObject({ format: '0%' });
    expect(p[5]).toMatchObject({ format: '₪#,##0.00' });
    expect(p[0]!.width).toBe(10);
    expect(p[1]!.width).toBe(12);
    expect(p[2]!.width).toBeUndefined();
  });

  it('payload form keeps only relevant stats', () => {
    expect(toPayloadColumn(p[11]!)).toEqual({
      i: 11,
      header: 'IdNo',
      type: 'idLike',
      shape: expect.any(String),
      stats: { empty: 0, values: 6, len: expect.any(Array), key: true, leadingZerosLost: true, israeliId: true },
      width: undefined,
    } as unknown as ReturnType<typeof toPayloadColumn>);
    const c = toPayloadColumn(p[4]!);
    expect(c.format).toBe('0%');
    expect(c.stats).toEqual({ empty: 0, values: 4, range: [0.05, 0.2] });
  });
});
