// An AI answer that honestly says "this column cannot be produced" (`from: null` plus an `unsupported` entry, typically externalData), run through
// the REAL engine (worker methods, in-process) and the real LearnFlow: the browser's verification checks the columns that have a rule, so when
// everything produced matches the learn is reported as `verified` (one successful AI learn) and the column "needs your input" on the rules map.
// An answer that produced no column at all is reported as `failed`.
import type { LearnResult } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api';
import { LearnFlow, type FileLike } from '../src/flow/learnFlow';
import { describeRules } from '../src/rulesText/describe';
import { createEngineClient, type EngineClient } from '../src/worker/engineClient';
import type { LearnOutput } from '../src/worker/engineApi';
import { engineMethods } from '../src/worker/engineMethods';
import { loopbackWorker } from './helpers/loopback';

const ITEMS = ['Kumquat', 'Zeppelin', 'Marzipan', 'Quokka', 'Lozenge', 'Buttress', 'Gazebo', 'Nutmeg', 'Cobbler', 'Trestle', 'Anvil', 'Bramble'];

/** Item and Qty are copied; Warehouse holds values that are nowhere in the input (external data). */
const CSV = {
  input: 'Item,Qty\n' + ITEMS.map((n, i) => `${n},${i + 3}`).join('\n') + '\n',
  output: 'Item,Qty,Warehouse\n' + ITEMS.map((n, i) => `${n},${i + 3},W-${400 + i * 7}`).join('\n') + '\n',
};

const bytesOf = (s: string): ArrayBuffer => {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};
const file = (name: string, body: string): FileLike => ({ name, size: body.length, arrayBuffer: async () => bytesOf(body) });
const engineOf = (): EngineClient => createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });

/** The local partial rules of the pair (what code built: Item and Qty copied, Warehouse with no rule), with the real file settings. */
async function localRules(engine: EngineClient): Promise<LearnResult> {
  const res: LearnOutput = await engine.learn(
    { input: { name: 'in.csv', bytes: bytesOf(CSV.input) }, output: { name: 'out.csv', bytes: bytesOf(CSV.output) }, masking: false, tier: 'paid', ai: 'notAllowed' },
    { callLearn: async () => { throw new Error('no AI step here'); }, callRepair: async () => { throw new Error('no AI step here'); }, callStep: async () => { throw new Error('no AI step here'); } },
  );
  if (res.path !== 'partial' || !res.rules) throw new Error(`expected a partial result, got ${res.path}`);
  return res.rules;
}

const EXTERNAL = { outputColumn: 'Warehouse', reasonCode: 'externalData' as const };

async function run(answer: LearnResult) {
  const engine = engineOf();
  const learnOutcome = vi.fn(async () => ({ counted: true, quota: { remaining: 2, period: 'month' as const }, failedAttempts: 0, exhausted: false }));
  const api = {
    session: vi.fn(),
    // The server's own checks passed (it excludes the unsupported column from its sample diff): the answer comes back as it is.
    learn: vi.fn(async () => ({ rules: answer, verified: true, problems: [], learnId: 'L1', cached: false, counted: false, failedAttempts: 0 })),
    // (a browser repair that does not fix it)
    repair: vi.fn(async () => ({ rules: answer, problems: [], counted: false, failedAttempts: 0 })),
    registry: { learnOutcome },
  } as unknown as Api;
  const flow = new LearnFlow({ engine, api, tier: 'paid' });
  await flow.start({ input: file('in.csv', CSV.input), output: file('out.csv', CSV.output), masking: true, ai: 'allowed' });
  return { flow, api, learnOutcome };
}

describe('LearnFlow with the real engine: an AI answer that reports a column as unsupported', () => {
  it('everything produced matches: the learn is reported as verified, and the column is "needs your input" on the rules map', async () => {
    const answer: LearnResult = { ...(await localRules(engineOf())), unsupported: [EXTERNAL] };
    const { flow, api, learnOutcome } = await run(answer);

    const state = flow.getState();
    if (state.status !== 'done') throw new Error(`expected done, got ${state.status}`);
    expect(state.result.path).toBe('llm');
    expect(state.result.verification).toMatchObject({ verified: true, matched: 12, total: 12, mismatches: [] });
    expect(state.result.unsupported).toEqual([EXTERNAL]);

    // One AI call, no browser repair, and the outcome the server counts as a successful learn.
    expect(api.learn).toHaveBeenCalledTimes(1);
    expect(api.repair).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'verified'));

    // The map says what the user has to do for it: nothing is "different", the column "needs your input".
    const model = describeRules(state.result.rules!, { lang: 'en', verification: state.result.verification! });
    const line = model.sections.flatMap((s) => s.lines).find((l) => l.id === 'col:Warehouse');
    expect(line).toMatchObject({ status: 'needsInput' });
  });

  it('a produced column that does not match is still not verified (the outcome is failed)', async () => {
    const rules = await localRules(engineOf());
    const qtyFrom = rules.output.columns.find((c) => c.header === 'Qty')!.from;
    // Item now copies Qty: wrong on every row.
    const wrong: LearnResult = {
      ...rules,
      unsupported: [EXTERNAL],
      output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Item' ? { ...c, from: qtyFrom } : c)) },
    };
    const { flow, api, learnOutcome } = await run(wrong);
    const state = flow.getState();
    if (state.status !== 'done') throw new Error(`expected done, got ${state.status}`);
    expect(state.result.verification?.verified).toBe(false);
    expect(api.repair).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'failed'));
  });

  it('every column reported as unsupported produced nothing: the outcome is failed, not verified', async () => {
    const rules = await localRules(engineOf());
    const nothing: LearnResult = {
      ...rules,
      transform: { ...rules.transform, computed: [] },
      output: { ...rules.output, columns: rules.output.columns.map((c) => ({ header: c.header, from: null })) },
      unsupported: rules.output.columns.map((c) => ({ outputColumn: c.header, reasonCode: 'externalData' as const })),
    };
    const { flow, api, learnOutcome } = await run(nothing);
    const state = flow.getState();
    if (state.status !== 'done') throw new Error(`expected done, got ${state.status}`);
    expect(state.result.verification).toMatchObject({ verified: false, total: 0 });
    // Nothing in the example to point a repair at (no diff) - but Item and Qty are copies the analysis found (a hint each), and the answer gave up on
    // them: that is what the one repair call asks about. Warehouse has no hint and is never asked about. The repair did not fix it: still failed.
    expect(api.repair).toHaveBeenCalledTimes(1);
    const problems = (api.repair as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![3] as { kind: string; out: number }[];
    expect(problems.map((p) => [p.kind, p.out])).toEqual([['unsupportedDespiteEvidence', 0], ['unsupportedDespiteEvidence', 1]]);
    await vi.waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'failed'));
  });
});
