// learnFromExamples in completion mode (LEARN_PROMPT "Completing a partial rules file"): the local partial result is kept as a fixed part and
// the AI step is asked only for what is missing. The fake `callLearn` plays the AI step: what matters is what the flow sends, what it accepts,
// and that what an answer changed of the fixed part is put back by code (`restoreFixed`) - or, what code cannot put back, caught and repaired:
// never silently used.
import { fromWire, LearnResultSchema, type LearnPayload, type LearnResult, type RepairProblem } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { formulaRulesFromWire } from '../../src/formula';
import { learnFromExamples, type LearnCallResult, type LearnFromExamplesOptions } from '../../src/learn/flow';
import { externalOnlyPair, mixedPair, type Pair, xlsxBytesOf } from './v5fixtures';

async function bytes(pair: Pair) {
  return { input: { bytes: await xlsxBytesOf(pair.input), name: 'in.xlsx' }, output: { bytes: await xlsxBytesOf(pair.output), name: 'out.xlsx' } };
}

/** What the visitor gets first: the local partial result (no AI step). */
async function localPartial(pair: Pair) {
  const r = await learnFromExamples({ ...(await bytes(pair)), masking: false, tier: 'paid', ai: 'notAllowed', callLearn: async () => { throw new Error('no AI step here'); } });
  if (r.path !== 'partial' || !r.rules) throw new Error(`expected a partial result, got ${r.path}`);
  return { rules: r.rules, partial: r.partial! };
}

/** The payload's `complete.fixed` read back into rules, the way the API reads it (still in the payload's vocabulary). */
function fixedOf(payload: LearnPayload): LearnResult {
  const { rules } = formulaRulesFromWire(fromWire(payload.complete!.fixed));
  return LearnResultSchema.parse(rules);
}

/** The answer that does what was asked for the mixed pair: `Label` is Group, except one row the user typed by hand (a computed column). */
function answerFor(payload: LearnPayload): LearnResult {
  const f = fixedOf(payload);
  const ref = f.input.columns.find((c) => c.header === 'Ref')!.id;
  const group = f.input.columns.find((c) => c.header === 'Group')?.id ?? 'group';
  const inputColumns = f.input.columns.some((c) => c.header === 'Group') ? f.input.columns : [...f.input.columns, { id: group, header: 'Group', type: 'text' as const }];
  return {
    ...f,
    input: { ...f.input, columns: inputColumns },
    transform: {
      ...f.transform,
      computed: [
        ...f.transform.computed,
        { id: 'labelOut', type: 'text', expr: { op: 'if', cond: { op: 'eq', args: [{ col: ref }, { const: 'R-1049' }] }, then: { const: 'Special' }, else: { col: group } } },
      ],
    },
    output: { ...f.output, columns: f.output.columns.map((c) => (c.header === 'Label' ? { ...c, from: 'labelOut' } : c)) },
  };
}

interface Spy {
  payloads: LearnPayload[];
  repairs: { problems: RepairProblem[] }[];
  callLearn: LearnFromExamplesOptions['callLearn'];
  callRepair: NonNullable<LearnFromExamplesOptions['callRepair']>;
}

function spy(answer: (payload: LearnPayload) => LearnResult | null, repaired?: (payload: LearnPayload) => LearnResult | null): Spy {
  const payloads: LearnPayload[] = [];
  const repairs: { problems: RepairProblem[] }[] = [];
  return {
    payloads,
    repairs,
    callLearn: async (payload): Promise<LearnCallResult> => {
      payloads.push(payload);
      return { rules: answer(payload), problems: [], calls: [] };
    },
    callRepair: async (payload, _previous, problems): Promise<LearnCallResult> => {
      repairs.push({ problems });
      return { rules: repaired ? repaired(payload) : null, problems: [], calls: [] };
    },
  };
}

