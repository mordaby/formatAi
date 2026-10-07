// AI code checks (learn-v9, SPEC 21 v14; docs/proposals/ai-code-checks.md) in the browser: the REAL engine (worker methods, in-process,
// through the real RPC) and the real LearnFlow, with a fake API. The AI step answers with checks; the worker answers them on every row and the
// main thread sends POST /api/learn/step under the learn's own id with every round so far, until the rules come - at most
// `limits.learn.checks.maxRounds` rounds. The progress says which round it is, "See what we send" lists each step, and a refused step is an
// error like any other API error.
import { limitMessages, limits, type Check, type CheckRound, type LearnPayload, type LearnResult, type StepResponse } from '@formatai/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Api } from '../src/api';
import { errorView } from '../src/app/messages';
import { LearnFlow, type FileLike, type LearnFlowState } from '../src/flow/learnFlow';
import { codeText, translate, type I18n } from '../src/i18n';
import { CHECK_ROUND_ALLOWANCE_MS, createEngineClient, type EngineClient } from '../src/worker/engineClient';
import type { LearnOutput, LearnProgress } from '../src/worker/engineApi';
import { RpcTimeoutError } from '../src/worker/rpcClient';
import type { MethodContext } from '../src/worker/runtime';
import { engineMethods } from '../src/worker/engineMethods';
import { loopbackWorker } from './helpers/loopback';

const ITEMS = ['Kumquat', 'Zeppelin', 'Marzipan', 'Quokka', 'Lozenge', 'Buttress', 'Gazebo', 'Nutmeg', 'Cobbler', 'Trestle'];
const QTY = [3, 12, 7, 25, 1, 40, 9, 15, 2, 30];

/** Output "Size" is a rule on Qty no single relation explains: the fast path gives up, the AI step is asked. */
const CSV = {
  input: 'Item,Qty\n' + ITEMS.map((n, i) => `${n},${QTY[i]}`).join('\n') + '\n',
  output: 'Item,Size\n' + ITEMS.map((n, i) => `${n},${QTY[i]! >= 10 ? 'bulk' : 'single'}`).join('\n') + '\n',
};

const bytesOf = (s: string): ArrayBuffer => {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};
const file = (name: string, body: string): FileLike => ({ name, size: body.length, arrayBuffer: async () => bytesOf(body) });
const engineOf = (): EngineClient => createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });
const noAi = async (): Promise<never> => {
  throw new Error('no AI step here');
};

/** The right answer, with the real file settings: the local result (Item copied, Size with no rule) and Size = bulk from 10 on. */
async function answerRules(): Promise<LearnResult> {
  const res: LearnOutput = await engineOf().learn(
    { input: { name: 'in.csv', bytes: bytesOf(CSV.input) }, output: { name: 'out.csv', bytes: bytesOf(CSV.output) }, masking: false, tier: 'paid', ai: 'notAllowed' },
    { callLearn: noAi, callRepair: noAi, callStep: noAi },
  );
  if (res.path !== 'partial' || !res.rules) throw new Error(`expected a partial result, got ${res.path}`);
  const rules = res.rules;
  const qty = rules.input.columns.find((c) => c.header === 'Qty') ?? { id: 'qty', header: 'Qty', type: 'integer' as const };
  return {
    ...rules,
    input: { ...rules.input, columns: rules.input.columns.some((c) => c.id === qty.id) ? rules.input.columns : [...rules.input.columns, qty] },
    transform: {
      ...rules.transform,
      computed: [...rules.transform.computed, { id: 'size', type: 'text', expr: { op: 'if', cond: { op: 'gte', args: [{ col: qty.id }, { const: 10 }] }, then: { const: 'bulk' }, else: { const: 'single' } } }],
    },
    output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Size' ? { ...c, from: 'size' } : c)) },
  };
}

