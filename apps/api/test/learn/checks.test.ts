import { describe, expect, it } from 'vitest';
import { formulaRulesToWire } from '@formatai/engine';
import { learnPromptOf, PROMPT_VERSIONS, toWire, type LearnPayload, type LearnResult } from '@formatai/shared';
import { runChecks } from '../../src/learn/index.js';
import {
  allUnsupportedRules,
  basicPayload,
  correctRules,
  derivableColumnPayload,
  derivableColumnRules,
  externalColumnPayload,
  externalColumnRules,
  gaveUpOnDerivableRules,
} from './fixtures.js';

describe('runChecks: structure (layer 1)', () => {
  it('reports schema problems and rules:null for an unknown op', () => {
    const rules = correctRules();
    const broken = {
      ...rules,
      transform: {
        ...rules.transform,
        computed: [{ id: 'total', type: 'decimal', expr: { op: 'multiplyByTwo', arg: { col: 'amount' } } }],
      },
    };
    const { problems, rules: out } = runChecks(toWire(broken as unknown as LearnResult), basicPayload(), {
      tier: 'registered',
    });
    expect(out).toBeNull();
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.kind === 'schema')).toBe(true);
  });
});

describe('runChecks: from-null rule (layer 2)', () => {
  it('flags a skipColumns position whose output column keeps a non-null "from"', () => {
    const payload: LearnPayload = { ...basicPayload(), skipColumns: [1] };
    const { problems } = runChecks(toWire(correctRules()), payload, { tier: 'registered' });
    expect(
      problems.some((p) => p.kind === 'reference' && p.message.includes('Total') && p.message.includes('skipColumns')),
    ).toBe(true);
  });

  it('flags a "from": null output column that is not in skipColumns or unsupported', () => {
    const rules = correctRules();
    const nulledOut: LearnResult = {
      ...rules,
      output: { ...rules.output, columns: [rules.output.columns[0]!, { header: 'Total', from: null }] },
    };
    const { problems } = runChecks(toWire(nulledOut), basicPayload(), { tier: 'registered' });
    expect(
      problems.some(
        (p) => p.kind === 'reference' && p.message.includes('Total') && p.message.includes('not in skipColumns'),
      ),
    ).toBe(true);
  });

  it('is clean when skipColumns and "from": null agree', () => {
    const rules = correctRules();
    const payload: LearnPayload = { ...basicPayload(), skipColumns: [1] };
    const skipped: LearnResult = {
      ...rules,
      transform: { ...rules.transform, computed: [] },
      output: { ...rules.output, columns: [rules.output.columns[0]!, { header: 'Total', from: null }] },
    };
    const { problems } = runChecks(toWire(skipped), payload, { tier: 'registered' });
    expect(problems.filter((p) => p.kind === 'reference')).toEqual([]);
  });
});

describe('runChecks: format lock (layer 5, attach mode)', () => {
  function attachPayload(): LearnPayload {
    return {
      ...basicPayload(),
      target: {
        output: {
          file: { type: 'xlsx' },
          sheetName: 'Out',
          direction: 'ltr',
          language: 'en',
          titleRows: [],
          columns: [{ header: 'ID' }, { header: 'Total', format: '#,##0.00' }],
          summaryRows: [],
        },
        layout: { sort: [] },
        validations: [],
      },
    };
  }

  it('reports a formatMismatch when the output does not match the target format', () => {
    const { problems } = runChecks(toWire(correctRules()), attachPayload(), { tier: 'registered' });
    expect(problems.some((p) => p.kind === 'formatMismatch')).toBe(true);
  });

  it('is clean when the output matches the target format exactly', () => {
    const rules = correctRules();
    const locked: LearnResult = {
      ...rules,
      output: {
        ...rules.output,
        columns: [
          { header: 'ID', from: 'id' },
          { header: 'Total', from: 'total', format: '#,##0.00' },
        ],
      },
    };
    const { problems } = runChecks(toWire(locked), attachPayload(), { tier: 'registered' });
    expect(problems.filter((p) => p.kind === 'formatMismatch')).toEqual([]);
  });
});

