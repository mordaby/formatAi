import { describe, expect, it, vi } from 'vitest';
import { formulaErrorMessagesByRecord, type RunRecord } from '../lib/runner.js';
import { buildCsvReport, buildMarkdownReport, printSummary } from '../lib/report.js';

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    case: 'crm-rename-reorder',
    domain: 'customerList',
    difficulty: 'easy',
    features: ['rename', 'fastPath'],
    model: 'haiku',
    masking: false,
    run: 1,
    path: 'local',
    classification: 'verified',
    expectationMet: true,
    holdOut: 'pass',
    fastPath: true,
    schemaValid: true,
    verifiedFirstCall: true,
    verifiedAfterRepair: true,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    costUsd: 0,
    latencyMs: 0,
    llmCalls: 0,
    formulaErrorCount: 0,
    firstCallFormulaErrors: 0,
    formulaFixedByRepair: false,
    ...overrides,
  };
}

describe('buildMarkdownReport', () => {
  it('produces one summary row per model x masking combination', () => {
    const records = [
      record({ model: 'haiku', masking: false }),
      record({ model: 'haiku', masking: true }),
      record({ model: 'sonnet', masking: false }),
    ];
    const md = buildMarkdownReport(records, '2025-01-01T00:00:00.000Z');
    expect(md).toContain('## Per model x masking');
    expect(md).toContain('| haiku | off |');
    expect(md).toContain('| haiku | on |');
    expect(md).toContain('| sonnet | off |');
  });

  it('computes shares correctly for a mixed group', () => {
    const records = [
      record({ model: 'haiku', masking: false, path: 'blocked', fastPath: false, expectationMet: true }),
      record({ model: 'haiku', masking: false, path: 'local', fastPath: true, expectationMet: true }),
      record({
        model: 'haiku',
        masking: false,
        path: 'llm',
        fastPath: false,
        schemaValid: true,
        verifiedFirstCall: false,
        verifiedAfterRepair: true,
        expectationMet: true,
        tokensIn: 100,
        tokensOut: 50,
        tokensCached: 10,
        costUsd: 0.02,
        latencyMs: 500,
        llmCalls: 2,
      }),
      record({
        model: 'haiku',
        masking: false,
        path: 'llm',
        fastPath: false,
        schemaValid: false,
        verifiedFirstCall: false,
        verifiedAfterRepair: false,
        expectationMet: false,
      }),
    ];
    const md = buildMarkdownReport(records, '2025-01-01T00:00:00.000Z');
    // 1 blocked of 4, 1 fast path of 4, 1 of 2 llm runs schema-valid, 1 of 2 verified
    // after repair, 3 of 4 expectation met.
    expect(md).toMatch(/\|\s*haiku\s*\|\s*off\s*\|\s*4\s*\|\s*25%\s*\|\s*25%\s*\|\s*50%\s*\|\s*0%\s*\|\s*50%\s*\|\s*75%/);
  });

  it('groups failures by feature, reason code and domain', () => {
    const records = [
      record({ expectationMet: false, classification: 'blocked:pivotDetected', features: ['pivot'], domain: 'sales' }),
      record({ expectationMet: false, classification: 'unsupported:externalData', features: ['externalData'], domain: 'purchaseOrders' }),
      record({ expectationMet: true }),
    ];
    const md = buildMarkdownReport(records, '2025-01-01T00:00:00.000Z');
    expect(md).toContain('2 of 3 runs did not meet');
    expect(md).toContain('| pivot | 1 |');
    expect(md).toContain('| pivotDetected | 1 |');
    expect(md).toContain('| externalData | 1 |');
    expect(md).toContain('| sales | 1 |');
    expect(md).toContain('| purchaseOrders | 1 |');
  });

  it('lists every case in the per-case table', () => {
    const records = [record({ case: 'a', domain: 'd1' }), record({ case: 'b', domain: 'd2', expectationMet: false })];
    const md = buildMarkdownReport(records, '2025-01-01T00:00:00.000Z');
    expect(md).toContain('## Per case');
    expect(md).toContain('| a | d1 |');
    expect(md).toContain('| b | d2 |');
  });
});

