// The two hooks, in React: `useEditor` (store, undo, redo) and `useLiveCheck` (debounced checks, Save status).
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveCheckResult, StaticProblem } from '../worker/editorApi';
import type { CheckEngine } from './liveCheckScheduler';
import { ordersRules } from './testkit';
import { useEditor } from './useEditor';
import { useLiveCheck } from './useLiveCheck';

afterEach(cleanup);

const result = (over: Partial<LiveCheckResult> = {}): LiveCheckResult => ({
  verified: true,
  matched: 5,
  total: 5,
  differences: 0,
  perColumn: [],
  mismatches: [],
  mismatchCount: 0,
  preview: [],
  layoutProblems: [],
  layoutIssues: [],
  partial: false,
  checkedInputRows: 5,
  totalInputRows: 5,
  ms: 1,
  ...over,
});

describe('useEditor', () => {
  it('applies edits, answers with the result, undoes and redoes', () => {
    const { result: r } = renderHook(() => useEditor(ordersRules()));
    expect(r.current.state.dirty).toBe(false);
    expect(r.current.canUndo).toBe(false);

    let res: ReturnType<typeof r.current.apply> | undefined;
    act(() => {
      res = r.current.apply({ type: 'setTitleText', index: 0, text: 'Other' });
    });
    expect(res).toEqual({ ok: true, changed: true });
    expect(r.current.state.dirty).toBe(true);
    expect(r.current.state.edited.has('title:0')).toBe(true);
    expect(r.current.canUndo).toBe(true);

    act(() => {
      res = r.current.apply({ type: 'setColumnHeader', index: 0, header: '' });
    });
    expect(res).toMatchObject({ ok: false, problems: [{ code: 'emptyHeader' }] });
    expect(r.current.state.dirty).toBe(true); // unchanged by the refusal

    act(() => r.current.undo());
    expect(r.current.state.dirty).toBe(false);
    expect(r.current.canRedo).toBe(true);
    act(() => r.current.redo());
    expect(r.current.state.dirty).toBe(true);
  });

  it('typing in one field is one undo step', () => {
    const { result: r } = renderHook(() => useEditor(ordersRules()));
    act(() => {
      for (const text of ['O', 'Or', 'Ord', 'Orde']) r.current.apply({ type: 'setTitleText', index: 0, text }, { coalesce: 'title:0' });
    });
    expect((r.current.state.rules.output.titleRows[0] as { text: string }).text).toBe('Orde');
    expect(r.current.state.history.past).toHaveLength(1);
    act(() => void r.current.apply({ type: 'setTitleText', index: 0, text: 'Other' })); // no key: its own step
    expect(r.current.state.history.past).toHaveLength(2);
    act(() => void r.current.apply({ type: 'setTitleText', index: 0, text: 'Other 2' }, { coalesce: 'x' }));
    act(() => void r.current.apply({ type: 'setTitleText', index: 0, text: 'Other 3' }, { coalesce: 'y' })); // another key
    expect(r.current.state.history.past).toHaveLength(4);
    act(() => r.current.undo());
    act(() => r.current.undo());
    expect((r.current.state.rules.output.titleRows[0] as { text: string }).text).toBe('Other');
  });

  it('markSaved and reset', () => {
    const { result: r } = renderHook(() => useEditor(ordersRules(), { format: { sourceCount: 2 } }));
    act(() => void r.current.apply({ type: 'setColumnHeader', index: 0, header: 'SKU' }));
    expect(r.current.state).toMatchObject({ dirty: true, formatChange: true });
    act(() => r.current.markSaved());
    expect(r.current.state).toMatchObject({ dirty: false, formatChange: false });
    act(() => r.current.reset(ordersRules()));
    expect(r.current.state.rules.output.columns[0]!.header).toBe('Item');
    expect(r.current.canUndo).toBe(false);
  });
});

