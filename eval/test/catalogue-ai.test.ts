// The catalogue's AI measurement (eval/catalogue/ai.ts, aiRecords.ts, args.ts and the AI parts of report.ts), tested WITHOUT any LLM: the fake provider
// answers with canned JSON. Nothing here may ever reach a real provider (`LLM_PROVIDER` is fake in every env this file builds).
import { describe, expect, it } from 'vitest';
import { createFakeProvider, LlmError } from '@formatai/api/llm';
import { loadEnv } from '@formatai/api/env';
import { toWire, type LearnResult } from '@formatai/shared';
import { AiConflictError, measureAi, referenceAnswerFake, runAiMeasurement } from '../catalogue/ai';
import { aiConfigKey, aiStatusOf, chunkOf, mergeRecords, needsAi, needsAiTypes, planAiWork } from '../catalogue/aiRecords';
import { CatalogueArgsError, parseArgs, parseChunk } from '../catalogue/args';
import { assembleWire } from '../catalogue/kit';
import { measure, prepare } from '../catalogue/measure';
import { renderCsv, renderMarkdown, summarize } from '../catalogue/report';
import { CATALOGUE } from '../catalogue/topics';
import type { AiConfigRecord, AiRecord, CatalogueRecord, CatalogueType } from '../catalogue/types';

const env = loadEnv({ ...process.env, LLM_PROVIDER: 'fake' });
const DEFAULTS = { out: '/out', dumpDir: '/out/.cache' };
const type = (id: string): CatalogueType => CATALOGUE.find((t) => t.id === id)!;
const CONFIG: AiConfigRecord = { model: 'fake', provider: 'fake', mode: 'full', masking: false, noEscalation: false };

// ---------- args ----------

describe('catalogue args', () => {
  it('without --ai it is the free run: no AI settings, and the old defaults', () => {
    const a = parseArgs([], DEFAULTS);
    expect(a).toEqual({ types: [], seeds: [1, 2], list: false, out: DEFAULTS.out, reportOnly: false });
    expect(parseArgs(['--types', 'dates.add-*,extraction', '--seeds=3,4', '--report-only'], DEFAULTS)).toMatchObject({ types: ['dates.add-*', 'extraction'], seeds: [3, 4], reportOnly: true });
    expect(parseArgs(['--dump'], DEFAULTS).dump).toBe(DEFAULTS.dumpDir);
  });

  it('--ai <model> defaults: provider from the environment, masking on, mode complete, escalation on, no chunk, no resume', () => {
    const { ai } = parseArgs(['--ai', 'haiku'], DEFAULTS);
    expect(ai).toEqual({ model: 'haiku', masking: true, mode: 'complete', noEscalation: false, resume: false, plan: false, replace: false });
    expect(ai!.provider).toBeUndefined();
  });

  it('parses the owner\'s command line: provider, --no-escalation, --chunk 1/3, --resume', () => {
    const { ai, types } = parseArgs(['--ai', 'haiku', '--provider', 'claude-cli', '--no-escalation', '--chunk', '1/3', '--resume', '--types', 'extraction'], DEFAULTS);
    expect(ai).toMatchObject({ model: 'haiku', provider: 'claude-cli', noEscalation: true, chunk: { index: 1, total: 3 }, resume: true });
    expect(types).toEqual(['extraction']);
  });

  it('parses --masking, --mode, --plan, --replace and the inline form', () => {
    expect(parseArgs(['--ai=sonnet', '--masking=off', '--mode=full', '--plan', '--replace'], DEFAULTS).ai).toMatchObject({ model: 'sonnet', masking: false, mode: 'full', plan: true, replace: true });
  });

  it('chunk syntax: N/M with 1 <= N <= M', () => {
    expect(parseChunk('2/3')).toEqual({ index: 2, total: 3 });
    expect(parseChunk('1/1')).toEqual({ index: 1, total: 1 });
    for (const bad of ['0/3', '4/3', '1/0', '1', '1-3', 'a/b', '1/3/5', '']) expect(() => parseChunk(bad), bad).toThrow(CatalogueArgsError);
  });

  it('refuses what would silently cost or lose something', () => {
    expect(() => parseArgs(['--chunk', '1/3'], DEFAULTS)).toThrow(/only applies together with --ai/);
    expect(() => parseArgs(['--resume'], DEFAULTS)).toThrow(/only applies together with --ai/);
    expect(() => parseArgs(['--masking', 'off'], DEFAULTS)).toThrow(/only applies together with --ai/);
    expect(() => parseArgs(['--ai', '--types', 'x'], DEFAULTS)).toThrow(/needs a model name/);
    expect(() => parseArgs(['--ai'], DEFAULTS)).toThrow(/needs a value/);
    expect(() => parseArgs(['--ai', 'haiku', '--masking', 'maybe'], DEFAULTS)).toThrow(/--masking/);
    expect(() => parseArgs(['--ai', 'haiku', '--mode', 'both'], DEFAULTS)).toThrow(/--mode/);
    expect(() => parseArgs(['--ai', 'haiku', '--provider', 'bogus'], DEFAULTS)).toThrow(/--provider/);
    expect(() => parseArgs(['--ai', 'haiku', '--report-only'], DEFAULTS)).toThrow(/never measures/);
    expect(() => parseArgs(['--bogus'], DEFAULTS)).toThrow(/unknown option/);
  });

  it('--ai fake always means the fake provider (the id is no real model), whatever the environment says', () => {
    expect(parseArgs(['--ai', 'fake'], DEFAULTS).ai!.provider).toBe('fake');
    expect(parseArgs(['--ai', 'fake', '--provider', 'fake'], DEFAULTS).ai!.provider).toBe('fake');
    expect(() => parseArgs(['--ai', 'fake', '--provider', 'claude-cli'], DEFAULTS)).toThrow(/fake provider only/);
  });
});

