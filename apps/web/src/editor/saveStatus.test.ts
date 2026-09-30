// The Save button's status (SPEC 8.11 "Saving"), and static problems in plain words tied to the rules map's lines.
import { describe, expect, it } from 'vitest';
import type { LiveCheckResult, StaticProblem } from '../worker/editorApi';
import { explainStaticProblems } from './explain';
import { computeSaveStatus, differencesOf, metaStatusOf, stampStatus } from './saveStatus';
import { ordersRules } from './testkit';

const check = (over: Partial<LiveCheckResult> = {}): LiveCheckResult => ({
  verified: true,
  matched: 10,
  total: 10,
  differences: 0,
  perColumn: [],
  mismatches: [],
  mismatchCount: 0,
  preview: [],
  layoutProblems: [],
  partial: false,
  checkedInputRows: 10,
  totalInputRows: 10,
  ms: 1,
  ...over,
});

const rules = ordersRules();
const base = { rules, staticProblems: [] as StaticProblem[], hasExample: true, fullCheck: check() as LiveCheckResult | null };

describe('computeSaveStatus', () => {
  it('verified: every row matches', () => {
    const s = computeSaveStatus(base);
    expect(s).toEqual({ kind: 'verified' });
    expect(metaStatusOf(s)).toBe('verified');
    expect(differencesOf(s)).toBeNull();
  });

  it('"Save with N differences": differencesAccepted, with the badge number', () => {
    const s = computeSaveStatus({ ...base, fullCheck: check({ verified: false, matched: 7, total: 10, differences: 4 }) });
    expect(s).toEqual({ kind: 'differences', differences: 4 });
    expect(metaStatusOf(s)).toBe('differencesAccepted');
    expect(differencesOf(s)).toBe(4);
  });

  it('a static problem blocks saving, before anything else', () => {
    const problem: StaticProblem = { layer: 'types', kind: 'type', path: 'transform.computed[0].expr.args[0]', message: 'expected decimal, got text; use toNumber' };
    const s = computeSaveStatus({ ...base, staticProblems: [problem] });
    expect(s.kind).toBe('blocked');
    expect(metaStatusOf(s)).toBeNull();
    // even with a partial or missing check
    expect(computeSaveStatus({ ...base, staticProblems: [problem], fullCheck: null }).kind).toBe('blocked');
  });

  it('checking: static checks not back yet, or no all-rows check for these rules', () => {
    expect(computeSaveStatus({ ...base, staticProblems: null as unknown as StaticProblem[] })).toEqual({ kind: 'checking' });
    expect(computeSaveStatus({ ...base, fullCheck: null })).toEqual({ kind: 'checking' });
    expect(computeSaveStatus({ ...base, fullCheck: check({ partial: true, verified: false }) })).toEqual({ kind: 'checking' });
    expect(metaStatusOf({ kind: 'checking' })).toBeNull();
  });

  it('checkFailed: the check itself could not run, so nothing is verified (Apply tries again)', () => {
    const s = computeSaveStatus({ ...base, fullCheck: null, checkError: { code: 'workerTimeout', message: 'timed out' } });
    expect(s).toEqual({ kind: 'checkFailed', message: 'timed out' });
    expect(metaStatusOf(s)).toBeNull();
    // ...but a result for these very rules wins over an older error
    expect(computeSaveStatus({ ...base, checkError: { message: 'old' } })).toEqual({ kind: 'verified' });
  });

  it('no example: can be saved as userConfirmed', () => {
    const s = computeSaveStatus({ ...base, hasExample: false, fullCheck: null });
    expect(s).toEqual({ kind: 'noExample' });
    expect(metaStatusOf(s)).toBe('userConfirmed');
  });

  it('stampStatus writes the status into meta, and leaves a blocked or unfinished save alone', () => {
    expect(stampStatus(rules, { kind: 'differences', differences: 3 }).meta.status).toBe('differencesAccepted');
    expect(stampStatus(rules, { kind: 'noExample' }).meta.status).toBe('userConfirmed');
    expect(stampStatus(rules, { kind: 'checking' })).toBe(rules);
  });
});

describe('explainStaticProblems', () => {
  const at = (path: string, over: Partial<StaticProblem> = {}): StaticProblem => ({ layer: 'types', kind: 'type', path, message: 'expected decimal, got text; use toNumber', ...over });

  it('ties a problem to its line of the rules map and says it in plain words', () => {
    // the helper column `total` feeds output column "Total"
    const [p] = explainStaticProblems(rules, [at('transform.computed[0].expr.args[0]')]);
    expect(p).toMatchObject({ lineId: 'col:Total', where: 'Column "Total"', layer: 'types', code: 'types.type', detail: 'expected decimal, got text; use toNumber' });
    expect(p!.text).toBe('Column "Total" mixes up kinds of values: it needs a number but gets text.');
  });

  it('knows every kind of line', () => {
    const lines = (path: string, layer: StaticProblem['layer'] = 'references', message = 'unknown column id "x"') =>
      explainStaticProblems(rules, [{ layer, kind: 'reference', path, message }])[0]!.lineId;
    expect(lines('output.columns[2].from')).toBe('col:Qty');
    expect(lines('input.rowFilters[1]')).toBe('filter:1');
    expect(lines('transform.dedupe.keys[0]')).toBe('dedupe');
    expect(lines('transform.expand.labelId')).toBe('expand');
    expect(lines('transform.sort[0].column')).toBe('sort');
    expect(lines('layout.sort[0]', 'formatLock')).toBe('sort');
    expect(lines('transform.group.by')).toBe('group');
    expect(lines('transform.group.summaryRows[1]')).toBe('summary:group:1');
    expect(lines('output.summaryRows[0].cells.Qty')).toBe('summary:end:0');
    expect(lines('output.titleRows[1].parts[0].column')).toBe('title:1');
    expect(lines('validations[1].column')).toBe('check:1');
    expect(lines('output.sheetName', 'formatLock')).toBeUndefined();
  });

  it('names functions and tables by name', () => {
    const r = { ...rules, transform: { ...rules.transform, functions: [{ name: 'netOf', params: [], returns: 'decimal' as const, body: { const: 1 } }], tables: [{ name: 'rates', columns: ['k'], rows: [] }] } };
    expect(explainStaticProblems(r, [at('transform.functions[0].body')])[0]).toMatchObject({ lineId: 'fn:netOf', where: 'Function "netOf"' });
    expect(explainStaticProblems(r, [at('transform.tables[0]')])[0]).toMatchObject({ lineId: 'table:rates', where: 'Table "rates"' });
  });

  it('says each layer in its own words', () => {
    const say = (layer: StaticProblem['layer'], message: string, path?: string): string =>
      explainStaticProblems(rules, [{ layer, kind: 'x', message, ...(path ? { path } : {}) }])[0]!.text;
    expect(say('references', 'unknown column id "ghost"', 'transform.sort[0].column')).toBe('Sort uses a column ("ghost") that does not exist.');
    expect(say('references', 'unknown output header "Ghost"', 'output.summaryRows[0].cells')).toBe('Summary row 1 names a column of the file ("Ghost") that does not exist.');
    expect(say('limits', '45 rules exceeds the "anonymous" tier\'s limit of 30 rules per format')).toBe('45 rules exceeds the "anonymous" tier\'s limit of 30 rules per format. Remove some rules or upgrade.');
    expect(say('formatLock', 'must equal the format\'s header "Item", got "Vendor"', 'output.columns[0].header')).toContain('no longer matches the format');
    expect(say('structure', 'Invalid input', 'output.direction')).toBe('The output file is not valid: Invalid input.');
  });
});