describe('useLiveCheck', () => {
  function setup(opts: { partial?: boolean; problems?: StaticProblem[]; exampleId?: string | undefined } = {}) {
    const liveCheck = vi.fn(async () => result(opts.partial ? { partial: true, verified: false } : {}));
    const fullCheck = vi.fn(async () => result({ matched: 9000, total: 9000, totalInputRows: 9000 }));
    const staticChecks = vi.fn(async () => opts.problems ?? []);
    const engine = { liveCheck, fullCheck, staticChecks } as unknown as CheckEngine;
    const exampleId = 'exampleId' in opts ? opts.exampleId : 'ex1';
    const hook = renderHook(() => {
      const editor = useEditor(ordersRules());
      const check = useLiveCheck({ engine, exampleId, editor: editor.state, tier: 'paid', debounceMs: 10 });
      return { editor, check };
    });
    return { hook, liveCheck, fullCheck, staticChecks };
  }

  it('checks when the editor opens, and once more (debounced) after a burst of edits', async () => {
    const { hook, liveCheck, staticChecks } = setup();
    await waitFor(() => expect(hook.result.current.check.saveStatus).toEqual({ kind: 'verified' }));
    expect(liveCheck).toHaveBeenCalledTimes(1);
    expect(hook.result.current.check.stale).toBe(false);

    act(() => {
      for (const text of ['A', 'B', 'C']) hook.result.current.editor.apply({ type: 'setTitleText', index: 0, text });
    });
    expect(hook.result.current.check.stale).toBe(true); // the shown result is for the rules before the edits
    await waitFor(() => expect(hook.result.current.check.stale).toBe(false));
    expect(liveCheck).toHaveBeenCalledTimes(2);
    expect(staticChecks).toHaveBeenCalledTimes(2);
    expect(hook.result.current.check.state.live).toMatchObject({ matched: 5, total: 5 });
  });

  it('the Save status: differences when rows differ, blocked (in plain words) when a static check fails', async () => {
    const differing = setup();
    differing.liveCheck.mockResolvedValue(result({ verified: false, matched: 3, total: 5, differences: 2 }));
    act(() => void differing.hook.result.current.editor.apply({ type: 'setTitleText', index: 0, text: 'x' }));
    await waitFor(() => expect(differing.hook.result.current.check.saveStatus).toEqual({ kind: 'differences', differences: 2 }));
    differing.hook.unmount();

    const problem: StaticProblem = { layer: 'references', kind: 'reference', path: 'transform.sort[0].column', message: 'unknown column id "ghost"' };
    const blocked = setup({ problems: [problem] });
    await waitFor(() => expect(blocked.hook.result.current.check.saveStatus.kind).toBe('blocked'));
    const status = blocked.hook.result.current.check.saveStatus;
    if (status.kind !== 'blocked') return;
    expect(status.problems).toEqual([expect.objectContaining({ lineId: 'sort', where: 'Sort', text: 'Sort uses a column ("ghost") that does not exist.' })]);
    expect(blocked.hook.result.current.check.problems).toHaveLength(1);
  });

  it('Apply runs the full check when the live one only saw a subset', async () => {
    const { hook, fullCheck } = setup({ partial: true });
    await waitFor(() => expect(hook.result.current.check.state.live?.partial).toBe(true));
    expect(hook.result.current.check.saveStatus).toEqual({ kind: 'checking' });
    let applied: LiveCheckResult | null = null;
    await act(async () => {
      applied = await hook.result.current.check.apply();
    });
    expect(fullCheck).toHaveBeenCalledTimes(1);
    expect(applied).toMatchObject({ matched: 9000 });
    await waitFor(() => expect(hook.result.current.check.saveStatus).toEqual({ kind: 'verified' }));
  });

  it('with no example: static checks only, and the status says so', async () => {
    const { hook, liveCheck } = setup({ exampleId: undefined });
    await waitFor(() => expect(hook.result.current.check.saveStatus).toEqual({ kind: 'noExample' }));
    expect(liveCheck).not.toHaveBeenCalled();
    expect(hook.result.current.check.stale).toBe(false); // the static result is current
    act(() => void hook.result.current.editor.apply({ type: 'setTitleText', index: 0, text: 'x' }));
    expect(hook.result.current.check.stale).toBe(true);
    await waitFor(() => expect(hook.result.current.check.stale).toBe(false));
  });

  it('a check that fails to run is said so, and Apply tries again', async () => {
    const { hook, liveCheck, fullCheck } = setup({ partial: true });
    await waitFor(() => expect(hook.result.current.check.saveStatus).toEqual({ kind: 'checking' }));
    liveCheck.mockRejectedValueOnce(Object.assign(new Error('Worker call "liveCheck" timed out'), { code: 'workerTimeout' }));
    act(() => void hook.result.current.editor.apply({ type: 'setTitleText', index: 0, text: 'x' }));
    await waitFor(() => expect(hook.result.current.check.saveStatus).toEqual({ kind: 'checkFailed', message: 'Worker call "liveCheck" timed out' }));
    await act(async () => {
      await hook.result.current.check.apply();
    });
    expect(fullCheck).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(hook.result.current.check.saveStatus).toEqual({ kind: 'verified' }));
  });

  it('does not leave a timer or a check behind on unmount', async () => {
    const { hook, liveCheck } = setup();
    await waitFor(() => expect(liveCheck).toHaveBeenCalledTimes(1));
    act(() => void hook.result.current.editor.apply({ type: 'setTitleText', index: 0, text: 'x' }));
    hook.unmount();
    await new Promise((r) => setTimeout(r, 60));
    expect(liveCheck).toHaveBeenCalledTimes(1);
  });
});
