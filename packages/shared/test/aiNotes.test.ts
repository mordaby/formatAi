// learn-v7 (issue #40, SPEC 8.10, 15): the optional `functionRequest` and `explanation` on an unsupported entry - the schema accepts and rejects
// them, the wire schema carries them (without keywords structured-output providers may refuse), the helpers take them out of any rules.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aiNotesOf, stripAiNotes, stripAiNotesFromJson } from '../src/rules/aiNotes';
import { learnResultJsonSchema } from '../src/rules/jsonSchema';
import { FunctionRequestSchema, LearnResultSchema, limits, type FunctionRequest, type LearnResult } from '../src';
import { learnResultWireJsonSchema } from '../src/rules/wire';
import { learnResultOf } from '../src/completion';
import example from './fixtures/learn-result-example.json';

const here = path.dirname(fileURLToPath(import.meta.url));

const request: FunctionRequest = {
  name: 'weekdayName',
  purpose: 'Gives the name of the weekday of a date.',
  args: [{ name: 'day', type: 'date' }],
  returns: 'text',
};

function withUnsupported(unsupported: unknown[]): unknown {
  return { ...(example as unknown as LearnResult), unsupported };
}

describe('LearnResultSchema: unsupported[].functionRequest and explanation (learn-v7)', () => {
  it('accepts a function request and an explanation, together or alone, and an entry with neither', () => {
    const base = { outputColumn: 'שם יום', reasonCode: 'other' };
    for (const entry of [base, { ...base, functionRequest: request }, { ...base, explanation: 'Looks like the weekday name of the date.' }, { ...base, functionRequest: request, explanation: 'x' }]) {
      const r = LearnResultSchema.safeParse(withUnsupported([entry]));
      expect(r.success, JSON.stringify(entry)).toBe(true);
    }
  });

  it('keeps the new fields on the parsed result (they are real fields of the type)', () => {
    const parsed = LearnResultSchema.parse(withUnsupported([{ outputColumn: 'A', reasonCode: 'other', functionRequest: request, explanation: 'guess' }]));
    expect(parsed.unsupported[0]).toEqual({ outputColumn: 'A', reasonCode: 'other', functionRequest: request, explanation: 'guess' });
  });

  it('rejects an unknown field on the entry or on the request (strict)', () => {
    expect(LearnResultSchema.safeParse(withUnsupported([{ outputColumn: 'A', reasonCode: 'other', example: '12' }])).success).toBe(false);
    expect(LearnResultSchema.safeParse(withUnsupported([{ outputColumn: 'A', reasonCode: 'other', functionRequest: { ...request, example: 'Monday' } }])).success).toBe(false);
    expect(LearnResultSchema.safeParse(withUnsupported([{ outputColumn: 'A', reasonCode: 'other', functionRequest: { ...request, args: [{ name: 'day', type: 'date', sample: '1' }] } }])).success).toBe(false);
  });

  it.each([
    ['a name that is not camelCase (spaces)', { name: 'weekday name' }],
    ['a name that starts with a capital', { name: 'WeekdayName' }],
    ['a name that starts with a digit', { name: '1stDay' }],
    ['a name with punctuation', { name: 'weekday_name' }],
    ['a Hebrew name', { name: 'שםיום' }],
    ['an empty name', { name: '' }],
    ['a name over 40 characters', { name: `a${'b'.repeat(40)}` }],
    ['an empty purpose', { purpose: '' }],
    ['a purpose over 160 characters', { purpose: 'x'.repeat(161) }],
    ['more than 6 args', { args: Array.from({ length: 7 }, (_, i) => ({ name: `a${i}`, type: 'text' })) }],
    ['an arg with a bad name', { args: [{ name: 'The Day', type: 'date' }] }],
    ['an arg type outside the value types', { args: [{ name: 'day', type: 'currency' }] }],
    ['a return type outside the value types', { returns: 'percent' }],
    ['no return type', { returns: undefined }],
  ])('rejects %s', (_label, patch) => {
    const bad = { ...request, ...patch };
    expect(FunctionRequestSchema.safeParse(bad).success).toBe(false);
    expect(LearnResultSchema.safeParse(withUnsupported([{ outputColumn: 'A', reasonCode: 'other', functionRequest: bad }])).success).toBe(false);
  });

  it('accepts the limits exactly: a 40-character name, a 160-character purpose, 6 args, a 200-character explanation', () => {
    const edge: FunctionRequest = {
      name: `a${'b'.repeat(39)}`,
      purpose: 'x'.repeat(160),
      args: Array.from({ length: 6 }, (_, i) => ({ name: `a${i}`, type: 'text' as const })),
      returns: 'integer',
    };
    expect(LearnResultSchema.safeParse(withUnsupported([{ outputColumn: 'A', reasonCode: 'other', functionRequest: edge, explanation: 'e'.repeat(200) }])).success).toBe(true);
    expect(limits.learn.notes).toMatchObject({ maxNameChars: 40, maxPurposeChars: 160, maxArgs: 6, maxExplanationChars: 200 });
  });

  it('rejects an explanation over 200 characters or one that is not a string', () => {
    expect(LearnResultSchema.safeParse(withUnsupported([{ outputColumn: 'A', reasonCode: 'other', explanation: 'e'.repeat(201) }])).success).toBe(false);
    expect(LearnResultSchema.safeParse(withUnsupported([{ outputColumn: 'A', reasonCode: 'other', explanation: 5 }])).success).toBe(false);
  });
});

