// The live check scheduler (SPEC 8.11): debounce, one request at a time, stale results dropped, Apply, and errors,
// against a fake worker whose every answer the test settles by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveCheckResult, StaticProblem } from '../worker/editorApi';
import { LiveCheckScheduler, type CheckEngine, type CheckInput } from './liveCheckScheduler';
import { createEditorState } from './model';
import { ordersRules } from './testkit';
import type { EditableRules } from './types';

interface Call {
  method: 'liveCheck' | 'fullCheck' | 'staticChecks';
  rules: EditableRules;
  options?: unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

function fakeWorker() {
  const calls: Call[] = [];
  const request = (method: Call['method']) => (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      // liveCheck/fullCheck(exampleId, rules, options), staticChecks(rules, options)
      const rules = (method === 'staticChecks' ? args[0] : args[1]) as EditableRules;
      const options = method === 'staticChecks' ? args[1] : args[2];
      calls.push({ method, rules, options, resolve, reject });
    });
  const engine = { liveCheck: request('liveCheck'), fullCheck: request('fullCheck'), staticChecks: request('staticChecks') } as unknown as CheckEngine;
  return {
    engine,
    calls,
    of: (method: Call['method']) => calls.filter((c) => c.method === method),
    /** Answer every open request of this method (the oldest first), each with what `answer` makes of it. */
    answer(method: Call['method'], answer: (c: Call) => unknown) {
      for (const c of calls.filter((x) => x.method === method && !('done' in x))) {
        (c as Call & { done?: boolean }).done = true;
        c.resolve(answer(c));
      }
    },
  };
}

const result = (over: Partial<LiveCheckResult> = {}): LiveCheckResult => ({
  verified: true,
  matched: 10,
  total: 10,
  differences: 0,
  perColumn: [],
  mismatches: [],
  mismatchCount: 0,
  preview: [],
  layoutProblems: [],
  layoutIssues: [],
  partial: false,
  checkedInputRows: 10,
  totalInputRows: 10,
  ms: 3,
  ...over,
});

/** A new revision of the rules: the title changes, so every call carries its own rules object. */
function revision(n: number): CheckInput {
  const rules = ordersRules();
  const r: EditableRules = { ...rules, output: { ...rules.output, titleRows: [{ text: `title ${n}` }] } };
  return { rules: r, exceptions: [], rev: n };
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function make(over: Partial<ConstructorParameters<typeof LiveCheckScheduler>[0]> = {}) {
  const w = fakeWorker();
  const s = new LiveCheckScheduler({ engine: w.engine, exampleId: 'ex1', tier: 'paid', ...over });
  return { w, s };
}

describe('debounce', () => {
  it('runs once, on the newest rules, after the edits pause for 150 ms', async () => {
    const { w, s } = make();
    s.update(revision(1));
    await vi.advanceTimersByTimeAsync(100);
    s.update(revision(2));
    await vi.advanceTimersByTimeAsync(100);
    s.update(revision(3));
    await vi.advanceTimersByTimeAsync(149);
    expect(w.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.of('liveCheck')).toHaveLength(1);
    expect(w.of('staticChecks')).toHaveLength(1);
    expect((w.of('liveCheck')[0]!.rules as { output: { titleRows: unknown[] } }).output.titleRows).toEqual([{ text: 'title 3' }]);
  });

  it('the first check can run at once', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    expect(w.of('liveCheck')).toHaveLength(1);
  });

  it('asks for the exceptions with every check, and for the tier and format with the static one', async () => {
    const { w, s } = make({ tier: 'registered' });
    s.update({ ...revision(1), exceptions: [4, 9] }, { immediate: true });
    await flush();
    expect(w.of('liveCheck')[0]!.options).toEqual({ exceptions: [4, 9] });
    expect(w.of('staticChecks')[0]!.options).toEqual({ tier: 'registered' });
  });

  it('marks a result stale the moment a newer edit is made', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    w.answer('liveCheck', () => result());
    w.answer('staticChecks', () => []);
    await flush();
    expect(s.getState()).toMatchObject({ status: 'ready', liveRev: 1, latestRev: 1 });
    s.update(revision(2));
    expect(s.getState()).toMatchObject({ liveRev: 1, latestRev: 2 }); // the result shown is for rules one edit old
  });
});

