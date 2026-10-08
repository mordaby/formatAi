// "You already have this format" (owner decision 2026-10-07, SPEC 5 A step 2a): before anything is learned, the saved rules of the user's
// formats are tried on the example - only for a format with this OUTPUT whose source this INPUT is - with the learn's own full verification.
// Rules that make the example exactly: nothing is learned (`path: 'known'`, no AI call, no fast path). Rules that make something else (the
// logic changed): the learn goes on, and says which format differed (`knownDiffers`).
import type { LearnPayload, LearnResult, Rules } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { exampleShapeOf, findAlreadyLearned, knownPairs, type KnownCandidates, type KnownFormats } from '../../src/learn/alreadyLearned';
import { learnFromExamples, type LearnCallResult, type LearnFromExamplesOptions } from '../../src/learn/flow';
import { formatOf, inputSignatureOf, type SavedFormatCandidate } from '../../src/registry';
import { analyzeOf, simplePair, xlsxBytesOf, type Pair } from './v5fixtures';

async function learn(pair: Pair, opts: Partial<LearnFromExamplesOptions> = {}) {
  const calls: LearnPayload[] = [];
  const r = await learnFromExamples({
    input: { bytes: await xlsxBytesOf(pair.input), name: 'in.xlsx' },
    output: { bytes: await xlsxBytesOf(pair.output), name: 'out.xlsx' },
    masking: false,
    tier: 'paid',
    callLearn: async (payload): Promise<LearnCallResult> => {
      calls.push(payload);
      return { rules: null, problems: [], calls: [] };
    },
    ...opts,
  });
  return { r, calls };
}

/** The rules the free engine learns for `pair`: what a user saved the first time. */
async function savedRulesOf(pair: Pair): Promise<LearnResult> {
  const { r } = await learn(pair, { ai: 'notAllowed' });
  expect(r.path).toBe('local');
  return r.rules!;
}

const idOf = (rules: LearnResult | Rules, header: string): string => rules.input.columns.find((c) => c.header === header)!.id;

/** A saved format with one conversion (`F?-C1`) from source `sourceId`. */
function format(id: string, name: string, rules: LearnResult | Rules, opts: { sourceId?: string; usedAt?: string } = {}): SavedFormatCandidate {
  return { id, name, format: formatOf(rules), usedAt: opts.usedAt ?? '2026-09-01T00:00:00.000Z', conversions: [{ id: `${id}-C1`, sourceId: opts.sourceId ?? 'S1', sourceName: 'Orders', version: 3 }] };
}

/** The user's saved formats as the browser hands them over: candidates once, rules per conversion (counted). */
function known(formats: SavedFormatCandidate[], rulesById: Record<string, LearnResult | Rules>, sources: KnownCandidates['sources']) {
  const rules = vi.fn(async (conversionId: string) => rulesById[conversionId] ?? null);
  const candidates = vi.fn(async () => ({ formats, sources }));
  const k: KnownFormats = { candidates, rules };
  return { k, rules, candidates };
}

const sourceOfRules = (id: string, rules: LearnResult | Rules) => ({ id, name: 'Orders', ...inputSignatureOf(rules) });

describe('the saved rules make this example exactly: nothing to learn', () => {
  it('path "known": no AI call, no fast path, and the format is named', async () => {
    const saved = await savedRulesOf(simplePair());
    const { k, rules } = known([format('F1', 'Monthly orders', saved)], { 'F1-C1': saved }, [sourceOfRules('S1', saved)]);
    const { r, calls } = await learn(simplePair(), { known: k });
    expect(r.path).toBe('known');
    expect(r.known).toEqual({ formatId: 'F1', formatName: 'Monthly orders', conversionId: 'F1-C1', sourceName: 'Orders' });
    expect(r.rules).toBeNull();
    expect(calls).toHaveLength(0);
    expect(r.stages.fastPathTried).toBe(false);
    expect(rules).toHaveBeenCalledTimes(1);
  });

  it('also when the learn was going to the AI step: it never gets there', async () => {
    const saved = await savedRulesOf(simplePair());
    const { k } = known([format('F1', 'Monthly orders', saved)], { 'F1-C1': saved }, [sourceOfRules('S1', saved)]);
    const { r, calls } = await learn(simplePair(), { known: k, ai: 'allowed' });
    expect(r.path).toBe('known');
    expect(calls).toHaveLength(0);
  });

  it('next month\'s file (other rows, same structure) is the same format too', async () => {
    const saved = await savedRulesOf(simplePair(20));
    const { k } = known([format('F1', 'Monthly orders', saved)], { 'F1-C1': saved }, [sourceOfRules('S1', saved)]);
    const { r } = await learn(simplePair(35), { known: k });
    expect(r.path).toBe('known');
  });
});

