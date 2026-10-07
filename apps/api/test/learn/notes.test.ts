// learn-v7 (issue #40, SPEC 15): the pure parts of the function-request pipeline - dropping malformed notes, the value filter, the identity of
// a request (key), the hashed owner, the topic guess. (The store and the routes are in test/protection/functionRequests.test.ts.)
import { limits, type FunctionRequest, type LearnPayload } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import {
  canonicalNumber,
  dropInvalidNotes,
  hashOwner,
  payloadValues,
  requestKey,
  requestMentionsPayloadValue,
  topicOfRequest,
} from '../../src/learn/notes.js';
import { basicPayload } from './fixtures.js';

const req = (over: Partial<FunctionRequest> = {}): FunctionRequest => ({
  name: 'weekdayName',
  purpose: 'Gives the name of the weekday of a date.',
  args: [{ name: 'day', type: 'date' }],
  returns: 'text',
  ...over,
});

/** A payload whose cells carry a name, a number, a date, a Hebrew word, hint values and a dropped row. */
function richPayload(): LearnPayload {
  const base = basicPayload();
  return {
    ...base,
    samples: [
      { in: ['Dana Cohen', 1234.5], out: ['Dana Cohen', 2469] },
      { in: ['2026-01-31', 7], out: ['שלום עולם', 14] },
      { in: ['x', 3], out: [['Fiona', 1], ['Gil', 2]] as never },
    ] as LearnPayload['samples'],
    dropped: [['Zorro', 99]],
    hints: [
      { out: 0, rel: 'valueMap', in: [0], pairs: [['Alpha', 'Beta']], coverage: 1 },
      { out: 1, rel: 'mulConst', in: [1], const: 1.18, round: 2, coverage: 1 },
      { rel: 'filter', in: [0], keptValues: ['Omega'], droppedValues: ['Sigma'], coverage: 1 },
      { out: 1, rel: 'bands', in: [1], bands: [{ lt: 50, value: 'Low' }, { gte: 50, value: 'High' }], coverage: 1 },
      { out: 0, rel: 'template', in: [0, 1], parts: [{ in: 0 }, ':"', { in: 1 }], coverage: 1 },
      { rel: 'filter', in: [1], droppedWhen: { op: 'isEmpty' }, coverage: 1 },
    ],
  } as LearnPayload;
}

describe('dropInvalidNotes: a malformed note is dropped, the rest of the answer is untouched', () => {
  const answer = (unsupported: unknown[]) => ({ schemaVersion: 1, unsupported, assumptions: [] });

  it('keeps valid notes and returns the same object when nothing was dropped', () => {
    const json = answer([{ outputColumn: 'A', reasonCode: 'other', functionRequest: req(), explanation: 'a guess' }]);
    expect(dropInvalidNotes(json)).toBe(json);
  });

  it.each([
    ['a name that is not camelCase', { functionRequest: req({ name: 'Weekday Name' }) }],
    ['a purpose over 160 characters', { functionRequest: req({ purpose: 'p'.repeat(161) }) }],
    ['more than 6 args', { functionRequest: req({ args: Array.from({ length: 7 }, (_, i) => ({ name: `a${i}`, type: 'text' as const })) }) }],
    ['an unknown field (an example)', { functionRequest: { ...req(), example: 'Monday' } }],
    ['an explanation over 200 characters', { explanation: 'e'.repeat(201) }],
    ['an empty explanation', { explanation: '   ' }],
    ['an explanation that is not text', { explanation: 7 }],
  ])('drops %s', (_label, note) => {
    const out = dropInvalidNotes(answer([{ outputColumn: 'A', reasonCode: 'other', ...note }])) as { unsupported: Record<string, unknown>[] };
    expect(out.unsupported).toEqual([{ outputColumn: 'A', reasonCode: 'other' }]);
  });

  it('drops only the bad note of an entry and leaves the good one', () => {
    const out = dropInvalidNotes(answer([{ outputColumn: 'A', reasonCode: 'other', functionRequest: req({ name: 'bad name' }), explanation: 'fine' }])) as { unsupported: Record<string, unknown>[] };
    expect(out.unsupported[0]).toEqual({ outputColumn: 'A', reasonCode: 'other', explanation: 'fine' });
  });

  it('never throws on a shape it does not know', () => {
    for (const j of [null, 'x', 5, [], {}, { unsupported: 'nope' }, { unsupported: [null, 1, 'x'] }]) expect(() => dropInvalidNotes(j)).not.toThrow();
  });
});

