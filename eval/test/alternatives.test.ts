// learn-v8 in the eval harness, WITHOUT any LLM: the real orders-priority case, the real pipeline (payload, the API's checks of each
// alternative, the browser's test of each on every row) and canned answers. The runner records per learn the alternatives proposed and
// their outcomes (bothPass / answerOnly / alternativeOnly / bothFail / invalid), and `--prompt` picks the prompt version sent.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '@formatai/api/env';
import type { CompleteFn } from '@formatai/api/learn';
import { formulaRulesToWire } from '@formatai/engine';
import { LEARN_SYSTEM_PROMPT, LEARN_SYSTEM_PROMPT_V7, learnResultWireJsonSchema, toWire, type LearnResult } from '@formatai/shared';
import { loadCase, type CaseDef } from '../lib/caseLoader';
import { alternativesOf, runMatrix } from '../lib/runner';

const env = loadEnv({ ...process.env, LLM_PROVIDER: 'fake' });
const CASES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');
const load = (name: string): CaseDef => loadCase(path.join(CASES, name))!;

/** The case's reference rules as the AI step writes them (formula text), plus `alternatives`. */
function answerWith(c: CaseDef, alternatives?: unknown[]): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(c.referenceRules)) as Record<string, unknown>;
  delete copy.name;
  delete copy.meta;
  const wire = toWire(formulaRulesToWire(copy as unknown as LearnResult) as unknown as LearnResult) as unknown as Record<string, unknown>;
  return alternatives ? { ...wire, alternatives } : wire;
}

/** The formula of Priority in the reference rules, with `from` replaced by `to`. */
function priorityFormula(c: CaseDef, from: string, to: string): string {
  const text = (answerWith(c).transform as { computed: { id: string; expr: string }[] }).computed.find((x) => x.id === 'priority')!.expr;
  if (!text.includes(from)) throw new Error(`orders-priority: the reference formula changed (${text})`);
  return text.replace(from, to);
}

function scripted(answers: unknown[]): { complete: CompleteFn; requests: { system: string; schema: unknown }[] } {
  const requests: { system: string; schema: unknown }[] = [];
  const complete: CompleteFn = async (req) => {
    requests.push({ system: req.system, schema: req.schema });
    const json = answers.shift();
    return { json, raw: JSON.stringify(json), model: 'fake', usage: { tokensIn: 1, tokensOut: 1, tokensCachedRead: 0, tokensCachedWrite: 0 }, costUsd: 0, latencyMs: 0 } as never;
  };
  return { complete, requests };
}

describe('the runner records the alternatives of each learn and their outcomes', () => {
  it('orders-priority: one that also fits every row (asked), one that fits only the samples (the answer stays), one the API drops', async () => {
    const c = load('orders-priority');
    const alternatives = [
      // `> 4999` and `>= 5000` agree on every amount of the example: a genuine ambiguity.
      { outputColumn: 'Priority', from: 'priorityAlt', computed: [{ id: 'priorityAlt', type: 'text', expr: priorityFormula(c, 'amount >= 5000', 'amount > 4999') }] },
      // a formula that does not parse: dropped by the API, counted
      { outputColumn: 'Customer', from: 'x', computed: [{ id: 'x', type: 'text', expr: 'upper(' }] },
    ];
    const { complete } = scripted([answerWith(c, alternatives)]);
    const [record] = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete });
    expect(record).toMatchObject({ verifiedFirstCall: true, prompt: 'learn-v8', alternativesProposed: 2, alternatives: 'Priority bothPass, invalid 1' });
  });

  it('an alternative right only on the samples is tested on every row and dropped: the answer stays the rule', async () => {
    const c = load('orders-priority');
    const narrow = priorityFormula(c, 'amount >= 5000', 'and(amount >= 5000, amount < 5100)');
    const { complete } = scripted([answerWith(c, [{ outputColumn: 'Priority', from: 'p2', computed: [{ id: 'p2', type: 'text', expr: narrow }] }])]);
    const [record] = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete });
    expect(record).toMatchObject({ verifiedFirstCall: true, alternativesProposed: 1, alternatives: 'Priority answerOnly' });
  });

  it('the alternative that is right replaces a wrong answer: verified with no round', async () => {
    const c = load('orders-priority');
    // the answer's cut-off is on round(amount): code does not fill it, and it is wrong on the full data; the alternative is the right rule
    const wrong = answerWith(c);
    const computed = (wrong.transform as { computed: { id: string; expr: string }[] }).computed;
    computed[0]!.expr = priorityFormula(c, 'amount >= 5000', 'round(amount, 0) >= 5300');
    const right = { outputColumn: 'Priority', from: 'p2', computed: [{ id: 'p2', type: 'text', expr: priorityFormula(c, 'amount >= 5000', 'amount >= 5000') }] };
    const { complete, requests } = scripted([{ ...wrong, alternatives: [right] }, { ...wrong }]);
    const [record] = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete });
    expect(record).toMatchObject({ verifiedFirstCall: true, loopRounds: 0, alternatives: 'Priority alternativeOnly', alternativesProposed: 1 });
    expect(requests.length).toBeLessThanOrEqual(2); // the learn (and the server repair its sample run asked for) - no browser round
  });

  it('alternativesOf: nothing proposed is an empty label', () => {
    expect(alternativesOf({ path: 'llm', calls: [], alternatives: undefined })).toEqual({ alternativesProposed: 0, alternatives: '' });
    expect(alternativesOf({ path: 'local', calls: [] })).toEqual({ alternativesProposed: 0, alternatives: '' });
  });
});

describe('--prompt: the prompt version sent, with the wire schema it was written for', () => {
  it('learn-v7 is sent the learn-v7 prompt and no alternatives in the schema; any it gives is dropped; the record says the version', async () => {
    const c = load('orders-priority');
    const extra = [{ outputColumn: 'Priority', from: 'p2', computed: [{ id: 'p2', type: 'text', expr: priorityFormula(c, 'amount >= 5000', 'amount > 4999') }] }];
    const v7 = scripted([answerWith(c, extra)]);
    const [old] = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete: v7.complete, prompt: 'learn-v7' });
    expect(v7.requests[0]!.system).toBe(LEARN_SYSTEM_PROMPT_V7);
    expect(v7.requests[0]!.schema).toEqual(learnResultWireJsonSchema({ alternatives: false }));
    expect(old).toMatchObject({ prompt: 'learn-v7', alternativesProposed: 1, alternatives: 'invalid 1' });

    const v8 = scripted([answerWith(c)]);
    const [current] = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete: v8.complete });
    expect(v8.requests[0]!.system).toBe(LEARN_SYSTEM_PROMPT);
    expect(current).toMatchObject({ prompt: 'learn-v8', alternativesProposed: 0, alternatives: '' });
    expect(env.LLM_PROVIDER).toBe('fake');
  });
});