describe('runChecks: overfitting lint (layer 6, never a rejection)', () => {
  it('adds an overfitSuspected assumption for a constant seen in only one sample row, without rejecting', () => {
    const rules = correctRules();
    const withSuspiciousConst: LearnResult = {
      ...rules,
      transform: {
        ...rules.transform,
        // Not referenced by any output column, so it can't change the sample-run
        // diff - only the lint should react to it. "A1" appears in sample 0's `in`
        // only (sample 1's id is "A2").
        computed: [
          ...rules.transform.computed,
          { id: 'isA1', type: 'boolean', expr: { op: 'eq', args: [{ col: 'id' }, { const: 'A1' }] } },
        ],
      },
    };

    const { problems, rules: out } = runChecks(toWire(withSuspiciousConst), basicPayload(), { tier: 'registered' });
    // The lint never rejects: it only ever appends to `assumptions`.
    expect(problems).toEqual([]);
    expect(out?.assumptions.some((a) => a.reasonCode === 'overfitSuspected')).toBe(true);
  });
});

describe('runChecks: layers 3-4 (types, limits) and layer 7 (run on samples)', () => {
  it('is fully clean and verified for a correct, simple rules file', () => {
    const { problems, rules } = runChecks(toWire(correctRules()), basicPayload(), { tier: 'registered' });
    expect(problems).toEqual([]);
    expect(rules).not.toBeNull();
  });
});

describe('runChecks: an honest "cannot produce this column" (from: null AND an unsupported entry)', () => {
  it('is left out of the sample diff: no problem at all, and the rules come back with the entry', () => {
    const { problems, rules } = runChecks(toWire(externalColumnRules()), externalColumnPayload(), { tier: 'registered' });
    expect(problems).toEqual([]);
    expect(rules?.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData' }]);
  });

  it('whatever the reason code is', () => {
    for (const code of ['externalData', 'hiddenByMasking'] as const) {
      const { problems } = runChecks(toWire(externalColumnRules(code)), externalColumnPayload(), { tier: 'registered' });
      expect(problems).toEqual([]);
    }
  });

  it('everything else is still compared: a wrong column next to it is still a diff', () => {
    const rules = externalColumnRules();
    const wrong: LearnResult = {
      ...rules,
      transform: { ...rules.transform, computed: [{ id: 'total', type: 'decimal', expr: { op: 'mul', args: [{ col: 'amount' }, { const: 3 }] } }] },
    };
    const { problems } = runChecks(toWire(wrong), externalColumnPayload(), { tier: 'registered' });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.kind === 'diff' && p.out === 1)).toBe(true);
  });

  it('a "from": null column WITHOUT an unsupported entry is still a reference problem (and is not hidden from the diff by it)', () => {
    const rules = externalColumnRules();
    const noEntry: LearnResult = { ...rules, unsupported: [] };
    const { problems } = runChecks(toWire(noEntry), externalColumnPayload(), { tier: 'registered' });
    expect(problems).toContainEqual({ kind: 'reference', message: 'output column "Warehouse" has "from": null but is not in skipColumns or unsupported' });
    // (a reference problem is a gate: the samples are not run on top of it)
    expect(problems.some((p) => p.kind === 'diff')).toBe(false);
  });

  it('every column unsupported is no verified learn: nothing is produced, so it is a problem (and no sample diff)', () => {
    const { problems, rules } = runChecks(toWire(allUnsupportedRules()), externalColumnPayload(), { tier: 'registered' });
    expect(rules).not.toBeNull();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'reference' });
    expect((problems[0] as { message: string }).message).toContain('no value at all');
  });
});

