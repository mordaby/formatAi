import type { LearnPayload, LearnResult } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Api } from '../src/api';
import { flowErrorText, type FlowError } from '../src/flow/errors';
import { LearnFlow, type FileLike, type LearnFlowDeps, type LearnFlowState } from '../src/flow/learnFlow';
import { codeText, translate, type I18n } from '../src/i18n';
import type { EngineCallOptions, EngineClient } from '../src/worker/engineClient';
import type { LearnArgs, LearnHost, LearnOutput, LearnProgress } from '../src/worker/engineApi';
import { RpcAbortedError, RpcRemoteError, RpcTimeoutError } from '../src/worker/rpcClient';

const RULES = { schemaVersion: 1, output: { columns: [] } } as unknown as LearnResult;
const PREV_RULES = { schemaVersion: 1, marker: 'previous' } as unknown as LearnResult;

const PAYLOAD = { masking: true, output: { columns: [{ i: 0, header: 'A' }] }, samples: [] } as unknown as LearnPayload;
const PAYLOAD_SKIP = {
  masking: true,
  output: { columns: [{ i: 0, header: 'A' }, { i: 1, header: 'Assigned Warehouse' }] },
  samples: [],
  skipColumns: [1],
} as unknown as LearnPayload;

const OK_PREFLIGHT = { status: 'ok', issues: [], skipColumns: [] };
const VERIFIED = { verified: true, matched: 3, total: 3, mismatches: [], layoutProblems: [], repairProblems: [] };

function result(over: Record<string, unknown>): LearnOutput {
  return {
    path: 'local',
    preflight: OK_PREFLIGHT,
    rules: RULES,
    verification: VERIFIED,
    assumptions: [],
    unsupported: [],
    calls: [],
    stages: {},
    ...over,
  } as unknown as LearnOutput;
}

type LearnImpl = (args: LearnArgs, host: LearnHost, opts: EngineCallOptions<LearnProgress>) => Promise<LearnOutput>;

function fakeEngine(impl: LearnImpl) {
  const learn = vi.fn((args: LearnArgs, host: LearnHost, opts: EngineCallOptions<LearnProgress> = {}) => impl(args, host, opts));
  const engine = { learn, convert: vi.fn(), verify: vi.fn(), terminate: vi.fn() } as unknown as EngineClient;
  return { engine, learn };
}

function fakeApi(over: Partial<Api> = {}) {
  const api = {
    session: vi.fn(),
    learn: vi.fn(async () => ({ rules: RULES, verified: true, problems: [], learnId: 'L1', cached: false })),
    repair: vi.fn(async () => ({ rules: RULES, verified: true, problems: [] })),
    ...over,
  };
  return api as unknown as Api & { learn: ReturnType<typeof vi.fn>; repair: ReturnType<typeof vi.fn> };
}

function file(name: string, size = 10): FileLike {
  return { name, size, arrayBuffer: async () => new ArrayBuffer(size) };
}

function makeFlow(engine: EngineClient, api: Api, extra: Partial<LearnFlowDeps> = {}) {
  const flow = new LearnFlow({ engine, api, tier: 'anonymous', ...extra });
  const statuses: string[] = [];
  flow.subscribe(() => {
    const s = flow.getState().status;
    if (statuses[statuses.length - 1] !== s) statuses.push(s);
  });
  const start = (masking = true) => flow.start({ input: file('in.csv'), output: file('out.csv'), masking });
  return { flow, statuses, start };
}

const state = (flow: LearnFlow): LearnFlowState => flow.getState();