// ---------- the needs-AI set, chunks, resume ----------

type Rec = { type: string; seed: number; expressible?: boolean; ok?: boolean; fast?: CatalogueRecord['fast']['status']; ai?: AiRecord };

/** A minimal record: only what the selection reads. */
function rec(o: Rec): CatalogueRecord {
  const t = CATALOGUE.find((x) => x.id === o.type)!;
  const expressible = o.expressible ?? true;
  return {
    type: o.type,
    topic: t.topic,
    title: t.title,
    lang: t.lang,
    seed: o.seed,
    rowsIn: 20,
    rowsOut: 20,
    language: expressible ? { expressible, valid: o.ok ?? true, reproduces: o.ok ?? true } : { expressible, capability: 'positionSearch', missingDetail: 'x' },
    fast: { path: 'local', status: o.fast ?? 'partial', verified: true, solvedColumns: [], totalColumns: 2, unsolved: [], blockedBy: [], needsAiParts: [], holdOut: 'n/a', ms: 1 },
    ...(o.ai ? { ai: o.ai } : {}),
  };
}

function ai(over: Partial<AiRecord> = {}): AiRecord {
  return {
    ...CONFIG,
    path: 'llm',
    classification: 'verified',
    verified: true,
    holdOut: 'pass',
    llmCalls: 1,
    tokensIn: 1000,
    tokensOut: 200,
    tokensCached: 0,
    costUsd: 0,
    latencyMs: 2000,
    formulaErrors: 0,
    callErrors: 0,
    unsupported: [],
    functionRequests: [],
    explanation: false,
    at: '2026-10-02T00:00:00.000Z',
    ...over,
  };
}

const IDS = ['extraction.left-n', 'extraction.nth-word', 'cleanup.proper-case', 'extraction.initials', 'extraction.digits-only', 'extraction.after-first-sep-rest', 'acrossRows.running-total'];

describe('the needs-AI set', () => {
  const free = [
    rec({ type: 'extraction.left-n', seed: 1, fast: 'solved' }),
    rec({ type: 'extraction.left-n', seed: 2, fast: 'solved' }),
    rec({ type: 'extraction.nth-word', seed: 1, fast: 'partial' }),
    rec({ type: 'extraction.nth-word', seed: 2, fast: 'partial' }),
    rec({ type: 'cleanup.proper-case', seed: 1, fast: 'none' }),
    rec({ type: 'extraction.initials', seed: 1, fast: 'solved' }),
    rec({ type: 'extraction.initials', seed: 2, fast: 'overfit' }), // wrong on one seed: not solved
    rec({ type: 'extraction.digits-only', seed: 1, fast: 'unverified' }),
    rec({ type: 'extraction.after-first-sep-rest', seed: 1, expressible: false, fast: 'none' }), // the language cannot say it: no AI to try
    rec({ type: 'acrossRows.running-total', seed: 1, ok: false, fast: 'partial' }), // broken reference rule: a catalogue bug, not an AI question
  ];

  it('is the types the language expresses and the free engine does not solve on every seed', () => {
    const ids = needsAiTypes(IDS.map(type), free).map((t) => t.id);
    expect(ids).toEqual(['extraction.nth-word', 'cleanup.proper-case', 'extraction.initials', 'extraction.digits-only']);
  });

  it('is decided from records only: a type with no free record is not in it', () => {
    expect(needsAiTypes([type('extraction.nth-word')], [])).toEqual([]);
    expect(needsAi([])).toBe(false);
  });

  it('agrees with the report\'s "Expressible, needs AI"', () => {
    const s = summarize(free);
    expect(s.topics.reduce((n, t) => n + t.needsAi, 0)).toBe(needsAiTypes(IDS.map(type), free).length);
    expect(s.types.filter((t) => t.needsAi).map((t) => t.type).sort()).toEqual(needsAiTypes(IDS.map(type), free).map((t) => t.id).sort());
  });

  it('keeps catalogue order and honours the --types selection it is given', () => {
    expect(needsAiTypes([type('cleanup.proper-case'), type('extraction.nth-word')], free).map((t) => t.id)).toEqual(['cleanup.proper-case', 'extraction.nth-word']);
  });

  it('on the real catalogue: only the types the language can say', async () => {
    const records: CatalogueRecord[] = [];
    for (const id of ['extraction.left-n', 'acrossRows.running-total', 'extraction.after-first-sep-rest']) records.push(await measure(type(id), 1));
    expect(needsAiTypes(CATALOGUE.filter((t) => ['extraction.left-n', 'acrossRows.running-total', 'extraction.after-first-sep-rest'].includes(t.id)), records).map((t) => t.id)).toEqual(['acrossRows.running-total']);
  }, 60_000);
});

