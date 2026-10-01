// "Finish with the AI step" as completion mode (LEARN_PROMPT "Completing a partial rules file"): the AI step produces ONLY what is missing,
// the rules on screen (code-solved columns and the user's edits) are the fixed part, and an answer replaces them only when it passed the
// fixed lock and the verification. "Re-run all with AI" is the whole learn again, behind "This replaces your current rules". And the
// regression tests of the owner's bug: a signed-in user's partial result shows "Finish with the AI step" however they got there.
import type { LearnResult, Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { createMemoryPendingStore, setPendingStore, storeFile, type PendingLearn, type PendingLearnStore } from '../src/app/pendingLearn';
import { learnFromExamples } from '@formatai/engine';
import { ordersRules } from '../src/editor/testkit';
import type { LearnOutput } from '../src/worker/engineApi';
import { csv, fakeApi, fakeEngine, learnResult, renderApp, USER } from './helpers/renderApp';

const { redirectTo } = vi.hoisted(() => ({ redirectTo: vi.fn() }));
vi.mock('../src/app/redirect', () => ({ redirectTo }));

let store: PendingLearnStore;
beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  store = createMemoryPendingStore();
  setPendingStore(store);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  setPendingStore(undefined);
});

/** The orders report as the local analysis leaves it: Total and Shipped have no rule (they need the AI step), Remarks is external data. */
function partialRules(): Rules {
  const rules = ordersRules();
  rules.output.columns = rules.output.columns.map((c) => (c.header === 'Total' || c.header === 'Shipped' ? { header: c.header, from: null } : c));
  rules.output.summaryRows = [];
  rules.transform.computed = [];
  rules.validations = [];
  rules.assumptions = [];
  return rules;
}

const PARTIAL = {
  reason: 'aiNotAllowed' as const,
  solved: ['Item', 'Supplier', 'Qty'],
  needsAi: ['Total', 'Shipped'],
  external: ['Remarks'],
  solvedColumns: [0, 1, 2],
  needsAiParts: ['sort' as const, 'summaryRows' as const],
};

const partialOutput = (over: Record<string, unknown> = {}): LearnOutput =>
  learnResult({ path: 'partial', rules: partialRules(), partial: PARTIAL, readiness: { ready: true }, verification: { verified: false, matched: 30, total: 30, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] }, ...over });

interface CompletionArgs {
  ai: string;
  tier: string;
  keepExampleId?: string;
  complete?: { fixedRules: LearnResult; columns: number[]; parts: string[] };
}

/** What the AI step would answer: the fixed rules, with Total, Shipped and the summary row produced. */
function completionOutput(args: CompletionArgs, over: Record<string, unknown> = {}, completion: Record<string, unknown> = {}): LearnOutput {
  const fixed = args.complete!.fixedRules;
  const full = ordersRules();
  const rules: LearnResult = {
    ...fixed,
    transform: { ...fixed.transform, computed: full.transform.computed },
    output: {
      ...fixed.output,
      columns: fixed.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: 'total', format: '#,##0.00' } : c.header === 'Shipped' ? { ...c, from: 'shipped', format: 'DD/MM/YYYY' } : c)),
      summaryRows: full.output.summaryRows,
    },
  };
  return learnResult({
    path: 'llm',
    rules,
    completion: { columns: args.complete!.columns, parts: args.complete!.parts, fixedProblems: [], matches: true, produced: { columns: 2, parts: 1 }, ...completion },
    verification: { verified: true, matched: 30, total: 30, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    ...over,
  });
}

/** An engine whose first learn (the local result) is partial and whose next ones are whatever `next` makes of their arguments. */
function engineWith(next: (args: CompletionArgs, host: unknown) => Promise<LearnOutput>, first: () => LearnOutput = () => partialOutput()) {
  const fake = fakeEngine();
  fake.learn.mockImplementation(async (args: unknown, host: unknown) => ((args as CompletionArgs).complete || fake.learn.mock.calls.length > 1 ? next(args as CompletionArgs, host) : first()));
  return fake;
}

async function start(engine: ReturnType<typeof fakeEngine>['engine'], api = fakeApi({ user: USER })) {
  renderApp({ engine, api });
  fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
  });
  await screen.findByTestId('rules-map');
  return api;
}

