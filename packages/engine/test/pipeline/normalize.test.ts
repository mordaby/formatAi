import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/pipeline';
import { ymdToSerial } from '../../src/values/dates';
import { col, dataRows, dateCell, rules, runOk, table, values } from './helpers';

const serial = (y: number, m: number, d: number) => ymdToSerial({ y, m, d });

describe('header mapping (SPEC 8.2 step 1, SPEC 17)', () => {
  it('matches exact, then aliases, then normalized headers; extra input columns are ignored', () => {
    const r = rules({
      columns: [
        col('agent', 'idLike', { header: 'מספר סוכן', aliases: ['סוכן'] }),
        col('policy', 'idLike', { header: "מס' פוליסה" }),
        col('total', 'decimal', { header: 'סה"כ' }),
        col('name', 'text', { header: 'Agent  Name' }),
      ],
    });
    const t = table(
      ['הערות', 'סוכן', 'מס׳ פוליסה', ' סה״כ ', 'agent name'],
      [['x', 7, '123', '10', 'Dana']],
    );
    expect(values(runOk(r, t).sheet)).toEqual([['7', '123', 10, 'Dana']]);
  });

  it("two apostrophes ('') stand for a double quote", () => {
    const r = rules({ columns: [col('total', 'decimal', { header: 'סה"כ' })] });
    expect(values(runOk(r, table(["סה''כ"], [[5]])).sheet)).toEqual([[5]]);
  });

  it('an exact match wins over a normalized one, whatever the order', () => {
    // 'a' would match "Name" loosely, but "Name" is b's exact match; 'a' gets "name ".
    const r = rules({ columns: [col('a', 'text', { header: 'name' }), col('b', 'text', { header: 'Name' })] });
    const t = table(['Name', 'name '], [['first', 'second']]);
    expect(values(runOk(r, t).sheet)).toEqual([['second', 'first']]);
  });

  it('missing required columns → missingRequiredColumns listing their headers', () => {
    const r = rules({
      columns: [
        col('a', 'text', { header: 'A', required: true }),
        col('b', 'text', { header: 'B', required: true }),
        col('c', 'text', { header: 'C', required: true }),
      ],
    });
    const res = runRules(r, table(['B'], [['1']]));
    expect(res).toEqual({
      ok: false,
      error: { code: 'missingRequiredColumns', missing: ['A', 'C'], params: { count: 2 } },
    });
  });

  it('a missing optional column is empty', () => {
    const r = rules({ columns: [col('a', 'text', { header: 'A' }), col('b', 'decimal', { header: 'B' })] });
    const res = runOk(r, table(['A'], [['x']]));
    expect(values(res.sheet)).toEqual([['x', null]]);
    expect(res.flags).toEqual([]);
  });
});

describe('idLike: leading zeros and padding', () => {
  const r = rules({ columns: [col('id', 'idLike', { padLeft: 9 }), col('code', 'idLike')] });

  it('numbers become integer text and are padded; text stays text', () => {
    const res = runOk(r, table(['id', 'code'], [[40217763, 123], ['040217763', '00123'], [' 5 ', 'AB-12'], ['A12', 1.23456789012345e20]]));
    expect(values(res.sheet)).toEqual([
      ['040217763', '123'],
      ['040217763', '00123'],
      ['000000005', 'AB-12'],
      ['A12', '123456789012345000000'],
    ]);
    expect(res.flags).toEqual([]);
  });

  it('a non-integer number in an idLike column is kept and flagged', () => {
    const res = runOk(r, table(['id', 'code'], [[12.5, 1]]));
    expect(values(res.sheet)).toEqual([['12.5', '1']]);
    expect(res.flags.map((f) => f.messageKey)).toEqual(['flag.parseFailed.idLike']);
  });
});

describe('numbers', () => {
  const r = rules({ columns: [col('n', 'decimal')] });

  it('numbers stored as text: ₪, thousands, %, parentheses, trailing minus', () => {
    const res = runOk(
      r,
      table(['n'], [['₪1,234.50'], ['1,000'], ['17%'], ['(150)'], ['150-'], ['(₪2,000.10)'], [' 42 '], ['−7'], [0.1 + 0.2]]),
    );
    expect(values(res.sheet).map((x) => x[0])).toEqual([1234.5, 1000, 0.17, -150, -150, -2000.1, 42, -7, 0.3]);
    expect(res.flags).toEqual([]);
  });

  it('text that is not a number is kept as-is and flagged', () => {
    const res = runOk(r, table(['n'], [['abc'], ['12']]), { fileName: 'in.xlsx' });
    expect(values(res.sheet)).toEqual([['abc'], [12]]);
    expect(res.flags).toEqual([
      {
        fileName: 'in.xlsx',
        rowNumber: 2,
        column: 'n',
        rule: 'type',
        value: 'abc',
        messageKey: 'flag.parseFailed.number',
        params: { type: 'decimal' },
      },
    ]);
    expect(dataRows(res.sheet)[0]!.cells[0]!.flagged).toBe(true);
  });

  it('integer columns flag non-integers', () => {
    const res = runOk(rules({ columns: [col('n', 'integer')] }), table(['n'], [[3], [3.5]]));
    expect(res.flags.map((f) => [f.rowNumber, f.messageKey])).toEqual([[3, 'flag.parseFailed.integer']]);
  });
});

