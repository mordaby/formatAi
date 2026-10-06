// Header check on a csv/txt example output (SPEC 8.13 "whether the first row is a
// header", SPEC 6.2). An all-text file has no type evidence either way, so pair
// analysis decides from the pair: row 0 is the header when it is NOT explained as a
// data row while the rows below it are (>= 90%); a row explained like the others is
// data. Synthetic, domain-neutral data.
import { describe, expect, it } from 'vitest';
import { detectFileSpecWithConfidence } from '../../../src/io/detectFileSpec';
import { analyzePair } from '../../../src/learn/analyze';
import { decideHeader, explainedRate, firstRowExplained } from '../../../src/learn/analyze/headerCheck';
import { preflight } from '../../../src/learn/preflight';
import { analyzeOk, delimited, xlsx, type V } from './helpers';

/** A letters-only word (no digits anywhere, so nothing types as a number or a code). */
function word(i: number, len = 5): string {
  let s = '';
  let n = i * 7 + 3;
  for (let k = 0; k < len; k++) {
    s += String.fromCharCode(97 + (n % 26));
    n = Math.floor(n / 26) + k + 1;
  }
  return s;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Contact list: input First/Last/Email/City, output (renamed) Full name/Email address/Town. All text, no digits. */
function contacts(n: number): { input: V[][]; output: string[][] } {
  const input: V[][] = [['First', 'Last', 'Email', 'City']];
  const output: string[][] = [['Full name', 'Email address', 'Town']];
  for (let i = 0; i < n; i++) {
    const first = cap(word(i, 4));
    const last = cap(word(i + 1000, 6));
    const email = `${word(i + 2000, 5)}@example.com`;
    const city = cap(word(i + 3000, 5));
    input.push([first, last, email, city]);
    output.push([`${first} ${last}`, email, city]);
  }
  return { input, output };
}

describe('detectFileSpecWithConfidence', () => {
  it('an all-text csv has no type evidence: ambiguous, defaulting to header: true', () => {
    const { output } = contacts(20);
    const d = detectFileSpecWithConfidence(delimited(output, 'csv'));
    expect(d.headerConfidence).toBe('ambiguous');
    expect(d.spec.header).toBe(true);
  });

  it('a typed column below the first row is evidence for a header', () => {
    const d = detectFileSpecWithConfidence(delimited([['Name', 'Amount'], ['dana', 10], ['omer', 20], ['noa', 30]], 'csv'));
    expect(d).toMatchObject({ headerConfidence: 'evidence', spec: { header: true } });
  });

  it('a number in the first row reads as data: evidence for header: false', () => {
    const d = detectFileSpecWithConfidence(delimited([['1001', 'dana'], ['1002', 'omer'], ['1003', 'noa']], 'txt'));
    expect(d).toMatchObject({ headerConfidence: 'evidence', spec: { header: false } });
  });

  it('xlsx has no header notion', () => {
    expect(detectFileSpecWithConfidence(xlsx([['a']]))).toEqual({ spec: { type: 'xlsx' }, headerConfidence: 'evidence' });
  });
});

describe('header check: an all-text csv with renamed headers', () => {
  it('reads row 0 as the header, counts data rows only, and aligns every row', () => {
    const { input, output } = contacts(300);
    const out = delimited(output, 'csv');
    const a = analyzeOk(xlsx(input), out);
    expect(a.output.file).toMatchObject({ type: 'csv', header: true });
    expect(a.output.headerless).toBe(false);
    expect(a.output.headerRow).toBe(0);
    expect(a.output.headers).toEqual(['Full name', 'Email address', 'Town']);
    expect(a.output.dataRows).toHaveLength(300);
    expect(a.alignment.rows).toHaveLength(300);
    expect(a.alignment.unalignedOut).toEqual([]);
    expect(a.columns.every((c) => !c.unknown)).toBe(true);
    expect(a.output.rowKinds.filter((k) => k === 'header')).toHaveLength(1);
    expect(a.output.rowKinds[0]).toBe('header');
    // The header is not a record: no "rows not aligned" warning.
    expect(preflight(a, 'registered')).toEqual({ status: 'ok', issues: [], skipColumns: [] });
  });

  it('a 300-row all-text pair is not blocked by the free tier (rows are data rows only)', () => {
    const { input, output } = contacts(300);
    const a = analyzeOk(xlsx(input), delimited(output, 'csv'));
    const pf = preflight(a, 'anonymous');
    expect(pf.issues.some((i) => i.code === 'overTierLimits')).toBe(false);
    expect(pf.status).toBe('ok');
  });

  it('301 data rows still exceed the free tier, and the report says 301 (not 302)', () => {
    const { input, output } = contacts(301);
    const a = analyzeOk(xlsx(input), delimited(output, 'csv'));
    expect(a.output.dataRows).toHaveLength(301);
    const pf = preflight(a, 'anonymous');
    expect(pf.status).toBe('block');
    expect(pf.issues).toContainEqual({ code: 'overTierLimits', severity: 'block', params: { dimension: 'rows', value: 301, limit: 300 } });
  });

  it('when the rows below the header line up only by position (no key), row 0 is still the header', () => {
    // Every output column is derived (padded code, mapped status): no column equals an input column,
    // so rows align by position, and row 0 (the header) has no input row to align with.
    const input: V[][] = [['Code', 'Status']];
    const output: string[][] = [['Ref', 'State']];
    const statuses = ['open', 'done', 'void'];
    const states = ['Live', 'Closed', 'Cancelled'];
    for (let i = 0; i < 40; i++) {
      const code = word(i, 5);
      const k = (i * 5) % 3;
      input.push([code, statuses[k]!]);
      output.push([`xxx${code}`, states[k]!]);
    }
    const a = analyzeOk(xlsx(input), delimited(output, 'csv'));
    expect(a.output.file.header).toBe(true);
    expect(a.output.dataRows).toHaveLength(40);
    expect(a.alignment.method).toBe('position');
    expect(a.alignment.unalignedOut).toEqual([]);
    expect(a.columns.filter((c) => c.unknown)).toEqual([]);
  });

  it('an explicit output.file spec is never second-guessed', () => {
    // The caller says the file has no header row: row 0 is data, whatever the pair suggests.
    const { input, output } = contacts(30);
    const a = analyzeOk(xlsx(input), delimited(output, 'csv'), { outputFileSpec: { type: 'csv', delimiter: ',', header: false } });
    expect(a.output.headerless).toBe(true);
    expect(a.output.dataRows).toHaveLength(31);
  });

  it('a first row that repeats the input headers stays a header (no pair check needed)', () => {
    const input: V[][] = [['name', 'city']];
    const output: string[][] = [['name', 'city']];
    for (let i = 0; i < 12; i++) {
      input.push([word(i, 5), word(i + 40, 6)]);
      output.push([word(i, 5), word(i + 40, 6)]);
    }
    const a = analyzeOk(xlsx(input), delimited(output, 'csv'));
    expect(a.output.file.header).toBe(true);
    expect(a.output.dataRows).toHaveLength(12);
  });
});

describe('header check: headerless outputs stay headerless', () => {
  it('a tab-delimited txt load file with numeric columns is headerless (types say so; row 0 is explained)', () => {
    const input: V[][] = [['Item', 'Name', 'Price']];
    const lines: string[][] = [];
    for (let i = 0; i < 25; i++) {
      const item = 800000 + i * 137;
      const price = 10 + i * 3.5;
      input.push([String(item), cap(word(i, 5)), price]);
      lines.push([String(item), cap(word(i, 5)), price.toFixed(2)]);
    }
    const out = delimited(lines, 'txt');
    expect(detectFileSpecWithConfidence(out)).toMatchObject({ headerConfidence: 'evidence', spec: { header: false } });
    const a = analyzeOk(xlsx(input), out);
    expect(a.output.file).toMatchObject({ type: 'txt', delimiter: '\t', header: false });
    expect(a.output.headerless).toBe(true);
    expect(a.output.dataRows).toHaveLength(25);
    expect(a.alignment.unalignedOut).toEqual([]);
    expect(firstRowExplained(a)).toBe(true);
  });

  it('an all-text headerless txt whose first row is real data: header false, decided by the pair', () => {
    // Renamed by position only (no header row); every value is text, so types say nothing.
    const input: V[][] = [['Code', 'Name', 'City']];
    const lines: string[][] = [];
    for (let i = 0; i < 30; i++) {
      const code = word(i, 5);
      const name = cap(word(i + 200, 6));
      const city = cap(word(i + 400, 5));
      input.push([code, name, city]);
      lines.push([city, code, name.toUpperCase()]);
    }
    const out = delimited(lines, 'txt');
    expect(detectFileSpecWithConfidence(out)).toMatchObject({ headerConfidence: 'ambiguous', spec: { header: true } });
    const a = analyzeOk(xlsx(input), out);
    expect(a.output.file).toMatchObject({ type: 'txt', header: false });
    expect(a.output.headerless).toBe(true);
    expect(a.output.headerRow).toBe(-1);
    expect(a.output.dataRows).toHaveLength(30);
    expect(a.alignment.rows).toHaveLength(30);
    expect(a.alignment.unalignedOut).toEqual([]);
    expect(a.columns.filter((c) => c.unknown)).toEqual([]);
    expect(firstRowExplained(a)).toBe(true);
  });

  it('an all-text headerless txt aligned by position only (no key) is headerless too', () => {
    const input: V[][] = [['Code', 'Status']];
    const lines: string[][] = [];
    const statuses = ['open', 'done', 'void'];
    const states = ['Live', 'Closed', 'Cancelled'];
    for (let i = 0; i < 30; i++) {
      const k = (i * 5) % 3;
      input.push([word(i, 5), statuses[k]!]);
      lines.push([`xxx${word(i, 5)}`, states[k]!]);
    }
    const a = analyzeOk(xlsx(input), delimited(lines, 'txt'));
    expect(a.output.headerless).toBe(true);
    expect(a.output.dataRows).toHaveLength(30);
    expect(a.alignment.method).toBe('position');
    expect(a.columns.filter((c) => c.unknown)).toEqual([]);
  });

  it('reports progress once, ending at done, even when a second reading is tested', () => {
    const { input, output } = contacts(40);
    const stages: string[] = [];
    let last = -1;
    const r = analyzePair(xlsx(input), delimited(output, 'csv'), {
      onProgress: (p) => {
        stages.push(p.stage);
        expect(p.fraction).toBeGreaterThanOrEqual(last);
        last = p.fraction;
      },
    });
    expect(r.ok).toBe(true);
    expect(stages[0]).toBe('tables');
    expect(stages.filter((s) => s === 'done')).toHaveLength(1);
    expect(stages[stages.length - 1]).toBe('done');
  });
});

describe('decideHeader', () => {
  it('keeps the default (unknown) when nothing is traced in either reading', () => {
    const input: V[][] = [['A', 'B']];
    for (let i = 0; i < 6; i++) input.push([word(i), word(i + 9)]);
    const output: string[][] = [['C', 'D']];
    for (let i = 0; i < 6; i++) output.push([word(i + 100), word(i + 200)]);
    const asHeader = analyzeOk(xlsx(input), delimited(output, 'csv'), { outputFileSpec: { type: 'csv', delimiter: ',', header: true } });
    const asData = analyzeOk(xlsx(input), delimited(output, 'csv'), { outputFileSpec: { type: 'csv', delimiter: ',', header: false } });
    expect(explainedRate(asHeader)).toBe(0);
    expect(decideHeader(asHeader, asData)).toBe('unknown');
    expect(decideHeader(null, null)).toBe('unknown');
  });
});

// Found by the engine stress test (eval/STRESS.md): a headerless csv whose first row has one empty cell ("0000" | "") is no header row,
// so the header reading took the SECOND row as the header and the first as a title. The pair check tested row 0 - the title, unexplained
// (its key is empty) - and kept that reading: the rules then wrote a fixed title and a fixed "header" made of one data row every month.
// It is the header reading's header row that must not be explained as data.
describe('decideHeader: a header reading with a title row above its header', () => {
  it('the row taken as the header is a data row: headerless', () => {
    const input: V[][] = [['Name', 'Dept']];
    const lines: string[][] = [];
    for (let i = 0; i < 20; i++) {
      const name = i === 0 ? '' : `${cap(word(i, 4))} ${cap(word(i + 500, 6))}`;
      input.push([name, ['ops', 'hr', 'it'][i % 3]!]);
      lines.push(['0000', name.toUpperCase()]);
    }
    const out = delimited(lines, 'csv');
    const asHeader = analyzeOk(xlsx(input), out, { outputFileSpec: { type: 'csv', delimiter: ',', header: true } });
    expect(asHeader.output.headerRow).toBe(1); // the setup: row 0 is no header row, so row 1 is taken, row 0 a title
    const asData = analyzeOk(xlsx(input), out, { outputFileSpec: { type: 'csv', delimiter: ',', header: false } });
    expect(firstRowExplained(asData)).toBe(false); // row 0's key is empty: not aligned
    expect(decideHeader(asHeader, asData)).toBe('data');
    const a = analyzeOk(xlsx(input), out);
    expect(a.output.headerless).toBe(true);
    expect(a.layout.titleRows).toEqual([]);
  });
});