describe('the value filter: a request that mentions a payload value is rejected (case-insensitive tokens of 3+ characters, and numbers)', () => {
  const values = payloadValues(richPayload());

  it('collects the words and numbers of sample cells (pairs and families), dropped rows, hint values and column ranges', () => {
    for (const w of ['dana', 'cohen', 'שלום', 'עולם', 'fiona', 'gil', 'zorro', 'alpha', 'beta', 'omega', 'sigma', 'low', 'high']) expect(values.words.has(w), w).toBe(true);
    for (const n of ['1234.5', '2469', '2026', '31', '7', '14', '99', '1.18', '50']) expect(values.numbers.has(n), n).toBe(true);
  });

  it('API audit C7: collects the input and output header words and the sheet names too (sent real: the user text)', () => {
    for (const w of ['amount', 'total', 'sheet', 'out']) expect(values.words.has(w), w).toBe(true);
    const named = payloadValues({ ...basicPayload(), input: { ...basicPayload().input, sheetName: 'Cohen Ltd prices' } });
    for (const w of ['cohen', 'ltd', 'prices']) expect(named.words.has(w), w).toBe(true);
  });

  it('does not collect hint structure (positions, relation names) or words shorter than 3 characters', () => {
    expect(values.words.has('valuemap')).toBe(false);
    expect(values.words.has('isempty')).toBe(false); // a threshold's operator is structure, not data
    expect(values.words.has('x')).toBe(false);
  });

  it.each([
    ['a sample word in the name', req({ name: 'danaLookup' })],
    ['a sample word in the purpose, other case', req({ purpose: 'Looks up the COHEN account.' })],
    ['a Hebrew word in the purpose', req({ purpose: 'מחזיר את שלום' })],
    ['a word of a dropped row', req({ purpose: 'Skips Zorro rows.' })],
    ['a hint value', req({ purpose: 'Maps alpha to something.' })],
    ['a filter hint value', req({ name: 'isOmega' })],
    ['a band value', req({ purpose: 'Returns High or not.' })],
    ['a word inside a camelCase name', req({ name: 'fionaCode' })],
    ['an argument name', req({ args: [{ name: 'gilValue', type: 'text' }] })],
    ['a number from a cell', req({ purpose: 'Adds 2469 to the total.' })],
    ['a number from a hint constant', req({ purpose: 'Multiplies by 1.18.' })],
    ['a number written another way (1,234.50)', req({ purpose: 'Rounds 1,234.50 down.' })],
    ['a number with leading zeros (007)', req({ purpose: 'Pads to 007.' })],
    ['a year inside a date cell', req({ purpose: 'Keeps only 2026.' })],
    ['a number in the name', req({ name: 'addNinetyNine99' })],
    ['a header word (API audit C7: headers are the user text)', req({ purpose: 'Uses the amount column.' })],
    ['an output header word in an argument name', req({ args: [{ name: 'totalValue', type: 'number' }] })],
  ])('rejects %s', (_label, r) => {
    expect(requestMentionsPayloadValue(r, values)).toBe(true);
  });

  it.each([
    ['a clean request', req()],
    ['a word of fewer than 3 characters that is a value', req({ purpose: 'Uses x as a marker.' })],
    ['a number that is not in the payload', req({ purpose: 'Returns the last 5 characters.' })],
    ['a longer word that merely contains a value', req({ name: 'highlightRows' })],
    ['names that are not values', req({ name: 'splitOnFirstSeparator', args: [{ name: 'text', type: 'text' }, { name: 'separator', type: 'text' }], returns: 'text' })],
  ])('accepts %s', (_label, r) => {
    expect(requestMentionsPayloadValue(r, values)).toBe(false);
  });

  it('compares only tokens of at least limits.learn.notes.minTokenChars characters (config)', () => {
    expect(limits.learn.notes.minTokenChars).toBe(3);
    const v = payloadValues({ ...basicPayload(), samples: [{ in: ['ab', 5], out: ['ab', 10] }] });
    expect([...v.words].sort()).toEqual(['amount', 'out', 'sheet', 'total']); // the header and sheet words only: no cell word of 3+ characters
    expect(requestMentionsPayloadValue(req({ purpose: 'Uses ab here.' }), v)).toBe(false);
    expect(requestMentionsPayloadValue(req({ purpose: 'Uses 10 here.' }), v)).toBe(true); // numbers are compared whatever their length
  });

  it('looks at what was sent: masked fakes count when masking is on (the answer was written against them)', () => {
    const masked = payloadValues({ ...basicPayload({ masking: true }), samples: [{ in: ['Qzxvb', 1], out: ['Qzxvb', 2] }] });
    expect(requestMentionsPayloadValue(req({ name: 'qzxvbCode' }), masked)).toBe(true);
    // the real word is not in the payload at all, so it cannot be compared (and the model never saw it)
    expect(requestMentionsPayloadValue(req({ name: 'danaCode' }), masked)).toBe(false);
  });
});