const VALUES_SIZE: Check = { check: 'values', column: 'Size' };
const VALUES_ITEM: Check = { check: 'values', column: 'Item' };
const QUOTA = { remaining: 2, period: 'month' as const, limit: null };

/** POST /api/learn's answer when the AI step asks checks: no rules, nothing counted yet, the learn's id for the steps. */
const checksAnswer = (checks: Check[], droppedChecks?: string[]) => ({
  rules: null,
  checks,
  ...(droppedChecks ? { droppedChecks } : {}),
  verified: false,
  problems: [],
  learnId: 'L1',
  cached: false,
  counted: false,
  failedAttempts: 0,
  quota: QUOTA,
});
const moreChecks = (checks: Check[]): StepResponse => ({ rules: null, checks, verified: false, problems: [], counted: false, failedAttempts: 0, quota: QUOTA });

function fakeApi(step: (token: string, payload: LearnPayload, rounds: CheckRound[], opts?: { signal?: AbortSignal }) => Promise<StepResponse>, first = checksAnswer([VALUES_SIZE])) {
  const learnOutcome = vi.fn(async () => ({ counted: true, quota: { remaining: 1, period: 'month' as const, limit: null }, failedAttempts: 0, exhausted: false }));
  const api = {
    session: vi.fn(),
    learn: vi.fn(async (_payload: LearnPayload, _opts?: unknown) => first),
    repair: vi.fn(async () => ({ rules: null, verified: false, problems: [], counted: false, failedAttempts: 0 })),
    step: vi.fn(step),
    registry: { learnOutcome },
  };
  return { api: api as unknown as Api, learn: api.learn, step: api.step, repair: api.repair, learnOutcome };
}

async function run(api: Api, masking = false) {
  const flow = new LearnFlow({ engine: engineOf(), api, tier: 'paid' });
  const states: LearnFlowState[] = [];
  flow.subscribe(() => states.push(flow.getState()));
  await flow.start({ input: file('in.csv', CSV.input), output: file('out.csv', CSV.output), masking, ai: 'allowed' });
  return { flow, states };
}

const i18n = (lang: 'en' | 'he'): I18n => ({ lang, dir: lang === 'he' ? 'rtl' : 'ltr', setLang: () => {}, toggle: () => {}, t: (key, params) => translate(lang, key, params), code: (msg) => codeText(lang, msg) });

