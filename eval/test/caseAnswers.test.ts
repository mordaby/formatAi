// Two learn-v7 regressions of the Haiku eval (2026-10-02), pinned WITHOUT any LLM: the real eval cases, the real learn pipeline (payload, API
// checks, server repair round, the browser's verification), and canned answers from the fake provider. Nothing here may reach a real provider.
//
//  - purchase-orders-supplier-summary (a summary output, one row per supplier): the right answer - group + column aggs + a Total row - was
//    rejected by the API's own checks (a count of an id column "is not an integer"; a sample run that "differs" on every group because the
//    samples hold one row per group), so no attempt could ever be clean. It verifies on the first call now.
//  - registry-supplier-c (attach): the answer gave up on a column ("unsupported externalData") that the analysis had a hint for, and was
//    accepted without a repair. It is repaired now.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '@formatai/api/env';
import type { CompleteFn } from '@formatai/api/learn';
import { formatOf, formulaRulesToWire, readWorkbook } from '@formatai/engine';
import { toWire, type LearnResult } from '@formatai/shared';
import { loadCase, type CaseDef } from '../lib/caseLoader';
import { applyCaseAnswers, rulesByRecord, runLearn, runMatrix } from '../lib/runner';

const env = loadEnv({ ...process.env, LLM_PROVIDER: 'fake' });
const CASES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');
const load = (name: string): CaseDef => loadCase(path.join(CASES, name))!;

/** The wire form of a rules file, as the AI step writes it. */
function wireOf(rules: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(rules)) as Record<string, unknown>;
  delete copy.name;
  delete copy.meta;
  return toWire(formulaRulesToWire(copy as unknown as LearnResult) as unknown as LearnResult);
}

/** A provider that answers with `answers` in order, and keeps every request it got. */
function scripted(answers: unknown[]): { complete: CompleteFn; requests: { content: { text: string }[] }[] } {
  const requests: { content: { text: string }[] }[] = [];
  const complete: CompleteFn = async (req) => {
    requests.push(req as never);
    const json = answers.shift();
    return { json, raw: JSON.stringify(json), model: 'fake', usage: { tokensIn: 1, tokensOut: 1, tokensCachedRead: 0, tokensCachedWrite: 0 }, costUsd: 0, latencyMs: 0 } as never;
  };
  return { complete, requests };
}

describe('purchase-orders-supplier-summary: the right summary answer is clean in the API checks and verifies on the first call', () => {
  it.each([false, true])('masking %s', async (masking) => {
    const c = load('purchase-orders-supplier-summary');
    const { complete, requests } = scripted([wireOf(c.referenceRules)]);
    const ran = await runLearn({ caseDef: c, masking, model: 'fake', run: 1, env, noEscalation: false, complete });

    expect(requests).toHaveLength(1); // no repair, no escalation: the first answer had no problem
    expect(ran.result.calls).toHaveLength(1);
    expect(ran.result.calls[0]!.problemCounts).toMatchObject({ type: 0, diff: 0, rowCount: 0, unsupportedDespiteEvidence: 0 });
    expect(ran.result.stages).toMatchObject({ llmCalled: true, verifiedFirstCall: true, browserRepairUsed: false, verifiedAfterRepair: true });
    expect(ran.result.verification).toMatchObject({ verified: true, mismatches: [] });
  });

  it('the payload says summary, and carries aggregate hints but no window hint (a window is for a row-per-row output)', async () => {
    const c = load('purchase-orders-supplier-summary');
    const { complete, requests } = scripted([wireOf(c.referenceRules)]);
    await runLearn({ caseDef: c, masking: false, model: 'fake', run: 1, env, noEscalation: false, complete });
    const payload = JSON.parse(requests[0]!.content[0]!.text) as { output: { layout: { summary: boolean } }; hints: { rel: string }[] };
    expect(payload.output.layout.summary).toBe(true);
    expect(payload.hints.some((h) => h.rel === 'window')).toBe(false);
    expect(payload.hints.filter((h) => h.rel === 'aggregate').length).toBeGreaterThan(0);
  });
});