describe('cancelling stale requests', () => {
  it('drops the result of a check that a newer edit made out of date, then checks the newer rules', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    expect(w.of('liveCheck')).toHaveLength(1);

    s.update(revision(2)); // arrives while check 1 runs
    w.answer('liveCheck', () => result({ matched: 1 }));
    w.answer('staticChecks', () => [{ layer: 'types', kind: 'type', message: 'old' } satisfies StaticProblem]);
    await flush();
    expect(s.getState().live).toBeNull(); // never shown
    expect(s.getState().staticProblems).toBeNull();
    expect(w.of('liveCheck')).toHaveLength(1); // and not re-run until the debounce ends

    await vi.advanceTimersByTimeAsync(150);
    expect(w.of('liveCheck')).toHaveLength(2);
    w.answer('liveCheck', () => result({ matched: 2 }));
    w.answer('staticChecks', () => []);
    await flush();
    expect(s.getState()).toMatchObject({ status: 'ready', liveRev: 2, staticRev: 2, staticProblems: [] });
    expect(s.getState().live!.matched).toBe(2);
  });

  it('one request at a time, and only the newest edit is ever queued', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    s.update(revision(2));
    await vi.advanceTimersByTimeAsync(150); // debounce ends while check 1 still runs: nothing new starts
    s.update(revision(3));
    await vi.advanceTimersByTimeAsync(150);
    expect(w.of('liveCheck')).toHaveLength(1);

    w.answer('liveCheck', () => result());
    w.answer('staticChecks', () => []);
    await flush();
    // check 1 was stale: revision 2 was skipped, revision 3 runs
    expect(w.of('liveCheck')).toHaveLength(2);
    expect((w.of('liveCheck')[1]!.rules as { output: { titleRows: unknown[] } }).output.titleRows).toEqual([{ text: 'title 3' }]);
  });

  it('does not restart the check while the debounce for a newer edit is still running', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    s.update(revision(2));
    w.answer('liveCheck', () => result());
    w.answer('staticChecks', () => []);
    await flush();
    expect(w.of('liveCheck')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(w.of('liveCheck')).toHaveLength(2);
  });
});

describe('Apply (all rows)', () => {
  it('runs the full check on the latest rules and hands back its result', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    w.answer('liveCheck', () => result({ partial: true, verified: false, matched: 2000, total: 2000, totalInputRows: 7000 }));
    w.answer('staticChecks', () => []);
    await flush();
    expect(s.getState().full).toBeNull(); // a partial result is not an all-rows result

    const applied = s.apply();
    expect(s.getState().applying).toBe(true);
    await flush();
    expect(w.of('fullCheck')).toHaveLength(1);
    w.answer('fullCheck', () => result({ matched: 7000, total: 7000, totalInputRows: 7000 }));
    w.answer('staticChecks', () => []);
    await flush();
    await expect(applied).resolves.toMatchObject({ matched: 7000, partial: false });
    expect(s.getState()).toMatchObject({ applying: false, fullRev: 1 });
    expect(s.getState().full!.total).toBe(7000);
  });

  it('answers at once when the last check already covered every row', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    w.answer('liveCheck', () => result());
    w.answer('staticChecks', () => []);
    await flush();
    await expect(s.apply()).resolves.toMatchObject({ matched: 10 });
    expect(w.of('fullCheck')).toHaveLength(0);
  });

  it('an Apply that comes in while a check runs is answered after it, on the newest rules', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    const applied = s.apply(); // check 1 (a live one) is in flight
    w.answer('liveCheck', () => result({ partial: true, verified: false }));
    w.answer('staticChecks', () => []);
    await flush();
    expect(w.of('fullCheck')).toHaveLength(1); // the partial result did not answer it
    w.answer('fullCheck', () => result({ matched: 99, total: 99 }));
    w.answer('staticChecks', () => []);
    await flush();
    await expect(applied).resolves.toMatchObject({ matched: 99 });
  });

  it('an edit during an Apply sends it round again for the newer rules', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    w.answer('liveCheck', () => result({ partial: true, verified: false }));
    w.answer('staticChecks', () => []);
    await flush();
    const applied = s.apply();
    await flush();
    s.update(revision(2));
    w.answer('fullCheck', () => result({ matched: 1, total: 1 }));
    w.answer('staticChecks', () => []);
    await flush();
    expect(w.of('fullCheck')).toHaveLength(1); // the result was for older rules: not shown, and not resolved either
    await vi.advanceTimersByTimeAsync(150); // once the edits pause, the Apply goes round again
    expect(w.of('fullCheck')).toHaveLength(2);
    w.answer('fullCheck', () => result({ matched: 2, total: 2 }));
    w.answer('staticChecks', () => []);
    await flush();
    await expect(applied).resolves.toMatchObject({ matched: 2 });
  });

  it('resolves null when there is no example', async () => {
    const { s } = make({ exampleId: undefined });
    s.update(revision(1), { immediate: true });
    await expect(s.apply()).resolves.toBeNull();
  });
});

