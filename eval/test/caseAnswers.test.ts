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
import { formatOf, formulaRulesToWire } from '@formatai/engine';
import { toWire, type LearnResult } from '@formatai/shared';
import { loadCase, type CaseDef } from '../lib/caseLoader';
import { runLearn, runMatrix } from '../lib/runner';

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