describe('LearnFlow', () => {
  it('fast path: reading -> checking -> done, never learning, nothing sent', async () => {
    const { engine } = fakeEngine(async (_a, _h, opts) => {
      opts.onProgress?.({ phase: 'reading' });
      opts.onProgress?.({ phase: 'checking', stage: 'profile', fraction: 0.4 });
      opts.onProgress?.({ phase: 'checking', stage: 'done', fraction: 1 });
      return result({ path: 'local' });
    });
    const api = fakeApi();
    const { flow, statuses, start } = makeFlow(engine, api);
    await start();
    expect(statuses).toEqual(['reading', 'checking', 'done']);
    const s = state(flow);
    expect(s.status === 'done' && s.result.path).toBe('local');
    expect(s.sent).toEqual([]);
    expect(api.learn).not.toHaveBeenCalled();
  });

  it('reports real progress fractions from the worker', async () => {
    const fractions: number[] = [];
    const { engine } = fakeEngine(async (_a, _h, opts) => {
      opts.onProgress?.({ phase: 'checking', stage: 'profile', fraction: 0.25 });
      opts.onProgress?.({ phase: 'checking', stage: 'align', fraction: 0.5 });
      return result({});
    });
    const { flow, start } = makeFlow(engine, fakeApi());
    flow.subscribe(() => {
      const s = state(flow);
      if (s.status === 'checking') fractions.push(s.fraction);
    });
    await start();
    expect(fractions).toEqual([0.25, 0.5]);
  });

  it('LLM path: the HTTP call is made on the main thread; the payload is recorded for "see what we send"', async () => {
    const { engine } = fakeEngine(async (_a, host, opts) => {
      opts.onProgress?.({ phase: 'reading' });
      opts.onProgress?.({ phase: 'checking', stage: 'done', fraction: 1 });
      opts.onProgress?.({ phase: 'learning', attempt: 'learn' });
      const r = await host.callLearn(PAYLOAD);
      opts.onProgress?.({ phase: 'verifying' });
      return result({ path: 'llm', rules: r.rules });
    });
    const api = fakeApi();
    const token = vi.fn(async () => 'turnstile-token');
    const { flow, statuses, start } = makeFlow(engine, api, { getTurnstileToken: token });
    await start();
    expect(statuses).toEqual(['reading', 'checking', 'learning', 'verifying', 'done']);
    expect(api.learn).toHaveBeenCalledTimes(1);
    expect(api.learn.mock.calls[0]![0]).toBe(PAYLOAD);
    expect(api.learn.mock.calls[0]![1]).toMatchObject({ turnstileToken: 'turnstile-token' });
    const s = state(flow);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ kind: 'learn', payload: PAYLOAD });
    expect(s.sent[0]!.bytes).toBe(new TextEncoder().encode(JSON.stringify(PAYLOAD)).length);
  });

  it('repair: uses the learnId the server returned, with the previous rules and problems', async () => {
    const problems = [{ kind: 'layout' as const, message: 'x' }];
    const { engine } = fakeEngine(async (_a, host) => {
      await host.callLearn(PAYLOAD);
      const r = await host.callRepair(PAYLOAD, PREV_RULES, problems);
      return result({ path: 'llm', rules: r.rules });
    });
    const api = fakeApi();
    const { flow, start } = makeFlow(engine, api);
    await start();
    expect(api.repair).toHaveBeenCalledWith('L1', PAYLOAD, PREV_RULES, problems, expect.anything());
    expect(state(flow).sent.map((r) => r.kind)).toEqual(['learn', 'repair']);
  });

  it('repair of a cached result (no learnId): learns afresh, uncached', async () => {
    const { engine } = fakeEngine(async (_a, host) => {
      await host.callLearn(PAYLOAD);
      await host.callRepair(PAYLOAD, PREV_RULES, []);
      return result({ path: 'llm' });
    });
    const api = fakeApi({ learn: vi.fn(async () => ({ rules: RULES, verified: true, problems: [], cached: true })) as unknown as Api['learn'] });
    const { flow, start } = makeFlow(engine, api);
    await start();
    expect(api.repair).not.toHaveBeenCalled();
    expect(api.learn).toHaveBeenCalledTimes(2);
    expect((api.learn as ReturnType<typeof vi.fn>).mock.calls[1]![1]).toMatchObject({ noCache: true });
    expect(state(flow).sent[1]).toMatchObject({ kind: 'repair', fresh: true });
  });

  describe('warnings (SPEC 6.4)', () => {
    it('unknown output columns: waits for the user before anything is sent', async () => {
      const { engine } = fakeEngine(async (_a, host) => {
        const r = await host.callLearn(PAYLOAD_SKIP);
        return result({ path: 'llm', rules: r.rules });
      });
      const api = fakeApi();
      const { flow, start } = makeFlow(engine, api);
      const done = start();
      await vi.waitFor(() => expect(state(flow).status).toBe('warn'));
      const s = state(flow);
      expect(s.status === 'warn' && s.reason).toBe('confirmSkipColumns');
      expect(s.status === 'warn' && s.columns).toEqual(['Assigned Warehouse']);
      expect(s.status === 'warn' && s.issues[0]).toMatchObject({ code: 'unknownOutputColumns', severity: 'warn', params: { count: 1 } });
      expect(api.learn).not.toHaveBeenCalled();
      expect(s.sent).toEqual([]);

      flow.confirm();
      await done;
      expect(api.learn).toHaveBeenCalledTimes(1);
      expect(state(flow).status).toBe('done');
    });

    it('cancelling at the warning sends nothing and returns to idle', async () => {
      const { engine } = fakeEngine(async (_a, host) => {
        await host.callLearn(PAYLOAD_SKIP);
        return result({ path: 'llm' });
      });
      const api = fakeApi();
      const { flow, start } = makeFlow(engine, api);
      const done = start();
      await vi.waitFor(() => expect(state(flow).status).toBe('warn'));
      flow.cancel();
      await done;
      expect(state(flow).status).toBe('idle');
      expect(api.learn).not.toHaveBeenCalled();
    });

    it('rows not aligned: a warn with "Try anyway", which re-runs with tryAnyway', async () => {
      const notAligned = { status: 'warn', issues: [{ code: 'rowsNotAligned', severity: 'warn', params: { count: 3 } }], skipColumns: [] };
      const { engine, learn } = fakeEngine(async (args) =>
        args.tryAnyway ? result({ path: 'local' }) : result({ path: 'blocked', preflight: notAligned, rules: null, verification: null }),
      );
      const { flow, start } = makeFlow(engine, fakeApi());
      await start();
      const s = state(flow);
      expect(s.status).toBe('warn');
      expect(s.status === 'warn' && s.reason).toBe('tryAnyway');
      expect(learn.mock.calls[0]![0].tryAnyway).toBeUndefined();

      flow.confirm();
      await vi.waitFor(() => expect(state(flow).status).toBe('done'));
      expect(learn).toHaveBeenCalledTimes(2);
      expect(learn.mock.calls[1]![0].tryAnyway).toBe(true);
    });
  });

  it('a pre-flight block ends in `blocked`, with the issues, and no API call', async () => {
    const block = { status: 'block', issues: [{ code: 'pivotDetected', severity: 'block' }], skipColumns: [] };
    const { engine } = fakeEngine(async () => result({ path: 'blocked', preflight: block, rules: null, verification: null }));
    const api = fakeApi();
    const { flow, start } = makeFlow(engine, api);
    await start();
    const s = state(flow);
    expect(s.status).toBe('blocked');
    expect(s.status === 'blocked' && s.result.preflight.issues[0]!.code).toBe('pivotDetected');
    expect(api.learn).not.toHaveBeenCalled();
  });

  describe('errors', () => {
    it('an API limit becomes {kind: api, code, limit}, even though it crossed the worker as a plain object', async () => {
      const { engine } = fakeEngine(async (_a, host) => {
        try {
          await host.callLearn(PAYLOAD);
        } catch {
          throw new RpcRemoteError({ name: 'Error', message: 'API error: limitHit', code: 'limitHit' });
        }
        return result({});
      });
      const api = fakeApi({ learn: vi.fn(async () => Promise.reject(new ApiError('limitHit', 429, { limit: 'learnsPerDay' }))) as unknown as Api['learn'] });
      const { flow, start } = makeFlow(engine, api);
      await start();
      const s = state(flow);
      expect(s.status === 'error' && s.error).toEqual({ kind: 'api', code: 'limitHit', limit: 'learnsPerDay', retryAfterSec: undefined });
    });

    it('a worker timeout is `timeout`', async () => {
      const { engine } = fakeEngine(async () => {
        throw new RpcTimeoutError('learn', 1000);
      });
      const { flow, start } = makeFlow(engine, fakeApi());
      await start();
      const s = state(flow);
      expect(s.status === 'error' && s.error.kind).toBe('timeout');
    });

    it('an unsupported file type from the worker is `unsupportedFileType`', async () => {
      const { engine } = fakeEngine(async () => {
        throw new RpcRemoteError({ name: 'UnsupportedFileTypeError', message: 'x', code: 'unsupportedFileType' });
      });
      const { flow, start } = makeFlow(engine, fakeApi());
      await start();
      const s = state(flow);
      expect(s.status === 'error' && s.error.kind).toBe('unsupportedFileType');
    });

    it('a file over the size limit fails before the worker is used', async () => {
      const { engine, learn } = fakeEngine(async () => result({}));
      const { flow } = makeFlow(engine, fakeApi(), { maxFileBytes: 5 });
      await flow.start({ input: file('big.xlsx', 10), output: file('out.csv', 1), masking: true });
      const s = state(flow);
      expect(s.status === 'error' && s.error).toMatchObject({ kind: 'fileTooLarge', fileName: 'big.xlsx', bytes: 10, maxBytes: 5 });
      expect(learn).not.toHaveBeenCalled();
    });

    it('the server returning no rules is `learnFailed`, with its problems', async () => {
      const problems = [{ kind: 'schema' as const, path: 'x', message: 'bad' }];
      const { engine } = fakeEngine(async (_a, host) => {
        await host.callLearn(PAYLOAD);
        return result({ path: 'llm', rules: null, verification: null });
      });
      const api = fakeApi({ learn: vi.fn(async () => ({ rules: null, verified: false, problems, learnId: 'L', cached: false })) as unknown as Api['learn'] });
      const { flow, start } = makeFlow(engine, api);
      await start();
      const s = state(flow);
      expect(s.status === 'error' && s.error).toEqual({ kind: 'learnFailed', problems });
    });

    it('beforeSend can stop a send: the payload is recorded, nothing goes out, and the flow errors', async () => {
      const { engine } = fakeEngine(async (_a, host) => {
        try {
          await host.callLearn(PAYLOAD);
        } catch (e) {
          throw new RpcRemoteError({ name: 'Error', message: (e as Error).message });
        }
        return result({});
      });
      const api = fakeApi();
      const { flow, start } = makeFlow(engine, api, {
        beforeSend: () => {
          throw new Error('not now');
        },
      });
      await start();
      const s = state(flow);
      expect(s.status === 'error' && s.error).toEqual({ kind: 'unexpected', message: 'not now' });
      expect(s.sent).toHaveLength(1);
      expect(api.learn).not.toHaveBeenCalled();
    });

    it('translates every error kind into text in both languages', () => {
      const i18n = (lang: 'en' | 'he'): I18n =>
        ({ lang, dir: lang === 'he' ? 'rtl' : 'ltr', t: (k, p) => translate(lang, k, p), code: (m) => codeText(lang, m) }) as I18n;
      const errors: FlowError[] = [
        { kind: 'fileTooLarge', fileName: 'x', bytes: 12 * 1024 * 1024, maxBytes: 10 * 1024 * 1024 },
        { kind: 'unsupportedFileType' },
        { kind: 'timeout' },
        { kind: 'workerCrashed' },
        { kind: 'learnFailed', problems: [] },
        { kind: 'unexpected', message: 'x' },
        { kind: 'api', code: 'network' },
        { kind: 'api', code: 'server' },
        { kind: 'api', code: 'payloadTooLarge' },
        { kind: 'api', code: 'unknown' },
        { kind: 'api', code: 'limitHit', limit: 'learnsPerDay' },
        { kind: 'api', code: 'anonBudgetExhausted' },
        { kind: 'api', code: 'budgetExhausted' },
        { kind: 'api', code: 'rateLimited' },
        { kind: 'api', code: 'turnstileFailed' },
        { kind: 'api', code: 'invalidLearnId' },
      ];
      for (const lang of ['en', 'he'] as const) {
        for (const e of errors) {
          const text = flowErrorText(i18n(lang), e);
          expect(text.trim(), `${lang} ${e.kind}`).not.toBe('');
          expect(text).not.toMatch(/\{\w+\}/); // no unfilled placeholder
        }
      }
      expect(flowErrorText(i18n('en'), errors[0]!)).toContain('12.0 MB');
    });
  });

  describe('cancel and restart', () => {
    /** An engine that runs until aborted, like a worker that is busy. */
    function hangingEngine() {
      return fakeEngine(
        (_a, _h, opts) =>
          new Promise<LearnOutput>((_resolve, reject) => {
            opts.onProgress?.({ phase: 'reading' });
            if (opts.signal?.aborted) reject(new RpcAbortedError('learn'));
            opts.signal?.addEventListener('abort', () => reject(new RpcAbortedError('learn')));
          }),
      );
    }

    it('cancel() aborts the worker call and goes back to idle, without an error', async () => {
      const { engine } = hangingEngine();
      const { flow, start } = makeFlow(engine, fakeApi());
      const done = start();
      await vi.waitFor(() => expect(state(flow).status).toBe('reading'));
      flow.cancel();
      await done;
      expect(state(flow).status).toBe('idle');
    });

    it('starting again supersedes the run in progress', async () => {
      let calls = 0;
      const { engine } = fakeEngine((_a, _h, opts) => {
        calls++;
        if (calls > 1) return Promise.resolve(result({ path: 'local' }));
        return new Promise<LearnOutput>((_res, reject) => opts.signal?.addEventListener('abort', () => reject(new RpcAbortedError('learn'))));
      });
      const { flow, start } = makeFlow(engine, fakeApi());
      const first = start();
      await vi.waitFor(() => expect(calls).toBe(1));
      const second = start();
      await Promise.all([first, second]);
      expect(state(flow).status).toBe('done');
    });
  });
});
