// Owner decision: the AI step never runs unless the user chooses it - signed in or not. Every learn is the free engine only; the Result screen
// says what it solved and lists what it could not (with a tick each) and the user decides, there, whether to run a deep analysis with AI.
// Home's "Deep analysis with AI if needed" (signed in, off by default, remembered per browser) makes the AI step start by itself after the free
// result when fields are missing. The engine and the API are fakes: nothing real is ever called.
import type { LearnResult, Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { ordersRules } from '../src/editor/testkit';
import type { LearnOutput } from '../src/worker/engineApi';
import { conversionSummary, createFormatResponse, formatSummary } from './helpers/registryKit';
import { csv, fakeApi, fakeEngine, learnResult, renderApp, USER } from './helpers/renderApp';

vi.mock('../src/app/redirect', () => ({ redirectTo: vi.fn() }));
const { downloaded } = vi.hoisted(() => ({ downloaded: vi.fn() }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));

const SUMMARY = { rowsIn: 3, rowsOut: 3, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] };
const converted = (): unknown => ({ ok: true, bytes: new ArrayBuffer(8), flags: [], summary: SUMMARY, preview: { name: 'Out', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] }, totalRows: 3 });

const PREF = 'formatai.deepAnalysis';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  window.localStorage.clear();
  setPendingStore(undefined);
});

/** The orders report as the free engine leaves it: Total, Shipped and Remarks have no rule; the sort is built, the summary row is not. */
function partialRules(missing: readonly string[] = ['Total', 'Shipped', 'Remarks']): Rules {
  const rules = ordersRules();
  rules.output.columns = rules.output.columns.map((c) => (missing.includes(c.header) ? { header: c.header, from: null } : c));
  rules.unsupported = [];
  rules.output.summaryRows = [];
  rules.transform.computed = [];
  rules.validations = [];
  rules.assumptions = [];
  return rules;
}

const partialOutput = (over: Record<string, unknown> = {}): LearnOutput =>
  learnResult({
    path: 'partial',
    rules: partialRules(),
    partial: {
      reason: 'aiNotAllowed' as const,
      solved: ['Item', 'Supplier', 'Qty'],
      needsAi: ['Total', 'Shipped', 'Remarks'],
      external: ['Remarks'],
      solvedColumns: [0, 1, 2],
      needsAiParts: ['sort' as const, 'summaryRows' as const],
    },
    readiness: { ready: true },
    verification: { verified: false, matched: 30, total: 30, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    ...over,
  });

interface Args {
  ai: string;
  tier: string;
  complete?: { fixedRules: LearnResult; columns: number[]; parts: string[] };
}

/** What the AI step would answer: the fixed rules with Total, Shipped and the summary row produced. */
function completionOutput(args: Args): LearnOutput {
  const fixed = args.complete!.fixedRules;
  const full = ordersRules();
  const rules: LearnResult = {
    ...fixed,
    transform: { ...fixed.transform, computed: full.transform.computed },
    output: {
      ...fixed.output,
      columns: fixed.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: 'total' } : c.header === 'Shipped' ? { ...c, from: 'shipped' } : c)),
      summaryRows: full.output.summaryRows,
    },
  };
  return learnResult({
    path: 'llm',
    rules,
    completion: { columns: args.complete!.columns, parts: args.complete!.parts, fixedProblems: [], matches: true, produced: { columns: 2, parts: 1 } },
    verification: { verified: true, matched: 30, total: 30, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
  });
}

/** A fake engine whose first learn is the free result and whose later ones are whatever `next` makes of them. */
function engineWith(next: (args: Args) => Promise<LearnOutput>, first: () => LearnOutput = () => partialOutput()) {
  const fake = fakeEngine(undefined, undefined, { convert: vi.fn(async () => converted()) });
  fake.learn.mockImplementation(async (args: unknown) => (fake.learn.mock.calls.length > 1 ? next(args as Args) : first()));
  return fake;
}

const callArgs = (learn: ReturnType<typeof fakeEngine>['learn'], n: number): Args => learn.mock.calls[n]![0] as Args;

