// A learned example that matches a saved format (owner decision 2026-10-07): "same format" by the output only, then "same source" by the
// file-to-source matching of flow C, then the format lock.
import { describe, expect, it } from 'vitest';
import type { LearnResult } from '@formatai/shared';
import { formatOf } from '../../src/registry/formatOf';
import { findFormatMatches, pickExampleSource, type SavedFormatCandidate } from '../../src/registry/matchFormats';
import type { ConversionSignatureInput } from '../../src/registry/matchConversions';

function rules(over: { inputHeaders?: [string, string]; title?: string; outputHeaders?: [string, string]; width?: number } = {}): LearnResult {
  const [nameHeader, amountHeader] = over.inputHeaders ?? ['Name', 'Amount'];
  const [outName, outAmount] = over.outputHeaders ?? ['Customer', 'Total'];
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'name', header: nameHeader, type: 'text' },
        { id: 'amount', header: amountHeader, type: 'decimal' },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: {
      sheetName: 'Out',
      direction: 'ltr',
      language: 'en',
      titleRows: over.title ? [{ text: over.title }] : [],
      columns: [
        { header: outName, from: 'name' },
        { header: outAmount, from: 'amount', format: '#,##0.00', ...(over.width ? { width: over.width } : {}) },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

const SUPPLIER_A: ConversionSignatureInput = {
  id: 'S1',
  name: 'Supplier A',
  columns: [
    { header: 'Name', aliases: [], type: 'text', required: true },
    { header: 'Amount', aliases: [], type: 'decimal', required: true },
  ],
};
const SUPPLIER_B: ConversionSignatureInput = {
  id: 'S2',
  name: 'Supplier B',
  columns: [
    { header: 'Client', aliases: [], type: 'text', required: true },
    { header: 'Sum', aliases: [], type: 'decimal', required: true },
  ],
};

function candidate(id: string, name: string, over: { usedAt?: string; rules?: LearnResult; conversions?: SavedFormatCandidate['conversions'] } = {}): SavedFormatCandidate {
  return {
    id,
    name,
    format: formatOf(over.rules ?? rules({ title: 'Report for March' })),
    usedAt: over.usedAt ?? '2026-09-01T00:00:00.000Z',
    conversions: over.conversions ?? [{ id: `${id}-C1`, sourceId: 'S1', sourceName: 'Supplier A', version: 3 }],
  };
}

describe('findFormatMatches', () => {
  it('no saved format with this output: nothing (Save goes on as before)', () => {
    expect(findFormatMatches({ rules: rules(), candidates: [], sources: [SUPPLIER_A] })).toEqual([]);
    const renamed = rules({ outputHeaders: ['Client', 'Total'] });
    expect(findFormatMatches({ rules: renamed, candidates: [candidate('F1', 'Monthly')], sources: [SUPPLIER_A] })).toEqual([]);
  });

  it('the same output from the same source: an update of that conversion (the title text may differ)', () => {
    const [match] = findFormatMatches({ rules: rules({ title: 'Report for April' }), inputHeaders: ['Name', 'Amount'], candidates: [candidate('F1', 'Monthly')], sources: [SUPPLIER_A, SUPPLIER_B] });
    expect(match).toMatchObject({ formatId: 'F1', formatName: 'Monthly', sources: 1, same: { id: 'F1-C1', sourceId: 'S1', sourceName: 'Supplier A', version: 3 } });
    // (the update writes the new title into the format: the lock says so)
    expect(match!.lock.map((p) => p.path)).toEqual(['output.titleRows']);
  });

  it('the same output from another input: a new source of the format (the input names never decide "same format")', () => {
    const [match] = findFormatMatches({
      rules: rules({ inputHeaders: ['Client', 'Sum'], title: 'Report for March' }),
      inputHeaders: ['Client', 'Sum'],
      candidates: [candidate('F1', 'Monthly')],
      sources: [SUPPLIER_A, SUPPLIER_B],
    });
    // Supplier B is a source of the user's, but not of this format: attach (the server reuses it).
    expect(match).toMatchObject({ formatId: 'F1', sources: 1, lock: [] });
    expect(match!.same).toBeUndefined();
  });

  it('a file no source clearly matches is a new source too', () => {
    const [match] = findFormatMatches({ rules: rules({ inputHeaders: ['Who', 'How much'], title: 'Report for March' }), inputHeaders: ['Who', 'How much', 'Other'], candidates: [candidate('F1', 'Monthly')], sources: [SUPPLIER_A] });
    expect(match!.same).toBeUndefined();
  });

  it('rules that break the format lock say why (an attach is not offered for them)', () => {
    const [match] = findFormatMatches({ rules: rules({ inputHeaders: ['Client', 'Sum'], title: 'Report for April', width: 30 }), inputHeaders: ['Client', 'Sum'], candidates: [candidate('F1', 'Monthly')], sources: [SUPPLIER_A] });
    expect(match!.same).toBeUndefined();
    expect(match!.lock.map((p) => p.path)).toEqual(['output.titleRows', 'output.columns[1].width']);
  });

  it('a csv output named after another file (its "sheet") is not a lock difference: the sheet is not in the file', () => {
    const csv = (sheetName: string, inputHeaders?: [string, string]): LearnResult => {
      const r = rules({ ...(inputHeaders ? { inputHeaders } : {}), title: 'Report for March' });
      return { ...r, output: { ...r.output, file: { type: 'csv' }, sheetName } };
    };
    const [match] = findFormatMatches({
      rules: csv('orders 2026-10', ['Client', 'Sum']),
      inputHeaders: ['Client', 'Sum'],
      candidates: [candidate('F1', 'Monthly', { rules: csv('orders 2026-09') })],
      sources: [SUPPLIER_A],
    });
    expect(match!.lock).toEqual([]);
  });

  it('several formats with the same output: all of them, most recently used first', () => {
    const matches = findFormatMatches({
      rules: rules({ title: 'Report for March' }),
      inputHeaders: ['Name', 'Amount'],
      candidates: [
        candidate('F1', 'Old', { usedAt: '2026-08-01T00:00:00.000Z', conversions: [] }),
        candidate('F2', 'Recent', { usedAt: '2026-10-01T00:00:00.000Z' }),
        candidate('F3', 'Other output', { rules: rules({ outputHeaders: ['A', 'B'] }) }),
      ],
      sources: [SUPPLIER_A],
    });
    expect(matches.map((m) => [m.formatId, m.same?.id ?? null])).toEqual([
      ['F2', 'F2-C1'],
      ['F1', null],
    ]);
  });

  it('without the example input\'s headers, the rules\' declared input columns are matched', () => {
    const [match] = findFormatMatches({ rules: rules({ title: 'Report for March' }), candidates: [candidate('F1', 'Monthly')], sources: [SUPPLIER_A] });
    expect(match!.same?.id).toBe('F1-C1');
  });
});

describe('pickExampleSource', () => {
  it('one clear winner with nothing required missing, as the server reuses a source', () => {
    expect(pickExampleSource(['Name', 'Amount'], [SUPPLIER_A, SUPPLIER_B])).toBe('S1');
    expect(pickExampleSource(['Name'], [SUPPLIER_A])).toBeNull();
    expect(pickExampleSource([], [SUPPLIER_A])).toBeNull();
    expect(pickExampleSource(['Name', 'Amount'], [])).toBeNull();
    // Two sources with the same columns: no clear winner.
    expect(pickExampleSource(['Name', 'Amount'], [SUPPLIER_A, { ...SUPPLIER_A, id: 'S9' }])).toBeNull();
  });
});