describe('the wire JSON Schema carries the two notes', () => {
  const wire = learnResultWireJsonSchema() as { properties: { unsupported: { items: { properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: unknown } } } };
  const item = wire.properties.unsupported.items;

  it('has functionRequest and explanation as OPTIONAL properties of an unsupported item, closed (additionalProperties false)', () => {
    expect(Object.keys(item.properties).sort()).toEqual(['explanation', 'functionRequest', 'outputColumn', 'reasonCode']);
    expect(item.required).toEqual(['outputColumn', 'reasonCode']);
    expect(item.additionalProperties).toBe(false);
    const fr = item.properties.functionRequest as { properties: Record<string, unknown>; required: string[]; additionalProperties: unknown };
    expect(Object.keys(fr.properties).sort()).toEqual(['args', 'name', 'purpose', 'returns']);
    expect(fr.required.sort()).toEqual(['args', 'name', 'purpose', 'returns']);
    expect(fr.additionalProperties).toBe(false);
  });

  it('types arguments and the return type with the value types, and keeps the length / pattern keywords off the wire (said in the prompt, enforced by the real schema)', () => {
    const json = JSON.stringify(item.properties);
    expect(json).toContain('"idLike"');
    expect(json).not.toContain('"pattern"');
    expect(json).not.toContain('"maxLength"');
    expect(json).not.toContain('"maxItems"');
  });

  it('stays under 20,000 characters with the new fields in', () => {
    expect(JSON.stringify(wire).length).toBeLessThan(20_000);
  });
});

describe('generated/learn-result.schema.json', () => {
  it('is in sync with the zod schema (re-run scripts/gen-json-schema.ts after a schema change), and has the new fields', () => {
    const file = JSON.parse(readFileSync(path.join(here, '..', 'generated', 'learn-result.schema.json'), 'utf8')) as unknown;
    expect(file).toEqual(JSON.parse(JSON.stringify(learnResultJsonSchema())));
    expect(JSON.stringify(file)).toContain('functionRequest');
    expect(JSON.stringify(file)).toContain('runningSum');
  });
});

describe('stripAiNotes / aiNotesOf / stripAiNotesFromJson', () => {
  const noted = (): LearnResult =>
    ({
      ...(example as unknown as LearnResult),
      unsupported: [
        { outputColumn: 'A', reasonCode: 'other', functionRequest: request, explanation: 'it is the weekday of Dana' },
        { outputColumn: 'B', reasonCode: 'externalData' },
        { outputColumn: 'C', reasonCode: 'other', explanation: '  only a guess ' },
      ],
    }) as LearnResult;

  it('stripAiNotes removes both notes from every entry, keeps the rest, and returns the same object when there is nothing to strip', () => {
    const stripped = stripAiNotes(noted());
    expect(stripped.unsupported).toEqual([
      { outputColumn: 'A', reasonCode: 'other' },
      { outputColumn: 'B', reasonCode: 'externalData' },
      { outputColumn: 'C', reasonCode: 'other' },
    ]);
    expect(JSON.stringify(stripped)).not.toContain('Dana');
    expect(stripAiNotes(stripped)).toBe(stripped);
  });

  it('aiNotesOf lists the entries that carry a note, with the explanation trimmed and functionRecorded for a request', () => {
    expect(aiNotesOf(noted())).toEqual([
      { header: 'A', explanation: 'it is the weekday of Dana', functionRecorded: true },
      { header: 'C', explanation: 'only a guess' },
    ]);
    expect(aiNotesOf(stripAiNotes(noted()))).toEqual([]);
  });

  it('stripAiNotesFromJson strips a rules-shaped JSON value (a save body) and leaves anything else alone', () => {
    const out = stripAiNotesFromJson(JSON.parse(JSON.stringify(noted()))) as LearnResult;
    expect(JSON.stringify(out)).not.toContain('Dana');
    expect(out.unsupported).toHaveLength(3);
    expect(stripAiNotesFromJson('x')).toBe('x');
    expect(stripAiNotesFromJson(null)).toBe(null);
    expect(stripAiNotesFromJson({ a: 1 })).toEqual({ a: 1 });
    expect(stripAiNotesFromJson({ unsupported: 'nope' })).toEqual({ unsupported: 'nope' });
  });

  it('learnResultOf (what a completion sends as `complete.fixed`, and what the web checks) never carries the notes', () => {
    expect(JSON.stringify(learnResultOf(noted()))).not.toContain('Dana');
    expect(JSON.stringify(learnResultOf(noted()))).not.toContain('weekdayName');
  });
});
