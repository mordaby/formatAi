// `learn_completed` and the table `file_rejected` (SPEC 14.1; owner decision 2026-10-08): the learn flow reports how EACH run ended - the browser's
// own final verdict, which the server never sees for the free engine's local learns - once, with the path, the status, the masking choice and
// whether the AI step was the user's click. Counts and codes only. A fake worker and a fake API; nothing is sent.
import type { LearnResult } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api';
import type { Track } from '../src/api/events';
import { learnStatus, LearnFlow, type FileLike, type StartParams } from '../src/flow/learnFlow';
import type { LearnArgs, LearnHost, LearnOutput } from '../src/worker/engineApi';
import type { EngineClient } from '../src/worker/engineClient';
import { RpcRemoteError } from '../src/worker/rpcClient';

const RULES = { schemaVersion: 1, output: { columns: [] } } as unknown as LearnResult;
const OK_PREFLIGHT = { status: 'ok', issues: [], skipColumns: [] };
const VERIFIED = { verified: true, matched: 3, total: 3, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] };
const NOT_VERIFIED = { ...VERIFIED, verified: false, matched: 1 };

function result(over: Record<string, unknown>): LearnOutput {
  return { path: 'local', preflight: OK_PREFLIGHT, rules: RULES, verification: VERIFIED, assumptions: [], unsupported: [], calls: [], stages: {}, ...over } as unknown as LearnOutput;
}

const file = (name: string): FileLike => ({ name, size: 10, arrayBuffer: async () => new ArrayBuffer(10) });

/** `calls`: everything the flow told `track`, in order, as `[type, props]`. */
function setup(impl: (args: LearnArgs, host: LearnHost) => Promise<LearnOutput>, api: Partial<Api> = {}) {
  const engine = { learn: vi.fn((args: LearnArgs, host: LearnHost) => impl(args, host)), convert: vi.fn(), terminate: vi.fn() } as unknown as EngineClient;
  const track = vi.fn() as unknown as Track & ReturnType<typeof vi.fn>;
  const fullApi = {
    session: vi.fn(),
    learn: vi.fn(async () => ({ rules: RULES, verified: true, problems: [], learnId: 'L1', cached: false })),
    repair: vi.fn(),
    registry: { learnOutcome: vi.fn(async () => ({ counted: true, quota: { remaining: 2, period: 'month' }, failedAttempts: 0, exhausted: false })) },
    ...api,
  } as unknown as Api;
  const flow = new LearnFlow({ engine, api: fullApi, tier: 'registered', track });
  const start = (over: Partial<StartParams> = {}) => flow.start({ input: file('Secret orders.csv'), output: file('Secret report.csv'), masking: true, ...over });
  const calls = (): [string, unknown][] => (track as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0] as string, c[1]]);
  return { flow, start, calls, engine };
}

const learned = (props: Record<string, unknown>): [string, unknown] => ['learn_completed', props];

