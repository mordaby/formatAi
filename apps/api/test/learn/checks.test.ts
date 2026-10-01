import { describe, expect, it } from 'vitest';
import { formulaRulesToWire } from '@formatai/engine';
import { toWire, type LearnPayload, type LearnResult } from '@formatai/shared';
import { runChecks } from '../../src/learn/index.js';
import { allUnsupportedRules, basicPayload, correctRules, externalColumnPayload, externalColumnRules } from './fixtures.js';

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

describe('runChecks: operations the prompt does not document yet (weekday, find, ...) are unknown functions', () => {
  function withExtraColumn(expr: LearnResult['transform']['computed'][number]['expr']): unknown {
    const rules = correctRules();
    const extended: LearnResult = {
      ...rules,
      // Not referenced by an output column, so only the check on the operation itself can react to it.
      transform: { ...rules.transform, computed: [...rules.transform.computed, { id: 'pos', type: 'integer', expr }] },
    };
    return toWire(formulaRulesToWire(extended) as unknown as LearnResult);
  }

  it('rejects find(...) in an LLM answer as a reference to an unknown function', () => {
    const { problems, rules } = runChecks(withExtraColumn({ op: 'find', arg: { col: 'id' }, search: 'A' }), basicPayload(), { tier: 'registered' });
    expect(problems.some((p) => p.kind === 'reference' && p.message.includes('find'))).toBe(true);
    expect(rules).not.toBeNull();
  });

  it('accepts the same rules while the answer only uses documented operations', () => {
    const { problems } = runChecks(withExtraColumn({ op: 'length', arg: { col: 'id' } }), basicPayload(), { tier: 'registered' });
    expect(problems).toEqual([]);
  });
});

describe('runChecks: the across-row (window) functions are not in the prompt yet', () => {
  function withComputed(expr: LearnResult['transform']['computed'][number]['expr'], extra: Partial<LearnResult['transform']> = {}): unknown {
    const rules = correctRules();
    const extended: LearnResult = {
      ...rules,
      transform: { ...rules.transform, ...extra, computed: [...rules.transform.computed, { id: 'run', type: 'decimal', expr }] },
    };
    return toWire(formulaRulesToWire(extended) as unknown as LearnResult);
  }

  it('reads runningSum(...) in an LLM answer as an unknown function, like any operation the prompt never documented', () => {
    // The printed formula has a named argument, which no function call can carry: a formula problem for the repair call, not a run.
    const named = withComputed({ op: 'window', fn: 'runningSum', arg: { col: 'amount' }, by: ['id'] });
    const { problems, rules } = runChecks(named, basicPayload(), { tier: 'registered' });
    expect(rules).toBeNull();
    expect(problems.some((p) => p.kind === 'formula')).toBe(true);
    // without named arguments the name is simply not a function that exists
    const bare = withComputed({ op: 'window', fn: 'rowNumber' });
    const second = runChecks(bare, basicPayload(), { tier: 'registered' });
    expect(second.problems.some((p) => p.kind === 'reference' && p.message.includes('rowNumber'))).toBe(true);
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