describe('chunks', () => {
  const items = Array.from({ length: 53 }, (_, i) => i);

  it('split a list into M disjoint parts that cover it, differ by at most one in size, and are deterministic', () => {
    for (const total of [1, 2, 3, 5, 7]) {
      const parts = Array.from({ length: total }, (_, k) => chunkOf(items, { index: k + 1, total }));
      expect(parts.flat().sort((a, b) => a - b)).toEqual(items);
      const sizes = parts.map((p) => p.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      expect(parts).toEqual(Array.from({ length: total }, (_, k) => chunkOf(items, { index: k + 1, total })));
    }
    expect(chunkOf(items, undefined)).toEqual(items);
    expect(chunkOf(items, { index: 1, total: 3 }).slice(0, 4)).toEqual([0, 3, 6, 9]);
  });

  it('a chunk is applied to the needs-AI set, after the --types selection', () => {
    const free = IDS.slice(1, 5).map((id) => rec({ type: id, seed: 1 })); // 4 needs-AI types
    const plan = (index: number) => planAiWork({ types: IDS.slice(1, 5).map(type), records: free, seeds: [1, 2], chunk: { index, total: 3 }, config: CONFIG, resume: false });
    expect(plan(1).chunk.map((t) => t.id)).toEqual([IDS[1], IDS[4]]);
    expect(plan(2).chunk.map((t) => t.id)).toEqual([IDS[2]]);
    expect(plan(3).chunk.map((t) => t.id)).toEqual([IDS[3]]);
    expect(plan(1).needs).toHaveLength(4);
    expect(plan(1).todo.map((w) => `${w.type.id}#${w.seed}`)).toEqual([`${IDS[1]}#1`, `${IDS[1]}#2`, `${IDS[4]}#1`, `${IDS[4]}#2`]);
  });
});

describe('--resume', () => {
  const types = [type('extraction.nth-word'), type('cleanup.proper-case')];
  const plan = (records: CatalogueRecord[], config: AiConfigRecord, resume = true) => planAiWork({ types, records, seeds: [1, 2], config, resume });
  const key = (w: { type: CatalogueType; seed: number }) => `${w.type.id}#${w.seed}`;

  it('skips pairs already measured under the same model/mode/masking and measures the rest', () => {
    const records = [
      rec({ type: 'extraction.nth-word', seed: 1, ai: ai() }),
      rec({ type: 'extraction.nth-word', seed: 2 }),
      rec({ type: 'cleanup.proper-case', seed: 1, ai: ai() }),
      rec({ type: 'cleanup.proper-case', seed: 2, ai: ai() }),
    ];
    const p = plan(records, CONFIG);
    expect(p.done.map(key)).toEqual(['extraction.nth-word#1', 'cleanup.proper-case#1', 'cleanup.proper-case#2']);
    expect(p.todo.map(key)).toEqual(['extraction.nth-word#2']);
    expect(p.conflicts).toEqual([]);
  });

  it('without --resume everything of the chunk is measured again', () => {
    const records = [rec({ type: 'extraction.nth-word', seed: 1, ai: ai() }), rec({ type: 'extraction.nth-word', seed: 2, ai: ai() }), rec({ type: 'cleanup.proper-case', seed: 1 }), rec({ type: 'cleanup.proper-case', seed: 2 })];
    expect(plan(records, CONFIG, false).todo).toHaveLength(4);
    expect(plan(records, CONFIG, false).done).toEqual([]);
  });

  it('does not skip a pair measured under another model, mode, masking or escalation setting: it is a conflict (the run would overwrite it)', () => {
    const records = [rec({ type: 'extraction.nth-word', seed: 1, ai: ai() }), rec({ type: 'extraction.nth-word', seed: 2, ai: ai() }), rec({ type: 'cleanup.proper-case', seed: 1 }), rec({ type: 'cleanup.proper-case', seed: 2 })];
    for (const other of [{ model: 'sonnet' }, { mode: 'complete' as const }, { masking: true }, { noEscalation: true }]) {
      const p = plan(records, { ...CONFIG, ...other });
      expect(p.done, JSON.stringify(other)).toEqual([]);
      expect(p.conflicts.map(key), JSON.stringify(other)).toEqual(['extraction.nth-word#1', 'extraction.nth-word#2']);
    }
    expect(plan(records, { ...CONFIG, provider: 'claude-cli' }).done).toHaveLength(2); // the provider is how the model is reached, not what is measured
    expect(aiConfigKey(CONFIG)).toBe('fake / full / masking off / escalation on');
  });

  it('measures again a pair whose measurement errored (every call failed): that is not an answer', () => {
    const records = [rec({ type: 'extraction.nth-word', seed: 1, ai: ai({ error: 'every LLM call failed (error:rateLimited)', verified: false, holdOut: 'n/a' }) }), rec({ type: 'extraction.nth-word', seed: 2 })];
    const p = plan(records, CONFIG);
    expect(p.todo.map(key)).toContain('extraction.nth-word#1');
    expect(p.conflicts).toEqual([]);
    expect(aiStatusOf(records[0]!.ai!)).toBe('error');
  });
});

describe('merging records', () => {
  it('a re-measured free record keeps the AI result it had; an AI result lands on its (type, seed)', () => {
    const old = [rec({ type: 'extraction.nth-word', seed: 1, ai: ai({ llmCalls: 3 }) }), rec({ type: 'extraction.nth-word', seed: 2 }), rec({ type: 'cleanup.proper-case', seed: 1 })];
    const fresh = [rec({ type: 'extraction.nth-word', seed: 1, fast: 'none' }), rec({ type: 'extraction.nth-word', seed: 2, ai: ai({ llmCalls: 7 }) })];
    const merged = mergeRecords(old, fresh, { order: IDS });
    expect(merged.map((r) => `${r.type}#${r.seed}`)).toEqual(['extraction.nth-word#1', 'extraction.nth-word#2', 'cleanup.proper-case#1']);
    expect(merged[0]!.fast.status).toBe('none'); // the fresh free layers
    expect(merged[0]!.ai!.llmCalls).toBe(3); // the old AI result survived
    expect(merged[1]!.ai!.llmCalls).toBe(7);
    expect(merged[2]!.ai).toBeUndefined();
  });

  it('a full free run replaces the records but still carries the AI results over', () => {
    const old = [rec({ type: 'extraction.nth-word', seed: 1, ai: ai() }), rec({ type: 'cleanup.proper-case', seed: 1, ai: ai() })];
    const merged = mergeRecords(old, [rec({ type: 'extraction.nth-word', seed: 1 })], { replaceAll: true });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.ai).toBeDefined();
  });

  it('sorts by catalogue order then seed, unknown types last', () => {
    const merged = mergeRecords([], [rec({ type: 'cleanup.proper-case', seed: 2 }), rec({ type: 'extraction.nth-word', seed: 2 }), rec({ type: 'extraction.nth-word', seed: 1 })], { order: IDS });
    expect(merged.map((r) => `${r.type}#${r.seed}`)).toEqual(['extraction.nth-word#1', 'extraction.nth-word#2', 'cleanup.proper-case#2']);
  });
});

