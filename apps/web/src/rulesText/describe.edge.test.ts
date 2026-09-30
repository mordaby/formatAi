import type { Expr } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { describeRules } from './describe';
import { col, lineTexts, num, rules, str, withColumn } from './fixtures';

const en = (r: ReturnType<typeof rules>) => describeRules(r, { lang: 'en' });
const columnLine = (r: ReturnType<typeof rules>, header: string) => en(r).sections[1]!.lines.find((l) => l.target.header === header)!;

describe('parts', () => {
  it('splits a sentence into text, names, values and the arrow', () => {
    const line = columnLine(
      withColumn('Price', { op: 'round', digits: 2, arg: { op: 'mul', args: [col('c_cost'), num(1.18)] } }),
      'Price',
    );
    expect(line.parts).toEqual([
      { kind: 'name', text: 'Price' },
      { kind: 'text', text: ' ' },
      { kind: 'arrow', text: '←' },
      { kind: 'text', text: ' ' },
      { kind: 'name', text: 'Cost' },
      { kind: 'text', text: ' × ' },
      { kind: 'value', text: '1.18' },
      { kind: 'text', text: ', rounded to 2 decimals' },
    ]);
    expect(line.text).toBe('Price ← Cost × 1.18, rounded to 2 decimals');
  });

  it('keeps quoted values whole, quotes included', () => {
    const line = columnLine(withColumn('Currency', str('ILS')), 'Currency');
    expect(line.parts.find((p) => p.kind === 'value')).toEqual({ kind: 'value', text: "'ILS'" });
  });

  it('puts a calculation with function calls in one formula part whose names are still names', () => {
    const expr: Expr = { op: 'round', digits: 2, arg: { op: 'lookup', table: 'rates', key: col('c_code'), return: 'rate', onMissing: 'flag' } };
    const line = columnLine(withColumn('Rate', { op: 'mul', args: [expr, col('c_cost')] }), 'Rate');
    const formula = line.parts.find((p) => p.kind === 'formula');
    expect(formula).toBeDefined();
    if (formula?.kind !== 'formula') return;
    expect(formula.text).toBe('round(lookup("rates", Code, "rate"), 2) × Cost');
    expect(formula.parts.filter((p) => p.kind === 'name').map((p) => p.text)).toEqual(['Code', 'Cost']);
    expect(formula.parts.filter((p) => p.kind === 'value').map((p) => p.text)).toEqual(['"rates"', '"rate"', '2']);
  });

  it('writes a header with an operator in it as one name', () => {
    const r = rules({
      input: { columns: [{ id: 'c_a', header: 'A * B', type: 'decimal' }, { id: 'c_b', header: 'Total - net', type: 'decimal' }] },
      transform: { computed: [{ id: 'p_x', type: 'decimal', expr: { op: 'call', fn: 'f', args: [col('c_a'), col('c_b')] } }] },
      output: { columns: [{ header: 'X', from: 'p_x' }] },
    });
    const formula = columnLine(r, 'X').parts.find((p) => p.kind === 'formula');
    expect(formula?.kind === 'formula' && formula.parts.filter((p) => p.kind === 'name').map((p) => p.text)).toEqual(['A * B', 'Total - net']);
  });
});

describe('odd rules', () => {
  it('writes a very small number in full', () => {
    const line = columnLine(withColumn('Tiny', { op: 'mul', args: [col('c_cost'), num(0.0000001)] }), 'Tiny');
    expect(line.text).toBe('Tiny ← Cost × 0.0000001');
  });

  it('does not loop on helper columns that refer to each other', () => {
    const r = rules({
      transform: {
        computed: [
          { id: 'p_a', type: 'decimal', expr: { op: 'add', args: [col('p_b'), num(1)] } },
          { id: 'p_b', type: 'decimal', expr: { op: 'add', args: [col('p_a'), num(1)] } },
          { id: 'p_c', type: 'decimal', expr: { op: 'mul', args: [col('p_a'), num(2)] } },
        ],
      },
      output: { columns: [{ header: 'C', from: 'p_c' }] },
    });
    expect(columnLine(r, 'C').text).toMatch(/^C ← /);
  });

  it('shows a column pointing at nothing as missing, and asks for input', () => {
    const r = rules({ output: { columns: [{ header: 'Ghost', from: 'x_gone' }] } });
    const line = columnLine(r, 'Ghost');
    expect(line.text).toBe("Ghost ← a column that isn't there");
    expect(line.status).toBe('needsInput');
    expect(line.statusReason).toBe("This column uses something that isn't in your input file.");
  });

  it('gives an empty header a name', () => {
    const r = rules({ output: { columns: [{ header: '', from: 'c_name' }] } });
    expect(en(r).sections[1]!.lines[0]!.text).toBe('(no name) ← Name');
  });

  it('writes what it can when an id has no better name', () => {
    const r = rules({ input: { rowFilters: [{ column: 'someUnknownId', op: 'isEmpty' }] } });
    expect(lineTexts(en(r)).find(([id]) => id === 'filter:0')![1]).toBe('Keep rows where Some unknown id is empty');
  });

  it('keeps an unsupported entry for a column that does not exist as a note', () => {
    const model = describeRules(rules({ unsupported: [{ outputColumn: 'Nope', reasonCode: 'pivot' }] }), { lang: 'en' });
    expect(model.notes).toHaveLength(1);
    expect(model.notes[0]).toMatchObject({ kind: 'unsupported', code: 'pivot', column: 'Nope' });
  });

  it('says what a hidden part number or count is when a calculation uses it', () => {
    const r = rules({
      transform: {
        expand: { mode: 'splitCell', column: 'c_tags', separator: ';', trim: false, partId: 'x_tag', indexId: 'x_i', countId: 'x_n', skipEmpty: false },
        computed: [{ id: 'p_share', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'div', args: [col('c_amount'), col('x_n')] } } }],
      },
      output: { columns: [{ header: 'Tag', from: 'x_tag' }, { header: 'Share', from: 'p_share' }] },
    });
    const model = en(r);
    const text = (id: string) => lineTexts(model).find(([i]) => i === id)![1];
    expect(text('col:Share')).toBe('Share ← Amount ÷ the number of parts, rounded to 2 decimals');
    expect(text('expand')).toBe("Split Tags at ';' into separate rows: each part goes in Tag");
  });

  it('handles a minimal rules object', () => {
    const model = en(rules());
    expect(model.sections.map((s) => s.lines.length)).toEqual([0, 1, 1, 0]);
  });

  it('does not change the rules it reads', () => {
    const r = rules({ input: { rowFilters: [{ column: 'c_status', op: 'ne', value: 'x' }] }, transform: { sort: [{ column: 'c_name', dir: 'desc' }] } });
    const before = JSON.stringify(r);
    en(r);
    describeRules(r, { lang: 'he' });
    expect(JSON.stringify(r)).toBe(before);
  });
});