async function dropFiles(lang: 'en' | 'he' = 'en') {
  const en = lang === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('Orders report.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
}
const learnClick = () => act(async () => void fireEvent.click(screen.getByRole('button', { name: /Learn the format/ })));

/** The whole trip: sign in (or not), drop the files, learn, land on the Result screen. */
async function toResult(engine: ReturnType<typeof fakeEngine>['engine'], api = fakeApi({ user: USER }), opts: { deep?: boolean } = {}) {
  renderApp({ engine, api });
  await dropFiles();
  if (opts.deep) {
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Deep analysis with AI if needed' }));
  }
  await learnClick();
  await screen.findByTestId('rules-map');
  return api;
}

/** The conversions of the whole example file (the download), not the previews the page makes to find what a run would flag. */
const fullConversions = (engine: ReturnType<typeof fakeEngine>['engine']) =>
  (engine.convert as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as { rules: LearnResult; file: { name: string }; previewRows: number }).filter((a) => a.previewRows === 0);

const line = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-line-id="${id}"]`);
  if (!el) throw new Error(`no line ${id}`);
  return el as HTMLElement;
};
const runButton = () => screen.getByRole('button', { name: 'Run deep analysis with AI' }) as HTMLButtonElement;
const tick = (name: string | RegExp) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

describe('every learn is the free engine only', () => {
  it('a signed-in learn does NOT call /api/learn, and the engine is told the AI step is not allowed', async () => {
    const { engine, learn } = engineWith(async (a) => completionOutput(a));
    const api = await toResult(engine);
    expect(learn).toHaveBeenCalledTimes(1);
    expect(callArgs(learn, 0)).toMatchObject({ ai: 'notAllowed', tier: 'registered' });
    expect(api.learn).not.toHaveBeenCalled();
    expect(api.repair).not.toHaveBeenCalled();
    // ... and with fields missing it is still waiting for the user, a moment later too.
    await new Promise((r) => setTimeout(r, 60));
    expect(learn).toHaveBeenCalledTimes(1);
    expect(runButton().disabled).toBe(false);
  });

  it('a visitor learns the same way', async () => {
    const { engine, learn } = engineWith(async (a) => completionOutput(a));
    await toResult(engine, fakeApi());
    expect(callArgs(learn, 0)).toMatchObject({ ai: 'notAllowed', tier: 'anonymous' });
  });
});

describe('Home: "Deep analysis with AI if needed"', () => {
  it('is shown to signed-in users only, and is off by default', async () => {
    const { engine } = fakeEngine();
    renderApp({ engine, api: fakeApi({ user: USER }) });
    const box = await screen.findByRole('checkbox', { name: 'Deep analysis with AI if needed' });
    expect((box as HTMLInputElement).checked).toBe(false);
    cleanup();
    renderApp({ engine, api: fakeApi() });
    await screen.findByRole('button', { name: /Learn the format/ });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('checkbox', { name: 'Deep analysis with AI if needed' })).toBeNull();
  });

  it('is remembered in this browser (localStorage)', async () => {
    const { engine } = fakeEngine();
    renderApp({ engine, api: fakeApi({ user: USER }) });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Deep analysis with AI if needed' }));
    expect(window.localStorage.getItem(PREF)).toBe('1');
    cleanup();
    renderApp({ engine, api: fakeApi({ user: USER }) });
    expect(((await screen.findByRole('checkbox', { name: 'Deep analysis with AI if needed' })) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Deep analysis with AI if needed' }));
    expect(window.localStorage.getItem(PREF)).toBe('0');
  });

  it('works when the browser storage throws (private window, blocked site data): off, and still usable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { engine } = fakeEngine();
    renderApp({ engine, api: fakeApi({ user: USER }) });
    const box = (await screen.findByRole('checkbox', { name: 'Deep analysis with AI if needed' })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true); // holds for this visit
  });

  it('has its Hebrew label', async () => {
    const { engine } = fakeEngine();
    renderApp({ engine, api: fakeApi({ user: USER }), lang: 'he' });
    expect(await screen.findByRole('checkbox', { name: 'ניתוח מעמיק עם AI במידת הצורך' })).toBeTruthy();
  });

  it('ON: the AI step starts by itself right after the free result when fields are missing - the free result is shown first, "Running deep analysis…" on the missing fields', async () => {
    let release!: () => void;
    const { engine, learn } = engineWith((a) => new Promise<LearnOutput>((resolve) => (release = () => resolve(completionOutput(a)))));
    await toResult(engine, fakeApi({ user: USER }), { deep: true });
    // The free result is on screen, and the analysis has started on what is missing.
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    expect(callArgs(learn, 1)).toMatchObject({ ai: 'allowed', tier: 'registered', complete: { columns: [3, 4, 5], parts: ['summaryRows'] } });
    expect((await screen.findByTestId('completion-running')).textContent).toContain('Running deep analysis…');
    for (const header of ['Total', 'Shipped', 'Remarks']) expect(line(`col:${header}`).getAttribute('data-ai-running')).toBe('true');
    expect(line('col:Item').getAttribute('data-status')).toBe('matches');
    await act(async () => release());
    await screen.findByTestId('completion-done');
    expect(line('col:Total').getAttribute('data-ai-step')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save format and download' })).toBeTruthy();
    expect(learn).toHaveBeenCalledTimes(2); // once per result
  });

  it('ON, but nothing is missing (the free engine solved it all): no AI call', async () => {
    const { engine, learn } = engineWith(async (a) => completionOutput(a), () => learnResult({ path: 'local' }));
    const api = await toResult(engine, fakeApi({ user: USER }), { deep: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(learn).toHaveBeenCalledTimes(1);
    expect(api.learn).not.toHaveBeenCalled();
    expect(screen.queryByTestId('deep-panel')).toBeNull();
  });

  it('OFF: fields are missing and nothing runs until the user chooses', async () => {
    const { engine, learn } = engineWith(async (a) => completionOutput(a));
    await toResult(engine);
    await new Promise((r) => setTimeout(r, 60));
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it('ON with too little solved: the whole learn runs (as for the button), with the AI step allowed', async () => {
    const { engine, learn } = engineWith(
      async () => learnResult({ path: 'llm' }),
      () => partialOutput({ rules: partialRules(['Supplier', 'Qty', 'Total', 'Shipped']) }), // 2 of 6 fixed: under half
    );
    await toResult(engine, fakeApi({ user: USER }), { deep: true });
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    expect(callArgs(learn, 1)).toMatchObject({ ai: 'allowed', tier: 'registered' });
    expect(callArgs(learn, 1).complete).toBeUndefined();
  });
});

describe('the panel on the Result screen', () => {
  it('says what the free engine solved and lists what it could not - fields and layout parts - each ticked', async () => {
    const { engine } = engineWith(async (a) => completionOutput(a));
    await toResult(engine);
    const panel = screen.getByTestId('deep-panel');
    expect(within(panel).getByRole('heading', { name: 'The free engine solved 3 of 6 fields.' })).toBeTruthy();
    const fields = within(panel).getByTestId('deep-fields');
    const names = within(fields).getAllByRole('checkbox').map((c) => c.closest('label')!.textContent);
    expect(names).toEqual(['Total', 'Shipped', 'Remarks — may come from another source', 'The summary or total rows.']);
    for (const box of within(fields).getAllByRole('checkbox')) expect((box as HTMLInputElement).checked).toBe(true);
    // The panel is above the editor content: before the map.
    expect(panel.compareDocumentPosition(screen.getByTestId('rules-map')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The one primary action, and the cost in words.
    expect(runButton().className).toContain('btn--primary');
    expect(screen.getByTestId('deep-uses').textContent).toBe('Uses 1 AI format (3 left this month), and only if it succeeds.');
    // "Re-run all with AI" is a secondary link in the same panel; there is no other place for the AI action.
    expect(within(panel).getByRole('button', { name: 'Re-run all with AI' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finish with the AI step' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try these columns with AI' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Run deep analysis with AI' })).toHaveLength(1);
  });

  it('is in Hebrew too, with the same numbers', async () => {
    const { engine } = engineWith(async (a) => completionOutput(a));
    renderApp({ engine, api: fakeApi({ user: USER }), lang: 'he' });
    await dropFiles('he');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /ללמוד את הפורמט/ })));
    await screen.findByTestId('rules-map');
    const panel = screen.getByTestId('deep-panel');
    expect(within(panel).getByRole('heading', { name: 'המנוע החינמי פתר 3 מתוך 6 שדות.' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'הפעלת ניתוח מעמיק עם AI' })).toBeTruthy();
    expect(screen.getByTestId('deep-uses').textContent).toBe('ינצל פורמט אחד עם AI (נותרו לכם 3 החודש), ורק אם יצליח.');
  });

  it('running it asks for the ticked fields: the whole list by default', async () => {
    const { engine, learn } = engineWith(async (a) => completionOutput(a));
    await toResult(engine);
    fireEvent.click(runButton());
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    expect(callArgs(learn, 1)).toMatchObject({ ai: 'allowed', complete: { columns: [3, 4, 5], parts: ['summaryRows'] } });
    await screen.findByTestId('completion-done');
  });

  it('unticking a field excludes it from the completion request - and a part too', async () => {
    const { engine, learn } = engineWith(async (a) => completionOutput(a));
    await toResult(engine);
    fireEvent.click(tick('Shipped'));
    expect(tick('Shipped').checked).toBe(false);
    fireEvent.click(tick('The summary or total rows.'));
    fireEvent.click(runButton());
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    const asked = callArgs(learn, 1).complete!;
    expect(asked.columns).toEqual([3, 5]); // Total and Remarks; Shipped (4) stays out
    expect(asked.parts).toEqual([]);
    // The fixed rules still carry Shipped as it was (no rule): it is not the AI step's to touch.
    expect(asked.fixedRules.output.columns[4]).toMatchObject({ header: 'Shipped', from: null });
  });

  it('with everything unticked there is nothing to run', async () => {
    const { engine, learn } = engineWith(async (a) => completionOutput(a));
    await toResult(engine);
    for (const name of ['Total', 'Shipped', /^Remarks/, 'The summary or total rows.']) fireEvent.click(tick(name));
    expect(runButton().disabled).toBe(true);
    fireEvent.click(runButton());
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it('too little solved (under half): the whole learn runs, so the choice is fixed and the panel says why', async () => {
    const { engine, learn } = engineWith(
      async () => learnResult({ path: 'llm' }),
      () => partialOutput({ rules: partialRules(['Supplier', 'Qty', 'Total', 'Shipped']) }),
    );
    await toResult(engine);
    expect(screen.getByText(/solved less than half/)).toBeTruthy();
    expect(tick('Total').disabled).toBe(true);
    expect(tick('Total').checked).toBe(true);
    fireEvent.click(runButton());
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    expect(callArgs(learn, 1)).toMatchObject({ ai: 'allowed' });
    expect(callArgs(learn, 1).complete).toBeUndefined();
  });

  it('the fields it is asked for cannot be edited while it works; the rest can', async () => {
    let release!: () => void;
    const { engine } = engineWith((a) => new Promise<LearnOutput>((resolve) => (release = () => resolve(completionOutput(a)))));
    await toResult(engine);
    fireEvent.click(runButton());
    await screen.findByTestId('completion-running');
    expect(screen.getByText('Working on 3 fields.')).toBeTruthy();
    fireEvent.click(line('col:Total').querySelector('.map-line__main') as HTMLElement);
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Grand total' } });
    expect((await screen.findByRole('alert')).textContent).toContain('The deep analysis is working on this part right now');
    await act(async () => release());
    await screen.findByTestId('completion-done');
  });

  it('afterwards it says what the AI solved and what still needs input (an honest "could not produce" stays "needs your input")', async () => {
    const { engine } = engineWith(async (a) => {
      // Total and Shipped are produced; Remarks is reported unsupported (left without a rule).
      const out = completionOutput(a);
      const rules = out.rules as LearnResult;
      rules.unsupported = [{ outputColumn: 'Remarks', reasonCode: 'externalData' }];
      return learnResult({ ...out, rules, completion: { ...(out.completion as object), produced: { columns: 2, parts: 1 } } });
    });
    await toResult(engine);
    fireEvent.click(runButton());
    await screen.findByTestId('completion-done');
    const panel = screen.getByTestId('deep-panel');
    expect(within(panel).getByRole('heading', { name: '5 of 6 fields are solved.' })).toBeTruthy();
    expect(within(panel).getByText('It solved 2 of the 3 fields you chose.')).toBeTruthy();
    // Said honestly, and still delivered (details: the "best we can do" tests below).
    expect(within(panel).getByTestId('deep-best').textContent).toContain("This is the best we can do for now: 1 field needs a rule we can't build yet. We keep improving and may support it next time.");
    expect(within(within(panel).getByTestId('deep-fields')).getByText('Remarks')).toBeTruthy();
    expect(line('col:Remarks').getAttribute('data-status')).toBe('needsInput');
  });

  it('shows the free result as savable once nothing is missing any more, and still offers the deep analysis (secondary)', async () => {
    // Every column has a rule and no layout part is missing, yet the strict fast path did not accept it: the result is the free engine's own.
    const covered = (): LearnOutput => {
      const rules = partialRules([]);
      rules.output.columns = rules.output.columns.map((c) => (c.from === null ? { ...c, from: 'sku' } : c)); // (the orders report's Remarks has no rule of its own)
      return partialOutput({
        rules,
        partial: { reason: 'aiNotAllowed' as const, solved: [], needsAi: [], external: [], solvedColumns: [0, 1, 2, 3, 4, 5], needsAiParts: [] },
      });
    };
    const { engine } = engineWith(async () => learnResult({ path: 'llm' }), covered);
    await toResult(engine);
    expect(screen.getByRole('button', { name: /^Save/ })).toBeTruthy();
    expect(runButton().className).not.toContain('btn--primary');
    expect(screen.getByText(/could not confirm the whole format on its own/)).toBeTruthy();
  });
});

describe('quota', () => {
  it('says what is left in the words of the period', async () => {
    const api = fakeApi({ user: USER, auth: { quota: vi.fn(async () => ({ remaining: 2, period: 'day' as const })) } });
    const { engine } = engineWith(async (a) => completionOutput(a));
    await toResult(engine, api);
    await waitFor(() => expect(screen.getByTestId('deep-uses').textContent).toBe('Uses 1 AI format (2 left today), and only if it succeeds.'));
  });

  it('with none left the run is not offered, and it says so (the fields are then "the best we can do for now", and delivered)', async () => {
    const api = fakeApi({ user: USER, auth: { quota: vi.fn(async () => ({ remaining: 0, period: 'month' as const })) } });
    const { engine, learn } = engineWith(async (a) => completionOutput(a));
    await toResult(engine, api, { deep: true });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Run deep analysis with AI' })).toBeNull());
    expect(screen.getByText(/You've used your AI formats/)).toBeTruthy();
    expect(screen.getByTestId('deep-best').textContent).toContain('This is the best we can do for now: 3 fields need a rule');
    expect(screen.getByRole('button', { name: 'Download with these fields empty' })).toBeTruthy();
    expect(learn).toHaveBeenCalledTimes(1); // not even the automatic run
  });

  it('a plan with no limit says so', async () => {
    const api = fakeApi({ user: USER, auth: { quota: vi.fn(async () => ({ remaining: null, period: 'unlimited' as const })) } });
    const { engine } = engineWith(async (a) => completionOutput(a));
    await toResult(engine, api);
    await waitFor(() => expect(screen.getByTestId('deep-uses').textContent).toBe('Uses 1 AI format, and only if it succeeds. Your plan has no limit.'));
  });
});

/** An AI answer that produced Total and the summary row but reports Shipped and Remarks as unsupported: they stay without a rule. */
function answerWithTwoUnsupported(a: Args): LearnOutput {
  const out = completionOutput(a);
  const rules = out.rules as LearnResult;
  rules.output.columns = rules.output.columns.map((c) => (c.header === 'Shipped' ? { header: 'Shipped', from: null } : c));
  rules.unsupported = [
    { outputColumn: 'Shipped', reasonCode: 'ambiguous' },
    { outputColumn: 'Remarks', reasonCode: 'externalData' },
  ];
  return learnResult({ ...out, rules, completion: { ...(out.completion as object), produced: { columns: 1, parts: 1 } } });
}

describe('fields that still have no rule: the best we can do for now - said honestly, and delivered', () => {
  const BEST_ONE = "This is the best we can do for now: 1 field needs a rule we can't build yet. We keep improving and may support it next time.";
  const BEST_TWO = "This is the best we can do for now: 2 fields need a rule we can't build yet. We keep improving and may support them next time.";

  it('appears after an AI answer that left columns unsupported: the wording, the list, and no error anywhere', async () => {
    const { engine } = engineWith(async (a) => answerWithTwoUnsupported(a));
    await toResult(engine);
    fireEvent.click(runButton());
    await screen.findByTestId('completion-done');
    const best = screen.getByTestId('deep-best');
    expect(within(best).getByText(BEST_TWO)).toBeTruthy();
    expect(within(best).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Shipped', 'Remarks']);
    // Never an error: not an alert, not the warning colour, and the screen carries on (the map says "needs your input" per field).
    expect(screen.getByTestId('deep-panel').getAttribute('data-tone')).toBe('info');
    expect(within(screen.getByTestId('deep-panel')).queryByRole('alert')).toBeNull();
    expect(line('col:Shipped').getAttribute('data-status')).toBe('needsInput');
    expect(line('col:Remarks').getAttribute('data-status')).toBe('needsInput');
    // Nothing to ask again right after the AI step has answered; the three ways forward are all there.
    expect(screen.queryByRole('button', { name: 'Run deep analysis with AI' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Download with these fields empty' })).toBeTruthy();
    expect(screen.getByText(/fill them in yourself on the map, or save the format/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save format and download' })).toBeTruthy();
  });

  it('says it in Hebrew', async () => {
    const { engine } = engineWith(async (a) => answerWithTwoUnsupported(a));
    renderApp({ engine, api: fakeApi({ user: USER }), lang: 'he' });
    await dropFiles('he');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /ללמוד את הפורמט/ })));
    await screen.findByTestId('rules-map');
    fireEvent.click(screen.getByRole('button', { name: 'הפעלת ניתוח מעמיק עם AI' }));
    await screen.findByTestId('completion-done');
    const best = screen.getByTestId('deep-best');
    expect(within(best).getByText('זה הכי טוב שאנחנו יכולים לעשות כרגע: 2 שדות דורשים כלל שאנחנו עדיין לא יודעים לבנות. אנחנו ממשיכים להשתפר, ואולי נתמוך בהם בפעם הבאה.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'הורדה כשהשדות האלה ריקים' })).toBeTruthy();
  });

  it('one field: the singular wording', async () => {
    const { engine } = engineWith(async (a) => {
      const out = completionOutput(a);
      const rules = out.rules as LearnResult;
      rules.unsupported = [{ outputColumn: 'Remarks', reasonCode: 'externalData' }];
      return learnResult({ ...out, rules });
    });
    await toResult(engine);
    fireEvent.click(runButton());
    await screen.findByTestId('completion-done');
    expect(within(screen.getByTestId('deep-best')).getByText(BEST_ONE)).toBeTruthy();
  });

  it("a result the AI learned in full (not the free engine's) with a column it could not produce says it the same way", async () => {
    const leftovers = (): LearnOutput => {
      const rules = ordersRules(); // Remarks: no rule, reported unsupported
      return learnResult({ path: 'llm', rules, unsupported: rules.unsupported, verification: { verified: false, matched: 30, total: 30, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] } });
    };
    const { engine } = engineWith(async (a) => completionOutput(a), leftovers);
    await toResult(engine);
    expect(within(screen.getByTestId('deep-panel')).getByRole('heading', { name: '5 of 6 fields are solved.' })).toBeTruthy();
    expect(within(screen.getByTestId('deep-best')).getByText(BEST_ONE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download with these fields empty' })).toBeTruthy();
  });

  it('is not said before the AI step has been tried (or while it can still be): the free result offers the analysis, and the way out', async () => {
    const { engine } = engineWith(async (a) => completionOutput(a));
    await toResult(engine);
    expect(screen.queryByTestId('deep-best')).toBeNull();
    expect(runButton().className).toContain('btn--primary');
    // ... but it can be delivered right away, too: nobody has to run the AI step to get a file.
    expect(screen.getByRole('button', { name: 'Download with these fields empty' })).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save format and download' });
    expect(save.className).not.toContain('btn--primary');
  });

  it('(a) downloads the converted example right away with those fields left empty: the rules as they are (no rule for the field), nothing saved', async () => {
    const api = fakeApi({ user: USER });
    const { engine } = engineWith(async (a) => answerWithTwoUnsupported(a));
    await toResult(engine, api);
    fireEvent.click(runButton());
    await screen.findByTestId('completion-done');
    fireEvent.click(screen.getByRole('button', { name: 'Download with these fields empty' }));
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
    // (the page's own check of what a real run would flag converts a preview too; the download is the one with no preview limit: the whole file)
    const whole = fullConversions(engine);
    expect(whole).toHaveLength(1);
    const call = whole[0]!;
    expect(call.file.name).toBe('orders.csv');
    expect(call.rules.output.columns.filter((c) => c.from === null).map((c) => c.header)).toEqual(['Shipped', 'Remarks']);
    expect(downloaded.mock.calls[0]![0]).toMatch(/\.xlsx$/);
    expect(api.registry.createFormat).not.toHaveBeenCalled();
    expect(screen.queryByText(/We couldn't prepare the file/)).toBeNull();
  });

  it('(a) the same from the free result, before any AI step', async () => {
    const { engine } = engineWith(async (a) => completionOutput(a));
    const api = await toResult(engine);
    fireEvent.click(screen.getByRole('button', { name: 'Download with these fields empty' }));
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
    expect(api.learn).not.toHaveBeenCalled();
    expect(fullConversions(engine)[0]!.rules.output.columns.filter((c) => c.from === null)).toHaveLength(3);
  });

  it('(c) saves the format with those fields marked "needs your input" (userConfirmed), and downloads the file with them empty', async () => {
    const created = createFormatResponse({ format: formatSummary({ id: 'F1', name: 'Orders report' }), conversion: conversionSummary({ id: 'C1', formatId: 'F1' }) });
    const createFormat = vi.fn(async () => created);
    const api = fakeApi({ user: USER, registry: { createFormat } });
    const { engine } = engineWith(async (a) => answerWithTwoUnsupported(a));
    await toResult(engine, api);
    fireEvent.click(runButton());
    await screen.findByTestId('completion-done');
    const save = (await screen.findByRole('button', { name: 'Save format and download' })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false)); // (the check of the new rules has finished)
    fireEvent.click(save);
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    const body = (createFormat.mock.calls[0] as unknown as [{ status: string; rules: LearnResult; learnPath: string }])[0];
    expect(body.status).toBe('userConfirmed');
    expect(body.learnPath).toBe('llm');
    expect(body.rules.output.columns.filter((c) => c.from === null).map((c) => c.header)).toEqual(['Shipped', 'Remarks']);
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
  });

  it('(b) a field can be filled in on the map, and then it is no longer listed', async () => {
    const { engine } = engineWith(async (a) => answerWithTwoUnsupported(a));
    await toResult(engine);
    fireEvent.click(runButton());
    await screen.findByTestId('completion-done');
    fireEvent.click(line('col:Remarks').querySelector('.map-line__main') as HTMLElement);
    fireEvent.click(screen.getByRole('radio', { name: 'Fixed value' }));
    fireEvent.change(await screen.findByLabelText('Value'), { target: { value: 'x' } });
    await waitFor(() => expect(within(screen.getByTestId('deep-best')).getByText(BEST_ONE)).toBeTruthy());
    expect(within(screen.getByTestId('deep-best')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Shipped']);
  });

  it('a visitor keeps the preview and signs in for the file: the download button opens the sign-in, nothing is converted', async () => {
    const { engine } = engineWith(async (a) => completionOutput(a));
    await toResult(engine, fakeApi());
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.getByText(/Sign in free to download the file with these fields left empty/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download with these fields empty' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(fullConversions(engine)).toHaveLength(0);
    expect(downloaded).not.toHaveBeenCalled();
  });
});

describe('a visitor', () => {
  it('sees the sign-in prompt in the panel instead of the run button, and the list of what is missing', async () => {
    const { engine, learn } = engineWith(async (a) => completionOutput(a));
    const api = await toResult(engine, fakeApi());
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    const panel = screen.getByTestId('deep-panel');
    expect(within(panel).getByRole('heading', { name: 'The free engine solved 3 of 6 fields.' })).toBeTruthy();
    expect(within(panel).getByText('Sign in free to run a deep analysis with AI on these fields (3 AI formats a month included).')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Sign in free to finish' })).toBeTruthy();
    expect(within(panel).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(panel).getByTestId('deep-fields').textContent).toContain('Total');
    expect(screen.queryByRole('button', { name: 'Run deep analysis with AI' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-run all with AI' })).toBeNull();
    expect(learn).toHaveBeenCalledTimes(1);
    expect(api.learn).not.toHaveBeenCalled();
  });

  it('is not auto-run by a remembered "Deep analysis" setting', async () => {
    window.localStorage.setItem(PREF, '1');
    const { engine, learn } = engineWith(async (a) => completionOutput(a));
    await toResult(engine, fakeApi());
    await new Promise((r) => setTimeout(r, 60));
    expect(learn).toHaveBeenCalledTimes(1);
  });
});