describe('buildMarkdownReport: formula errors (SPEC 9.2 formula-kind RepairProblem)', () => {
  it('reports the formula-error columns per model x masking group', () => {
    const records = [
      record({ model: 'haiku', masking: false, path: 'llm', llmCalls: 2, formulaErrorCount: 1, firstCallFormulaErrors: 1, formulaFixedByRepair: true }),
      record({ model: 'haiku', masking: false, path: 'llm', llmCalls: 1, formulaErrorCount: 0, firstCallFormulaErrors: 0, formulaFixedByRepair: false }),
    ];
    const md = buildMarkdownReport(records, '2025-01-01T00:00:00.000Z');
    expect(md).toContain('Formula err/call');
    expect(md).toContain('Learns w/ formula err');
    expect(md).toContain('Fixed by repair');
    // 1 formula error over 3 total llm calls = 0.33/call; 1 of 2 learns had one; 1 of 1 fixed.
    expect(md).toMatch(/\|\s*0\.33\s*\|\s*50%\s*\|\s*100%\s*\|/);
  });

  it('lists the top formula error messages, most common first, with no formula text otherwise present', () => {
    const a = record({ path: 'llm' });
    const b = record({ path: 'llm' });
    const c = record({ path: 'llm' });
    formulaErrorMessagesByRecord.set(a, ['expected ")" at 17']);
    formulaErrorMessagesByRecord.set(b, ['expected ")" at 17']);
    formulaErrorMessagesByRecord.set(c, ['round() needs 2 argument(s)']);

    const md = buildMarkdownReport([a, b, c], '2025-01-01T00:00:00.000Z');
    expect(md).toContain('## Formula errors');
    const idxCommon = md.indexOf('expected ")" at 17');
    const idxRare = md.indexOf('round() needs 2 argument(s)');
    expect(idxCommon).toBeGreaterThan(-1);
    expect(idxRare).toBeGreaterThan(idxCommon); // more common message listed first
    expect(md).toContain('| expected ")" at 17 | 2 |');
  });

  it('shows a placeholder when there are no formula errors', () => {
    const md = buildMarkdownReport([record()], '2025-01-01T00:00:00.000Z');
    expect(md).toContain('(no formula errors in this run)');
  });
});

describe('buildCsvReport', () => {
  it('writes one header row plus one row per record', () => {
    const csv = buildCsvReport([record(), record({ case: 'other' })]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('case');
    expect(lines[1]).toContain('crm-rename-reorder');
    expect(lines[2]).toContain('other');
  });

  it('quotes fields containing commas', () => {
    const csv = buildCsvReport([record({ error: 'failed: a, b' })]);
    expect(csv).toContain('"failed: a, b"');
  });

  it('includes the formula-error columns', () => {
    const csv = buildCsvReport([record({ formulaErrorCount: 2, firstCallFormulaErrors: 1, formulaFixedByRepair: true })]);
    const [header, row] = csv.trim().split('\n');
    expect(header).toContain('formulaErrorCount');
    expect(header).toContain('firstCallFormulaErrors');
    expect(header).toContain('formulaFixedByRepair');
    const headerCols = header!.split(',');
    const rowCols = row!.split(',');
    expect(rowCols[headerCols.indexOf('formulaErrorCount')]).toBe('2');
    expect(rowCols[headerCols.indexOf('firstCallFormulaErrors')]).toBe('1');
    expect(rowCols[headerCols.indexOf('formulaFixedByRepair')]).toBe('true');
  });
});

describe('printSummary', () => {
  it('prints one line per model x masking group and a run/case count', () => {
    const lines: string[] = [];
    printSummary([record(), record({ model: 'sonnet' })], (l) => lines.push(l));
    const joined = lines.join('\n');
    expect(joined).toContain('2 runs across');
    expect(joined).toContain('haiku');
    expect(joined).toContain('sonnet');
  });

  it('notes when some runs did not meet their expectation', () => {
    const lines: string[] = [];
    printSummary([record({ expectationMet: false })], (l) => lines.push(l));
    expect(lines.some((l) => l.includes('did not meet expectation'))).toBe(true);
  });

  it('defaults to console.log when no logger is given', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printSummary([record()]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