describe('registry-supplier-c: giving up on a column the analysis explained is repaired', () => {
  const attach = () => ({ caseDef: load('registry-supplier-c'), target: formatOf(load('registry-supplier-a').referenceRules!) });
  const gaveUp = (c: CaseDef): unknown => {
    const rules = JSON.parse(JSON.stringify(c.referenceRules)) as { output: { columns: { header: string; from: string | null }[] }; unsupported: unknown[] };
    rules.output.columns.find((x) => x.header === 'Unit Price')!.from = null;
    rules.unsupported = [{ outputColumn: 'Unit Price', reasonCode: 'externalData' }];
    return wireOf(rules);
  };

  it('the server repair round asks for it (the hint is named, no value) and the next answer verifies', async () => {
    const { caseDef, target } = attach();
    const { complete, requests } = scripted([gaveUp(caseDef), wireOf(caseDef.referenceRules)]);
    const ran = await runLearn({ caseDef, masking: false, model: 'fake', run: 1, env, noEscalation: true, target, complete });

    expect(ran.result.calls.map((x) => x.purpose)).toEqual(['learn', 'repair']);
    expect(ran.result.calls[0]!.problemCounts.unsupportedDespiteEvidence).toBe(1);
    const repair = requests[1]!.content[1]!.text;
    expect(repair).toContain('"kind":"unsupportedDespiteEvidence"');
    expect(repair).toContain('the app found it is built from');
    expect(repair).toContain('(copy); write a rule for it.');
    expect(ran.result.unsupported).toEqual([]);
    expect(ran.result.stages).toMatchObject({ verifiedAfterRepair: true });
    expect(ran.result.verification).toMatchObject({ verified: true });
  });

  it('a model that insists is asked once more by the browser (one loop round, with its own server repair), then accepted: the column stays unsupported', async () => {
    const { caseDef, target } = attach();
    const { complete } = scripted([gaveUp(caseDef), gaveUp(caseDef), gaveUp(caseDef), gaveUp(caseDef)]);
    const ran = await runLearn({ caseDef, masking: false, model: 'fake', run: 1, env, noEscalation: true, target, complete });

    // the learn and its server repair; the browser's round and ITS server repair (the server's checks still name the column)
    expect(ran.result.calls.map((x) => x.purpose)).toEqual(['learn', 'repair', 'repair', 'repair']);
    expect(ran.result.stages).toMatchObject({ verifiedFirstCall: false, browserRepairUsed: true, verifiedAfterRepair: true });
    expect(ran.result.loop).toMatchObject({ rounds: 1, end: 'verified' });
    expect(ran.result.unsupported).toEqual([{ outputColumn: 'Unit Price', reasonCode: 'externalData' }]);
  });
});

describe('the learning loop in the runner: the same rounds the browser makes, recorded per learn', () => {
  /**
   * The case's reference rules with "Urgent" narrowed to amounts below 5,100: right on the 12 samples (their one Urgent order is the
   * 5,000 one), wrong on the four urgent orders the sample does not hold (5,340.50 to 6,455.80).
   */
  const narrowUrgent = (c: CaseDef): unknown => {
    const gte = '{"op":"gte","args":[{"col":"amount"},{"const":5000}]}';
    const json = JSON.stringify(c.referenceRules);
    if (!json.includes(gte)) throw new Error('orders-priority: the reference rules changed');
    return wireOf(JSON.parse(json.replace(gte, `{"op":"and","args":[${gte},{"op":"lt","args":[{"col":"amount"},{"const":5100}]}]}`)));
  };

  it('orders-priority: the first answer misses rows away from the samples, a round sends them, the next answer verifies', async () => {
    const c = load('orders-priority');
    // the learn (wrong, but right on the samples: no server repair); the round (right, checked on the samples plus the rows sent)
    const { complete, requests } = scripted([narrowUrgent(c), wireOf(c.referenceRules)]);
    const ran = await runLearn({ caseDef: c, masking: false, model: 'fake', run: 1, env, noEscalation: true, complete });

    expect(ran.result.calls.map((x) => x.purpose)).toEqual(['learn', 'repair']);
    expect(ran.result.stages).toMatchObject({ verifiedFirstCall: false, browserRepairUsed: true, verifiedAfterRepair: true });
    expect(ran.result.loop).toEqual({ rounds: 1, rowsSent: 4, end: 'verified' });
    // the round's repair block names the rows of the example it sends (never a sample index past the payload's)
    const round = requests[1]!.content[1]!.text;
    expect(round).toContain('"row":{"in":["ORD-01119"');
    expect(round).toContain('"expected":"Urgent","actual":"Normal"');
  });

  it('a cut-off on the column itself is filled by code from every row: verified with no round, and the record says what code filled', async () => {
    const c = load('orders-priority');
    // the AI's cut-off is too high (the server's sample run says so, and its one repair answers the same): code settles it on every row
    const gte = '{"op":"gte","args":[{"col":"amount"},{"const":5000}]}';
    const wrong = wireOf(JSON.parse(JSON.stringify(c.referenceRules).replace(gte, gte.replace('5000', '6400'))));
    const { complete, requests } = scripted([wrong, wrong]);
    const records = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete });
    expect(requests).toHaveLength(2); // the learn and its server repair; no browser round
    expect(records[0]).toMatchObject({ loopRounds: 0, loopEnd: 'verified', verifiedFirstCall: true, filledByCode: 'cutoff 1, 1 check', ambiguities: '' });
    // what was sent is the AI's own answer: the request carries no filled value (no cut-off check)
    expect(JSON.stringify(requests)).not.toContain('cutoffRange');
  });

  it('records rounds, rows sent and how the loop ended next to the token columns', async () => {
    const c = load('orders-priority');
    // the round's answer is the same: its server repair (the rows sent are still wrong) is the third call
    const { complete } = scripted([narrowUrgent(c), narrowUrgent(c), narrowUrgent(c)]);
    const records = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete });
    expect(records).toHaveLength(1);
    // the round's answer is no better (the same rules): the loop stops on no progress after one round
    expect(records[0]).toMatchObject({ loopRounds: 1, loopRowsSent: 4, loopEnd: 'noProgress', llmCalls: 3, verifiedAfterRepair: false });
  });
});