describe('canonicalNumber', () => {
  it.each([
    ['1,234.50', '1234.5'],
    ['1234.5', '1234.5'],
    ['007', '7'],
    ['0.170', '0.17'],
    ['3,5', '3.5'],
    ['10', '10'],
    ['0', '0'],
    ['100.00', '100'],
  ])('%s -> %s', (raw, canonical) => {
    expect(canonicalNumber(raw)).toBe(canonical);
  });
});

describe('requestKey, hashOwner, topicOfRequest', () => {
  it('the key is the normalized name plus the signature: argument NAMES and name case do not matter, argument types and the return type do', () => {
    expect(requestKey(req())).toBe('weekdayname(date):text');
    expect(requestKey(req({ name: 'WeekdayName'.toLowerCase(), args: [{ name: 'other', type: 'date' }] }))).toBe(requestKey(req()));
    expect(requestKey(req({ returns: 'integer' }))).not.toBe(requestKey(req()));
    expect(requestKey(req({ args: [{ name: 'day', type: 'text' }] }))).not.toBe(requestKey(req()));
  });

  it('hashOwner is a keyed, stable, truncated hash: never the id, different per owner and per secret', () => {
    const h = hashOwner('user:0123456789abcdef01234567', 'secret-a');
    expect(h).toMatch(/^[0-9a-f]{24}$/);
    expect(h).toBe(hashOwner('user:0123456789abcdef01234567', 'secret-a'));
    expect(h).not.toBe(hashOwner('user:0123456789abcdef01234568', 'secret-a'));
    expect(h).not.toBe(hashOwner('user:0123456789abcdef01234567', 'secret-b'));
    expect(h).not.toContain('0123456789abcdef');
  });

  it.each([
    [req(), 'dates'],
    [req({ name: 'runningTotal', purpose: 'Adds up the values of all rows up to the current one.' }), 'acrossRows'],
    [req({ name: 'lookupRate', purpose: 'Finds a rate in a reference table by code.' }), 'lookups'],
    [req({ name: 'afterFirstSeparator', purpose: 'Extracts the part of a text after the first delimiter.' }), 'extraction'],
    [req({ name: 'collapseSpaces', purpose: 'Removes repeated whitespace from a text.' }), 'cleanup'],
    [req({ name: 'median', purpose: 'The median of several numbers.' }), 'arithmetic'],
    [req({ name: 'zzz', purpose: 'Does something nobody has words for.' }), 'unknown'],
  ])('topicOfRequest(%j) is %s', (r, topic) => {
    expect(topicOfRequest(r)).toBe(topic);
  });
});
