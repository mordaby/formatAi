import { describe, expect, it } from 'vitest';
import { formatYmd, serialToYmd } from '../../../src/values/dates';
import { padLeft } from '../../../src/values/text';
import { analyzeOk, best, date, dec, findRel, pick, rng, serial, xlsx, xround, type V } from './helpers';

const FIRST = ['Dana', 'Omer', 'Lior', 'Noa', 'Avi', 'Maya', 'Tal', 'Gil'];
const LAST = ['Levi', 'Cohen', 'Mizrahi', 'Peretz', 'Biton', 'Friedman'];
const STATUS = ['active', 'closed', 'pending'];
const STATUS_CODE: Record<string, string> = { active: 'A', closed: 'C', pending: 'P' };

const IN_HEADERS = ['ID', 'Code', 'First', 'Last', 'Status', 'Qty', 'Price', 'Start', 'Due', 'Ref'];
const OUT_HEADERS = [
  'Ref #', 'Name', 'STATUS', 'Status code', 'Prefix', 'Suffix', 'Middle', 'Total', 'With tax', 'Plus fee',
  'Diff', 'Ratio', 'Sum3', 'Start text', 'Due date', 'Price text', 'Source', 'Copy ID', 'External', 'Month',
];

interface Row {
  id: number;
  code: string;
  first: string;
  last: string;
  status: string;
  qty: number;
  price: number;
  start: number;
  due: string;
  dueSerial: number;
  ref: number;
}

