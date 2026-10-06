// Amendment 2026-10-06 (SPEC 7.2): numeric IDs on the free path. The bug: the profile calls a column of identifiers `idLike` whatever
// its cells hold, and the fast path declared the input column with that type - a reading that turns every cell into text. A copy of IDs
// stored as numbers then wrote text where the example holds numbers, and the verification (typed) failed: a file that only copied a
// numeric ID column always needed the AI. Now the free path writes what the example shows: a numeric ID copied as a number stays a
// number (the column is declared `integer`), zero-padded text stays text with the padding (`idLike` + `padLeft`), and a text ID is
// copied as text, as before.
import { checkRules, type LearnPayload } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { typeCheck } from '../../src/check';
import { learnFromExamples, type LearnFromExamplesResult } from '../../src/learn/flow';
import { partialRules } from '../../src/learn/partial';
import { preflight } from '../../src/learn/preflight';
import { makeValidIsraeliId } from '../../src/values/israeliId';
import { analyzeOk, xlsx, type V } from './analyze/helpers';
import { xlsxBytesOf } from './v5fixtures';

const NAMES = ['Dana', 'Yossi', 'Noa', 'Omer', 'Maya', 'Avi', 'Tal', 'Gil', 'Rina', 'Eli'];
/** Israeli IDs stored as numbers: half of them lost their leading zero in Excel (8 digits), half have 9. */
const IDS = NAMES.map((_, i) => Number(makeValidIsraeliId(String((i % 2 === 0 ? 1234500 : 31234500) + i * 1117).padStart(8, '0'))));

/** A learn with no AI step at all: the AI call fails the test. Masking on or off. */
async function learnFree(input: V[][], output: V[][], masking: boolean): Promise<LearnFromExamplesResult> {
  return learnFromExamples({
    input: { bytes: await xlsxBytesOf(input), name: 'in.xlsx' },
    output: { bytes: await xlsxBytesOf(output), name: 'out.xlsx' },
    masking,
    ...(masking ? { key: new TextEncoder().encode('free-path') } : {}),
    tier: 'registered',
    callLearn: async (payload: LearnPayload) => {
      throw new Error(`the AI step was asked (${payload.samples.length} samples)`);
    },
  });
}

function expectFreeAndVerified(r: LearnFromExamplesResult): void {
  expect(r.path).toBe('local');
  expect(r.calls).toEqual([]);
  expect(r.verification?.mismatches).toEqual([]);
  expect(r.verification?.verified).toBe(true);
  expect(checkRules(r.rules!)).toEqual([]);
  expect(typeCheck(r.rules!)).toEqual([]);
}

describe('the free path: an ID column stored as numbers', () => {
  it('copied as numbers: verifies on the fast path with no AI, the column declared integer, the ID check kept', async () => {
    const input: V[][] = [['ID', 'Name', 'Notes'], ...NAMES.map((n, i) => [IDS[i]!, n, `x${i}`])];
    const output: V[][] = [['Name', 'ID'], ...NAMES.map((n, i) => [n, IDS[i]!])];
    expect(analyzeOk(xlsx(input), xlsx(output)).input.profile[0]!.type).toBe('idLike'); // the setup: Israeli IDs, so idLike
    for (const masking of [true, false]) {
      const r = await learnFree(input, output, masking);
      expectFreeAndVerified(r);
      const id = r.rules!.input.columns.find((c) => c.header === 'ID')!;
      expect(id.type).toBe('integer');
      expect(id.padLeft).toBeUndefined();
      expect(r.rules!.validations).toContainEqual({ on: 'output', column: 'ID', rule: 'israeliIdChecksum', severity: 'flag' });
    }
  });

  it('long codes (8+ digits: idLike by length) copied as numbers next to a filter: the same', async () => {
    const codes = NAMES.map((_, i) => 40010020 + i * 3301);
    const input: V[][] = [['Code', 'Name', 'Status'], ...NAMES.map((n, i) => [codes[i]!, n, i % 4 === 0 ? 'cancelled' : 'active'])];
    const output: V[][] = [['Code', 'Name'], ...NAMES.flatMap((n, i) => (i % 4 === 0 ? [] : [[codes[i]!, n]]))];
    const r = await learnFree(input, output, true);
    expectFreeAndVerified(r);
    expect(r.rules!.input.columns.find((c) => c.header === 'Code')!.type).toBe('integer');
    expect(r.rules!.input.rowFilters).toHaveLength(1);
  });

  it('padded with zeros into text: verifies on the fast path, idLike with padLeft, the output text with its zeros', async () => {
    const input: V[][] = [['ID', 'Name'], ...NAMES.map((n, i) => [IDS[i]!, n])];
    const output: V[][] = [['ID', 'Name'], ...NAMES.map((n, i) => [String(IDS[i]).padStart(9, '0'), n])];
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.columns[0]!.relations.some((rel) => rel.rel === 'padLeft' && rel.coverage === 1)).toBe(true);
    for (const masking of [true, false]) {
      const r = await learnFree(input, output, masking);
      expectFreeAndVerified(r);
      const id = r.rules!.input.columns.find((c) => c.header === 'ID')!;
      expect(id).toMatchObject({ type: 'idLike', padLeft: 9 });
    }
  });

  it('written as text with the same digits (no padding): stays idLike, the output text', async () => {
    const input: V[][] = [['ID', 'Name'], ...NAMES.map((n, i) => [IDS[i]!, n])];
    const output: V[][] = [['Name', 'ID'], ...NAMES.map((n, i) => [n, String(IDS[i])])];
    const r = await learnFree(input, output, false);
    expectFreeAndVerified(r);
    expect(r.rules!.input.columns.find((c) => c.header === 'ID')!.type).toBe('idLike');
  });
});

