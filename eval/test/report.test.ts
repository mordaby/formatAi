import { describe, expect, it, vi } from 'vitest';
import { callsOf, formulaErrorMessagesByRecord, type RunRecord } from '../lib/runner.js';
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
    estInTokens: 0,
    estCachedTokens: 0,
    estCacheWriteTokens: 0,
    estOutTokens: 0,
    estCostUsd: 0,
    loopRounds: 0,
    loopRowsSent: 0,
    loopEnd: '',
    checkRounds: 0,
    checksAsked: 0,
    filledByCode: '',
    ambiguities: '',
    prompt: 'learn-v8',
    alternativesProposed: 0,
    alternatives: '',
    unsupportedDespiteEvidence: 0,
    unsupportedReasons: '',
    problemsByKind: '',
    truncatedCalls: 0,
    callFailures: '',
    overfitSuspected: 0,
    overfitFound: 0,
    overfitFellBack: 0,
    oneTimeAsked: 0,
    oneTimeParts: '',
    oneTimeDefault: '',
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

describe('reports with modes (completion mode)', () => {
  const full = (over: Partial<RunRecord> = {}) => record({ mode: 'full', path: 'llm', fastPath: false, classification: 'verified', tokensIn: 1000, tokensOut: 400, llmCalls: 1, payloadBytes: 8192, ...over });
  const complete = (over: Partial<RunRecord> = {}) =>
    record({ mode: 'complete', path: 'llm', fastPath: false, classification: 'verified', tokensIn: 300, tokensOut: 120, llmCalls: 1, payloadBytes: 3072, fixedColumns: 4, missingColumns: 2, missingParts: 1, ...over });

  it('a run without modes keeps the report exactly as it was: no Mode column, no completion section, no extra CSV columns', () => {
    const records = [record(), record({ case: 'b' })];
    const md = buildMarkdownReport(records, '2025-01-01T00:00:00.000Z');
    expect(md).not.toContain('| Mode |');
    expect(md).not.toContain('Completion');
    expect(buildCsvReport(records).split('\n')[0]!.split(',')).not.toContain('mode');
  });

  it('with both modes: a Mode column, and full vs completion side by side per case, with tokens and payload size', () => {
    const records = [full({ case: 'budget' }), complete({ case: 'budget' })];
    const md = buildMarkdownReport(records, '2025-01-01T00:00:00.000Z');
    expect(md).toContain('| Model | Masking | Mode |');
    expect(md).toContain('| haiku | off | full |');
    expect(md).toContain('| haiku | off | complete |');
    expect(md).toContain('## Full vs completion (side by side)');
    expect(md).toContain('| budget | verified | 8.0 | 1000 / 400 | 1.0 | verified | 4 | 2 / 1 | 3.0 | 300 / 120 | 1.0 |');
    // the per-case table says which mode each row is
    expect(md).toContain('| budget | full |');
    expect(md).toContain('| budget | complete |');
  });

  it('with complete only: the completion details (fixed and missing, and why no call was made)', () => {
    const records = [complete({ case: 'budget' }), complete({ case: 'crm', path: 'local', llmCalls: 0, payloadBytes: 0, missingColumns: 0, missingParts: 0, completionSkipped: 'local', tokensIn: 0, tokensOut: 0 })];
    const md = buildMarkdownReport(records, '2025-01-01T00:00:00.000Z');
    expect(md).toContain('## Completion details');
    expect(md).not.toContain('side by side');
    expect(md).toContain('| budget | verified | 4 | 2 | 1 |');
    expect(md).toContain('| crm | verified | 4 | 0 | 0 | local |');
  });

  it('the CSV gets mode, payload and completion columns only when there are modes', () => {
    const csv = buildCsvReport([full(), complete()]);
    const [head, ...rows] = csv.trim().split('\n');
    expect(head).toContain('mode,payloadBytes,fixedColumns,missingColumns,missingParts,completionSkipped,error');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('complete');
  });

  it('the stdout summary names the mode', () => {
    const lines: string[] = [];
    printSummary([full(), complete()], (l) => lines.push(l));
    expect(lines.join('\n')).toContain('masking=off mode=full');
    expect(lines.join('\n')).toContain('masking=off mode=complete');
  });
});

