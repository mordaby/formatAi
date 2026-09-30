import { describe, expect, it } from 'vitest';
import { analyzeOk, bold, date, dec, num, rng, xlsx, type V } from './helpers';

describe('layout: title rows', () => {
  it('a title with the month of an input date column (English)', () => {
    const input: V[][] = [['Ticket', 'Opened', 'Hours']];
    const output: V[][] = [[bold('Monthly summary September 2024')], [], [bold('Ticket'), bold('Opened'), bold('Hours')]];
    for (let i = 0; i < 10; i++) {
      input.push([`T${i}`, date(2024, 9, 1 + i * 2), i + 1]);
      output.push([`T${i}`, date(2024, 9, 1 + i * 2), i + 1]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.output.headerRow).toBe(2);
    expect(a.layout.headerRow).toBe(2);
    expect(a.layout.headerBold).toBe(true);
    expect(a.layout.titleRows).toEqual([
      {
        row: 0,
        text: 'Monthly summary September 2024',
        bold: true,
        containsDate: { in: 1, agg: 'min', format: 'MMMM YYYY' },
        parts: [{ text: 'Monthly summary ' }, { in: 1, agg: 'min', format: 'MMMM YYYY', language: 'en' }],
      },
      { row: 1, blank: true },
    ]);
    expect(a.layout.language).toBe('en');
    expect(a.layout.direction).toBe('ltr');
  });

  it('a Hebrew title with a date range from a text date column, RTL', () => {
    const input: V[][] = [['מספר', 'תאריך', 'סכום']];
    const output: V[][] = [['דוח תנועות 01/03/2024 - 28/03/2024'], ['מספר', 'תאריך', 'סכום']];
    for (let i = 0; i < 10; i++) {
      const d = `${String(1 + i * 3).padStart(2, '0')}/03/2024`;
      input.push([`${1000 + i}`, d, 5 * i]);
      output.push([`${1000 + i}`, d, 5 * i]);
    }
    const a = analyzeOk(xlsx(input, { rtl: true }), xlsx(output, { rtl: true }));
    const t = a.layout.titleRows[0]!;
    expect(t.containsDate).toEqual({ in: 1, agg: 'min', format: 'DD/MM/YYYY' });
    expect(t.parts).toEqual([
      { text: 'דוח תנועות ' },
      { in: 1, agg: 'min', format: 'DD/MM/YYYY', language: 'he' },
      { text: ' - ' },
      { in: 1, agg: 'max', format: 'DD/MM/YYYY', language: 'he' },
    ]);
    expect(a.layout.direction).toBe('rtl');
    expect(a.layout.language).toBe('he');
  });
});

interface Member {
  team: string;
  name: string;
  hours: number;
  rate: number;
}

function teams(): Member[] {
  const r = rng(31);
  const out: Member[] = [];
  const sizes: [string, number][] = [['blue', 3], ['green', 1], ['red', 4], ['gold', 2]];
  for (const [team, n] of sizes) {
    for (let i = 0; i < n; i++) out.push({ team, name: `${team}-${i}`, hours: 1 + Math.floor(r() * 40), rate: 12 + Math.floor(r() * 20) * 5 });
  }
  return out;
}

describe('layout: groups, blank rows and summary rows', () => {
  it('summary rows after each group (sum, average, count, max) and at the end (sum, min, count, average), one blank row after each group', () => {
    const ms = teams();
    const input: V[][] = [['Team', 'Member', 'Hours', 'Rate']];
    for (const m of ms) input.push([m.team, m.name, m.hours, m.rate]);
    const output: V[][] = [[bold('Team'), bold('Member'), bold('Hours'), bold('Rate'), bold('Pay')]];
    const byTeam = new Map<string, Member[]>();
    for (const m of ms) byTeam.set(m.team, [...(byTeam.get(m.team) ?? []), m]);
    const pay = (m: Member): number => m.hours * m.rate;
    for (const [, g] of byTeam) {
      for (const m of g) output.push([m.team, m.name, m.hours, m.rate, pay(m)]);
      const avgRate = g.reduce((s, m) => s.plus(m.rate), dec(0)).div(g.length).toNumber();
      output.push(['Subtotal', null, g.reduce((s, m) => s + m.hours, 0), avgRate, g.reduce((s, m) => s + pay(m), 0)]);
      output.push(['Members', null, g.length, null, Math.max(...g.map(pay))]);
      output.push([]);
    }
    const allAvg = ms.reduce((s, m) => s.plus(m.hours), dec(0)).div(ms.length).toDecimalPlaces(2, 4).toNumber();
    output.push(['Grand total', null, ms.reduce((s, m) => s + m.hours, 0), Math.min(...ms.map((m) => m.rate)), ms.reduce((s, m) => s + pay(m), 0)]);
    output.push(['Average hours', null, allAvg, null, null]);
    const a = analyzeOk(xlsx(input), xlsx(output));

    const kinds = a.output.rowKinds;
    expect(kinds.filter((k) => k === 'summaryGroup')).toHaveLength(8);
    expect(kinds.filter((k) => k === 'summaryEnd')).toHaveLength(2);
    expect(a.output.dataRows).toHaveLength(ms.length);
    expect(a.alignment.rows).toHaveLength(ms.length);

    const g = a.layout.groupBy!;
    expect(g.out).toBe(0);
    expect(g.blankRowsAfter).toBe(1);
    expect(g.summaryRows).toHaveLength(2);
    expect(g.summaryRows![0]).toMatchObject({
      label: 'Subtotal',
      labelOut: 0,
      cells: [
        { out: 2, agg: 'sum' },
        { out: 3, agg: 'average' },
        { out: 4, agg: 'sum' },
      ],
      unexplained: [],
    });
    expect(g.summaryRows![1]).toMatchObject({
      label: 'Members',
      labelOut: 0,
      cells: [
        { out: 2, agg: 'count' },
        { out: 4, agg: 'max' },
      ],
    });
    expect(a.layout.summaryRows).toHaveLength(2);
    expect(a.layout.summaryRows[0]).toMatchObject({
      label: 'Grand total',
      cells: [
        { out: 2, agg: 'sum' },
        { out: 3, agg: 'min' },
        { out: 4, agg: 'sum' },
      ],
    });
    expect(a.layout.summaryRows[1]).toMatchObject({ label: 'Average hours', cells: [{ out: 2, agg: 'average' }] });
    expect(a.layout.blankRowsBeforeSummary).toBe(1);
    expect(a.layout.unexplainedBlankRows).toEqual([]);
    expect(a.layout.headerBold).toBe(true);
    // The relation of the pay column is found on the data rows only.
    expect(a.columns[4]!.relations[0]).toMatchObject({ rel: 'mul', in: [2, 3], coverage: 1 });
  });

  it('a numeric group code that collides with a distinct id column after zero-stripping still aligns as a plain report (regression)', () => {
    // The group code ("01".."04") and the id column ("00001".."00020") both
    // normalize to plain small integers once leading zeros are stripped
    // (SPEC 6.2 step 2: "match one-to-one after normalization"), so codes
    // 1-4 coincidentally also identify the first few ids. Picking the group
    // column as the alignment key by mistake maps every detail row of a
    // group onto that one coincidental id row, which then looks like an
    // ill-formed family: row expansion, which SPEC 6.3 blocks as unsupported.
    const groups = ['01', '02', '03', '04'];
    interface Member {
      group: string;
      id: number;
      name: string;
      value: number;
      dateCell: V;
    }
    const members: Member[] = [];
    const r = rng(17);
    let id = 1;
    let day = 0;
    for (const g of groups) {
      for (let i = 0; i < 5; i++) {
        // A random value (not an arithmetic progression): an increasing
        // 100, 200, 300... would let a later row's own value coincide with
        // the running sum of the rows above it, a false summary row.
        const value = (5 + Math.floor(r() * 95)) * 10;
        members.push({ group: g, id: id++, name: `פריט ${i % 3}`, value, dateCell: date(2024, 3, 1 + day++) });
      }
    }
    const input: V[][] = [['קבוצה', 'מזהה', 'שם', 'תאריך', 'ערך']];
    for (const m of members) input.push([m.group, String(m.id).padStart(5, '0'), m.name, m.dateCell, m.value]);

    const output: V[][] = [
      ['דוח קבוצות - מרץ 2024', null, null, null, null, null],
      [],
      ['קבוצה', 'מזהה', 'שם', 'תאריך', 'ערך', 'ניקוד'],
    ];
    for (const g of groups) {
      const rows = members.filter((m) => m.group === g);
      for (const m of rows) output.push([m.group, String(m.id).padStart(5, '0'), m.name, m.dateCell, m.value, m.value / 10]);
      const sum = rows.reduce((s, m) => s + m.value, 0);
      const avgScore = rows.reduce((s, m) => s + m.value / 10, 0) / rows.length;
      output.push([null, rows.length, null, null, sum, avgScore]);
      output.push([]);
    }
    const totalValue = members.reduce((s, m) => s + m.value, 0);
    const totalScore = members.reduce((s, m) => s + m.value / 10, 0);
    output.push(['סה"כ', null, null, null, totalValue, totalScore]);

    const a = analyzeOk(xlsx(input, { rtl: true }), xlsx(output, { rtl: true }));

    // The real key is the id column (out 1 / in 1); the coincidentally
    // matching group column (out 0) must lose the tie.
    expect(a.alignment.method).toBe('key');
    expect(a.alignment.key).toMatchObject({ in: [1], out: [1], matchRate: 1, uniqueness: 1 });
    expect(a.output.dataRows).toHaveLength(members.length);
    expect(a.alignment.rows).toHaveLength(members.length);
    expect(a.shape).toEqual({ kind: 'plain' });
    expect(a.columns.some((c) => c.unknown)).toBe(false);

    expect(a.layout.titleRows[0]).toMatchObject({ containsDate: { in: 3, agg: 'min', format: 'MMMM YYYY' } });

    const g = a.layout.groupBy!;
    expect(g.out).toBe(0);
    expect(g.blankRowsAfter).toBe(1);
    expect(g.summaryRows).toHaveLength(1);
    expect(g.summaryRows![0]).toMatchObject({
      cells: [
        { out: 1, agg: 'count' },
        { out: 4, agg: 'sum' },
        { out: 5, agg: 'average' },
      ],
      unexplained: [],
    });
    expect(a.layout.summaryRows).toHaveLength(1);
    expect(a.layout.summaryRows[0]).toMatchObject({
      label: 'סה"כ',
      labelOut: 0,
      cells: [
        { out: 4, agg: 'sum' },
        { out: 5, agg: 'sum' },
      ],
    });
    expect(a.layout.unexplainedBlankRows).toEqual([]);
  });

  it('a blank row after each change of a column, no summary rows', () => {
    const ms = teams();
    const input: V[][] = [['Team', 'Member', 'Hours']];
    const output: V[][] = [['Team', 'Member', 'Hours']];
    let prev = '';
    for (const m of ms) {
      input.push([m.team, m.name, m.hours]);
      if (prev !== '' && prev !== m.team) output.push([]);
      output.push([m.team, m.name, m.hours]);
      prev = m.team;
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.layout.groupBy).toEqual({ out: 0, blankRowsAfter: 1 });
    expect(a.layout.summaryRows).toEqual([]);
    expect(a.layout.unexplainedBlankRows).toEqual([]);
  });
});

describe('layout: sort order, formats, direction', () => {
  it('detects a sort on one column (desc) and keeps number formats and widths', () => {
    const r = rng(40);
    const input: V[][] = [['Batch', 'Yield', 'Grade']];
    const rows: [string, number, string][] = [];
    for (let i = 0; i < 15; i++) rows.push([`B${i}`, Math.round(r() * 1000) / 10, ['x', 'y'][i % 2]!]);
    for (const x of rows) input.push(x);
    const sorted = [...rows].sort((p, q) => q[1] - p[1]);
    const output: V[][] = [['Batch', 'Yield', 'Grade']];
    for (const x of sorted) output.push([x[0], num(x[1], '0.0'), x[2]]);
    const a = analyzeOk(xlsx(input), xlsx(output, { widths: [12, 9, undefined] }));
    expect(a.layout.orderMatchesInput).toBe(false);
    expect(a.layout.sort).toEqual([{ out: 1, dir: 'desc' }]);
    expect(a.layout.columnFormats).toEqual([undefined, '0.0', undefined]);
    expect(a.layout.columnWidths).toEqual([12, 9, undefined]);
    expect(a.output.profile[1]).toMatchObject({ format: '0.0', width: 9 });
  });

  it('detects a two-key sort (text asc, then number desc)', () => {
    const ms = teams();
    const input: V[][] = [['Team', 'Member', 'Hours']];
    for (const m of ms) input.push([m.team, m.name, m.hours]);
    const sorted = [...ms].sort((p, q) => (p.team < q.team ? -1 : p.team > q.team ? 1 : q.hours - p.hours));
    const output: V[][] = [['Team', 'Member', 'Hours']];
    for (const m of sorted) output.push([m.team, m.name, m.hours]);
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.layout.sort).toEqual([
      { out: 0, dir: 'asc' },
      { out: 2, dir: 'desc' },
    ]);
  });

  it('no sort when the output keeps the input order', () => {
    const input: V[][] = [['K', 'V']];
    for (let i = 0; i < 6; i++) input.push([`k${i}`, 6 - i]);
    const a = analyzeOk(xlsx(input), xlsx(input.map((r) => [...r])));
    expect(a.layout.sort).toBeNull();
    expect(a.layout.orderMatchesInput).toBe(true);
  });

  it('English LTR and Hebrew RTL sheets', () => {
    const en: V[][] = [['Name', 'Count']];
    const he: V[][] = [['שם', 'כמות']];
    for (let i = 0; i < 5; i++) {
      en.push([`n${i}`, i]);
      he.push([`שם ${i}`, i]);
    }
    const a = analyzeOk(xlsx(en), xlsx(en.map((r) => [...r]), { name: 'Report' }));
    expect(a.layout).toMatchObject({ direction: 'ltr', language: 'en', sheetName: 'Report' });
    const b = analyzeOk(xlsx(he, { rtl: true }), xlsx(he.map((r) => [...r]), { rtl: true, name: 'דוח' }));
    expect(b.layout).toMatchObject({ direction: 'rtl', language: 'he', sheetName: 'דוח' });
    expect(b.input.direction).toBe('rtl');
    // Without the sheet flag (csv), direction comes from the headers' script.
    const c = analyzeOk(xlsx(he), xlsx(he.map((r) => [...r])));
    expect(c.layout.direction).toBe('rtl');
  });
});