describe('the free path: a text ID column, as before', () => {
  it('text IDs with leading zeros copied as they are: idLike, verified on the fast path', async () => {
    const texts = IDS.map((id) => String(id).padStart(9, '0'));
    const input: V[][] = [['ID', 'Name'], ...NAMES.map((n, i) => [texts[i]!, n])];
    const output: V[][] = [['Name', 'ID'], ...NAMES.map((n, i) => [n, texts[i]!])];
    for (const masking of [true, false]) {
      const r = await learnFree(input, output, masking);
      expectFreeAndVerified(r);
      expect(r.rules!.input.columns.find((c) => c.header === 'ID')!.type).toBe('idLike');
    }
  });
});

describe('the local partial result reads a numeric ID copy as numbers too', () => {
  it('the ID column is declared integer while another column is left to the AI step', () => {
    const input: V[][] = [['ID', 'Name'], ...NAMES.map((n, i) => [IDS[i]!, n])];
    const output: V[][] = [['ID', 'Name', 'Comment'], ...NAMES.map((n, i) => [IDS[i]!, n, ['ok', 'call back', 'late', 'n/a', 'paid'][(i * 7) % 5]!])];
    const a = analyzeOk(xlsx(input), xlsx(output));
    const p = partialRules(a, preflight(a, 'registered'));
    if (!('rules' in p)) throw new Error(`no partial result: ${JSON.stringify(p)}`);
    expect(p.solved).toEqual(['ID', 'Name']);
    expect(p.rules.input.columns.find((c) => c.header === 'ID')!.type).toBe('integer');
  });
});

describe('typeCheck: israeliIdChecksum on an integer column', () => {
  const rules = (type: 'integer' | 'decimal' | 'idLike') => ({
    schemaVersion: 1 as const,
    input: { sheet: { pick: 'first' as const }, headerRow: 'auto' as const, columns: [{ id: 'id', header: 'ID', type }] },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: { sheetName: 'S', direction: 'ltr' as const, language: 'en' as const, titleRows: [], columns: [{ header: 'ID', from: 'id' }] },
    validations: [{ column: 'id', rule: 'israeliIdChecksum' as const, severity: 'flag' as const }],
    unsupported: [],
    assumptions: [],
  });

  it('is accepted (an ID stored as a number; the check pads it to 9 digits at run time), and still refused on a decimal', () => {
    expect(typeCheck(rules('integer'))).toEqual([]);
    expect(typeCheck(rules('idLike'))).toEqual([]);
    expect(typeCheck(rules('decimal')).map((p) => p.message)).toEqual([expect.stringContaining('israeliIdChecksum applies to a text/idLike or integer column')]);
  });
});