describe('token usage and cost (our own estimate)', () => {
  /** A learn that made LLM calls: priced, with a cache write on the first call and a read on the repair. */
  const aiLearn = (over: Partial<RunRecord> = {}) =>
    record({
      path: 'llm',
      fastPath: false,
      classification: 'verified',
      llmCalls: 2,
      latencyMs: 12_000,
      estInTokens: 3000,
      estCachedTokens: 10_000,
      estCacheWriteTokens: 10_000,
      estOutTokens: 1500,
      estCostUsd: 0.04,
      loopRounds: 1,
      loopRowsSent: 8,
      loopEnd: 'verified',
      ...over,
    });

  it('has a section with the totals and the average per learn, over the learns that made an LLM call only', () => {
    const records = [aiLearn({ case: 'a', holdOut: 'pass' }), aiLearn({ case: 'b', classification: 'notVerified', holdOut: 'fail', estCostUsd: 0.06, llmCalls: 3, estOutTokens: 2500, loopRounds: 2, loopRowsSent: 13, loopEnd: 'noProgress' }), record({ case: 'free' })];
    const md = buildMarkdownReport(records, '2025-01-01T00:00:00.000Z');
    expect(md).toContain('## Token usage and cost (our own estimate)');
    // 2 AI learns (the free-engine learn costs nothing and is not counted): totals, then the average per learn
    expect(md).toContain('| haiku | off | total | 2 | 5 | 3 | 21 | noProgress 1, verified 1 | 6000 | 20000 | 20000 | 4000 | 0.1000 | 24.0 | 1 of 2 | 1 of 2 |');
    expect(md).toContain('| haiku | off | average per learn |  | 2.50 | 1.50 | 10.5 |  | 3000 | 10000 | 10000 | 2000 | 0.0500 | 12.0 | 50% | 50% |');
  });

  it('lists every AI learn with its calls, loop rounds, rows sent and how the loop ended, tokens, cost, latency, verification and hold-out', () => {
    const md = buildMarkdownReport([aiLearn({ case: 'orders-priority', holdOut: 'fail', classification: 'notVerified', loopRounds: 3, loopRowsSent: 24, loopEnd: 'roundCap' }), record({ case: 'free' })], '2025-01-01T00:00:00.000Z');
    expect(md).toContain('### Per learn');
    expect(md).toContain('| orders-priority | haiku | off | 1 | 2 | 3 | 24 | roundCap | - | - | - | 3000 | 10000 | 10000 | 1500 | 0.0400 | 12.0 | no | fail |');
    expect(md).not.toContain('| free | haiku | off | 1 |');
  });

  it('says per learn what code filled from every row and what the example could not settle (kinds and counts), and puts both in the CSV', () => {
    const learn = aiLearn({ case: 'branch-lookup-50', filledByCode: 'lookup 47, cutoff 1, 1 check', ambiguities: 'dayMonthOrder' });
    const md = buildMarkdownReport([learn], '2025-01-01T00:00:00.000Z');
    expect(md).toContain('| branch-lookup-50 | haiku | off | 1 | 2 | 1 | 8 | verified | lookup 47, cutoff 1, 1 check | dayMonthOrder | - | 3000 |');
    const [head, row] = buildCsvReport([learn]).trim().split('\n');
    const cols = head!.split(',');
    expect(cols.slice(cols.indexOf('loopEnd') + 1, cols.indexOf('loopEnd') + 3)).toEqual(['filledByCode', 'ambiguities']);
    expect(row).toContain('"lookup 47, cutoff 1, 1 check",dayMonthOrder');
  });

  it('the prompt audit\'s columns (section 5): hinted columns given up on, unsupported reasons, problem kinds, cut-off or failed calls, overfit - per learn, in the totals and in the CSV', () => {
    const learn = aiLearn({ case: 'orders-priority', unsupportedDespiteEvidence: 2, unsupportedReasons: 'ambiguous 1', problemsByKind: 'diff 4, unsupportedDespiteEvidence 2', truncatedCalls: 1, callFailures: 'truncated 1', overfitSuspected: 1 });
    const md = buildMarkdownReport([learn, aiLearn({ case: 'b' })], '2025-01-01T00:00:00.000Z');
    expect(md).toContain('| yes | pass | 2 | ambiguous 1 | diff 4, unsupportedDespiteEvidence 2 | truncated 1 | 1 |');
    expect(md).toContain('| yes | pass | 0 | - | - | - | 0 |');
    expect(md).toContain('| 2 of 2 | 2 of 2 | 2 | 1 |');
    expect(md).toContain('| 100% | 100% | 1.00 | 0.50 |');
    const [head, row] = buildCsvReport([learn]).trim().split('\n');
    const cols = head!.split(',');
    const at = cols.indexOf('alternatives');
    expect(cols.slice(at + 1, at + 9)).toEqual(['unsupportedDespiteEvidence', 'unsupportedReasons', 'problemsByKind', 'truncatedCalls', 'callFailures', 'overfitSuspected', 'overfitFound', 'overfitFellBack']);
    expect(row).toContain(',2,ambiguous 1,"diff 4, unsupportedDespiteEvidence 2",1,truncated 1,1,0,0,');
  });

  it('the overfitting guards (SPEC 9.2 layer 6): what the calls found and what code reported, per learn and in the CSV', () => {
    const learn = aiLearn({ case: 'fulfillment-external-column', problemsByKind: 'overfit 1', unsupportedReasons: 'overfit 1', overfitFound: 1, overfitFellBack: 1 });
    const md = buildMarkdownReport([learn, aiLearn({ case: 'b' })], '2025-01-01T00:00:00.000Z');
    expect(md).toContain('| overfit 1 | overfit 1 | - | 0 | found 1, fell back 1 |');
    expect(md).toContain('| - | - | - | 0 | - |');
    expect(md).toContain('"Copies rows"');
    const [, row] = buildCsvReport([learn]).trim().split('\n');
    expect(row).toContain(',0,overfit 1,overfit 1,0,,0,1,1,');
  });

  it('a one-time edit or a rule? (SPEC 21 v12 item 20): what would be asked and what answering "one-time" does, per learn, in the CSV and on stdout', () => {
    const learn = aiLearn({ case: 'discount-hand-edited', oneTimeAsked: 2, oneTimeParts: 'Discount r54 id, Discount r99 id', oneTimeDefault: 'one-time: holdOut pass' });
    const md = buildMarkdownReport([learn, aiLearn({ case: 'b' })], '2025-01-01T00:00:00.000Z');
    expect(md).toContain('| - | Discount r54 id, Discount r99 id; one-time: holdOut pass |');
    expect(md).toContain('"One-time"');
    const [head, row] = buildCsvReport([learn]).trim().split('\n');
    const cols = head!.split(',');
    expect(cols.slice(cols.indexOf('overfitFellBack') + 1, cols.indexOf('overfitFellBack') + 4)).toEqual(['oneTimeAsked', 'oneTimeParts', 'oneTimeDefault']);
    expect(row).toContain(',2,"Discount r54 id, Discount r99 id",one-time: holdOut pass,');
    const lines: string[] = [];
    printSummary([learn], (l) => lines.push(l));
    expect(lines.some((l) => l.includes('one-time questions: 2 in 1 learn(s) - discount-hand-edited: Discount r54 id, Discount r99 id (one-time: holdOut pass)'))).toBe(true);
  });

  it('callsOf: counts from the call records and the kept answer only - never a message or a value', () => {
    const call = (outcome: string, counts: Record<string, number>) => ({ outcome, problemCounts: { formula: 0, diff: 0, unsupportedDespiteEvidence: 0, truncated: 0, invalidAlternative: 0, ...counts } });
    const result = {
      path: 'llm' as const,
      calls: [call('needsRepair', { diff: 3, unsupportedDespiteEvidence: 1, invalidAlternative: 2 }), call('truncated', { truncated: 1 }), call('error:timeout', { schema: 1 }), call('verified', {})],
      rules: { unsupported: [{ outputColumn: 'A', reasonCode: 'externalData' }, { outputColumn: 'B', reasonCode: 'hiddenByMasking' }, { outputColumn: 'C', reasonCode: 'externalData' }], assumptions: [{ reasonCode: 'overfitSuspected' }, { reasonCode: 'filterGuessed' }] },
    };
    expect(callsOf(result as never)).toEqual({
      unsupportedDespiteEvidence: 1,
      unsupportedReasons: 'externalData 2, hiddenByMasking 1',
      problemsByKind: 'diff 3, schema 1, truncated 1, unsupportedDespiteEvidence 1',
      truncatedCalls: 1,
      callFailures: 'error:timeout 1, truncated 1',
      overfitSuspected: 1,
      overfitFound: 0,
      overfitFellBack: 0,
    });
    expect(callsOf({ path: 'local', calls: [], rules: null } as never)).toEqual({ unsupportedDespiteEvidence: 0, unsupportedReasons: '', problemsByKind: '', truncatedCalls: 0, callFailures: '', overfitSuspected: 0, overfitFound: 0, overfitFellBack: 0 });
    // The overfitting guards: the overfit problems over every call, the kept answer's columns code reported; the fallbacks themselves
    // (a count beside the problem kinds, like the dropped alternatives) are not a problem kind.
    const guarded = {
      path: 'llm' as const,
      calls: [call('needsRepair', { overfit: 1 }), call('verified', { overfitFallback: 1 })],
      rules: { unsupported: [{ outputColumn: 'W', reasonCode: 'overfit' }], assumptions: [] },
    };
    expect(callsOf(guarded as never)).toMatchObject({ problemsByKind: 'overfit 1', unsupportedReasons: 'overfit 1', overfitFound: 1, overfitFellBack: 1 });
  });

  it('shows n/a, never a guess, for a model with no price', () => {
    const md = buildMarkdownReport([aiLearn({ estCostUsd: null })], '2025-01-01T00:00:00.000Z');
    expect(md).toContain('| n/a |');
    expect(md).not.toContain('0.0400');
  });

  it('says so when no call was made', () => {
    expect(buildMarkdownReport([record()], '2025-01-01T00:00:00.000Z')).toContain('(no LLM call in this run)');
  });

  it('puts the estimate in the CSV, after the call count', () => {
    const csv = buildCsvReport([aiLearn({ estCostUsd: null })]);
    const [head, row] = csv.trim().split('\n');
    const cols = head!.split(',');
    expect(cols.slice(cols.indexOf('llmCalls'), cols.indexOf('llmCalls') + 6)).toEqual(['llmCalls', 'estInTokens', 'estCachedTokens', 'estCacheWriteTokens', 'estOutTokens', 'estCostUsd']);
    const values = row!.split(',');
    expect(values[cols.indexOf('estCacheWriteTokens')]).toBe('10000');
    expect(values[cols.indexOf('estCostUsd')]).toBe('');
    expect(cols.slice(cols.indexOf('estCostUsd') + 1, cols.indexOf('estCostUsd') + 4)).toEqual(['loopRounds', 'loopRowsSent', 'loopEnd']);
    expect([values[cols.indexOf('loopRounds')], values[cols.indexOf('loopRowsSent')], values[cols.indexOf('loopEnd')]]).toEqual(['1', '8', 'verified']);
  });

  it('the stdout summary prints the totals and the per-learn numbers, with the cost, latency, verification and hold-out', () => {
    const lines: string[] = [];
    printSummary([aiLearn({ holdOut: 'pass' }), aiLearn({ holdOut: 'pass' })], (l) => lines.push(l));
    const text = lines.join('\n');
    expect(text).toContain('over 2 AI learn(s), 4 call(s): in 6000 / cached 20000 / cache write 20000 / out 3000, est. cost $0.0800, 24.0 s');
    expect(text).toContain('per learn: in 3000 / cached 10000 / cache write 10000 / out 1500, est. cost $0.0400, 12.0 s');
    expect(text).toContain('loop: 2 round(s), 16 row(s) sent, ends verified 2; verified on example 2 of 2, hold-out 2 of 2');
  });

  it('prints no usage line for a run without LLM calls', () => {
    const lines: string[] = [];
    printSummary([record()], (l) => lines.push(l));
    expect(lines.join('\n')).not.toContain('est. tokens');
  });
});