async function complete(pair: Pair, s: Spy, over: Partial<LearnFromExamplesOptions> = {}) {
  const { rules } = await localPartial(pair);
  return learnFromExamples({
    ...(await bytes(pair)),
    masking: false,
    tier: 'paid',
    complete: { fixedRules: rules, columns: [3], parts: [] },
    callLearn: s.callLearn,
    callRepair: s.callRepair,
    ...over,
  });
}

describe('learnFromExamples with complete', () => {
  it('sends complete.fixed (the partial rules in wire form), the listed columns and parts; no fast path, no local partial', async () => {
    const s = spy(answerFor);
    const r = await complete(mixedPair(), s);
    expect(s.payloads).toHaveLength(1);
    const c = s.payloads[0]!.complete!;
    expect(c.columns).toEqual([3]);
    expect(c.parts).toEqual([]);
    const fixed = fixedOf(s.payloads[0]!);
    expect(fixed.output.columns.map((x) => [x.header, x.from === null])).toEqual([['Item', false], ['Ref', false], ['Total', false], ['Label', true], ['Warehouse', true]]);
    expect(fixed.unsupported).toEqual([]); // the local rules never call a column unsupported: only the AI step does
    expect(s.payloads[0]!.skipColumns).toBeUndefined(); // an unexplained column is not skipped
    expect(r.stages).toMatchObject({ fastPathTried: false, llmCalled: true, partialBuilt: false, readinessBlocked: false });
  });

  it('a good answer: the fixed lock holds, and everything but the column with no rule matches the example', async () => {
    const s = spy(answerFor);
    const r = await complete(mixedPair(), s);
    expect(r.path).toBe('llm');
    expect(r.completion).toEqual({ columns: [3], parts: [], fixedProblems: [], matches: true, produced: { columns: 1, parts: 0 } });
    // (Warehouse is external data: no rule, so the full verification cannot be `verified`; the completion does not count it.)
    expect(r.verification?.verified).toBe(false);
    expect(r.rules?.output.columns.find((x) => x.header === 'Label')?.from).toBe('labelOut');
    expect(r.stages).toMatchObject({ verifiedFirstCall: true, verifiedAfterRepair: true, browserRepairUsed: false });
    expect(s.repairs).toHaveLength(0);
  });

  it('an answer that changed a fixed element gets it put back by code: the lock holds, the answer is good, and no repair is asked for', async () => {
    const { rules: fixed } = await localPartial(mixedPair());
    const bad = (p: LearnPayload): LearnResult => {
      const a = answerFor(p);
      return { ...a, output: { ...a.output, columns: a.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: a.input.columns.find((i) => i.header === 'Ref')!.id } : c)) } };
    };
    const s = spy(bad);
    const r = await complete(mixedPair(), s);
    expect(r.completion).toMatchObject({ fixedProblems: [], matches: true, produced: { columns: 1, parts: 0 } });
    expect(r.rules!.output.columns.find((c) => c.header === 'Total')!.from).toBe(fixed.output.columns.find((c) => c.header === 'Total')!.from);
    expect(r.rules!.output.columns.find((c) => c.header === 'Label')!.from).toBe('labelOut'); // what it was asked for stays
    expect(r.stages).toMatchObject({ verifiedFirstCall: true, browserRepairUsed: false, verifiedAfterRepair: true });
    expect(s.repairs).toHaveLength(0);
  });

  it('a dropped fixed computed column is put back too (no repair needed)', async () => {
    const bad = (p: LearnPayload): LearnResult => {
      const a = answerFor(p);
      return { ...a, transform: { ...a.transform, computed: a.transform.computed.filter((c) => c.id === 'labelOut') } }; // dropped the fixed computed column
    };
    const s = spy(bad);
    const r = await complete(mixedPair(), s);
    expect(s.repairs).toHaveLength(0);
    expect(r.stages).toMatchObject({ verifiedFirstCall: true, browserRepairUsed: false, verifiedAfterRepair: true });
    expect(r.completion).toMatchObject({ fixedProblems: [], matches: true });
  });

  it('what code cannot put back is still a repair problem: a new value map on a column a fixed output column reads', async () => {
    const bad = (p: LearnPayload): LearnResult => {
      const a = answerFor(p);
      const ref = a.input.columns.find((i) => i.header === 'Ref')!.id;
      return { ...a, transform: { ...a.transform, valueMaps: [...a.transform.valueMaps, { column: ref, map: { 'R-1049': 'X' }, onMissing: 'keep' }] } };
    };
    const s = spy(bad, (p) => answerFor(p));
    const r = await complete(mixedPair(), s);
    expect(s.repairs).toHaveLength(1);
    expect(s.repairs[0]!.problems).toContainEqual(expect.objectContaining({ kind: 'fixedMismatch', path: expect.stringMatching(/^transform\.valueMaps\[/) }));
    expect(r.stages).toMatchObject({ verifiedFirstCall: false, browserRepairUsed: true, verifiedAfterRepair: true });
    expect(r.completion).toMatchObject({ fixedProblems: [], matches: true });
    expect(r.loop).toEqual({ rounds: 1, rowsSent: expect.any(Number), end: 'verified' });
  });

  it('a column the AI step reports as unsupported is left empty and does not spoil the answer', async () => {
    const s = spy((p) => {
      const f = fixedOf(p);
      return { ...f, unsupported: [...f.unsupported, { outputColumn: 'Label', reasonCode: 'ambiguous' }] };
    });
    const r = await complete(mixedPair(), s);
    // Label stays empty (no rule): it is reported, not compared - the lock holds and every other cell matches.
    expect(r.completion).toMatchObject({ fixedProblems: [], matches: true, produced: { columns: 0, parts: 0 } }); // ... but it produced nothing of what was asked
    expect(r.rules!.output.columns.find((x) => x.header === 'Label')!.from).toBeNull();
    expect(r.unsupported).toContainEqual({ outputColumn: 'Label', reasonCode: 'ambiguous' });
  });

  it('edits by the user may depart from the example: that is not counted against the answer - a wrong column the AI step produced is', async () => {
    const { rules } = await localPartial(mixedPair());
    const edited: LearnResult = { ...rules, output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Total' ? { ...c, header: 'Total amount' } : c)) } };
    const good = await complete(mixedPair(), spy(answerFor), { complete: { fixedRules: edited, columns: [3], parts: [] } });
    // (the header row of the example says "Total"; the user's rules say otherwise, on purpose)
    expect(good.verification?.layoutProblems.join(' ')).toContain('Total amount');
    expect(good.completion).toMatchObject({ fixedProblems: [], matches: true });

    const wrong = (p: LearnPayload): LearnResult => {
      const a = answerFor(p);
      const ref = a.input.columns.find((c) => c.header === 'Ref')!.id;
      return { ...a, output: { ...a.output, columns: a.output.columns.map((c) => (c.header === 'Label' ? { ...c, from: ref } : c)) } };
    };
    const bad = await complete(mixedPair(), spy(wrong), { complete: { fixedRules: edited, columns: [3], parts: [] } });
    expect(bad.completion).toMatchObject({ fixedProblems: [], matches: false });
  });

  it('with masking: the fixed constants leave masked, and come back unmasked - the lock compares real with real', async () => {
    const { rules } = await localPartial(mixedPair());
    const withFilter: LearnResult = {
      ...rules,
      input: { ...rules.input, columns: [...rules.input.columns, { id: 'group', header: 'Group', type: 'text' }], rowFilters: [{ column: 'group', op: 'ne', value: 'Zzqx' }] },
    };
    const s = spy(answerFor);
    const r = await learnFromExamples({
      ...(await bytes(mixedPair())),
      masking: true,
      key: new TextEncoder().encode('flow-complete-key'),
      tier: 'paid',
      complete: { fixedRules: withFilter, columns: [3], parts: [] },
      callLearn: s.callLearn,
      callRepair: s.callRepair,
    });
    expect(JSON.stringify(s.payloads[0])).not.toContain('Zzqx');
    expect(r.completion!.fixedProblems).toEqual([]);
    expect((r.rules!.input.rowFilters![0] as { value: string }).value).toBe('Zzqx'); // unmasked again
  });

  it('with masking: a dropped fixed filter is put back by code (no repair asked for it), and no call carries the real word', async () => {
    const { rules } = await localPartial(mixedPair());
    const withFilter: LearnResult = {
      ...rules,
      input: { ...rules.input, columns: [...rules.input.columns, { id: 'group', header: 'Group', type: 'text' }], rowFilters: [{ column: 'group', op: 'ne', value: 'Zzqx' }] },
    };
    // the answer drops the user's row filter
    const dropsFilter = (p: LearnPayload): LearnResult => {
      const a = answerFor(p);
      return { ...a, input: { ...a.input, rowFilters: [] } };
    };
    const s = spy(dropsFilter);
    const r = await learnFromExamples({
      ...(await bytes(mixedPair())),
      masking: true,
      key: new TextEncoder().encode('flow-complete-key'),
      tier: 'paid',
      complete: { fixedRules: withFilter, columns: [3], parts: [] },
      callLearn: s.callLearn,
      callRepair: s.callRepair,
    });
    // v12: the learning loop puts back what an answer changed of the fixed rules (restoreFixed) before the checks decide
    expect(r.completion!.fixedProblems).toEqual([]);
    expect((r.rules!.input.rowFilters![0] as { value: string }).value).toBe('Zzqx'); // the user's filter, real again
    expect(s.repairs.flatMap((rq) => rq.problems).filter((p) => p.kind === 'fixedMismatch')).toEqual([]);
    expect(JSON.stringify([s.payloads, s.repairs.map((rq) => rq.problems)])).not.toContain('Zzqx');
  });

  it('what is asked for does not depend on the readiness gate: only external columns left still goes to the AI step', async () => {
    const s = spy((p) => fixedOf(p));
    const { rules } = await localPartial(externalOnlyPair());
    const r = await learnFromExamples({
      ...(await bytes(externalOnlyPair())),
      masking: false,
      tier: 'paid',
      complete: { fixedRules: rules, columns: [], parts: ['sort'] },
      callLearn: s.callLearn,
    });
    expect(s.payloads).toHaveLength(1);
    expect(r.path).toBe('llm');
  });

  it('refuses what cannot work: attach mode, no AI step, rules the API could not read', async () => {
    const s = spy(answerFor);
    const { rules } = await localPartial(mixedPair());
    const base = { ...(await bytes(mixedPair())), masking: false, tier: 'paid' as const, callLearn: s.callLearn };
    await expect(learnFromExamples({ ...base, complete: { fixedRules: rules, columns: [3], parts: [] }, ai: 'notAllowed' })).rejects.toThrow(/not allowed/);
    await expect(learnFromExamples({ ...base, complete: { fixedRules: { ...rules, schemaVersion: 9 } as unknown as LearnResult, columns: [3], parts: [] } })).rejects.toThrow(/not a valid rules file/);
    await expect(
      learnFromExamples({ ...base, complete: { fixedRules: rules, columns: [3], parts: [] }, target: { output: rules.output as never, layout: { sort: [] }, outputValidations: [] } }),
    ).rejects.toThrow(/cannot be combined/);
    expect(s.payloads).toHaveLength(0);
  });

  it('a plain learn is unchanged: no complete in the payload, no completion in the result', async () => {
    const s = spy(() => null);
    const r = await learnFromExamples({ ...(await bytes(mixedPair())), masking: false, tier: 'paid', callLearn: s.callLearn });
    expect(s.payloads[0]!.complete).toBeUndefined();
    expect(r.completion).toBeUndefined();
  });
});