describe('the logic changed: the learn goes on', () => {
  it('saved rules that make other values: learned again, and the format that differed is said', async () => {
    const saved = await savedRulesOf(simplePair());
    const changed = structuredClone(saved);
    changed.output.columns[0]!.from = idOf(saved, 'Ref'); // "Item" made from another column
    const { k } = known([format('F1', 'Monthly orders', changed)], { 'F1-C1': changed }, [sourceOfRules('S1', changed)]);
    const { r } = await learn(simplePair(), { known: k });
    expect(r.path).toBe('local');
    expect(r.rules).not.toBeNull();
    expect(r.knownDiffers).toEqual({ formatId: 'F1', formatName: 'Monthly orders', conversionId: 'F1-C1', sourceName: 'Orders' });
  });

  it('the same values in another row order is not the same (the row order is checked, as in a learn)', async () => {
    const saved = await savedRulesOf(simplePair());
    const sorted = structuredClone(saved);
    sorted.transform.sort = [{ column: idOf(saved, 'Item'), dir: 'desc' }];
    const { k } = known([format('F1', 'Monthly orders', sorted)], { 'F1-C1': sorted }, [sourceOfRules('S1', sorted)]);
    const { r } = await learn(simplePair(), { known: k });
    expect(r.path).toBe('local');
    expect(r.knownDiffers?.formatId).toBe('F1');
  });
});

describe('nothing is run unless the output AND the input match', () => {
  it('another source (the input is not one of the format\'s sources): no "already", no rules read, nothing said', async () => {
    const saved = await savedRulesOf(simplePair());
    const other = { id: 'S2', name: 'Other', columns: [{ header: 'Code', aliases: [], type: 'text', required: true }, { header: 'Label', aliases: [], type: 'text', required: true }] };
    const { k, rules } = known([format('F1', 'Monthly orders', saved, { sourceId: 'S2' })], { 'F1-C1': saved }, [other]);
    const { r } = await learn(simplePair(), { known: k });
    expect(r.path).toBe('local');
    expect(r.knownDiffers).toBeUndefined();
    expect(rules).not.toHaveBeenCalled();
  });

  it('the input matches a source that feeds ANOTHER format only: not this one', async () => {
    const saved = await savedRulesOf(simplePair());
    const { k, rules } = known([format('F1', 'Monthly orders', saved, { sourceId: 'S9' })], { 'F1-C1': saved }, [sourceOfRules('S1', saved)]);
    const { r } = await learn(simplePair(), { known: k });
    expect(r.path).toBe('local');
    expect(rules).not.toHaveBeenCalled();
  });

  it('another output (a column named otherwise): never read', async () => {
    const saved = structuredClone(await savedRulesOf(simplePair()));
    saved.output.columns[2]!.header = 'Amount';
    const { k, rules } = known([format('F1', 'Renamed', saved)], { 'F1-C1': saved }, [sourceOfRules('S1', saved)]);
    const { r } = await learn(simplePair(), { known: k });
    expect(r.path).toBe('local');
    expect(rules).not.toHaveBeenCalled();
  });

  it('no saved formats (a visitor, or none yet): the learn is exactly as before', async () => {
    const plain = await learn(simplePair());
    const { k, candidates } = known([], {}, []);
    const checked = await learn(simplePair(), { known: k });
    expect(checked.r.path).toBe(plain.r.path);
    expect(checked.r.rules).toEqual(plain.r.rules);
    expect(checked.r.knownDiffers).toBeUndefined();
    expect(candidates).toHaveBeenCalledTimes(1);
  });

  it('formats that cannot be read are no match: the learn goes on', async () => {
    const k: KnownFormats = { candidates: async () => Promise.reject(new Error('offline')), rules: async () => null };
    const { r } = await learn(simplePair(), { known: k });
    expect(r.path).toBe('local');
  });

  it('Add a source (a target) and a completion never look: they learn against what the user already has', async () => {
    const saved = await savedRulesOf(simplePair());
    const { k, candidates } = known([format('F1', 'Monthly orders', saved)], { 'F1-C1': saved }, [sourceOfRules('S1', saved)]);
    const { r } = await learn(simplePair(), { known: k, ai: 'notAllowed', target: formatOf(saved) });
    expect(r.path).toBe('local');
    expect(candidates).not.toHaveBeenCalled();
  });
});