describe('expected outcomes in words', () => {
  it('prints a case note next to the case, without scoring it', () => {
    const md = buildMarkdownReport([record({ case: 'discount-hand-edited', expectNote: 'the rule for the rest, the 3 rows reported', expectationMet: false })], '2025-01-01T00:00:00.000Z');
    expect(md).toContain('## Expected outcomes in words');
    expect(md).toContain('| discount-hand-edited | the rule for the rest, the 3 rows reported |');
  });

  it('has no such section when no case has a note', () => {
    expect(buildMarkdownReport([record()], '2025-01-01T00:00:00.000Z')).not.toContain('Expected outcomes in words');
  });
});

describe('learn-v8: the alternatives of each learn, and the prompt version', () => {
  const aiLearn = (over: Partial<RunRecord> = {}) => record({ path: 'llm', fastPath: false, classification: 'verified', llmCalls: 2, latencyMs: 12_000, estInTokens: 3000, estCachedTokens: 10_000, estCacheWriteTokens: 10_000, estOutTokens: 1500, estCostUsd: 0.04, loopRounds: 1, loopRowsSent: 8, loopEnd: 'verified', ...over });
  it('per learn: the alternatives and their outcomes; the CSV has the prompt, the number proposed and the outcomes; the header says the prompt', () => {
    const learn = aiLearn({ case: 'orders-priority', alternativesProposed: 3, alternatives: 'Priority bothPass, Tag alternativeOnly, invalid 1' });
    const md = buildMarkdownReport([learn], '2025-01-01T00:00:00.000Z');
    expect(md).toContain('Prompt: learn-v8');
    expect(md).toContain('| verified | - | - | Priority bothPass, Tag alternativeOnly, invalid 1 | 3000 |');
    const [head, row] = buildCsvReport([learn]).trim().split('\n');
    const cols = head!.split(',');
    expect(cols.slice(cols.indexOf('ambiguities') + 1, cols.indexOf('ambiguities') + 4)).toEqual(['prompt', 'alternativesProposed', 'alternatives']);
    expect(row).toContain('learn-v8,3,"Priority bothPass, Tag alternativeOnly, invalid 1"');
  });

  it('the stdout summary counts the outcomes across the learns', () => {
    const lines: string[] = [];
    printSummary(
      [
        aiLearn({ case: 'a', alternativesProposed: 2, alternatives: 'Priority bothPass, invalid 1' }),
        aiLearn({ case: 'b', alternativesProposed: 1, alternatives: 'Tag alternativeOnly' }),
        aiLearn({ case: 'c' }),
      ],
      (l) => lines.push(l),
    );
    expect(lines.find((l) => l.includes('alternatives:'))).toBe('    alternatives: 3 proposed in 2 learn(s) - bothPass 1, alternativeOnly 1, invalid 1');
  });

  it('says nothing about alternatives when no learn had any', () => {
    const lines: string[] = [];
    printSummary([aiLearn({ case: 'a' })], (l) => lines.push(l));
    expect(lines.some((l) => l.includes('alternatives:'))).toBe(false);
  });
});