// ---------- measuring one pair against the fake provider ----------

/** The reference answer of a type, in the wire shape, with its last column reported as unsupported and a function request + explanation on it. */
function unsupportedAnswer(t: CatalogueType): unknown {
  const wire = assembleWire(t) as unknown as LearnResult;
  const last = wire.output.columns[wire.output.columns.length - 1]!;
  return toWire({
    ...wire,
    transform: { ...wire.transform, computed: [] },
    output: { ...wire.output, columns: [...wire.output.columns.slice(0, -1), { header: last.header, from: null }] },
    unsupported: [
      {
        outputColumn: last.header,
        reasonCode: 'other',
        functionRequest: { name: 'wordAtPosition', purpose: 'Returns the word at a given position of a text.', args: [{ name: 'text', type: 'text' }, { name: 'position', type: 'decimal' }], returns: 'text' },
        explanation: 'Looks like a part of the address.',
      },
    ],
  } as unknown as LearnResult);
}

describe('measureAi (fake provider, canned answers)', () => {
  const nth = type('extraction.nth-word');

  it('a right answer: verified, hold-out passes, calls and tokens are the canned ones', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: toWire(assembleWire(nth) as unknown as LearnResult), usage: { tokensIn: 1200, tokensOut: 300, tokensCachedRead: 100, tokensCachedWrite: 50 }, costUsd: 0.01 });
    const a = await measureAi(await prepare(nth, 1), { ...CONFIG, env, complete: (req) => fake.complete(req) });
    expect(fake.calls).toHaveLength(1);
    expect(a).toMatchObject({ ...CONFIG, path: 'llm', classification: 'verified', verified: true, holdOut: 'pass', llmCalls: 1, tokensIn: 1200, tokensOut: 300, tokensCached: 150, costUsd: 0.01, formulaErrors: 0, callErrors: 0, unsupported: [], functionRequests: [], explanation: false });
    expect(a.error).toBeUndefined();
    expect(aiStatusOf(a)).toBe('learned');
  }, 60_000);

  it('the record carries our own token estimate: counts and a price, never text (an unpriced model has no cost)', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: toWire(assembleWire(nth) as unknown as LearnResult) });
    const a = await measureAi(await prepare(nth, 1), { ...CONFIG, env, complete: (req) => fake.complete(req) });
    expect(Object.keys(a.estimate!).sort()).toEqual(['cacheWriteTokens', 'cachedInputTokens', 'costUsd', 'inputTokens', 'outputTokens']);
    expect(a.estimate).toMatchObject({ cachedInputTokens: 0, costUsd: null });
    expect(a.estimate!.cacheWriteTokens).toBeGreaterThan(1000); // the system prompt and the schema, written once
    expect(a.estimate!.inputTokens).toBeGreaterThan(0);
    expect(a.estimate!.outputTokens).toBeGreaterThan(0);
  }, 60_000);

  it('a free-engine record (no call) estimates nothing and costs nothing', async () => {
    const free = await measureAi(await prepare(type('extraction.left-n'), 1), { ...CONFIG, env, complete: referenceAnswerFake(type('extraction.left-n')) });
    expect(free).toMatchObject({ path: 'local', llmCalls: 0, estimate: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 } });
  }, 60_000);

  it('an answer with an unsupported column: the codes, the function NAME and the explanation FLAG are recorded, nothing else', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: unsupportedAnswer(nth), usage: { tokensIn: 900, tokensOut: 150 } });
    const a = await measureAi(await prepare(nth, 1), { ...CONFIG, env, complete: (req) => fake.complete(req) });
    expect(a).toMatchObject({ path: 'llm', classification: 'unsupported:other', verified: false, holdOut: 'fail', llmCalls: 1, unsupported: ['other'], functionRequests: ['wordAtPosition'], explanation: true });
    expect(aiStatusOf(a)).toBe('failed');
    // value-free: neither the purpose, the arguments nor the explanation text is in the record
    const text = JSON.stringify(a);
    expect(text).not.toMatch(/Returns the word|Looks like|position"/);
  }, 60_000);

  it('formula errors in an answer are counted, and a repair that fixes it still ends verified', async () => {
    const fake = createFakeProvider();
    const good = toWire(assembleWire(nth) as unknown as LearnResult) as unknown as { transform: { computed: { expr: string }[] } };
    const broken = JSON.parse(JSON.stringify(good)) as typeof good;
    broken.transform.computed[0]!.expr = 'toNumber(split(address, " ", 2'; // unbalanced parenthesis: a formula-kind problem
    fake.enqueue({ json: broken });
    fake.enqueue({ json: good });
    const a = await measureAi(await prepare(nth, 1), { ...CONFIG, env, complete: (req) => fake.complete(req) });
    expect(a.llmCalls).toBe(2);
    expect(a.formulaErrors).toBeGreaterThanOrEqual(1);
    expect(a.verified).toBe(true);
    expect(a.holdOut).toBe('pass');
  }, 60_000);

  it('every call failing is a measurement error (not a wrong answer): --resume will redo it', async () => {
    const fake = createFakeProvider();
    for (let i = 0; i < 4; i++) fake.enqueue({ error: new LlmError('rateLimited', 'fake', '429') });
    const a = await measureAi(await prepare(nth, 1), { ...CONFIG, env, complete: (req) => fake.complete(req) });
    expect(a.error).toMatch(/every LLM call failed/);
    expect(a.callErrors).toBe(a.llmCalls);
    expect(a.verified).toBe(false);
    expect(aiStatusOf(a)).toBe('error');
  }, 60_000);

  it('--no-escalation: the escalation call is not made', async () => {
    const fake = createFakeProvider();
    for (let i = 0; i < 4; i++) fake.enqueue({ error: new LlmError('rateLimited', 'fake', '429') });
    const withEsc = await measureAi(await prepare(nth, 1), { ...CONFIG, env, complete: (req) => fake.complete(req) });
    const fake2 = createFakeProvider();
    for (let i = 0; i < 4; i++) fake2.enqueue({ error: new LlmError('rateLimited', 'fake', '429') });
    const without = await measureAi(await prepare(nth, 1), { ...CONFIG, noEscalation: true, env, complete: (req) => fake2.complete(req) });
    expect(withEsc.llmCalls).toBe(without.llmCalls + 1);
  }, 60_000);

  it('complete mode runs the free engine first and the AI step on what is missing, and says how much that was', async () => {
    const a = await measureAi(await prepare(nth, 1), { ...CONFIG, mode: 'complete', env, complete: referenceAnswerFake(nth) });
    expect(a.mode).toBe('complete');
    expect(a.path).toBe('llm');
    expect(a.completion).toBeDefined();
    expect(a.completion!.missingColumns).toBeGreaterThanOrEqual(1);
    expect(a.llmCalls).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('masking on sends the masked payload: none of the real cell words reaches the provider (and with masking off they do)', async () => {
    const streets = ['הרצל', 'ויצמן', 'רוטשילד', 'אלנבי', 'הגפן', 'הזית', 'דיזנגוף', 'סוקולוב'];
    const sentWith = async (masking: boolean): Promise<string> => {
      const fake = createFakeProvider();
      fake.enqueue({ json: toWire(assembleWire(nth) as unknown as LearnResult) });
      await measureAi(await prepare(nth, 1), { ...CONFIG, masking, env, complete: (req) => fake.complete(req) });
      return JSON.stringify(fake.calls[0]!.content);
    };
    const masked = await sentWith(true);
    for (const word of streets) expect(masked, word).not.toContain(word);
    const open = await sentWith(false);
    expect(streets.some((w) => open.includes(w))).toBe(true);
  }, 60_000);

  it('a type the free engine finishes never reaches the AI step: path local, zero calls', async () => {
    const left = type('extraction.left-n');
    const fake = createFakeProvider();
    const a = await measureAi(await prepare(left, 1), { ...CONFIG, mode: 'full', env, complete: (req) => fake.complete(req) });
    expect(a).toMatchObject({ path: 'local', llmCalls: 0, verified: true, holdOut: 'pass' });
    expect(fake.calls).toHaveLength(0);
  }, 60_000);
});