describe('runChecks: an unsupported column the app found a relation for (layer 5d)', () => {
  it('is a problem for the repair round: the column, the input columns it is built from and the hint kind - no value', () => {
    const { problems, rules } = runChecks(toWire(gaveUpOnDerivableRules()), derivableColumnPayload(), { tier: 'registered' });
    expect(rules).not.toBeNull();
    expect(problems).toEqual([
      { kind: 'unsupportedDespiteEvidence', out: 2, message: 'Column "Warehouse": the app found it is built from "Site" (copy); write a rule for it.' },
    ]);
  });

  it('a column with NO hint stays an honest unsupported: no problem (the same answer, the same payload without the hint)', () => {
    const noHint = { ...derivableColumnPayload(), hints: [] };
    expect(runChecks(toWire(gaveUpOnDerivableRules()), noHint, { tier: 'registered' }).problems).toEqual([]);
  });

  it('the answer that writes the rule has no problem at all', () => {
    expect(runChecks(toWire(derivableColumnRules()), derivableColumnPayload(), { tier: 'registered' }).problems).toEqual([]);
  });

  it('is not a gate: the sample run still runs, so one repair call also carries a diff on a column that has a rule', () => {
    const rules = gaveUpOnDerivableRules();
    const wrong: LearnResult = {
      ...rules,
      transform: { ...rules.transform, computed: [{ id: 'total', type: 'decimal', expr: { op: 'mul', args: [{ col: 'amount' }, { const: 3 }] } }] },
    };
    const { problems } = runChecks(toWire(wrong), derivableColumnPayload(), { tier: 'registered' });
    expect(problems.filter((p) => p.kind === 'unsupportedDespiteEvidence')).toHaveLength(1);
    expect(problems.some((p) => p.kind === 'diff' && p.out === 1)).toBe(true);
    expect(problems.some((p) => p.kind === 'diff' && p.out === 2)).toBe(false); // the given-up column is never compared
  });

  it("completion mode: only a column the AI step was asked for is asked about again (a fixed unsupported entry is the user's own)", () => {
    const fixed = gaveUpOnDerivableRules();
    const base = derivableColumnPayload();
    const evidenceOf = (columns: number[]) =>
      runChecks(toWire(fixed), { ...base, complete: { fixed: toWire(fixed) as Record<string, unknown>, columns, parts: [] } } as LearnPayload, { tier: 'registered' }).problems.filter(
        (p) => p.kind === 'unsupportedDespiteEvidence',
      );
    expect(evidenceOf([])).toEqual([]);
    expect(evidenceOf([2])).toHaveLength(1);
  });
});

describe('runChecks: the operations added after learn-v6 (weekday, find, ...) are documented by learn-v7, so an AI answer may use them', () => {
  function withExtraColumn(expr: LearnResult['transform']['computed'][number]['expr']): unknown {
    const rules = correctRules();
    const extended: LearnResult = {
      ...rules,
      // Not referenced by an output column, so only the check on the operation itself can react to it.
      transform: { ...rules.transform, computed: [...rules.transform.computed, { id: 'pos', type: 'integer', expr }] },
    };
    return toWire(formulaRulesToWire(extended) as unknown as LearnResult);
  }

  it('accepts find(...), weekday-style date ops and the other seven in an LLM answer: no unknown-function problem', () => {
    const { problems, rules } = runChecks(withExtraColumn({ op: 'find', arg: { col: 'id' }, search: 'A' }), basicPayload(), { tier: 'registered' });
    expect(problems).toEqual([]);
    expect(rules).not.toBeNull();
    const titled = runChecks(withExtraColumn({ op: 'find', arg: { op: 'titleCase', arg: { col: 'id' } }, search: 'A' }), basicPayload(), { tier: 'registered' });
    expect(titled.problems).toEqual([]);
  });

  it('accepts the same rules while the answer only uses documented operations', () => {
    const { problems } = runChecks(withExtraColumn({ op: 'length', arg: { col: 'id' } }), basicPayload(), { tier: 'registered' });
    expect(problems).toEqual([]);
  });
});