function makeRows(n: number, seed = 11): Row[] {
  const r = rng(seed);
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const d = 1 + (i % 28);
    const m = 1 + (i % 12);
    rows.push({
      id: 100 + i,
      code: `${pick(r, ['AB', 'CD', 'EF'])}-${1000 + i * 7}-${pick(r, ['X', 'Y'])}`,
      first: pick(r, FIRST),
      last: pick(r, LAST),
      status: pick(r, STATUS),
      qty: 1 + Math.floor(r() * 20),
      price: xround(5 + r() * 4000, 2),
      start: serial(2024, m, d),
      due: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/2025`,
      dueSerial: serial(2025, m, d),
      ref: 40 + i * 37,
    });
  }
  return rows;
}

function renderPrice(p: number): string {
  const [i, f] = dec(p).toFixed(2).split('.') as [string, string];
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}

function pair(n: number) {
  const rows = makeRows(n);
  const input: V[][] = [IN_HEADERS];
  const output: V[][] = [OUT_HEADERS];
  const r = rng(99);
  for (const x of rows) {
    input.push([x.id, x.code, x.first, x.last, x.status, x.qty, x.price, { v: x.start, isDate: true, z: 'dd/mm/yyyy' }, x.due, x.ref]);
    output.push([
      padLeft(String(x.ref), 6, '0'),
      `${x.first} ${x.last}`,
      x.status.toUpperCase(),
      STATUS_CODE[x.status]!,
      x.code.slice(0, 2),
      x.code.slice(-1),
      x.code.substr(3, 4),
      dec(x.qty).times(x.price).toNumber(),
      dec(x.price).times(1.17).toDecimalPlaces(2, 4).toNumber(),
      dec(x.price).plus(2.5).toNumber(),
      dec(x.price).minus(x.qty).toNumber(),
      dec(x.price).div(x.qty).toDecimalPlaces(2, 4).toNumber(),
      dec(x.id).plus(x.qty).plus(x.price).toNumber(),
      formatYmd(serialToYmd(x.start), 'YYYY-MM-DD', 'en'),
      { v: x.dueSerial, isDate: true, z: 'dd/mm/yyyy' },
      renderPrice(x.price),
      'WEB',
      x.id,
      Math.floor(r() * 100000),
      formatYmd(serialToYmd(x.start), 'MMMM YYYY', 'en'),
    ]);
  }
  return { rows, input: xlsx(input), output: xlsx(output) };
}

describe('relations: one output column per relation type', () => {
  const { input, output } = pair(40);
  const a = analyzeOk(input, output);

  it('aligns every row by a key', () => {
    expect(a.alignment.method).toBe('key');
    expect(a.alignment.rows).toHaveLength(40);
    expect(a.alignment.unalignedOut).toEqual([]);
    expect(a.alignment.droppedIn).toEqual([]);
    expect(a.shape.kind).toBe('plain');
  });

  it('padLeft', () => {
    expect(best(a, 0)).toMatchObject({ rel: 'padLeft', in: [9], length: 6, char: '0', coverage: 1 });
  });

  it('concat of whole words with a separator', () => {
    expect(best(a, 1)).toMatchObject({ rel: 'concat', in: [2, 3], separator: ' ', coverage: 1 });
  });

  it('normalize (upper case)', () => {
    expect(best(a, 2)).toMatchObject({ rel: 'normalize', in: [4], case: 'upper', coverage: 1 });
  });

  it('valueMap with its pairs', () => {
    const r = best(a, 3);
    expect(r).toMatchObject({ rel: 'valueMap', in: [4], coverage: 1 });
    if (r.rel === 'valueMap') expect(r.pairs).toEqual([['active', 'A'], ['closed', 'C'], ['pending', 'P']]);
  });

  it('substr: prefix, suffix and fixed position', () => {
    expect(best(a, 4)).toMatchObject({ rel: 'substr', in: [1], from: 'start', length: 2, coverage: 1 });
    expect(best(a, 5)).toMatchObject({ rel: 'substr', in: [1], from: 'end', length: 1, coverage: 1 });
    expect(findRel(a, 6, 'substr')).toMatchObject({ in: [1], from: 4, length: 4, coverage: 1 });
    expect(findRel(a, 6, 'split')).toMatchObject({ in: [1], separator: '-', index: 2, coverage: 1 });
  });

  it('mul of two columns (exact, no rounding)', () => {
    const r = best(a, 7);
    expect(r).toMatchObject({ rel: 'mul', in: [5, 6], coverage: 1 });
    expect('round' in r && r.round).toBeFalsy();
  });

  it('mulConst with rounding', () => {
    expect(best(a, 8)).toMatchObject({ rel: 'mulConst', in: [6], const: 1.17, constText: '1.17', round: 2, coverage: 1 });
  });

  it('addConst', () => {
    const r = best(a, 9);
    expect(r).toMatchObject({ rel: 'addConst', in: [6], const: 2.5, coverage: 1 });
    expect('round' in r && r.round).toBeFalsy();
  });

  it('sub and div (with rounding)', () => {
    expect(best(a, 10)).toMatchObject({ rel: 'sub', in: [6, 5], coverage: 1 });
    expect(best(a, 11)).toMatchObject({ rel: 'div', in: [6, 5], round: 2, coverage: 1 });
  });

  it('sum of three columns', () => {
    expect(best(a, 12)).toMatchObject({ rel: 'sum', in: [0, 5, 6], coverage: 1 });
  });

  it('dateFormat: real date -> text, DD/MM text -> real date, date -> month name', () => {
    expect(best(a, 13)).toMatchObject({ rel: 'dateFormat', in: [7], from: 'date', to: 'YYYY-MM-DD', coverage: 1 });
    expect(best(a, 14)).toMatchObject({ rel: 'dateFormat', in: [8], from: 'DD/MM/YYYY', to: 'dd/mm/yyyy', coverage: 1 });
    expect(best(a, 19)).toMatchObject({ rel: 'dateFormat', in: [7], from: 'date', to: 'MMMM YYYY', coverage: 1 });
  });

  it('numberFormat', () => {
    expect(best(a, 15)).toMatchObject({ rel: 'numberFormat', in: [6], format: '#,##0.00', coverage: 1 });
  });

  it('constant and copy', () => {
    expect(best(a, 16)).toMatchObject({ rel: 'constant', in: [], value: 'WEB', coverage: 1 });
    expect(best(a, 17)).toMatchObject({ rel: 'copy', in: [0], coverage: 1 });
  });

  it('unknown: values that come from elsewhere', () => {
    expect(a.columns[18]!.unknown).toBe(true);
    expect(a.columns[18]!.relations).toEqual([]);
  });

  it('every relation carries total, matched and an empty failing list at coverage 1', () => {
    const r = best(a, 17);
    expect(r.total).toBe(40);
    expect(r.matched).toBe(40);
    expect(r.failing).toEqual([]);
    expect(r.failCount).toBe(0);
  });
});

describe('relations: coverage below 1', () => {
  it('reports coverage and the failing aligned rows (copy, mulConst)', () => {
    const rows = makeRows(40, 5);
    const input: V[][] = [['Key', 'Label', 'Amount']];
    const output: V[][] = [['Key', 'Label', 'Amount x2']];
    const bad = new Set([3, 17, 25, 38]);
    rows.forEach((x, i) => {
      input.push([x.id, x.first, x.price]);
      output.push([x.id, bad.has(i) ? 'Other' : x.first, bad.has(i) ? 1 : dec(x.price).times(2).toNumber()]);
    });
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(best(a, 1)).toMatchObject({ rel: 'copy', in: [1], coverage: 0.9, failing: [3, 17, 25, 38], failCount: 4 });
    expect(best(a, 2)).toMatchObject({ rel: 'mulConst', in: [2], const: 2, coverage: 0.9, failing: [3, 17, 25, 38] });
  });

  it('drops relations below minCoverage (column becomes unknown)', () => {
    const input: V[][] = [['K', 'V']];
    const output: V[][] = [['K', 'V']];
    for (let i = 0; i < 20; i++) {
      input.push([i + 1, `v${i}`]);
      output.push([i + 1, i % 3 === 0 ? `x${i}` : `v${i}`]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.columns[1]!.unknown).toBe(true);
    const lenient = analyzeOk(xlsx(input), xlsx(output), { minCoverage: 0.6 });
    expect(best(lenient, 1)).toMatchObject({ rel: 'copy', coverage: 13 / 20 });
  });
});

describe('relations: traps', () => {
  it('leading zeros lost in the input, restored by padLeft (and the profile says so)', () => {
    const input: V[][] = [['Account', 'Holder']];
    const output: V[][] = [['Account', 'Holder']];
    const ids = [1234567, 20458, 3000123, 44556677, 5012, 600789, 7070707, 81234, 912345, 1000001];
    ids.forEach((id, i) => {
      input.push([id, `holder ${i}`]);
      output.push([padLeft(String(id), 9, '0'), `holder ${i}`]);
    });
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(best(a, 0)).toMatchObject({ rel: 'padLeft', in: [0], length: 9, char: '0', coverage: 1 });
    expect(a.input.profile[0]).toMatchObject({ type: 'idLike', leadingZerosLost: true });
    expect(a.output.profile[0]).toMatchObject({ type: 'idLike' });
  });

  it('numbers stored as text in the input are copied as numbers', () => {
    const input: V[][] = [['Item', 'Amount']];
    const output: V[][] = [['Item', 'Amount']];
    const amounts = [1234.5, 99, 18000, 0.75, 250.25, 7, 3100.1, 42];
    amounts.forEach((v, i) => {
      input.push([`item-${i}`, renderPrice(v)]);
      output.push([`item-${i}`, v]);
    });
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(best(a, 1)).toMatchObject({ rel: 'copy', in: [1], coverage: 1 });
    expect(a.input.profile[1]).toMatchObject({ type: 'decimal', numbersAsText: true });
  });

  it('DD/MM text dates that read both ways: the output decides the order', () => {
    // Every day <= 12: DD/MM and MM/DD both parse; the output was built month-first.
    const input: V[][] = [['Ref', 'When']];
    const output: V[][] = [['Ref', 'When']];
    for (let i = 0; i < 10; i++) {
      const a = 1 + i;
      const b = 12 - i;
      input.push([`r${i}`, `${String(a).padStart(2, '0')}/${String(b).padStart(2, '0')}/2024`]);
      output.push([`r${i}`, `2024-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.input.profile[1]).toMatchObject({ type: 'date', dateFormat: 'DD/MM/YYYY', dayMonthAmbiguous: true });
    expect(best(a, 1)).toMatchObject({ rel: 'dateFormat', in: [1], from: 'MM/DD/YYYY', to: 'YYYY-MM-DD', coverage: 1 });
  });

  it('Excel serial numbers become dates (serialDates)', () => {
    const input: V[][] = [['Doc', 'Posted']];
    const output: V[][] = [['Doc', 'Posted']];
    for (let i = 0; i < 8; i++) {
      const s = serial(2024, 1 + i, 3 + i);
      input.push([`d${i}`, s]);
      output.push([`d${i}`, date(2024, 1 + i, 3 + i)]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(best(a, 1)).toMatchObject({ rel: 'dateFormat', from: 'excelSerial', to: 'dd/mm/yyyy', coverage: 1 });
    expect(a.input.profile[1]).toMatchObject({ type: 'date', serialDates: true });
  });
});