// ---------- the whole run ----------

describe('runAiMeasurement (fake provider)', () => {
  const types = [type('extraction.nth-word'), type('extraction.left-n')];
  const run = (records: CatalogueRecord[], over: Partial<Parameters<typeof runAiMeasurement>[0]> = {}) =>
    runAiMeasurement({ config: CONFIG, env, types, seeds: [1], records, resume: false, replace: false, completeFor: (t) => referenceAnswerFake(t), ...over });

  it('measures the free layers it is missing, then only the needs-AI types, and records them; --resume then has nothing left to do', async () => {
    const written: number[] = [];
    const first = await run([], { onRecords: (r) => written.push(r.length) });
    expect(first.plan.needs.map((t) => t.id)).toEqual(['extraction.nth-word']);
    expect(first.measured).toBe(1);
    expect(first.records.map((r) => r.type).sort()).toEqual(['extraction.left-n', 'extraction.nth-word']);
    expect(first.records.find((r) => r.type === 'extraction.nth-word')!.ai).toMatchObject({ verified: true, holdOut: 'pass' });
    expect(first.records.find((r) => r.type === 'extraction.left-n')!.ai).toBeUndefined();
    expect(written.length).toBeGreaterThanOrEqual(2); // after the free layers, and after every pair

    const again = await run(first.records, { resume: true });
    expect(again.measured).toBe(0);
    expect(again.plan.done).toHaveLength(1);
  }, 120_000);

  it('refuses to overwrite results of another configuration unless told to', async () => {
    const first = await run([]);
    await expect(run(first.records, { config: { ...CONFIG, model: 'other-model' } })).rejects.toBeInstanceOf(AiConflictError);
    const replaced = await run(first.records, { config: { ...CONFIG, model: 'other-model' }, replace: true });
    expect(replaced.records.find((r) => r.type === 'extraction.nth-word')!.ai!.model).toBe('other-model');
  }, 120_000);

  it('refuses to run when the configuration and the environment name different providers (tokens would go where nobody meant)', async () => {
    await expect(run([], { config: { ...CONFIG, provider: 'claude-cli' } })).rejects.toThrow(/provider claude-cli but the environment says fake/);
  });

  it('--plan makes no measurement', async () => {
    const planned = await run([], { planOnly: true });
    expect(planned.measured).toBe(0);
    expect(planned.plan.todo).toHaveLength(1);
    expect(planned.records.every((r) => r.ai === undefined)).toBe(true);
  }, 120_000);

  it('stops cleanly between pairs when asked, and keeps what it measured', async () => {
    const first = await run([], { seeds: [1, 2], shouldStop: (() => { let n = 0; return () => n++ >= 1; })() });
    expect(first.stopped).toBe(true);
    expect(first.measured).toBe(1);
    expect(first.records.filter((r) => r.ai).length).toBe(1);
  }, 120_000);
});