describe('problems and errors', () => {
  it('static problems are published with the revision they are for, even with no example', async () => {
    const { w, s } = make({ exampleId: undefined });
    s.update(revision(1), { immediate: true });
    await flush();
    expect(w.of('liveCheck')).toHaveLength(0);
    const problem: StaticProblem = { layer: 'types', kind: 'type', message: 'expected decimal, got text; use toNumber', path: 'transform.computed[0].expr' };
    w.answer('staticChecks', () => [problem]);
    await flush();
    expect(s.getState()).toMatchObject({ status: 'noExample', staticProblems: [problem], staticRev: 1 });
  });

  it('a worker that no longer holds the example: no example from then on, static checks go on', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    w.of('liveCheck')[0]!.reject(Object.assign(new Error('gone'), { code: 'exampleGone' }));
    w.answer('staticChecks', () => []);
    await flush();
    expect(s.getState()).toMatchObject({ status: 'noExample', error: { code: 'exampleGone' }, staticProblems: [] });

    s.update(revision(2));
    await vi.advanceTimersByTimeAsync(150);
    expect(w.of('liveCheck')).toHaveLength(1); // not asked again
    expect(w.of('staticChecks')).toHaveLength(2);
    await expect(s.apply()).resolves.toBeNull();
  });

  it('another error is an error state, and the static result still comes through', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    w.of('liveCheck')[0]!.reject(Object.assign(new Error('Worker call "liveCheck" timed out'), { code: 'workerTimeout' }));
    w.answer('staticChecks', () => []);
    await flush();
    expect(s.getState()).toMatchObject({ status: 'error', error: { code: 'workerTimeout' }, staticProblems: [] });
    // and the next edit tries again
    s.update(revision(2));
    await vi.advanceTimersByTimeAsync(150);
    expect(w.of('liveCheck')).toHaveLength(2);
  });

  it('an Apply that fails rejects', async () => {
    const { w, s } = make();
    s.update(revision(1), { immediate: true });
    await flush();
    w.answer('liveCheck', () => result({ partial: true, verified: false }));
    w.answer('staticChecks', () => []);
    await flush();
    const applied = s.apply();
    const caught = applied.catch((e: unknown) => e);
    await flush();
    w.of('fullCheck')[0]!.reject(new Error('boom'));
    w.answer('staticChecks', () => []);
    await flush();
    expect(await caught).toMatchObject({ message: 'boom' });
  });
});

describe('dispose', () => {
  it('clears the timer, drops what is in flight, answers a waiting Apply with null; start allows it again', async () => {
    const { w, s } = make();
    s.update(revision(1)); // debounce pending
    s.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(w.calls).toHaveLength(0);

    s.start();
    s.update(revision(2), { immediate: true });
    await flush();
    const applied = s.apply();
    s.dispose();
    w.answer('liveCheck', () => result());
    w.answer('staticChecks', () => []);
    await flush();
    await expect(applied).resolves.toBeNull();
    expect(s.getState().live).toBeNull();
  });
});

describe('with the editor state', () => {
  it('a revision of the editor is a revision of the check', async () => {
    const { w, s } = make();
    let state = createEditorState(ordersRules());
    s.update({ rules: state.rules, exceptions: state.exceptions, rev: state.rev }, { immediate: true });
    await flush();
    w.answer('liveCheck', () => result());
    w.answer('staticChecks', () => []);
    await flush();
    expect(s.getState().liveRev).toBe(state.rev);
    state = { ...state, rev: state.rev + 1 };
    s.update({ rules: state.rules, exceptions: state.exceptions, rev: state.rev });
    expect(s.getState().latestRev).toBe(state.rev);
  });
});