describe('runChecks: the across-row (window) functions are documented by learn-v7, so an AI answer may use them', () => {
  function withComputed(expr: LearnResult['transform']['computed'][number]['expr'], extra: Partial<LearnResult['transform']> = {}): unknown {
    const rules = correctRules();
    const extended: LearnResult = {
      ...rules,
      transform: { ...rules.transform, ...extra, computed: [...rules.transform.computed, { id: 'run', type: 'decimal', expr }] },
    };
    return toWire(formulaRulesToWire(extended) as unknown as LearnResult);
  }

  it('accepts runningSum(..., by: ...) and rowNumber() in a computed column of an LLM answer (named arguments and all)', () => {
    const named = withComputed({ op: 'window', fn: 'runningSum', arg: { col: 'amount' }, by: ['id'] });
    const first = runChecks(named, basicPayload(), { tier: 'registered' });
    expect(first.problems).toEqual([]);
    expect(first.rules?.transform.computed.at(-1)?.expr).toMatchObject({ op: 'window', fn: 'runningSum', by: ['id'] });
    const bare = runChecks(withComputed({ op: 'window', fn: 'rowNumber' }), basicPayload(), { tier: 'registered' });
    expect(bare.problems).toEqual([]);
  });

  it('a window written wrongly (a missing column, an order: on a group function) is a precise problem for the repair call', () => {
    const wire = (formula: string): unknown => {
      const json = withComputed({ op: 'window', fn: 'rowNumber' }) as { transform: { computed: { id: string; expr: unknown }[] } };
      json.transform.computed = json.transform.computed.map((c) => (c.id === 'run' ? { ...c, expr: formula } : c));
      return json;
    };
    const missing = runChecks(wire('runningSum()'), basicPayload(), { tier: 'registered' });
    expect(missing.rules).toBeNull();
    expect(missing.problems.some((p) => p.kind === 'formula')).toBe(true);
    const orderOnGroup = runChecks(wire('groupSum(amount, order: id)'), basicPayload(), { tier: 'registered' });
    expect(orderOnGroup.problems.some((p) => p.kind === 'formula')).toBe(true);
  });

  it('refuses a function the AI names like a built-in across-row function (it would be read as the built-in)', () => {
    const rules = correctRules();
    const named: LearnResult = {
      ...rules,
      transform: {
        ...rules.transform,
        functions: [{ name: 'rank', params: [{ name: 'x', type: 'decimal' }], returns: 'decimal', body: { param: 'x' } }],
      },
    };
    const { problems } = runChecks(toWire(formulaRulesToWire(named) as unknown as LearnResult), basicPayload(), { tier: 'registered' });
    expect(problems.some((p) => p.kind === 'reference' && p.message.includes('"rank"') && p.message.includes('built-in'))).toBe(true);
  });
});

// The system prompt's one whole example (a masked Hebrew payload and its answer) is the only text that shows the model a complete answer:
// in every version the code can send, that answer must pass every check on that payload, exactly as a real answer would.
describe('runChecks: the system prompt\'s own example answer passes every check on its example payload', () => {
  const between = (text: string, tag: string): string => {
    const m = text.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
    if (!m) throw new Error(`no <${tag}> in the prompt`);
    return m[1]!;
  };
  for (const version of PROMPT_VERSIONS) {
    it(version, () => {
      const prompt = learnPromptOf(version);
      const payload = JSON.parse(between(prompt.system, 'example_payload')) as LearnPayload;
      const answer = JSON.parse(between(prompt.system, 'example_result')) as unknown;
      const { problems, rules } = runChecks(answer, payload, { tier: 'registered', alternatives: prompt.alternatives });
      expect(problems).toEqual([]);
      expect(rules).not.toBeNull();
    });
  }
});