describe('several formats with this output', () => {
  it('each format / source pair in turn, most recently used first: the first whose rules make the example', async () => {
    const saved = await savedRulesOf(simplePair());
    const changed = structuredClone(saved);
    changed.output.columns[0]!.from = idOf(saved, 'Ref');
    const recentChanged = format('F2', 'Board report', changed, { usedAt: '2026-10-01T00:00:00.000Z' });
    const older = format('F1', 'Monthly orders', saved, { usedAt: '2026-09-01T00:00:00.000Z' });
    const { k, rules } = known([older, recentChanged], { 'F1-C1': saved, 'F2-C1': changed }, [sourceOfRules('S1', saved)]);
    const { r } = await learn(simplePair(), { known: k });
    expect(r.path).toBe('known');
    expect(r.known?.formatId).toBe('F1');
    expect(rules.mock.calls.map((c) => c[0])).toEqual(['F2-C1', 'F1-C1']);
  });

  it('stops at the first match: the others are never read', async () => {
    const saved = await savedRulesOf(simplePair());
    const { k, rules } = known(
      [format('F1', 'Monthly orders', saved, { usedAt: '2026-10-02T00:00:00.000Z' }), format('F2', 'Board report', saved)],
      { 'F1-C1': saved, 'F2-C1': saved },
      [sourceOfRules('S1', saved)],
    );
    const { r } = await learn(simplePair(), { known: k });
    expect(r.known?.formatId).toBe('F1');
    expect(rules).toHaveBeenCalledTimes(1);
  });
});

describe('the pieces', () => {
  it('the example\'s shape is headers and file kind only', () => {
    const shape = exampleShapeOf(analyzeOf(simplePair()));
    expect(shape).toEqual({ outputHeaders: ['Item', 'Ref', 'Total'], fileType: 'xlsx', headerRow: true, inputHeaders: ['Ref', 'Item', 'Qty', 'Price', 'Group'] });
  });

  it('spaces around a header do not count; a csv is not an xlsx', async () => {
    const saved = await savedRulesOf(simplePair());
    const sources = [sourceOfRules('S1', saved)];
    const shape = exampleShapeOf(analyzeOf(simplePair()));
    expect(knownPairs({ ...shape, outputHeaders: [' Item ', 'Ref', 'Total'] }, { formats: [format('F1', 'x', saved)], sources })).toHaveLength(1);
    expect(knownPairs({ ...shape, fileType: 'csv' }, { formats: [format('F1', 'x', saved)], sources })).toHaveLength(0);
    expect(knownPairs({ ...shape, headerRow: false }, { formats: [format('F1', 'x', saved)], sources })).toHaveLength(0);
  });

  it('findAlreadyLearned on an analysis made already (what the learn reuses)', async () => {
    const saved = await savedRulesOf(simplePair());
    const { k } = known([format('F1', 'Monthly orders', saved)], { 'F1-C1': saved }, [sourceOfRules('S1', saved)]);
    const check = await findAlreadyLearned(analyzeOf(simplePair()), k);
    expect(check).toMatchObject({ match: { formatId: 'F1' }, differs: [], ran: 1 });
  });
});
