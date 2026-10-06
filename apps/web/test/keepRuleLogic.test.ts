// "Do this every time?" (SPEC 5 C, 8.4a): the pure parts - what a typed fix of one cell offers, which fixes the user said yes to, what leaves the
// per-run decisions once they are rules, and the rules with them added.
import { limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { fixesWithout, fixIdentifiers, readAsFixes, readAsOffer, toRowDecisions, typedReading, withoutSaved, withReadAs, type Choices } from '../src/pages/Convert/logic';
import { RULES } from './helpers/convertKit';

const text = (columnId: string, header: string, value: string) => ({ columnId, header, value, isText: true as const });
const rowInputs = {
  3: [text('c_code', 'Item Code', '00003'), text('c_qty', 'Qty', 'N/A'), text('c_price', 'Price', '1')],
  4: [text('c_code', 'Item Code', '00004'), text('c_qty', 'Qty', 'N/A'), text('c_price', 'Price', '2')],
  5: [text('c_code', 'Item Code', '00005'), text('c_qty', 'Qty', 'n/a'), { columnId: 'c_price', header: 'Price', value: 7 }],
  6: [text('c_code', 'Item Code', '00006'), text('c_qty', 'Qty', '4')],
};
const qty3 = rowInputs[3][1]!;

describe('typedReading', () => {
  it('nothing typed (or only spaces) is "read as empty"; anything else is as typed', () => {
    expect(typedReading('')).toBe('');
    expect(typedReading('   ')).toBe('');
    expect(typedReading(' 12 ')).toBe(' 12 ');
  });
});

describe('readAsOffer', () => {
  it('a changed text cell offers its exact text and what it becomes, and counts the rows of the review that have that exact text', () => {
    expect(readAsOffer(RULES, qty3, '', rowInputs, [])).toEqual({ columnId: 'c_qty', header: 'Qty', from: 'N/A', to: '', rows: 2, clash: false });
    expect(readAsOffer(RULES, qty3, '0', rowInputs, [])).toMatchObject({ to: '0', rows: 2 });
    // exact text: "n/a" is another text
    expect(readAsOffer(RULES, rowInputs[5][1]!, '', rowInputs, [])).toMatchObject({ from: 'n/a', rows: 1 });
  });

  it('nothing for a cell that is not text, an empty one, an unchanged value, an unknown column, or a column that already reads it', () => {
    expect(readAsOffer(RULES, rowInputs[5][2]!, '8', rowInputs, [])).toBeNull(); // a number
    expect(readAsOffer(RULES, { columnId: 'c_qty', header: 'Qty', value: null }, '1', rowInputs, [])).toBeNull(); // empty
    expect(readAsOffer(RULES, { columnId: 'c_qty', header: 'Qty', value: '', isText: true }, '1', rowInputs, [])).toBeNull();
    expect(readAsOffer(RULES, qty3, 'N/A', rowInputs, [])).toBeNull(); // the same text
    expect(readAsOffer(RULES, { ...qty3, columnId: 'nope' }, '1', rowInputs, [])).toBeNull();
    const known = { ...RULES, input: { ...RULES.input, columns: RULES.input.columns.map((c) => (c.id === 'c_qty' ? { ...c, readAs: { 'N/A': '' } } : c)) } };
    expect(readAsOffer(known, qty3, '0', rowInputs, [])).toBeNull();
    const many = Object.fromEntries(Array.from({ length: limits.rules.maxReadAsPerColumn }, (_, i) => [`t${i}`, '']));
    const full = { ...RULES, input: { ...RULES.input, columns: RULES.input.columns.map((c) => (c.id === 'c_qty' ? { ...c, readAs: many } : c)) } };
    expect(readAsOffer(full, qty3, '0', rowInputs, [])).toBeNull();
  });

  it('another row that keeps the same text as something else is a clash; the same value is not', () => {
    const other = { columnId: 'c_qty', header: 'Qty', from: 'N/A', to: '' };
    const qty4 = rowInputs[4][1]!;
    expect(readAsOffer(RULES, qty4, '9', rowInputs, [other])?.clash).toBe(true);
    expect(readAsOffer(RULES, qty4, '', rowInputs, [other])?.clash).toBe(false);
    expect(readAsOffer(RULES, qty4, '9', rowInputs, [{ ...other, from: 'x' }, { ...other, columnId: 'c_price' }])?.clash).toBe(false);
  });
});

describe('readAsFixes', () => {
  const choices: Choices = {
    3: { action: 'override', values: { c_qty: '' }, every: ['c_qty'] },
    4: { action: 'override', values: { c_qty: '  ' }, every: ['c_qty'] },
    5: { action: 'override', values: { c_qty: '1' } }, // typed, not ticked
    6: { action: 'skip' },
  };

  it('one fix per (column, text) however many rows said yes; rows without a tick, skip and keep count for nothing', () => {
    expect(readAsFixes(RULES, rowInputs, choices)).toEqual([{ columnId: 'c_qty', header: 'Qty', from: 'N/A', to: '' }]);
    // what the OTHER rows keep: row 4 still says it when row 3 is left out
    expect(readAsFixes(RULES, rowInputs, choices, 3)).toEqual([{ columnId: 'c_qty', header: 'Qty', from: 'N/A', to: '' }]);
    expect(readAsFixes(RULES, rowInputs, { 3: choices[3]! }, 3)).toEqual([]);
  });

  it('rows that keep the same text as different values cancel each other: a text is read one way only, and code does not pick', () => {
    const disagree: Choices = { 3: { action: 'override', values: { c_qty: '' }, every: ['c_qty'] }, 4: { action: 'override', values: { c_qty: '9' }, every: ['c_qty'] } };
    expect(readAsFixes(RULES, rowInputs, disagree)).toEqual([]);
  });
});

describe('withoutSaved', () => {
  const fixes = [{ columnId: 'c_qty', header: 'Qty', from: 'N/A', to: '' }];
  const choices: Choices = {
    3: { action: 'override', values: { c_qty: '' }, every: ['c_qty'] },
    4: { action: 'override', values: { c_qty: '', c_price: '5' }, every: ['c_qty'] },
    5: { action: 'override', values: { c_qty: '1' } },
    6: { action: 'skip' },
  };

  it('the saved fixes leave the row decisions (the rule reads those cells now); a row left with nothing has no decision; other fields and rows stay', () => {
    expect(withoutSaved(choices, rowInputs, fixes)).toEqual({
      4: { action: 'override', values: { c_price: '5' } },
      5: { action: 'override', values: { c_qty: '1' } },
      6: { action: 'skip' },
    });
    expect(toRowDecisions(withoutSaved(choices, rowInputs, fixes))).toEqual({ 4: { action: 'override', values: { c_price: '5' } }, 5: { action: 'override', values: { c_qty: '1' } }, 6: { action: 'skip' } });
  });

  it('a tick whose fix was not saved keeps its one-off value and its tick', () => {
    expect(withoutSaved({ 3: choices[3]! }, rowInputs, [])).toEqual({ 3: choices[3] });
  });
});

describe('withReadAs', () => {
  it('adds the fixes to their columns and nothing else, keeps what a column already read, and never mutates', () => {
    const before = JSON.stringify(RULES);
    const out = withReadAs(RULES, [
      { columnId: 'c_qty', header: 'Qty', from: 'N/A', to: '' },
      { columnId: 'c_qty', header: 'Qty', from: '__proto__', to: '0' },
    ]);
    expect(out.input.columns.map((c) => c.id)).toEqual(['c_code', 'c_qty', 'c_price']);
    // a cell whose text is "__proto__" is a key like any other
    expect(Object.keys(out.input.columns[1]!.readAs!)).toEqual(['N/A', '__proto__']);
    expect(Object.getOwnPropertyDescriptor(out.input.columns[1]!.readAs!, '__proto__')?.value).toBe('0');
    expect(out.input.columns[0]!.readAs).toBeUndefined();
    expect({ ...out, input: RULES.input }).toEqual(RULES);
    expect(JSON.stringify(RULES)).toBe(before);
    const more = withReadAs(out, [{ columnId: 'c_qty', header: 'Qty', from: 'none', to: '0' }]);
    expect(Object.keys(more.input.columns[1]!.readAs!)).toEqual(['N/A', '__proto__', 'none']);
    expect(withReadAs(RULES, [])).toBe(RULES);
  });
});

// What a saved format may keep (docs/proposals/saved-format-contents.md sections 5 and 7).
describe('a fix a saved format would keep', () => {
  it('nothing is offered for a text or a value over the cap of one value (the server would refuse the save)', () => {
    expect(readAsOffer(RULES, qty3, 'x'.repeat(limits.rules.maxValueChars), rowInputs, [])).not.toBeNull();
    expect(readAsOffer(RULES, qty3, 'x'.repeat(limits.rules.maxValueChars + 1), rowInputs, [])).toBeNull();
    expect(readAsOffer(RULES, { ...qty3, value: 'y'.repeat(limits.rules.maxValueChars + 1) }, '', rowInputs, [])).toBeNull();
  });

  it('fixIdentifiers: a line per column and kind for the fixes holding an identifier-shaped value (its text or what it is read as); fixesWithout drops them', () => {
    const fixes = [
      { columnId: 'c_qty', header: 'Qty', from: 'N/A', to: '039337423' },
      { columnId: 'c_price', header: 'Price', from: 'call 050-1234567', to: '' },
      { columnId: 'c_code', header: 'Item Code', from: '-', to: '61000100' },
    ];
    const found = fixIdentifiers(fixes);
    expect(found.lines).toEqual([
      { kind: 'identifier', header: 'Qty', idKind: 'israeliId' },
      { kind: 'identifier', header: 'Price', idKind: 'phone' },
    ]);
    expect(found.fixes).toEqual(fixes.slice(0, 2));
    expect(fixesWithout(fixes, found.fixes)).toEqual([fixes[2]]);
    expect(fixIdentifiers([fixes[2]!])).toEqual({ lines: [], fixes: [] });
  });
});