const line = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-line-id="${id}"]`);
  if (!el) throw new Error(`no line ${id}`);
  return el as HTMLElement;
};

/** The user edits by hand: Supplier becomes Vendor. */
async function renameSupplier() {
  fireEvent.click(document.querySelector('[data-line-id="col:Supplier"] .map-line__main') as HTMLElement);
  fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Vendor' } });
  await waitFor(() => expect(document.querySelector('[data-line-id="col:Vendor"]')).toBeTruthy());
}

const finishButton = () => screen.getByRole('button', { name: 'Finish with the AI step' });

describe('"Finish with the AI step" completes only what is missing', () => {
  it('sends the rules on screen (with the user\'s edits) as the fixed part, and only the missing columns and parts', async () => {
    const seen: CompletionArgs[] = [];
    const { engine, learn } = engineWith(async (args) => {
      seen.push(args);
      return completionOutput(args);
    });
    await start(engine);
    await renameSupplier();
    fireEvent.click(finishButton());
    await waitFor(() => expect(seen).toHaveLength(1));

    expect(learn).toHaveBeenCalledTimes(2);
    const args = seen[0]!;
    expect(args).toMatchObject({ ai: 'allowed', tier: 'registered', keepExampleId: 'ex1' });
    // Total (3) and Shipped (4) have no rule; Remarks (5) is external data; the sort is there already, the summary row is not.
    expect(args.complete!.columns).toEqual([3, 4]);
    expect(args.complete!.parts).toEqual(['summaryRows']);
    expect(args.complete!.fixedRules.output.columns.map((c) => c.header)).toEqual(['Item', 'Vendor', 'Qty', 'Total', 'Shipped', 'Remarks']);
    expect(args.complete!.fixedRules.output.columns[1]!.from).toBe('supplier');
  });

  it('an answer that passes replaces the rules: the AI columns are filled in, what the user edited is still there and still marked edited', async () => {
    const { engine } = engineWith(async (args) => completionOutput(args));
    await start(engine);
    await renameSupplier();
    expect(line('col:Total').getAttribute('data-ai-step')).toBe('true');

    fireEvent.click(finishButton());
    await screen.findByTestId('completion-done');
    await waitFor(() => expect(line('col:Total').getAttribute('data-ai-step')).toBeNull());
    expect(line('col:Shipped').getAttribute('data-ai-step')).toBeNull();
    expect(line('col:Vendor').getAttribute('data-status')).toBe('edited');
    expect(document.querySelector('[data-line-id="col:Supplier"]')).toBeNull();
    // It is an ordinary result now: there is something to save, and nothing waits for the AI step.
    expect(screen.getByRole('button', { name: 'Save format and download' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finish with the AI step' })).toBeNull();
    expect(screen.queryByTestId('ai-step-parts')).toBeNull();
    expect(screen.getByText('Everything you had was kept as it was.', { exact: false })).toBeTruthy();
  });

  it('while it works the rules stay as they are, and the button says it is busy', async () => {
    let release!: (o: LearnOutput) => void;
    const { engine } = engineWith((args) => new Promise<LearnOutput>((resolve) => (release = () => resolve(completionOutput(args)))));
    await start(engine);
    fireEvent.click(finishButton());
    const running = await screen.findByTestId('completion-running');
    expect(running.textContent).toContain('The AI step is working on what is missing');
    expect(screen.getByText('Working on 2 columns.')).toBeTruthy();
    expect(line('col:Total').getAttribute('data-ai-step')).toBe('true'); // nothing replaced yet
    expect(finishButton().getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: 'Re-run all with AI' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release(undefined as never));
    await screen.findByTestId('completion-done');
  });

  it('"See what we send" shows the completion payload: the rules to keep and what is missing (and only after a call was made)', async () => {
    const api = fakeApi({ user: USER });
    const { engine } = engineWith(async (args, host) => {
      await (host as { callLearn(p: unknown): Promise<unknown> }).callLearn({ masking: false, output: { columns: [] }, samples: [], skipColumns: [], complete: { fixed: { marker: 'rules-to-keep' }, columns: args.complete!.columns, parts: args.complete!.parts } });
      return completionOutput(args);
    });
    await start(engine, api);
    expect(screen.queryByRole('button', { name: 'See what we send' })).toBeNull();
    fireEvent.click(finishButton());
    await screen.findByTestId('completion-done');
    fireEvent.click(screen.getByRole('button', { name: 'See what we send' }));
    const panel = await screen.findByText(/rules-to-keep/);
    expect(panel.textContent).toContain('"complete"');
  });

  it('an answer that changed something the user had is NOT used: the rules and the edits stay, and it says so plainly', async () => {
    const { engine } = engineWith(async (args) =>
      completionOutput(args, {}, { fixedProblems: [{ kind: 'fixedMismatch', path: 'output.columns[0].from', message: 'must stay "sku"' }] }),
    );
    await start(engine);
    await renameSupplier();
    fireEvent.click(finishButton());
    const kept = await screen.findByTestId('completion-kept');
    expect(kept.textContent).toBe('The AI step changed something that you already had, so its answer was not used.');
    expect(screen.getByText('Your rules were kept as they were')).toBeTruthy();
    expect(line('col:Vendor').getAttribute('data-status')).toBe('edited');
    expect(line('col:Total').getAttribute('data-ai-step')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Save format and download' })).toBeNull();
    // ... and it can be tried again.
    expect(finishButton().hasAttribute('disabled')).toBe(false);
  });

  it('an answer that does not match the example is not used either', async () => {
    const { engine } = engineWith(async (args) => completionOutput(args, {}, { matches: false }));
    await start(engine);
    fireEvent.click(finishButton());
    expect((await screen.findByTestId('completion-kept')).textContent).toBe('The AI step filled in what was missing, but the result did not match your example, so its answer was not used.');
    expect(line('col:Total').getAttribute('data-ai-step')).toBe('true');
  });

  it('an answer that produced nothing of what was asked is not used (and is a failed attempt, not a success)', async () => {
    const { engine } = engineWith(async (args) => completionOutput(args, {}, { produced: { columns: 0, parts: 0 } }));
    const api = await start(engine);
    fireEvent.click(finishButton());
    expect((await screen.findByTestId('completion-kept')).textContent).toBe('The AI step could not work out any of the missing parts, so there was nothing to add.');
    expect(line('col:Total').getAttribute('data-ai-step')).toBe('true');
    void api;
  });

  it('the readiness gate saying no (nothing is used up) is shown in words, and the rules stay', async () => {
    const { engine } = engineWith(async () =>
      learnResult({ path: 'notReady', rules: null, verification: null, readiness: { ready: false, issues: [{ code: 'payloadTooLarge', params: { kb: 60, limitKb: 48 } }] } }) as LearnOutput,
    );
    await start(engine);
    fireEvent.click(finishButton());
    const text = (await screen.findByTestId('completion-notready')).textContent!;
    expect(text).toContain('too large (60 KB; the limit is 48 KB)');
    expect(screen.getByText('Nothing was used up.')).toBeTruthy();
    expect(line('col:Total').getAttribute('data-ai-step')).toBe('true');
    expect(finishButton().hasAttribute('disabled')).toBe(false);
  });

  it('a learn that was continued past "rows could not be aligned" is analysed the same way for the completion', async () => {
    const seen: CompletionArgs[] = [];
    const fake = fakeEngine();
    fake.learn.mockImplementation(async (args: unknown) => {
      const a = args as CompletionArgs & { tryAnyway?: boolean };
      if (a.complete) {
        seen.push(a);
        return completionOutput(a);
      }
      return a.tryAnyway
        ? partialOutput()
        : ({ path: 'blocked', preflight: { status: 'warn', issues: [{ code: 'rowsNotAligned', severity: 'warn' }], skipColumns: [] }, rules: null, verification: null, assumptions: [], unsupported: [], calls: [], stages: {} } as unknown as LearnOutput);
    });
    renderApp({ engine: fake.engine, api: fakeApi({ user: USER }) });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
    });
    fireEvent.click(await screen.findByRole('button', { name: /Try anyway/ }));
    await screen.findByTestId('rules-map');
    fireEvent.click(finishButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ tryAnyway: true });
    await screen.findByTestId('completion-done');
  });

  it('rules edited while the AI step was working are not overwritten by its (older) answer', async () => {
    let release!: () => void;
    const { engine } = engineWith((args) => new Promise<LearnOutput>((resolve) => (release = () => resolve(completionOutput(args)))));
    await start(engine);
    fireEvent.click(finishButton());
    await screen.findByTestId('completion-running');
    await renameSupplier();
    await act(async () => release());
    expect((await screen.findByTestId('completion-kept')).textContent).toContain('You changed the rules while the AI step was working');
    expect(line('col:Vendor').getAttribute('data-status')).toBe('edited');
    expect(line('col:Total').getAttribute('data-ai-step')).toBe('true');
  });

  it('failures are plain: the server says it is exhausted (3 failed attempts) and the AI buttons stop', async () => {
    const { engine } = engineWith(async () => {
      throw new ApiError('aiAttemptsExhausted', 409, { counted: true });
    });
    await start(engine);
    fireEvent.click(finishButton());
    const text = (await screen.findByTestId('completion-error')).textContent!;
    expect(text.length).toBeGreaterThan(20);
    expect(screen.getByText('Your rules were kept as they were')).toBeTruthy();
    await waitFor(() => expect(finishButton().hasAttribute('disabled')).toBe(true));
    expect((screen.getByRole('button', { name: 'Re-run all with AI' }) as HTMLButtonElement).disabled).toBe(true);
    expect(line('col:Total').getAttribute('data-ai-step')).toBe('true');
  });

  it('the learn outcome is reported on the answer\'s own learn id (verified only when lock, match and production all hold)', async () => {
    const learnOutcome = vi.fn(async () => ({ counted: true, quota: { remaining: 2, period: 'month' as const }, failedAttempts: 0, exhausted: false }));
    const api = fakeApi({ user: USER, registry: { learnOutcome } });
    const { engine } = engineWith(async (args, host) => {
      await (host as { callLearn(p: unknown): Promise<unknown> }).callLearn({ masking: false, output: { columns: [] }, samples: [], skipColumns: [] });
      return completionOutput(args);
    });
    await start(engine, api);
    fireEvent.click(finishButton());
    await screen.findByTestId('completion-done');
    await waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'verified'));
  });
});

describe('"Re-run all with AI" is the whole learn again, behind a confirmation', () => {
  it('asks "This replaces your current rules"; "Keep my rules" changes nothing', async () => {
    const { engine, learn } = engineWith(async (args) => completionOutput(args));
    await start(engine);
    fireEvent.click(screen.getByRole('button', { name: 'Re-run all with AI' }));
    const dialog = await screen.findByRole('dialog', { name: 'Re-run everything with the AI step?' });
    expect(within(dialog).getByText(/This replaces your current rules/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep my rules' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it('"Replace my rules" runs the learn from scratch (no complete, AI allowed) and the new result replaces everything', async () => {
    const { engine, learn } = engineWith(async () => learnResult({ path: 'llm' }));
    await start(engine);
    await renameSupplier();
    fireEvent.click(screen.getByRole('button', { name: 'Re-run all with AI' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace my rules' }));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    const second = learn.mock.calls[1]![0] as CompletionArgs;
    expect(second).toMatchObject({ ai: 'allowed', tier: 'registered' });
    expect(second.complete).toBeUndefined();
    expect(await screen.findByRole('button', { name: 'Save format and download' })).toBeTruthy();
    expect(document.querySelector('[data-line-id="col:Vendor"]')).toBeNull(); // the user's edit went with the old rules
  });

  it('with nothing missing (the local rules cover everything) "Finish with the AI step" is the whole learn, and asks only when there are edits', async () => {
    const covered = (): LearnOutput => {
      const rules = partialRules();
      rules.output.columns = rules.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: 'sku' } : c.header === 'Shipped' ? { ...c, from: 'shipped' } : c));
      return partialOutput({ rules, partial: { ...PARTIAL, needsAi: [], needsAiParts: [] } });
    };
    const { engine, learn } = engineWith(async () => learnResult({ path: 'llm' }), covered);
    await start(engine);
    fireEvent.click(finishButton()); // no edits: straight to the learn
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    expect((learn.mock.calls[1]![0] as CompletionArgs).complete).toBeUndefined();
  });

  it('... and with edits it asks first', async () => {
    const covered = (): LearnOutput => {
      const rules = partialRules();
      rules.output.columns = rules.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: 'sku' } : c.header === 'Shipped' ? { ...c, from: 'shipped' } : c));
      return partialOutput({ rules, partial: { ...PARTIAL, needsAi: [], needsAiParts: [] } });
    };
    const { engine, learn } = engineWith(async () => learnResult({ path: 'llm' }), covered);
    await start(engine);
    await renameSupplier();
    fireEvent.click(finishButton());
    expect(await screen.findByRole('dialog', { name: 'Re-run everything with the AI step?' })).toBeTruthy();
    expect(learn).toHaveBeenCalledTimes(1);
  });
});

describe('"Try these columns with AI" on a result that still has columns with no rule', () => {
  /** An AI result where Shipped could not be worked out (ambiguous) and Remarks is external data. */
  function leftovers(): LearnOutput {
    const rules = ordersRules();
    rules.output.columns = rules.output.columns.map((c) => (c.header === 'Shipped' ? { header: 'Shipped', from: null } : c));
    rules.unsupported = [{ outputColumn: 'Shipped', reasonCode: 'ambiguous' }, { outputColumn: 'Remarks', reasonCode: 'externalData' }];
    return learnResult({ path: 'llm', rules, unsupported: rules.unsupported, verification: { verified: false, matched: 30, total: 30, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] } });
  }

  it('is offered to a signed-in user (next to Save), for the columns the AI step left - never the external ones', async () => {
    const seen: CompletionArgs[] = [];
    const { engine } = engineWith(
      async (args) => {
        seen.push(args);
        const out = completionOutput(args, {}, { produced: { columns: 1, parts: 0 } });
        return out;
      },
      leftovers,
    );
    await start(engine);
    expect(screen.getByRole('button', { name: /Save/ })).toBeTruthy();
    expect(screen.getByText(/Only the columns with no rule go to the AI step/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try these columns with AI' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.complete!.columns).toEqual([4]); // Shipped, not Remarks
    expect(seen[0]!.complete!.parts).toEqual([]);
  });

  it('is not offered to a visitor', async () => {
    const { engine } = engineWith(async (args) => completionOutput(args), leftovers);
    await start(engine, fakeApi());
    expect(screen.queryByRole('button', { name: 'Try these columns with AI' })).toBeNull();
  });

  it('is not offered when nothing is left to ask for', async () => {
    const { engine } = engineWith(async (args) => completionOutput(args), () => learnResult({ path: 'llm' }));
    await start(engine);
    expect(screen.queryByRole('button', { name: 'Try these columns with AI' })).toBeNull();
  });
});

describe('the owner\'s bug: a signed-in user\'s partial result shows "Finish with the AI step"', () => {
  /** The record the app keeps just before it goes to the provider. */
  async function kept(over: Partial<PendingLearn> = {}): Promise<PendingLearn> {
    return {
      version: 1,
      savedAt: Date.now(),
      path: '/result',
      input: await storeFile(csv('orders.csv', 'a,b\n1,2\n')),
      output: await storeFile(csv('Orders report.csv', 'x\n1\n')),
      masking: true,
      result: { name: 'Orders', rules: partialRules(), edited: [], exceptions: [] },
      ...over,
    };
  }

  it('after the full-page return from the provider (files kept in the browser): the button is there, and the AI step has not run', async () => {
    await store.save(await kept());
    const { engine, learn } = fakeEngine(async () => partialOutput());
    const api = fakeApi({ user: USER });
    renderApp({ api, engine, route: '/result' });
    await screen.findByTestId('rules-map');
    expect(finishButton()).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-run all with AI' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('AI formats left this month: 3', { exact: false })).toBeTruthy();
    expect(learn).toHaveBeenCalledTimes(1);
    expect(learn.mock.calls[0]![0]).toMatchObject({ ai: 'notAllowed', tier: 'registered' });
    expect(api.learn).not.toHaveBeenCalled();
  });

  it('when /api/me answers late the restore waits for it (it never shows the sign-in popup to someone who is signed in)', async () => {
    await store.save(await kept());
    let answer!: (u: typeof USER) => void;
    const me = vi.fn(() => new Promise<typeof USER>((resolve) => (answer = resolve)));
    const { engine } = fakeEngine(async () => partialOutput());
    renderApp({ api: fakeApi({ auth: { me } }), engine, route: '/result' });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('rules-map')).toBeNull(); // still waiting, on the spinner
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => answer(USER));
    await screen.findByTestId('rules-map');
    expect(finishButton()).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('signed in first, files dropped afterwards: the learn runs with the AI step allowed, as the user\'s tier - even when /api/me was still on its way at the click', async () => {
    let answer!: (u: typeof USER) => void;
    const me = vi.fn(() => new Promise<typeof USER>((resolve) => (answer = resolve)));
    const { engine, learn } = fakeEngine(async () => partialOutput());
    renderApp({ api: fakeApi({ auth: { me } }), engine });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(learn).not.toHaveBeenCalled(); // waiting for "who is signed in"
    await act(async () => answer(USER));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(1));
    expect(learn.mock.calls[0]![0]).toMatchObject({ ai: 'allowed', tier: 'registered' });
    // (this fake engine answers a partial result even to a signed-in user: the button is there to finish it)
    await screen.findByTestId('rules-map');
    expect(finishButton()).toBeTruthy();
  });

  it('signed in first, /api/me already answered: the learn is allowed the AI step at once', async () => {
    const { engine, learn } = fakeEngine(async () => partialOutput());
    await start(engine);
    expect(learn.mock.calls[0]![0]).toMatchObject({ ai: 'allowed', tier: 'registered' });
    expect(finishButton()).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a visitor sees the sign-in popup instead, and no button that would spend an AI format', async () => {
    const { engine } = fakeEngine(async () => partialOutput());
    await start(engine, fakeApi());
    expect(await screen.findByRole('dialog', { name: 'Sign in to finish' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('button', { name: 'Finish with the AI step' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in free to finish' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Re-run all with AI' })).toBeNull();
  });

  it('signing in somewhere else (another tab): coming back to this one shows the button, without a reload (which would lose the result)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let signedIn = false;
    const me = vi.fn(async () => (signedIn ? USER : null));
    const { engine } = fakeEngine(async () => partialOutput());
    await start(engine, fakeApi({ auth: { me } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.getByRole('button', { name: 'Sign in free to finish' })).toBeTruthy();

    signedIn = true;
    vi.setSystemTime(Date.now() + 60_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish with the AI step' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Sign in free to finish' })).toBeNull();
  });

  it('the kept learn stays until the restore has come to an end (a reload in the middle of it does not lose it)', async () => {
    const record = await kept();
    await store.save(record);
    const clear = vi.spyOn(store, 'clear');
    let finish!: () => void;
    const { engine } = fakeEngine(() => new Promise<LearnOutput>((resolve) => (finish = () => resolve(partialOutput()))));
    renderApp({ api: fakeApi({ user: USER }), engine, route: '/result' });
    await new Promise((r) => setTimeout(r, 40));
    expect(clear).not.toHaveBeenCalled();
    expect(await store.load()).not.toBeNull();
    await act(async () => finish());
    await screen.findByTestId('rules-map');
    await waitFor(() => expect(clear).toHaveBeenCalled());
    expect(await store.load()).toBeNull();
  });

  it('a learn that was continued past "rows could not be aligned" is restored the same way (it is not sent back to the warning)', async () => {
    await store.save(await kept({ tryAnyway: true }));
    const { engine, learn } = fakeEngine(async () => partialOutput());
    renderApp({ api: fakeApi({ user: USER }), engine, route: '/result' });
    await screen.findByTestId('rules-map');
    expect(learn.mock.calls[0]![0]).toMatchObject({ tryAnyway: true, ai: 'notAllowed' });
  });

  it('and a learn the visitor continued past that warning remembers it across the trip to the provider', async () => {
    const first = fakeEngine(async () => partialOutput());
    // the first call says "blocked: rows could not be aligned"; the user goes on; the second call (tryAnyway) gives the result
    first.learn.mockImplementation(async (args: unknown) =>
      (args as { tryAnyway?: boolean }).tryAnyway
        ? partialOutput()
        : ({ path: 'blocked', preflight: { status: 'warn', issues: [{ code: 'rowsNotAligned', severity: 'warn' }], skipColumns: [] }, rules: null, verification: null, assumptions: [], unsupported: [], calls: [], stages: {} } as unknown as LearnOutput),
    );
    renderApp({ api: fakeApi(), engine: first.engine });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
    });
    fireEvent.click(await screen.findByRole('button', { name: /Try anyway/ }));
    await screen.findByTestId('rules-map');
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to finish' });
    await act(async () => {
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue with Google' }));
    });
    await waitFor(() => expect(redirectTo).toHaveBeenCalled());
    expect((await store.load())!.tryAnyway).toBe(true);
  });
});

// A column COMPOSED from three input columns (`312345002 - Dana Cohen`) is beyond the light template, but the AI can write it: the pair
// analysis calls it derived, not external, so the AI step is offered for it. These tests run the REAL pair analysis (the engine) on such an
// example and feed what it said to the screen; an external column (nothing in the input explains it) is the control.
describe('a column composed from three input columns reaches the AI buttons (the real pair analysis, not a fixture)', () => {
  const FIRSTS = ['Dana', 'Omer', 'Noa', 'Yael', 'Tamar', 'Eitan', 'Lior', 'Maya', 'Amit', 'Shira', 'Ron', 'Gal'];
  const LASTS = ['Cohen', 'Levi', 'Mizrahi', 'Katz', 'Peretz', 'Bar', 'Avraham', 'Dahan', 'Golan', 'Segal'];
  const enc = (rows: string[][]): Uint8Array => new TextEncoder().encode(`${rows.map((r) => r.join(',')).join('\n')}\n`);

  /** Ref + Cust + First + Last in; Ref + Label out, where Label is composed (or, for the control, a code the input does not explain). */
  async function analysed(kind: 'composed' | 'external') {
    const input: string[][] = [['Ref', 'Cust', 'First', 'Last']];
    const output: string[][] = [['Ref', 'Label']];
    for (let i = 0; i < 24; i++) {
      const [first, last, cust, ref] = [FIRSTS[i % FIRSTS.length]!, LASTS[(i * 3) % LASTS.length]!, String(312345002 + i * 7), `R-${1000 + i * 7}`];
      input.push([ref, cust, first, last]);
      output.push([ref, kind === 'composed' ? `${cust} - ${first} ${last}` : `Z${(i * 7919) % 8000}x`]);
    }
    const res = await learnFromExamples({
      input: { bytes: enc(input), name: 'in.csv' },
      output: { bytes: enc(output), name: 'out.csv' },
      masking: false,
      tier: 'registered',
      ai: 'notAllowed',
      callLearn: async () => ({ rules: null, problems: [], calls: [] }),
    });
    if (res.path !== 'partial' || !res.rules || !res.partial) throw new Error(`unexpected path ${res.path}`);
    return res;
  }

  it('the pair analysis: composed is "needs the AI step" and not skipped; the external control is skipped', async () => {
    const composed = await analysed('composed');
    expect(composed.partial).toMatchObject({ solved: ['Ref'], needsAi: ['Label'], external: [] });
    expect(composed.preflight.skipColumns).toEqual([]);
    // The control: a code nothing in the input explains is external data (skipped, "needs your input"), and with only external columns
    // left the local result is final - there is no AI step to finish.
    const external = await analysed('external');
    expect(external.partial).toMatchObject({ reason: 'onlyExternalColumns', needsAi: [], external: ['Label'] });
    expect(external.preflight.skipColumns).toEqual([1]);
  });

  it('partial result, signed in: "Finish with the AI step" is there and asks the AI step for the composed column', async () => {
    const res = await analysed('composed');
    const seen: CompletionArgs[] = [];
    const { engine } = engineWith(
      async (args) => {
        seen.push(args);
        return completionOutput(args);
      },
      () => learnResult({ path: 'partial', rules: res.rules, partial: res.partial, preflight: res.preflight, readiness: res.readiness }),
    );
    await start(engine);
    fireEvent.click(finishButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.complete!.columns).toEqual([1]); // Label, by position
  });

  it('a result that left the composed column without a rule, signed in: "Try these columns with AI" is offered for it', async () => {
    const res = await analysed('composed');
    const rules: LearnResult = { ...res.rules!, unsupported: [{ outputColumn: 'Label', reasonCode: 'ambiguous' }] };
    const seen: CompletionArgs[] = [];
    const { engine } = engineWith(
      async (args) => {
        seen.push(args);
        return completionOutput(args, {}, { produced: { columns: 1, parts: 0 } });
      },
      () => learnResult({ path: 'llm', rules, unsupported: rules.unsupported, preflight: res.preflight, verification: { verified: false, matched: 24, total: 24, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] } }),
    );
    await start(engine);
    fireEvent.click(screen.getByRole('button', { name: 'Try these columns with AI' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.complete!.columns).toEqual([1]);
  });

  it('a column that was skipped as external data (pre-flight skipColumns) is never offered', async () => {
    const res = await analysed('composed');
    // The same screen, but the pair analysis had called Label external (skipColumns [1]): nothing for the AI step to try.
    const rules: LearnResult = { ...res.rules!, unsupported: [{ outputColumn: 'Label', reasonCode: 'ambiguous' }] };
    const { engine } = engineWith(async (args) => completionOutput(args), () =>
      learnResult({ path: 'llm', rules, unsupported: rules.unsupported, preflight: { ...res.preflight, skipColumns: [1] }, verification: { verified: false, matched: 24, total: 24, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] } }),
    );
    await start(engine);
    expect(screen.queryByRole('button', { name: 'Try these columns with AI' })).toBeNull();
  });
});