describe('a one-time edit or a rule? in the runner (SPEC 21 v12 item 20): what the kept answer would ask, and what "one-time" would do', () => {
  /** The case's reference rules (Discount = 10% of Amount) with the three hand-edited rows named by their Order ID, as a loop round might write it. */
  const byOrderId = (c: CaseDef): unknown => {
    const json = JSON.stringify(c.referenceRules);
    const tenth = '{"op":"round","digits":2,"arg":{"op":"mul","args":[{"col":"amount"},{"const":0.1}]}}';
    if (!json.includes(tenth)) throw new Error('discount-hand-edited: the reference rules changed');
    const id = (order: string, value: number): string => `{"when":{"op":"eq","args":[{"col":"orderId"},{"const":"${order}"}]},"then":{"const":${value}}}`;
    return wireOf(JSON.parse(json.replace(tenth, `{"op":"switch","cases":[${id('ORD-03053', 0)},${id('ORD-03098', 170.02)},${id('ORD-03132', 25)}],"else":${tenth}}`)));
  };

  it('discount-hand-edited: three questions by Order ID (next month brings new IDs, so the kept rules pass the hold-out too)', async () => {
    const c = load('discount-hand-edited');
    const { complete } = scripted([byOrderId(c)]);
    const records = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete });
    expect(records[0]).toMatchObject({
      verifiedFirstCall: true,
      holdOut: 'pass',
      oneTimeAsked: 3,
      oneTimeParts: 'Discount r54 id, Discount r99 id, Discount r133 id',
      oneTimeDefault: 'one-time: holdOut pass',
    });
  });

  it('the same three rows by their position: the API leaves them to the browser, which asks - kept, next month\'s rows 53 and 98 go wrong; answered "one-time", they pass', async () => {
    const c = load('discount-hand-edited');
    const tenth = '{"op":"round","digits":2,"arg":{"op":"mul","args":[{"col":"amount"},{"const":0.1}]}}';
    const at = (row: number, value: number): string => `{"when":{"op":"eq","args":[{"op":"window","fn":"rowNumber"},{"const":${row}}]},"then":{"const":${value}}}`;
    const json = JSON.stringify(c.referenceRules).replace(tenth, `{"op":"switch","cases":[${at(53, 0)},${at(98, 170.02)},${at(132, 25)}],"else":${tenth}}`);
    const { complete, requests } = scripted([wireOf(JSON.parse(json))]);
    const records = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete });
    expect(requests).toHaveLength(1); // no overfit repair: neither the API nor the browser asked the AI step about it
    expect(records[0]).toMatchObject({
      verifiedFirstCall: true,
      overfitFound: 0,
      holdOut: 'fail',
      oneTimeAsked: 3,
      oneTimeParts: 'Discount r54 position, Discount r99 position, Discount r133 position',
      oneTimeDefault: 'one-time: holdOut pass',
    });
  });

  it('the honest rule (the three rows wrong) asks nothing', async () => {
    const c = load('discount-hand-edited');
    const { complete } = scripted([wireOf(c.referenceRules), wireOf(c.referenceRules), wireOf(c.referenceRules), wireOf(c.referenceRules)]);
    const records = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete });
    expect(records[0]).toMatchObject({ oneTimeAsked: 0, oneTimeParts: '', oneTimeDefault: '' });
  });
});