describe('learn_completed: how a learn ended', () => {
  it('the free engine solved it and the browser verified it: path local, verified', async () => {
    const t = setup(async () => result({ path: 'local' }));
    await t.start();
    expect(t.calls()).toEqual([learned({ path: 'local', status: 'verified', masking: true, aiClicked: false })]);
  });

  it('says which masking choice the learn ran with', async () => {
    const t = setup(async () => result({ path: 'local' }));
    await t.start({ masking: false });
    expect(t.calls()).toEqual([learned({ path: 'local', status: 'verified', masking: false, aiClicked: false })]);
  });

  it('the free engine\'s partial result, before the AI step: path local, partial', async () => {
    const t = setup(async () => result({ path: 'partial', partial: { reason: 'aiNotAllowed' }, verification: NOT_VERIFIED }));
    await t.start({ ai: 'notAllowed' });
    expect(t.calls()).toEqual([learned({ path: 'local', status: 'partial', masking: true, aiClicked: false })]);
  });

  it('the AI step\'s answer: path llm, verified or failed by the browser\'s own check, and the AI was the user\'s click', async () => {
    const ok = setup(async () => result({ path: 'llm' }));
    await ok.start({ ai: 'allowed' });
    expect(ok.calls()).toEqual([learned({ path: 'llm', status: 'verified', masking: true, aiClicked: true })]);

    const bad = setup(async () => result({ path: 'llm', verification: NOT_VERIFIED }));
    await bad.start({ ai: 'allowed' });
    expect(bad.calls()).toEqual([learned({ path: 'llm', status: 'failed', masking: true, aiClicked: true })]);
  });

  it('an answer from the saved structure: path cache', async () => {
    const t = setup(
      async (_args, host) => {
        // the worker asked the API for the rules: the server had them cached
        await host.callLearn({ masking: true, output: { columns: [] }, samples: [] } as never);
        return result({ path: 'llm' });
      },
      { learn: vi.fn(async () => ({ rules: RULES, verified: true, problems: [], learnId: 'L1', cached: true })) as never },
    );
    await t.start({ ai: 'allowed' });
    expect(t.calls()).toEqual([learned({ path: 'cache', status: 'verified', masking: true, aiClicked: true })]);
  });

  it('stopped before learning by the checks: blocked, and the table check that turned the file away - its code, never the file', async () => {
    const issues = [
      { code: 'tableRejected', severity: 'block', params: { side: 'input', tableIssueCode: 'noHeaderRow' } },
      { code: 'tableRejected', severity: 'block', params: { side: 'output', tableIssueCode: 'noHeaderRow' } },
      { code: 'tableRejected', severity: 'block', params: { side: 'output', tableIssueCode: 'tooFewDataRows', rows: 1 } },
    ];
    const t = setup(async () => result({ path: 'blocked', rules: null, verification: null, preflight: { status: 'block', issues, skipColumns: [] } }));
    await t.start();
    expect(t.calls()).toEqual([
      learned({ path: 'local', status: 'blocked', masking: true, aiClicked: false }),
      ['file_rejected', { reason: 'noHeaderRow' }],
      ['file_rejected', { reason: 'tooFewDataRows' }],
    ]);
  });

  it('a block that is not a table check (identical files, a pivot) is blocked and rejects no file', async () => {
    const issues = [{ code: 'identicalFiles', severity: 'block' }];
    const t = setup(async () => result({ path: 'blocked', rules: null, verification: null, preflight: { status: 'block', issues, skipColumns: [] } }));
    await t.start();
    expect(t.calls()).toEqual([learned({ path: 'local', status: 'blocked', masking: true, aiClicked: false })]);
  });

  it('"rows could not be aligned" is a pause, not an end: nothing is reported until the user goes on', async () => {
    const issues = [{ code: 'rowsNotAligned', severity: 'warn', params: { count: 2 } }];
    let runs = 0;
    const t = setup(async () => {
      runs++;
      return runs === 1 ? result({ path: 'blocked', rules: null, verification: null, preflight: { status: 'warn', issues, skipColumns: [] } }) : result({ path: 'local' });
    });
    await t.start();
    expect(t.flow.getState().status).toBe('warn');
    expect(t.calls()).toEqual([]);
    t.flow.confirm();
    await vi.waitFor(() => expect(t.calls()).toHaveLength(1));
    expect(t.calls()).toEqual([learned({ path: 'local', status: 'verified', masking: true, aiClicked: false })]);
  });

  it('the AI readiness gate stopped the AI step: notReady, nothing went to the AI so the path is local', async () => {
    const t = setup(async () => result({ path: 'notReady', rules: null, verification: null }));
    await t.start({ ai: 'allowed' });
    expect(t.calls()).toEqual([learned({ path: 'local', status: 'notReady', masking: true, aiClicked: true })]);
  });

  it('no rules at all: error', async () => {
    const t = setup(async () => result({ path: 'llm', rules: null, verification: null }));
    await t.start({ ai: 'allowed' });
    expect(t.calls()).toEqual([learned({ path: 'llm', status: 'error', masking: true, aiClicked: true })]);
  });

  it('a failure of the worker or the network: error, on the path that was tried', async () => {
    const free = setup(async () => {
      throw new RpcRemoteError({ name: 'Error', message: 'boom', code: 'unreadable' });
    });
    await free.start();
    expect(free.calls()).toEqual([learned({ path: 'local', status: 'error', masking: true, aiClicked: false })]);

    const ai = setup(async () => {
      throw new Error('network');
    });
    await ai.start({ ai: 'allowed' });
    expect(ai.calls()).toEqual([learned({ path: 'llm', status: 'error', masking: true, aiClicked: true })]);
  });

  it('is reported once per run', async () => {
    const t = setup(async () => result({ path: 'local' }));
    await t.start();
    await t.start();
    expect(t.calls()).toHaveLength(2);
  });
});

