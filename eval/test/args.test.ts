import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalArgsError, parseArgs } from '../lib/args.js';
import { loadCases } from '../lib/caseLoader.js';

describe('parseArgs', () => {
  it('applies the documented defaults with no flags', () => {
    const args = parseArgs([]);
    expect(args).toEqual({ masking: ['on', 'off'], runs: 1, noEscalation: false, modes: ['full'] });
  });

  it('parses --models as a comma-separated list', () => {
    expect(parseArgs(['--models', 'a,b,c']).models).toEqual(['a', 'b', 'c']);
  });

  it('parses --masking', () => {
    expect(parseArgs(['--masking', 'on']).masking).toEqual(['on']);
    expect(parseArgs(['--masking', 'off,on']).masking).toEqual(['off', 'on']);
  });

  it('rejects an invalid --masking value', () => {
    expect(() => parseArgs(['--masking', 'maybe'])).toThrow(EvalArgsError);
  });

  it('parses --runs as a positive integer', () => {
    expect(parseArgs(['--runs', '3']).runs).toBe(3);
  });

  it('rejects a non-positive or non-integer --runs', () => {
    expect(() => parseArgs(['--runs', '0'])).toThrow(EvalArgsError);
    expect(() => parseArgs(['--runs', '1.5'])).toThrow(EvalArgsError);
    expect(() => parseArgs(['--runs', 'x'])).toThrow(EvalArgsError);
  });

  it('parses --provider against the closed provider list', () => {
    expect(parseArgs(['--provider', 'fake']).provider).toBe('fake');
    expect(() => parseArgs(['--provider', 'bogus'])).toThrow(EvalArgsError);
  });

  it('parses --cases and --out as plain strings', () => {
    const args = parseArgs(['--cases', 'crm', '--out', '/tmp/x']);
    expect(args.cases).toBe('crm');
    expect(args.out).toBe('/tmp/x');
  });

  it('parses --mode: full (default), complete, both, or a comma list', () => {
    expect(parseArgs([]).modes).toEqual(['full']);
    expect(parseArgs(['--mode', 'full']).modes).toEqual(['full']);
    expect(parseArgs(['--mode', 'complete']).modes).toEqual(['complete']);
    expect(parseArgs(['--mode', 'both']).modes).toEqual(['full', 'complete']);
    expect(parseArgs(['--mode', 'complete,full']).modes).toEqual(['complete', 'full']);
    expect(parseArgs(['--mode=complete']).modes).toEqual(['complete']);
    expect(parseArgs(['--mode', 'full,full']).modes).toEqual(['full']);
  });

  it('rejects an unknown --mode, an empty one, and a missing value', () => {
    expect(() => parseArgs(['--mode', 'partial'])).toThrow(EvalArgsError);
    expect(() => parseArgs(['--mode', 'full,bogus'])).toThrow(/expected "full", "complete" or "both"/);
    expect(() => parseArgs(['--mode', ','])).toThrow(EvalArgsError);
    expect(() => parseArgs(['--mode'])).toThrow(EvalArgsError);
  });

  it('parses --no-escalation as a bare boolean flag', () => {
    expect(parseArgs(['--no-escalation']).noEscalation).toBe(true);
  });

  it('accepts --flag=value form', () => {
    const args = parseArgs(['--models=haiku,sonnet', '--runs=2']);
    expect(args.models).toEqual(['haiku', 'sonnet']);
    expect(args.runs).toBe(2);
  });

  it('combines several flags in one call', () => {
    const args = parseArgs(['--models', 'haiku,sonnet', '--masking', 'on', '--runs', '3', '--provider', 'fake', '--cases', 'crm', '--no-escalation', '--mode', 'full']);
    expect(args).toEqual({
      models: ['haiku', 'sonnet'],
      masking: ['on'],
      runs: 3,
      provider: 'fake',
      cases: 'crm',
      noEscalation: true,
      modes: ['full'],
    });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus', 'x'])).toThrow(EvalArgsError);
  });
});

describe('--cases: a substring, or a comma-separated list of them', () => {
  const casesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');
  const names = (filter?: string) => loadCases(casesDir, filter).map((c) => c.name);

  it('parses the value as it is', () => {
    expect(parseArgs(['--cases', 'crm']).cases).toBe('crm');
    expect(parseArgs(['--cases=a,b']).cases).toBe('a,b');
  });

  it('one substring keeps the cases whose name contains it (case-insensitive); none keeps all', () => {
    expect(names('PURCHASE-ORDERS')).toEqual(['purchase-orders-supplier-summary']);
    expect(names('registry-supplier-')).toEqual(['registry-supplier-a', 'registry-supplier-b', 'registry-supplier-c']);
    expect(names().length).toBeGreaterThan(10);
  });

  it('a list keeps a case that contains ANY of them: exactly the cases named', () => {
    expect(names('registry-supplier-a,registry-supplier-c,purchase-orders,stock-count')).toEqual([
      'purchase-orders-supplier-summary',
      'registry-supplier-a',
      'registry-supplier-c',
      'stock-count-warehouse-report',
    ]);
    expect(names(' crm , ,orders-dedupe')).toEqual(['crm-rename-reorder', 'orders-dedupe']);
  });
});

describe('parseArgs: --prompt (learn-v8: compare two prompt versions on the same code)', () => {
  it('takes learn-v7 or learn-v8, and nothing else; absent means the current version', () => {
    expect(parseArgs(['--prompt', 'learn-v7']).prompt).toBe('learn-v7');
    expect(parseArgs(['--prompt=learn-v8']).prompt).toBe('learn-v8');
    expect(parseArgs([]).prompt).toBeUndefined();
    expect(() => parseArgs(['--prompt', 'learn-v6'])).toThrow(EvalArgsError);
  });
});