describe('value maps need repeated keys (no memorizing)', () => {
  // An output column filled by another system (e.g. a warehouse assigned per order): its values
  // line up with an almost-unique input column only by coincidence. Must stay unknown.
  it('does not explain an externally-filled column with a near-unique key column', () => {
    const header = ['Order', 'Requested', 'Qty'];
    const outHeader = ['Order', 'Qty', 'Warehouse'];
    const inRows: V[][] = [header];
    const outRows: V[][] = [outHeader];
    for (let i = 0; i < 20; i++) {
      const requested = `2026-03-${String((i % 19) + 1).padStart(2, '0')}`; // 19 distinct of 20
      inRows.push([`PO-${1000 + i}`, requested, 5 + (i % 4)]);
      outRows.push([`PO-${1000 + i}`, 5 + (i % 4), ['WH-A', 'WH-B', 'WH-C'][(i * 7) % 3]!]);
    }
    const a = analyzeOk(xlsx(inRows), xlsx(outRows));
    expect(findRel(a, 2, 'valueMap')).toBeUndefined();
    expect(a.columns[2]?.unknown).toBe(true);
  });

  // Found by the engine stress test (eval/STRESS.md): a "High"/"Low" band on an amount, "Low" on almost every row. Supplier names
  // repeat, so the names "map" onto the band - but only "Low" is ever confirmed by a repeat; the two "High" rows are two names seen
  // once. Next month a known name with a high amount would be written "Low" with no flag.
  it('the repeats confirm at least two of the values written: "mostly one value" plus memorized exceptions is not a map', () => {
    const names = ['North', 'South', 'East', 'West', 'Centre'];
    const inRows: V[][] = [['Ref', 'Supplier', 'Amount']];
    const outRows: V[][] = [['Ref', 'Band']];
    for (let i = 0; i < 20; i++) {
      const high = i === 6 || i === 13;
      inRows.push([`R${100 + i}`, high ? `Rare ${i}` : names[i % names.length]!, high ? 9000 + i : 100 + i * 37]);
      outRows.push([`R${100 + i}`, high ? 'High' : 'Low']);
    }
    const a = analyzeOk(xlsx(inRows), xlsx(outRows));
    expect(findRel(a, 1, 'valueMap')).toBeUndefined();

    // The same names with the band confirmed on both sides: a map.
    const inOk: V[][] = [['Ref', 'Supplier']];
    const outOk: V[][] = [['Ref', 'Band']];
    for (let i = 0; i < 20; i++) {
      inOk.push([`R${100 + i}`, names[i % names.length]!]);
      outOk.push([`R${100 + i}`, i % names.length === 2 ? 'High' : 'Low']);
    }
    expect(findRel(analyzeOk(xlsx(inOk), xlsx(outOk)), 1, 'valueMap')).toMatchObject({ coverage: 1 });
  });
});