describe('dates', () => {
  it('date cells (isDate serials) are dates without any inputFormats', () => {
    const r = rules({ columns: [col('d', 'date')], out: [{ header: 'd', from: 'd', format: 'DD/MM/YYYY' }] });
    const s = serial(2024, 3, 15);
    const res = runOk(r, table(['d'], [[dateCell(s)], [dateCell(s + 0.75)]]));
    const cells = dataRows(res.sheet).map((x) => x.cells[0]);
    expect(cells[0]).toEqual({ v: s, isDate: true, z: 'dd/mm/yyyy', text: '15/03/2024' });
    expect(cells[1]!.v).toBe(s); // the time of day is dropped
  });

  it('1904-system workbooks are shifted', () => {
    const r = rules({ columns: [col('d', 'date')] });
    const s1900 = serial(2024, 3, 15);
    const res = runOk(r, table(['d'], [[dateCell(s1900 - 1462)]], { date1904: true }));
    expect(values(res.sheet)).toEqual([[s1900]]);
  });

  it('DD/MM text dates, "excelSerial" numbers, and impossible dates with a day/month-swap suggestion', () => {
    const r = rules({
      columns: [col('d', 'date', { inputFormats: ['DD/MM/YYYY', 'excelSerial'] })],
      out: [{ header: 'd', from: 'd', format: 'DD/MM/YYYY' }],
    });
    const res = runOk(r, table(['d'], [['05/03/2024'], [45366], ['45366'], ['03/15/2024'], ['31/31/2024'], ['2024-03-05']]));
    const vs = values(res.sheet).map((x) => x[0]);
    expect(vs.slice(0, 3)).toEqual([serial(2024, 3, 5), 45366, 45366]);
    expect(vs.slice(3)).toEqual(['03/15/2024', '31/31/2024', '2024-03-05']);
    expect(res.flags.map((f) => [f.rowNumber, f.messageKey, f.value, f.suggestion])).toEqual([
      [5, 'flag.parseFailed.date', '03/15/2024', '15/03/2024'],
      [6, 'flag.parseFailed.date', '31/31/2024', undefined],
      [7, 'flag.parseFailed.date', '2024-03-05', undefined],
    ]);
  });

  it('a plain number is not a date unless "excelSerial" is listed', () => {
    const r = rules({ columns: [col('d', 'date', { inputFormats: ['DD/MM/YYYY'] })] });
    const res = runOk(r, table(['d'], [[45366]]));
    expect(values(res.sheet)).toEqual([[45366]]);
    expect(dataRows(res.sheet)[0]!.cells[0]!.isDate).toBeUndefined();
    expect(res.flags.map((f) => f.messageKey)).toEqual(['flag.parseFailed.date']);
  });

  it('without inputFormats, day-first text and ISO are accepted (never month-first)', () => {
    const r = rules({ columns: [col('d', 'date')] });
    const res = runOk(r, table(['d'], [['5/3/2024'], ['05.03.2024'], ['2024-03-05']]));
    expect(values(res.sheet).map((x) => x[0])).toEqual([serial(2024, 3, 5), serial(2024, 3, 5), serial(2024, 3, 5)]);
  });
});

describe('text and boolean', () => {
  it('text keeps text; numbers are stringified plainly', () => {
    const r = rules({ columns: [col('t', 'text')] });
    const res = runOk(r, table(['t'], [['  as is '], [1234.5], [0.1 + 0.2], [1e21], [true]]));
    expect(values(res.sheet).map((x) => x[0])).toEqual(['  as is ', '1234.5', '0.3', '1000000000000000000000', true]);
  });

  it('boolean columns read TRUE/FALSE and 1/0, flag the rest', () => {
    const r = rules({ columns: [col('b', 'boolean')] });
    const res = runOk(r, table(['b'], [[true], ['false'], [1], ['כן']]));
    expect(values(res.sheet).map((x) => x[0])).toEqual([true, false, true, 'כן']);
    expect(res.flags.map((f) => f.messageKey)).toEqual(['flag.parseFailed.boolean']);
  });
});

describe('rows', () => {
  it('rows whose mapped cells are all empty are skipped and not counted', () => {
    const r = rules({ columns: [col('a'), col('b', 'decimal')] });
    const res = runOk(r, table(['a', 'b', 'other'], [['x', 1, null], [null, '  ', 'note'], ['y', 2, null]]));
    expect(values(res.sheet)).toEqual([['x', 1], ['y', 2]]);
    expect(dataRows(res.sheet).map((x) => x.sourceRow)).toEqual([2, 4]);
    expect(res.summary.rowsIn).toBe(2);
  });
});

describe('dates Excel cannot hold', () => {
  it('a text date before 1900 is kept as-is and flagged', () => {
    const r = rules({ columns: [col('d', 'date', { inputFormats: ['DD/MM/YYYY'] })] });
    const res = runOk(r, table(['d'], [['01/01/1850'], ['01/01/1900']]));
    expect(values(res.sheet)).toEqual([['01/01/1850'], [1]]);
    expect(res.flags.map((f) => [f.rowNumber, f.messageKey])).toEqual([[2, 'flag.parseFailed.date']]);
  });
});
