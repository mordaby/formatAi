// Completion mode, engine side (LEARN_PROMPT "Completing a partial rules file"): the `complete` payload field (the rules in wire form,
// constants masked like the samples), and what is missing from rules (`completionPlan`).
import type { LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { columnsReportedUnsupported, columnsWithRule, completePayloadOf, completionPlan, completionProduced, fixedLabelTexts, isCompletable, learnResultOf, missingParts } from '../../src/learn/complete';
import { createMasker, maskRules, unmaskRules } from '../../src/learn/mask';
import { partialRules } from '../../src/learn/partial';
import { buildPayload } from '../../src/learn/payload';
import { analyzeWithPreflight, mixedPair } from './v5fixtures';

function key(seed: string): Uint8Array {
  return new TextEncoder().encode(seed);
}

/** The local partial rules of the mixed pair (Item, Ref, Total built; Label needs the AI step; Warehouse is external data, which needs the AI step too), plus a filter and a computed column with text constants. */
function setup() {
  const { a, pf } = analyzeWithPreflight(mixedPair());
  const partial = partialRules(a, pf);
  if ('reason' in partial) throw new Error('no partial');
  const rules = partial.rules;
  const itemId = rules.input.columns.find((c) => c.header === 'Item')!.id;
  const fixed: LearnResult = {
    ...rules,
    input: {
      ...rules.input,
      columns: [...rules.input.columns, { id: 'group', header: 'Group', type: 'text' }],
      rowFilters: [{ column: 'group', op: 'ne', value: 'North' }, { column: 'group', op: 'ne', value: 'Zzqx' }],
    },
    transform: { ...rules.transform, computed: [...rules.transform.computed, { id: 'tag', type: 'text', expr: { op: 'concat', args: [{ col: itemId }, { const: '-Zzqx' }] } }] },
  };
  return { a, pf, partial, rules, fixed, itemId };
}

describe('completePayloadOf: the complete field', () => {
  it('carries the rules in WIRE form (formula text, key/value pairs), the columns and the parts', () => {
    const { fixed, itemId } = setup();
    fixed.transform.valueMaps = [{ column: itemId, map: { a: 'b' }, onMissing: 'keep' }];
    const c = completePayloadOf({ fixedRules: fixed, columns: [3], parts: ['sort'] });
    expect(c.columns).toEqual([3]);
    expect(c.parts).toEqual(['sort']);
    const f = c.fixed as unknown as { schemaVersion: number; transform: { computed: { id: string; expr: unknown }[]; valueMaps: { map: unknown }[] }; name?: unknown; meta?: unknown };
    expect(f.schemaVersion).toBe(1);
    const tag = f.transform.computed.find((x) => x.id === 'tag')!;
    expect(tag.expr).toBe(`concat(${itemId}, "-Zzqx")`); // formula text, not a tree
    expect(f.transform.valueMaps[0]!.map).toEqual([{ key: 'a', value: 'b' }]); // pairs, not a record
    expect(f.name).toBeUndefined();
    expect(f.meta).toBeUndefined();
  });

  it('leaves name and meta of a stored rules file out', () => {
    const { fixed } = setup();
    const stored = { ...fixed, name: 'My format', meta: { source: 'examplePair' } } as unknown as LearnResult;
    expect(Object.keys(learnResultOf(stored)).sort()).toEqual(['assumptions', 'input', 'output', 'schemaVersion', 'transform', 'unsupported', 'validations']);
    expect(JSON.stringify(completePayloadOf({ fixedRules: stored, columns: [], parts: [] }))).not.toContain('My format');
  });

  it('with masking, constants inside fixed are masked with the same map as the samples; ids, headers and formula names stay', () => {
    const { a, pf, fixed, itemId } = setup();
    const masker = createMasker(key('k1'));
    const { payload } = buildPayload(a, pf, { masker, complete: { fixedRules: fixed, columns: [3], parts: [] } });
    const c = payload.complete!;
    const f = c.fixed as unknown as {
      input: { columns: { id: string; header: string }[]; rowFilters: { column: string; value: string }[] };
      transform: { computed: { id: string; expr: string }[] };
    };
    // "North" appears in the data, so the sample cells and the filter constant are the SAME fake word.
    const fakeNorth = masker.maskText('North');
    expect(fakeNorth).not.toBe('North');
    expect(JSON.stringify(payload.samples)).toContain(fakeNorth);
    expect(f.input.rowFilters[0]).toEqual({ column: 'group', op: 'ne', value: fakeNorth });
    // A constant that is nowhere in the data is masked too (nothing the user typed leaves real).
    expect(JSON.stringify(payload)).not.toContain('Zzqx');
    expect(f.input.rowFilters[1]!.value).not.toBe('Zzqx');
    expect(f.input.rowFilters[1]!.value).toHaveLength(4);
    // Structure is real: ids, headers, the function name in the formula.
    expect(f.input.columns.map((x) => x.header)).toContain('Group');
    expect(f.input.rowFilters[0]!.column).toBe('group');
    const tag = f.transform.computed.find((x) => x.id === 'tag')!;
    expect(tag.expr).toMatch(new RegExp(`^concat\\(${itemId}, "-[A-Za-z]{4}"\\)$`));
    expect(tag.expr).not.toContain('Zzqx');
  });

  it('what was masked is unmasked again, exactly (the answer comes back in the same vocabulary)', () => {
    const { fixed } = setup();
    const masker = createMasker(key('k2'));
    const masked = maskRules(fixed, masker);
    expect(JSON.stringify(masked)).not.toContain('Zzqx');
    expect(unmaskRules(masked, masker)).toEqual(fixed);
  });

  it('a pure-digit constant is masked like an ID cell (so it matches the masked samples)', () => {
    const { fixed } = setup();
    const masker = createMasker(key('k3'));
    const withId: LearnResult = { ...fixed, input: { ...fixed.input, rowFilters: [{ column: 'group', op: 'eq', value: '40217763' }] } };
    const masked = maskRules(withId, masker) as LearnResult;
    expect((masked.input.rowFilters![0] as { value: string }).value).toBe(masker.maskIdLike('40217763'));
    expect(unmaskRules(masked, masker)).toEqual(withId);
  });

  it('without masking nothing is changed', () => {
    const { a, pf, fixed } = setup();
    const { payload } = buildPayload(a, pf, { complete: { fixedRules: fixed, columns: [3], parts: [] } });
    const f = payload.complete!.fixed as unknown as { input: { rowFilters: { value: string }[] } };
    expect(f.input.rowFilters.map((x) => x.value)).toEqual(['North', 'Zzqx']);
  });

  it('a payload without complete has no complete field', () => {
    const { a, pf } = setup();
    expect(buildPayload(a, pf).payload.complete).toBeUndefined();
  });

  it('label words in the fixed rules (title and summary-row labels) are sent real, like the labels of the example', () => {
    const { a, pf, fixed } = setup();
    const withTitle: LearnResult = { ...fixed, output: { ...fixed.output, titleRows: [{ text: 'Quarterly review' }], summaryRows: [{ label: 'Grand total', cells: { Total: 'sum' } }] } };
    expect(fixedLabelTexts(withTitle)).toEqual(['Quarterly review', 'Grand total']);
    const masker = createMasker(key('k4'));
    const { payload } = buildPayload(a, pf, { masker, complete: { fixedRules: withTitle, columns: [3], parts: [] } });
    const f = payload.complete!.fixed as unknown as { output: { titleRows: { text: string }[]; summaryRows: { label: string }[] } };
    expect(f.output.titleRows[0]!.text).toBe('Quarterly review');
    expect(f.output.summaryRows[0]!.label).toBe('Grand total');
  });
});

describe('completionPlan: what is missing', () => {
  it('EVERY output column with no rule (an external one too), and the layout parts still lacking', () => {
    const { rules } = setup();
    // Item, Ref, Total built; Label (needs the AI step) and Warehouse (no trace in the input: still the AI step's to try) have no rule.
    expect(completionPlan(rules, { parts: ['sort', 'summaryRows'] })).toEqual({ columns: [3, 4], parts: ['sort', 'summaryRows'] });
  });

  it('a column an earlier answer reported as unsupported (externalData or not) is asked for again', () => {
    const { rules } = setup();
    const reported: LearnResult = { ...rules, unsupported: [{ outputColumn: 'Label', reasonCode: 'ambiguous' }, { outputColumn: 'Warehouse', reasonCode: 'externalData' }] };
    expect(completionPlan(reported).columns).toEqual([3, 4]);
  });

  it('parts the user has built since are no longer asked for', () => {
    const { fixed } = setup();
    const done: LearnResult = { ...fixed, transform: { ...fixed.transform, sort: [{ column: 'group', dir: 'asc' }] } };
    expect(missingParts(done, ['sort', 'group', 'summaryRows', 'blankRows', 'rows', 'droppedRows', 'dateTitle'])).toEqual(['group', 'summaryRows', 'blankRows', 'rows', 'dateTitle']);
    expect(missingParts(fixed, ['droppedRows'])).toEqual([]); // the fixed rules have row filters
  });

  it('nothing missing is an empty plan', () => {
    const { rules } = setup();
    const all: LearnResult = { ...rules, output: { ...rules.output, columns: rules.output.columns.map((c) => (c.from === null ? { ...c, from: 'ref' } : c)) } };
    expect(completionPlan(all)).toEqual({ columns: [], parts: [] });
  });

  it('completionProduced: listed columns that got a rule, listed parts that were built (and lacked before)', () => {
    const { rules } = setup();
    const answer: LearnResult = {
      ...rules,
      transform: { ...rules.transform, sort: [{ column: rules.input.columns[0]!.id, dir: 'asc' }] },
      output: { ...rules.output, columns: rules.output.columns.map((c, i) => (i === 3 ? { ...c, from: rules.input.columns[0]!.id } : c)) },
    };
    expect(completionProduced(answer, rules, { columns: [3, 4], parts: ['sort', 'group'] })).toEqual({ columns: 1, parts: 1 });
    expect(completionProduced(rules, rules, { columns: [3, 4], parts: ['sort', 'group'] })).toEqual({ columns: 0, parts: 0 });
    // a part the fixed rules already had is not something the answer produced
    expect(completionProduced(answer, answer, { columns: [], parts: ['sort'] })).toEqual({ columns: 0, parts: 0 });
  });

  it('completionProduced: a listed column answered as unsupported is answered (the lock accepts it) but not produced; nothing produced at all stays nothing', () => {
    const { rules } = setup();
    const unsupported: LearnResult = { ...rules, unsupported: [{ outputColumn: 'Label', reasonCode: 'externalData' }, { outputColumn: 'Warehouse', reasonCode: 'externalData' }] };
    // Both listed columns answered as unsupported: nothing produced, whatever the entries say.
    expect(completionProduced(unsupported, rules, { columns: [3, 4], parts: [] })).toEqual({ columns: 0, parts: 0 });
    // One produced, the other answered unsupported: only the produced one counts.
    const one: LearnResult = {
      ...unsupported,
      unsupported: [{ outputColumn: 'Warehouse', reasonCode: 'externalData' }],
      output: { ...unsupported.output, columns: unsupported.output.columns.map((c, i) => (i === 3 ? { ...c, from: rules.input.columns[0]!.id } : c)) },
    };
    expect(completionProduced(one, rules, { columns: [3, 4], parts: [] })).toEqual({ columns: 1, parts: 0 });
  });

  it('columnsWithRule / columnsReportedUnsupported: what is compared with the example, and what is left empty on purpose', () => {
    const { rules } = setup();
    // Label and Warehouse have no rule (from null). Only Warehouse is reported as unsupported.
    const reported: LearnResult = { ...rules, unsupported: [{ outputColumn: 'Warehouse', reasonCode: 'externalData' }] };
    expect(columnsWithRule(reported)).toEqual([0, 1, 2]);
    expect(columnsReportedUnsupported(reported)).toEqual([4]);
    // A column with a `from` is never "reported unsupported" and is not "with a rule" when an entry says otherwise.
    const contradiction: LearnResult = { ...rules, unsupported: [{ outputColumn: 'Item', reasonCode: 'externalData' }] };
    expect(columnsReportedUnsupported(contradiction)).toEqual([]);
    expect(columnsWithRule(contradiction)).not.toContain(0);
  });

  it('isCompletable: rules the API can read back', () => {
    const { fixed } = setup();
    expect(isCompletable(fixed)).toBe(true);
    expect(isCompletable({ ...fixed, schemaVersion: 2 } as unknown as LearnResult)).toBe(false);
  });
});
