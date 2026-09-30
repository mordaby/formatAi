import { describe, expect, it } from 'vitest';
import { toWire, type LearnPayload, type LearnResult } from '@formatai/shared';
import { runChecks } from '../../src/learn/index.js';
import { basicPayload, correctRules } from './fixtures.js';

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
