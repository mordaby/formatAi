// What a saved format keeps (docs/proposals/saved-format-contents.md; `cases/buildContents.ts`): the four cases, run through the real learn
// pipeline (payload, API checks, the browser's verification, the one round for a list, the case's answers) with canned answers from a scripted
// provider. Nothing here may reach a real provider.
//   - catalog-200: a list of 200 fixed values - retried once (the canned answer keeps it), asked at Save, answered "Keep it": verified;
//   - small-vocabulary, ledger-account-labels: silent - no round, nothing asked;
//   - label-is-an-id: logic, no round - and the identifier finding fires (column and kind, never the value).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CompleteFn } from '@formatai/api/learn';
import { formulaRulesToWire } from '@formatai/engine';
import { toWire, type LearnResult } from '@formatai/shared';
import { loadCase, type CaseDef } from '../lib/caseLoader';
import { runMatrix, type RunRecord } from '../lib/runner';

const CASES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');
const load = (name: string): CaseDef => loadCase(path.join(CASES, name))!;

/** The wire form of a rules file, as the AI step writes it. */
function wireOf(rules: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(rules)) as Record<string, unknown>;
  delete copy.name;
  delete copy.meta;
  return toWire(formulaRulesToWire(copy as unknown as LearnResult) as unknown as LearnResult);
}

/** A provider that answers with `answers` in order (the last one again when they run out), and keeps every request it got. */
function scripted(answers: unknown[]): { complete: CompleteFn; requests: { purpose: string; content: { text: string }[] }[] } {
  const requests: { purpose: string; content: { text: string }[] }[] = [];
  const complete: CompleteFn = async (req) => {
    requests.push(req as never);
    const json = answers.length > 1 ? answers.shift() : answers[0];
    return { json, raw: JSON.stringify(json), model: 'fake', usage: { tokensIn: 1, tokensOut: 1, tokensCachedRead: 0, tokensCachedWrite: 0 }, costUsd: 0, latencyMs: 0 } as never;
  };
  return { complete, requests };
}

/** The problems of the repair requests that carry a `list` problem: the one round for a list (the server's own repair rounds carry none). */
function listRounds(requests: { purpose: string; content: { text: string }[] }[]): { kind: string; out: number; message: string }[][] {
  return requests
    .filter((r) => r.purpose === 'repair')
    .map((r) => (JSON.parse(r.content[1]!.text.split('\n')[0]!) as { problems: { kind: string; out: number; message: string }[] }).problems)
    .filter((problems) => problems.some((p) => p.kind === 'list'));
}

async function run(c: CaseDef, answers: unknown[], masking = false): Promise<{ record: RunRecord; requests: { purpose: string; content: { text: string }[] }[] }> {
  const { complete, requests } = scripted(answers);
  const [record] = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [masking], runs: 1, provider: 'fake', noEscalation: true, complete });
  return { record: record!, requests };
}

describe('catalog-200: a list of 200 fixed values, retried once, asked at Save, kept', () => {
  /** What the AI step writes: the lookup by product code, its table left for code to fill from every row. */
  const lookupAnswer = (c: CaseDef): unknown => {
    const rules = JSON.parse(JSON.stringify(c.referenceRules)) as LearnResult;
    rules.transform.tables = [{ ...rules.transform.tables![0]!, rows: [] }];
    return wireOf(rules);
  };

  it.each([false, true])('masking %s: verified after "Keep it" (answers.copiedList "rule"); the round names the column, the count and the key, no value', async (masking) => {
    const c = load('catalog-200');
    expect(c.meta.answers).toEqual({ copiedList: 'rule' });
    const { record, requests } = await run(c, [lookupAnswer(c)], masking);
    expect(record).toMatchObject({
      classification: 'verified',
      expectationMet: true,
      holdOut: 'pass',
      verifiedFirstCall: true,
      listRetry: 'Category kept (1 call)',
      oneTimeAsked: 1,
      oneTimeParts: 'Category list by Product code 200',
      savedIdentifiers: '',
      loopRounds: 1,
    });
    // The round: a repair whose one problem is the list, in the proposal's words - one per learn.
    const rounds = listRounds(requests);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toEqual([
      {
        kind: 'list',
        out: 2,
        message:
          'Column "Category" is a list of 200 fixed values, one per Product code. Find the rule behind it from the other columns. Only if no rule exists - the value depends on each Product code itself, or comes from outside the file - keep the list.',
      },
    ]);
    expect(JSON.stringify(rounds[0])).not.toMatch(/PRD-|Electronics|Garden|Kitchen/);
  });

  it('"Save without it" (answers.copiedList "oneTime"): the column needs your input, as the case would then expect', async () => {
    const c = load('catalog-200');
    const { record } = await run({ ...c, meta: { ...c.meta, answers: { copiedList: 'oneTime' } } }, [lookupAnswer(c)]);
    expect(record).toMatchObject({ classification: 'unsupported:overfit', oneTimeParts: 'Category list by Product code 200 answered one-time' });
  });
});

describe('small-vocabulary and ledger-account-labels: saved silently', () => {
  // (Both are a vocabulary the free engine learns by itself - no AI step at all; were the AI step asked, its answer would be silent too: the
  // engine's `copiedLists` and the identifier detectors find nothing in such rules, see packages/engine/test/learn/lists.test.ts.)
  it.each([false, true])('masking %s: both verify, with no round, nothing asked, no identifier', async (masking) => {
    for (const name of ['small-vocabulary', 'ledger-account-labels']) {
      const c = load(name);
      const { record, requests } = await run(c, [wireOf(c.referenceRules)], masking);
      expect(record, name).toMatchObject({ classification: 'verified', expectationMet: true, holdOut: 'pass', listRetry: '', oneTimeAsked: 0, oneTimeParts: '', savedIdentifiers: '', loopRounds: 0 });
      expect(listRounds(requests), name).toEqual([]);
    }
  });
});

describe('label-is-an-id: logic whose label is an ID number', () => {
  it.each([false, true])('masking %s: verified, no round - and the identifier finding fires (column and kind, never the value)', async (masking) => {
    const c = load('label-is-an-id');
    expect(c.meta.answers).toEqual({ identifier: 'keep' });
    const { record, requests } = await run(c, [wireOf(c.referenceRules)], masking);
    expect(record).toMatchObject({ classification: 'verified', expectationMet: true, holdOut: 'pass', listRetry: '', oneTimeAsked: 0, savedIdentifiers: 'Target customer israeliId' });
    expect(listRounds(requests)).toEqual([]);
    expect(JSON.stringify(record)).not.toContain('039337423');
  });

  it('"Save without it" (answers.identifier "without"): the column needs your input (savedWithout), and the record says so', async () => {
    const c = load('label-is-an-id');
    const { record } = await run({ ...c, meta: { ...c.meta, answers: { identifier: 'without' } } }, [wireOf(c.referenceRules)]);
    expect(record).toMatchObject({ classification: 'unsupported:savedWithout', savedIdentifiers: 'Target customer israeliId answered without' });
  });
});