describe('what is not a learn that ended', () => {
  it('"You already have this format" and "This output matches your format" report nothing (their answers are known_format)', async () => {
    const known = setup(async () => result({ path: 'known', rules: null, verification: null, known: { formatId: 'F1', formatName: 'My format', sourceId: 'S1', sourceName: 'Input', conversionId: 'C1' } }));
    await known.start({ checkKnown: true });
    expect(known.flow.getState().status === 'idle' || known.flow.getState().status === 'known').toBe(true);
    expect(known.calls()).toEqual([]);

    const same = setup(async () => result({ path: 'matchesFormat', rules: null, verification: null, sameOutput: [{ formatId: 'F1', formatName: 'My format', sources: 1, format: {} }] }));
    await same.start({ checkKnown: true });
    expect(same.calls()).toEqual([]);
  });

  it('a run that was cancelled or replaced reports nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup(async () => {
      await gate;
      return result({ path: 'local' });
    });
    const first = t.start();
    t.flow.cancel();
    release();
    await first;
    expect(t.calls()).toEqual([]);
  });

  it('a run that puts a result back after a sign-in (restore) reports nothing: the learn was counted when the user first saw it', async () => {
    const t = setup(async () => result({ path: 'local' }));
    await t.start({ restore: true });
    expect(t.flow.getState().status).toBe('done');
    expect(t.calls()).toEqual([]);
  });

  it('a flow with no emitter (a test, a page without one) learns the same', async () => {
    const engine = { learn: vi.fn(async () => result({ path: 'local' })), convert: vi.fn(), terminate: vi.fn() } as unknown as EngineClient;
    const flow = new LearnFlow({ engine, api: {} as Api, tier: 'registered' });
    await flow.start({ input: file('a.csv'), output: file('b.csv'), masking: true });
    expect(flow.getState().status).toBe('done');
  });
});

describe('a completion (Finish with AI for what is missing)', () => {
  const completion = (over: Record<string, unknown>) => ({ columns: [1], parts: [], fixedProblems: [], matches: true, produced: { columns: 1, parts: 0 }, ...over });

  it('is verified only when the answer holds the user\'s rules and matches the example', () => {
    expect(learnStatus({ path: 'llm', verification: VERIFIED, completion: completion({}) } as never)).toBe('verified');
    expect(learnStatus({ path: 'llm', verification: VERIFIED, completion: completion({ matches: false }) } as never)).toBe('failed');
    expect(learnStatus({ path: 'llm', verification: VERIFIED, completion: completion({ fixedProblems: [{ code: 'x' }] }) } as never)).toBe('failed');
    expect(learnStatus({ path: 'llm', verification: NOT_VERIFIED, completion: completion({}) } as never)).toBe('failed');
  });

  it('is reported like a learn, as the AI\'s: path llm, aiClicked', async () => {
    const t = setup(async () => result({ path: 'llm', completion: completion({}) }));
    await t.start({ ai: 'allowed', complete: { fixedRules: RULES, columns: [1], parts: [], exampleId: 'ex1' } as never });
    expect(t.calls()).toEqual([learned({ path: 'llm', status: 'verified', masking: true, aiClicked: true })]);
  });
});

describe('what a learn event holds', () => {
  it('has no file name, header or value: only the four codes', async () => {
    const t = setup(async () => result({ path: 'local' }));
    await t.start();
    const props = t.calls()[0]![1];
    expect(Object.keys(props as object).sort()).toEqual(['aiClicked', 'masking', 'path', 'status']);
    expect(JSON.stringify(t.calls())).not.toMatch(/Secret|csv/);
  });
});
