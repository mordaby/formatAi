// AI code checks in the eval harness (learn-v9, docs/proposals/ai-code-checks.md), WITHOUT any LLM: the real orders-priority case (Priority
// by Status AND Amount), the real pipeline and a scripted model that asks checks first, then answers. The harness answers the checks itself
// (the engine, on every row) and makes the step in-process (`learn()` with the rounds); the record says how many rounds and checks there were.
// `--no-pattern-hints` builds the payload without the pattern hints.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CompleteFn } from '@formatai/api/learn';
import { formulaRulesToWire } from '@formatai/engine';
import { LEARN_SYSTEM_PROMPT_V9, learnStepWireJsonSchema, toWire, type DependsOnAnswer, type LearnResult, type RangesAnswer } from '@formatai/shared';
import { parseArgs } from '../lib/args';
import { loadCase, type CaseDef } from '../lib/caseLoader';
import { buildCsvReport, buildMarkdownReport } from '../lib/report';
import { runMatrix } from '../lib/runner';

const CASES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');
const load = (name: string): CaseDef => loadCase(path.join(CASES, name))!;

/** The case's reference rules as the AI step writes them (formula text, wire form). */
function rulesOf(c: CaseDef): unknown {
  const copy = JSON.parse(JSON.stringify(c.referenceRules)) as Record<string, unknown>;
  delete copy.name;
  delete copy.meta;
  return toWire(formulaRulesToWire(copy as unknown as LearnResult) as unknown as LearnResult);
}

interface Seen {
  system: string;
  schema: unknown;
  content: { text: string }[];
}

function scripted(answers: unknown[]): { complete: CompleteFn; requests: Seen[] } {
  const requests: Seen[] = [];
  const complete: CompleteFn = async (req) => {
    requests.push({ system: req.system, schema: req.schema, content: req.content });
    const json = answers.shift();
    return { json, raw: JSON.stringify(json), model: 'fake', provider: 'fake', usage: { tokensIn: 1, tokensOut: 1, tokensCachedRead: 0, tokensCachedWrite: 0 }, costUsd: 0, latencyMs: 0 } as never;
  };
  return { complete, requests };
}

describe('the runner with --prompt learn-v9: checks answered in-process, then the step', () => {
  it('orders-priority: the AI step asks whether Status decides Priority and where Amount cuts it, then answers; one round, two checks, verified', async () => {
    const c = load('orders-priority');
    const checks = [
      { check: 'dependsOn', column: 'Priority', on: ['Status'] },
      { check: 'ranges', column: 'Priority', by: 'Amount', where: 'in4 = "Open"' },
    ];
    const { complete, requests } = scripted([{ checks, rules: null }, { checks: null, rules: rulesOf(c) }]);
    const [record] = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete, prompt: 'learn-v9' });
    expect(record).toMatchObject({ prompt: 'learn-v9', checkRounds: 1, checksAsked: 2, llmCalls: 2, verifiedAfterRepair: true, classification: 'verified' });
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(r.system).toBe(LEARN_SYSTEM_PROMPT_V9);
      expect(r.schema).toEqual(learnStepWireJsonSchema());
    }
    // the step: the payload, then the round - what was asked and what code answered on every row
    expect(requests[1]!.content).toHaveLength(2);
    expect(requests[1]!.content[0]!.text).toBe(requests[0]!.content[0]!.text);
    const round = JSON.parse(requests[1]!.content[1]!.text) as { round: number; checks: unknown[]; answers: unknown[] };
    expect(round).toMatchObject({ round: 1, checks });
    const [depends, ranges] = round.answers as [DependsOnAnswer, RangesAnswer];
    // Status alone does not decide Priority (Open is Urgent or Normal) ...
    expect(depends.keysConflict).toBe(1);
    expect(depends.conflicts[0]!.key).toEqual(['Open']);
    // ... and among the open orders, Amount cuts it in two clean runs
    expect(ranges.clean && ranges.runs.map((x) => x.value)).toEqual(['Normal', 'Urgent']);

    const md = buildMarkdownReport([record!], '2026-10-05T00:00:00.000Z');
    expect(md).toContain('Check rounds');
    // (the two are the CSV's last columns before the error; a quoted cell may hold commas, so the row is read from its end)
    const [head, row] = buildCsvReport([record!]).trim().split('\n');
    expect(head!.endsWith(',checkRounds,checksAsked,error')).toBe(true);
    expect(row!.endsWith(',1,2,')).toBe(true);
  }, 60_000);

  it('a model that answers at once makes one call and asks nothing', async () => {
    const c = load('orders-priority');
    const { complete, requests } = scripted([{ checks: null, rules: rulesOf(c) }]);
    const [record] = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete, prompt: 'learn-v9' });
    expect(record).toMatchObject({ checkRounds: 0, checksAsked: 0, llmCalls: 1 });
    expect(requests).toHaveLength(1);
  }, 60_000);
});

describe('--no-pattern-hints', () => {
  it('parses as a bare flag', () => {
    expect(parseArgs([]).noPatternHints).toBe(false);
    expect(parseArgs(['--no-pattern-hints', '--prompt', 'learn-v9']).noPatternHints).toBe(true);
  });

  it('the payload carries no bands / dependsOn / contains hint; the record and the report say so', async () => {
    // (branch-lookup-50: the branch name depends on the branch code - a dependsOn hint)
    const c = load('branch-lookup-50');
    const sent: string[] = [];
    const { complete } = scripted([{ checks: null, rules: rulesOf(c) }, { checks: null, rules: rulesOf(c) }]);
    const spy: CompleteFn = async (req, env) => {
      sent.push(req.content[0]!.text);
      return complete(req, env);
    };
    const [withHints] = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete: spy, prompt: 'learn-v9' });
    const [without] = await runMatrix({ cases: [c], models: ['fake'], maskingModes: [false], runs: 1, provider: 'fake', noEscalation: true, complete: spy, prompt: 'learn-v9', patternHints: false });
    const rels = (text: string): string[] => (JSON.parse(text) as { hints: { rel: string }[] }).hints.map((h) => h.rel);
    expect(rels(sent[0]!).some((r) => ['bands', 'dependsOn', 'contains'].includes(r))).toBe(true);
    expect(rels(sent[1]!).some((r) => ['bands', 'dependsOn', 'contains'].includes(r))).toBe(false);
    expect(withHints!.patternHints).toBeUndefined();
    expect(without!.patternHints).toBe(false);
    expect(buildMarkdownReport([without!], 'x')).toContain('Pattern hints: off');
  }, 60_000);
});