describe('a list copied from the example (owner amendment, 2026-10-06): external-agent-column answers "a one-time edit" in its meta', () => {
  /** The five copies, and Account Manager looked up by Account in a table of the example's 40 rows - what learn-v7 and learn-v9 wrote. */
  async function lookupOfAccounts(c: CaseDef): Promise<unknown> {
    const sheet = (await readWorkbook(c.output.bytes, c.output.fileName)).sheets[0]!;
    const rows = sheet.rows.slice(1).map((r) => [r[0]!.v, r[5]!.v] as [string, string]);
    expect(rows).toHaveLength(40);
    const col = (id: string, header: string, type: string) => ({ id, header, type });
    return wireOf({
      schemaVersion: 1,
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [col('account', 'Account', 'idLike'), col('company', 'Company', 'text'), col('region', 'Region', 'text'), col('plan', 'Plan', 'text'), col('monthlyFee', 'Monthly Fee', 'integer')],
      },
      transform: {
        computed: [{ id: 'accountManager', type: 'text', expr: { op: 'lookup', table: 'accountManagers', key: { col: 'account' }, return: 'manager', onMissing: 'flag' } }],
        valueMaps: [],
        sort: [],
        tables: [{ name: 'accountManagers', columns: ['account', 'manager'], rows }],
      },
      output: {
        sheetName: sheet.name,
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'Account', from: 'account' },
          { header: 'Company', from: 'company' },
          { header: 'Region', from: 'region' },
          { header: 'Plan', from: 'plan' },
          { header: 'Monthly Fee', from: 'monthlyFee' },
          { header: 'Account Manager', from: 'accountManager' },
        ],
      },
      validations: [],
      unsupported: [],
      assumptions: [],
    });
  }
  const runCase = async (c: CaseDef, answer: unknown) => {
    const { complete } = scripted([answer, answer, answer, answer]);
    const [record] = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete });
    return record!;
  };

  it('the case declares the answer: the copied list is asked about, answered "one-time", and the case scores unsupported as it expects', async () => {
    const c = load('external-agent-column');
    expect(c.meta.answers).toEqual({ copiedList: 'oneTime' });
    const record = await runCase(c, await lookupOfAccounts(c));
    expect(record).toMatchObject({
      verifiedFirstCall: true,
      classification: 'unsupported:overfit',
      expectationMet: true,
      oneTimeAsked: 1,
      oneTimeParts: 'Account Manager list by Account 40 answered one-time',
      oneTimeDefault: 'one-time: holdOut n/a',
      // What the AI step did stays its own: it reported nothing, and no guard fell back.
      unsupportedReasons: '',
      overfitFellBack: 0,
    });
    // The rules kept for the report are the AI step's answer as code filled it (the list is still in them).
    expect(rulesByRecord.get(record)?.transform.tables?.[0]?.rows).toHaveLength(40);
  });

  it('unanswered (no answers in the meta): the list is kept, the run is "verified" - the copy the case is built to catch, not met', async () => {
    const c = load('external-agent-column');
    const { answers: _answers, ...meta } = c.meta;
    const record = await runCase({ ...c, meta }, await lookupOfAccounts(c));
    expect(record).toMatchObject({ classification: 'verified', expectationMet: false, oneTimeAsked: 1, oneTimeParts: 'Account Manager list by Account 40' });
  });

  it('the honest answer (Account Manager unsupported, externalData) asks nothing and meets the expectation as before', async () => {
    const c = load('external-agent-column');
    const honest = JSON.parse(JSON.stringify(await lookupOfAccounts(c))) as { output: { columns: { header: string; from: string | null }[] }; transform: { computed: unknown[]; tables: unknown[] }; unsupported: unknown[] };
    honest.output.columns[5]!.from = null;
    honest.transform.computed = [];
    honest.transform.tables = [];
    honest.unsupported = [{ outputColumn: 'Account Manager', reasonCode: 'externalData' }];
    const record = await runCase(c, honest);
    expect(record).toMatchObject({ classification: 'unsupported:externalData', expectationMet: true, oneTimeAsked: 0, oneTimeParts: '' });
  });
});

describe('applyCaseAnswers', () => {
  it('changes nothing without an answer, for "rule", or when nothing was asked', () => {
    const result = { path: 'llm', rules: { output: {} }, oneTimers: undefined, unsupported: [], assumptions: [], verification: null } as never;
    expect(applyCaseAnswers(result, {})).toEqual({ result, answered: [] });
    expect(applyCaseAnswers(result, { answers: { copiedList: 'rule' } })).toEqual({ result, answered: [] });
    expect(applyCaseAnswers(result, { answers: { copiedList: 'oneTime' } })).toEqual({ result, answered: [] });
  });
});