describe('LearnFlow with the real engine: the AI step asks code to check ideas first (AI code checks)', () => {
  it('a checks answer, then a step, then the rules: the step goes under the learn\'s id with the round, and the rules are the result', async () => {
    const answer = await answerRules();
    const { api, learn, step, repair, learnOutcome } = fakeApi(async () => ({ rules: answer, verified: true, problems: [], counted: true, failedAttempts: 0, quota: { remaining: 1, period: 'month', limit: null } }));
    const { flow, states } = await run(api);

    const state = flow.getState();
    if (state.status !== 'done') throw new Error(`expected done, got ${state.status}`);
    // The result is the step's rules, verified on every row of the example; the engine says what the checks were.
    expect(state.result.path).toBe('llm');
    expect(state.result.verification).toMatchObject({ verified: true, matched: 10, total: 10 });
    expect(state.result.rules!.output.columns.find((c) => c.header === 'Size')?.from).toBe('size');
    expect(state.result.checks).toEqual({ rounds: 1, asked: 1, rowsShown: 0, dropped: 0, errors: 0 });

    // One learn, one step under the learn's id with the learn's own payload and the one round: the check as asked, code's answer.
    expect(learn).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledTimes(1);
    const [token, payload, rounds, opts] = step.mock.calls[0]!;
    expect(token).toBe('L1');
    expect(payload).toEqual(learn.mock.calls[0]![0]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.checks).toEqual([VALUES_SIZE]);
    expect(rounds[0]!.answers[0]).toMatchObject({ rows: 10, distinct: 2, empty: 0 });
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(repair).not.toHaveBeenCalled();

    // What the step said is what the learn reports (it counted); the browser's own verification goes back on the learn's id.
    expect(state.ai).toMatchObject({ learnId: 'L1', counted: true });
    await vi.waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'verified'));

    // "See what we send": the learn, then the step with its round (the size is the payload with every round, as the API caps it).
    expect(state.sent.map((r) => [r.kind, r.round])).toEqual([['learn', undefined], ['step', { n: 1, of: limits.learn.checks.maxRounds }]]);
    const sentStep = state.sent[1]!;
    expect(sentStep.rounds).toEqual(rounds);
    expect(sentStep.bytes).toBe(new TextEncoder().encode(JSON.stringify({ payload: sentStep.payload, rounds: sentStep.rounds })).length);

    // The progress: while the checks are answered and the step runs, the first try says which round of checks it is - and there is no
    // "checking against your example" before the rules came.
    const learning = states.filter((s): s is Extract<LearnFlowState, { status: 'learning' }> => s.status === 'learning');
    expect(learning.some((s) => s.checkRound?.n === 1 && s.checkRound.of === limits.learn.checks.maxRounds && s.attempt === 'learn')).toBe(true);
    const firstCheck = states.findIndex((s) => s.status === 'learning' && s.checkRound !== undefined);
    expect(states.slice(0, firstCheck).some((s) => s.status === 'verifying')).toBe(false);
    expect(states.slice(firstCheck).some((s) => s.status === 'verifying')).toBe(true);
  });

  it('every round so far goes with each step, and the API\'s dropped lines go with their round', async () => {
    const answer = await answerRules();
    const { api, step } = fakeApi(
      async (_t, _p, rounds) => (rounds.length === 1 ? moreChecks([VALUES_ITEM]) : { rules: answer, verified: true, problems: [], counted: true, failedAttempts: 0 }),
      checksAnswer([VALUES_SIZE], ['check 5 was not run: at most 4 checks a round']),
    );
    const { flow, states } = await run(api);
    expect(flow.getState().status).toBe('done');
    expect(step.mock.calls.map((c) => c[2].length)).toEqual([1, 2]);
    expect(step.mock.calls.map((c) => c[0])).toEqual(['L1', 'L1']);
    const last = step.mock.calls[1]![2];
    expect(last[0]!.dropped).toEqual(['check 5 was not run: at most 4 checks a round']);
    expect(last[1]!.checks).toEqual([VALUES_ITEM]);
    expect(flow.getState().sent.map((r) => r.round?.n)).toEqual([undefined, 1, 2]);
    const seen = states.flatMap((s) => (s.status === 'learning' && s.checkRound ? [s.checkRound.n] : []));
    expect([...new Set(seen)]).toEqual([1, 2]);
  });

  it(`stops after ${limits.learn.checks.maxRounds} rounds: an AI step that keeps asking makes no more steps, and the learn has no rules`, async () => {
    const { api, step, repair, learnOutcome } = fakeApi(async () => moreChecks([VALUES_SIZE]));
    const { flow, states } = await run(api);
    expect(step).toHaveBeenCalledTimes(limits.learn.checks.maxRounds);
    expect(step.mock.calls.map((c) => c[2].length)).toEqual(Array.from({ length: limits.learn.checks.maxRounds }, (_, i) => i + 1));
    const state = flow.getState();
    expect(state).toMatchObject({ status: 'error', error: { kind: 'learnFailed' } });
    expect(state.sent.map((r) => r.kind)).toEqual(['learn', ...Array<string>(limits.learn.checks.maxRounds).fill('step')]);
    // The progress never says a round past the cap.
    const seen = states.flatMap((s) => (s.status === 'learning' && s.checkRound ? [s.checkRound.n] : []));
    expect(Math.max(...seen)).toBe(limits.learn.checks.maxRounds);
    expect(repair).not.toHaveBeenCalled();
    expect(learnOutcome).not.toHaveBeenCalled();
  });

  it.each([
    ['limitHit', 429, { limit: 'stepsPerLearn' as const }],
    ['invalidRounds', 400, {}],
    ['invalidLearnId', 400, {}],
    ['invalidRequest', 400, {}],
    ['aiAttemptsExhausted', 409, { counted: false }],
  ] as const)('a step the API refuses (%s) ends the learn with that error, in the shared words', async (code, status, extra) => {
    const { api, step, learnOutcome } = fakeApi(async () => {
      throw new ApiError(code, status, extra);
    });
    const { flow } = await run(api);
    const state = flow.getState();
    if (state.status !== 'error') throw new Error(`expected error, got ${state.status}`);
    expect(state.error).toMatchObject({ kind: 'api', code, ...extra });
    expect(step).toHaveBeenCalledTimes(1);
    expect(learnOutcome).not.toHaveBeenCalled();
    // (the step was made: it is in "see what we send")
    expect(state.sent.map((r) => r.kind)).toEqual(['learn', 'step']);
    for (const lang of ['en', 'he'] as const) expect(errorView(i18n(lang), state.error).text.length).toBeGreaterThan(10);
  });

  it('"the AI already checked every idea it may" is a limit of the one learn: an amber block with Try again, never a sign-in nudge', () => {
    const error = { kind: 'api' as const, code: 'limitHit' as const, limit: 'stepsPerLearn' as const };
    for (const lang of ['en', 'he'] as const) {
      expect(errorView(i18n(lang), error)).toEqual({ tone: 'block', text: limitMessages.stepsPerLearn[lang], action: 'tryAgain' });
    }
  });

  it('masking on: the answers the step carries are masked like the samples (no real text value leaves), the counts are real', async () => {
    const { api, step } = fakeApi(async () => ({ rules: null, verified: false, problems: [], counted: false, failedAttempts: 0 }), checksAnswer([VALUES_ITEM]));
    await run(api, true);
    expect(step).toHaveBeenCalledTimes(1);
    const rounds = step.mock.calls[0]![2];
    expect(rounds[0]!.answers[0]).toMatchObject({ rows: 10, distinct: 10 });
    const sent = JSON.stringify(rounds);
    for (const word of ITEMS) expect(sent).not.toContain(word);
  });

  it('cancel while a step is on its way: the request is aborted and the flow is idle again', async () => {
    let signal: AbortSignal | undefined;
    const { api, step } = fakeApi(
      (_t, _p, _r, opts) =>
        new Promise<StepResponse>((_resolve, reject) => {
          signal = opts?.signal;
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const flow = new LearnFlow({ engine: engineOf(), api, tier: 'paid' });
    const done = flow.start({ input: file('in.csv', CSV.input), output: file('out.csv', CSV.output), masking: false, ai: 'allowed' });
    await vi.waitFor(() => expect(step).toHaveBeenCalledTimes(1));
    expect(flow.getState()).toMatchObject({ status: 'learning', checkRound: { n: 1 } });
    flow.cancel();
    await done;
    expect(signal?.aborted).toBe(true);
    expect(flow.getState().status).toBe('idle');
  });
});

describe("the learn's timeout: the worker's time answering a round of checks is not counted as a hang", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const TIMEOUT = 1000;
  const ALLOWANCE = 5000;
  const bytes = () => ({ name: 'x.csv', bytes: new ArrayBuffer(1) });
  const round = (n: number): LearnProgress => ({ phase: 'learning', attempt: 'learn', checkRound: { n, of: 3 } });
  const busy = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** The real engine client over a fake worker `learn`, which reports rounds of checks like the real one and then works for `workMs` per round. */
  function learnWith(rounds: number, workMs: number) {
    const learn = async (_args: unknown, ctx: MethodContext) => {
      await ctx.host('callLearn', {});
      for (let n = 1; n <= rounds; n++) {
        ctx.progress(round(n)); // the answer asked checks: the worker answers round n now
        await busy(workMs);
        ctx.progress(round(n)); // (the step's own progress, the same round again: no second allowance)
        await ctx.host('callStep', {}, []);
      }
      return { path: 'llm', rules: null };
    };
    const engine = createEngineClient({ createWorker: () => loopbackWorker({ learn }), timeouts: { learn: TIMEOUT }, checkRoundAllowanceMs: ALLOWANCE });
    const host = { callLearn: async () => ({ rules: null, problems: [], calls: [], checks: [] }), callRepair: noAi, callStep: async () => ({ rules: null, problems: [], calls: [] }) };
    return engine.learn({ input: bytes(), output: bytes(), masking: false, tier: 'paid' }, host).catch((e: unknown) => e);
  }

  it('each round of checks adds the allowance once, when it starts', async () => {
    // two rounds of 5.5 s of work each: 11 s of busy time, within 1 s + 2 x 5 s
    const done = learnWith(2, 5500);
    await vi.advanceTimersByTimeAsync(11_500);
    expect(await done).toMatchObject({ path: 'llm' });
  });

  it('a round that works past its allowance still times out (a hung worker is still caught)', async () => {
    const done = learnWith(1, TIMEOUT + ALLOWANCE + 100);
    await vi.advanceTimersByTimeAsync(TIMEOUT + ALLOWANCE + 200);
    expect(await done).toBeInstanceOf(RpcTimeoutError);
  });

  it('without checks nothing is added: the learn times out as before', async () => {
    const done = (async () => {
      const learn = async () => {
        await busy(TIMEOUT + 100);
        return { path: 'llm', rules: null };
      };
      const engine = createEngineClient({ createWorker: () => loopbackWorker({ learn }), timeouts: { learn: TIMEOUT }, checkRoundAllowanceMs: ALLOWANCE });
      return engine.learn({ input: bytes(), output: bytes(), masking: false, tier: 'paid' }, { callLearn: noAi, callRepair: noAi, callStep: noAi }).catch((e: unknown) => e);
    })();
    await vi.advanceTimersByTimeAsync(TIMEOUT + 200);
    expect(await done).toBeInstanceOf(RpcTimeoutError);
  });

  it('the round for a list has its own rounds of checks, and each gets the allowance too - also after the first try had rounds of its own (C4)', async () => {
    const repairRound = (checkRound?: number): LearnProgress => ({
      phase: 'learning',
      attempt: 'repair',
      round: { n: 1, of: 3, rows: 0, list: true },
      ...(checkRound ? { checkRound: { n: checkRound, of: 3 } } : {}),
    });
    const learn = async (_args: unknown, ctx: MethodContext) => {
      await ctx.host('callLearn', {});
      ctx.progress(round(1)); // the first try: one round of checks
      await busy(500);
      await ctx.host('callStep', {}, []);
      ctx.progress(repairRound()); // the list's round
      await ctx.host('callRepair', {}, {}, [], {});
      ctx.progress(repairRound(1)); // ... answered with checks: code answers them on every row now
      await busy(6000);
      await ctx.host('callRepair', {}, {}, [], {});
      return { path: 'llm', rules: null };
    };
    const engine = createEngineClient({ createWorker: () => loopbackWorker({ learn }), timeouts: { learn: TIMEOUT }, checkRoundAllowanceMs: ALLOWANCE });
    const answer = async () => ({ rules: null, problems: [], calls: [] });
    const done = engine.learn({ input: bytes(), output: bytes(), masking: false, tier: 'paid' }, { callLearn: answer, callRepair: answer, callStep: answer }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await done).toMatchObject({ path: 'llm' });
  });

  it('the allowance of a round is every check of it at its time budget', () => {
    expect(CHECK_ROUND_ALLOWANCE_MS).toBe(limits.learn.checks.timeBudgetMs * limits.learn.checks.maxChecksPerRound);
  });
});