// ---------- the report ----------

describe('report with AI results', () => {
  async function records(): Promise<CatalogueRecord[]> {
    const out: CatalogueRecord[] = [];
    for (const id of ['extraction.left-n', 'extraction.nth-word', 'cleanup.proper-case', 'acrossRows.running-total', 'extraction.after-first-sep-rest']) out.push(await measure(type(id), 1));
    return out;
  }
  const attach = (rs: CatalogueRecord[], id: string, a: AiRecord): CatalogueRecord[] => rs.map((r) => (r.type === id ? { ...r, ai: a } : r));

  it('without any AI result the report and the CSV are the free-run ones (no AI column, no AI section)', async () => {
    const rs = await records();
    const md = renderMarkdown(summarize(rs));
    expect(md).not.toContain('AI learns it');
    expect(md).not.toContain('## AI step');
    expect(md).toContain('no AI calls');
    expect(renderCsv(rs).split('\n')[0]).toMatch(/ai_latencyMs$/);
    // stripping the AI results from a measured set gives back exactly the free report
    const withAi = attach(rs, 'extraction.nth-word', ai());
    expect(renderMarkdown(summarize(withAi.map(({ ai: _ai, ...rest }) => rest)))).toBe(md);
  }, 120_000);

  it('adds the "AI learns it" column: ✓ verified + hold-out, ~ verified only, ✗, not run, and — where there is nothing for the AI to do', async () => {
    let rs = await records();
    rs = attach(rs, 'extraction.nth-word', ai());
    rs = attach(rs, 'cleanup.proper-case', ai({ holdOut: 'fail' }));
    const md = renderMarkdown(summarize(rs));
    /** The "AI learns it" cell of a type's capability-map row: `| <topic> | `<id>` <title> | ... | <ai> |`. */
    const cell = (text: string, id: string): string => {
      const line = text.split('\n').find((l) => l.startsWith('| ') && l.split('|')[2]?.trim().startsWith(`\`${id}\` `))!;
      return line.split('|').map((c) => c.trim()).at(-2)!;
    };
    expect(md).toContain('| Hold-out | AI learns it |');
    expect(cell(md, 'extraction.nth-word')).toBe('✓');
    expect(cell(md, 'cleanup.proper-case')).toMatch(/^~ verified only/);
    expect(cell(md, 'acrossRows.running-total')).toBe('not run');
    expect(cell(md, 'extraction.left-n')).toBe('—'); // the free engine solves it
    expect(cell(md, 'extraction.after-first-sep-rest')).toBe('—'); // the language cannot say it
    rs = attach(rs, 'acrossRows.running-total', ai({ verified: false, classification: 'unsupported:crossRowCalculation', holdOut: 'fail', unsupported: ['crossRowCalculation'] }));
    expect(cell(renderMarkdown(summarize(rs)), 'acrossRows.running-total')).toBe('✗ unsupported:crossRowCalculation');
  }, 120_000);

  it('summarizes per topic: share learned, averages, top unsupported codes, function requests named', async () => {
    let rs = await records();
    rs = attach(rs, 'extraction.nth-word', ai({ llmCalls: 1, tokensIn: 1000, tokensOut: 100, tokensCached: 400, latencyMs: 2000 }));
    rs = attach(rs, 'cleanup.proper-case', ai({ verified: false, holdOut: 'fail', classification: 'unsupported:externalData', llmCalls: 3, tokensIn: 3000, tokensOut: 300, unsupported: ['externalData', 'externalData'], functionRequests: ['lookupSomething'], explanation: true, formulaErrors: 2 }));
    rs = attach(rs, 'acrossRows.running-total', ai({ verified: false, holdOut: 'fail', classification: 'unsupported:crossRowCalculation', unsupported: ['crossRowCalculation'], functionRequests: ['lookupSomething', 'otherFn'] }));
    const s = summarize(rs);
    expect(s.ai).toBeDefined();
    const topic = (label: string) => s.ai!.topics.find((t) => t.label === label)!;
    expect(topic('Text extraction')).toMatchObject({ needsAi: 1, run: 1, learned: 1, failed: 0, share: 1, avgCalls: 1, avgTokensIn: 1000, avgTokensCached: 400 });
    expect(topic('Text cleanup')).toMatchObject({ run: 1, learned: 0, failed: 1, share: 0, avgCalls: 3, formulaErrors: 2, explanations: 1 });
    expect(topic('Text cleanup').unsupported).toEqual([['externalData', 2]]);
    expect(topic('Text cleanup').functionRequests).toEqual([['lookupSomething', 1]]);
    expect(s.ai!.total).toMatchObject({ needsAi: 3, run: 3, learned: 1, failed: 2, notRun: 0 });
    expect(s.ai!.total.functionRequests).toEqual([['lookupSomething', 2], ['otherFn', 1]]);
    expect(s.ai!.functionRequests).toEqual([{ name: 'lookupSomething', types: ['cleanup.proper-case', 'acrossRows.running-total'] }, { name: 'otherFn', types: ['acrossRows.running-total'] }]);

    const md = renderMarkdown(s);
    expect(md).toContain('## AI step: what the AI learns that the free engine does not');
    expect(md).toContain('### By topic');
    expect(md).toMatch(/\| Text cleanup \| 1 \| 1 \| 0 \| 0 \| 1 \| 0% \| 3 \| 3\.0k \/ 300 \(0\) \| — \| — \| 2\.0 s \| 2 \| externalData ×2 \| lookupSomething ×1 \| 1 \|/);
    expect(md).toContain('| `lookupSomething` | `cleanup.proper-case`, `acrossRows.running-total` |');
    expect(md).toContain('| **All** | 3 | 3 | 1 | 0 | 2 | 33% |');
    expect(md).toContain('fake / full / masking off / escalation on');
    // an errored measurement is not an answer: left out of the shares, listed as an error
    const errored = attach(rs, 'cleanup.proper-case', ai({ error: 'every LLM call failed (error:rateLimited)', verified: false, holdOut: 'n/a' }));
    const e = summarize(errored).ai!;
    expect(e.total).toMatchObject({ errors: 1, run: 2, learned: 1, failed: 1 });
    expect(renderMarkdown(summarize(errored))).toContain('Measurement errors');
  }, 120_000);

  it('shows our own token estimate per topic, per type and in total, and in the CSV; n/a for an unpriced model, nothing for an old record', async () => {
    const est = (inputTokens: number, costUsd: number | null) => ({ inputTokens, cachedInputTokens: 10_000, cacheWriteTokens: 10_000, outputTokens: 2000, costUsd });
    let rs = await records();
    rs = attach(rs, 'extraction.nth-word', ai({ estimate: est(2000, 0.03) }));
    rs = attach(rs, 'cleanup.proper-case', ai({ estimate: est(4000, 0.05) }));
    rs = attach(rs, 'acrossRows.running-total', ai({})); // measured before the estimate existed
    const s = summarize(rs);
    expect(s.ai!.est).toMatchObject({ records: 2, inTokens: 6000, cachedTokens: 20_000, cacheWriteTokens: 20_000, outTokens: 4000 });
    expect(s.ai!.est.costUsd).toBeCloseTo(0.08, 10);
    const md = renderMarkdown(s);
    expect(md).toContain('| Estimated tokens in / cached / cache write / out, all measurements (our own count) | 6.0k / 20.0k / 20.0k / 4.0k |');
    expect(md).toContain('| Estimated cost at the published prices, all measurements | $0.0800 |');
    expect(md).toContain('| 2.0k / 10.0k / 10.0k / 2.0k | $0.0300 |'); // the mean per record of the one type of its topic
    const unpriced = renderMarkdown(summarize(attach(rs, 'cleanup.proper-case', ai({ estimate: est(4000, null) }))));
    expect(unpriced).toContain('| Estimated cost at the published prices, all measurements | n/a |');
    const csv = renderCsv(rs).split('\n');
    const header = csv[0]!.split(',');
    const row = csv.find((l) => l.startsWith('extraction.nth-word,'))!.split(',');
    expect(row).toHaveLength(header.length);
    expect(row[header.indexOf('ai_estCacheWriteTokens')]).toBe('10000');
    expect(row[header.indexOf('ai_estCostUsd')]).toBe('0.03');
  }, 120_000);

  it('the CSV gains the AI columns only when there is AI data', async () => {
    const rs = attach(await records(), 'extraction.nth-word', ai({ unsupported: ['other'], functionRequests: ['wordAtPosition'], explanation: true }));
    const csv = renderCsv(rs).split('\n');
    expect(csv[0]).toContain('ai_functionRequests');
    const header = csv[0]!.split(',');
    const nth = csv.find((l) => l.startsWith('extraction.nth-word,'))!;
    expect(nth.split(',').length).toBe(header.length);
    expect(nth).toContain('wordAtPosition');
    expect(nth).toContain('learned');
  }, 120_000);
});
