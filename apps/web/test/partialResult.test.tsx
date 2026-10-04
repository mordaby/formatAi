// SPEC 21 v5 items 1 and 4: an example that needs the AI step shows the LOCAL result first - what code worked out, checked against
// the example, with the rest marked "Needs the AI step" - and a popup asks a visitor to sign in free to finish. A signed-in user
// gets "Run deep analysis with AI". A column code could not explain at all (external) needs the AI step too ("may come from another
// source"), and when the AI can't help at all the screen says what to fix. The worker is a fake; the API is never asked to learn for a visitor.
import type { LearnResult, MeUser, Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { ordersRules } from '../src/editor/testkit';
import type { LearnOutput } from '../src/worker/engineApi';
import { csv, fakeApi, fakeEngine, learnResult, liveResult, renderApp, USER } from './helpers/renderApp';

const { redirectTo } = vi.hoisted(() => ({ redirectTo: vi.fn() }));
vi.mock('../src/app/redirect', () => ({ redirectTo }));

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPendingStore(undefined);
});

/** The orders report with two computed columns the local analysis could not build (`Total`, `Shipped`) and one it found no trace of in the input (`Remarks`). */
function partialRules(): Rules {
  const rules = ordersRules();
  rules.output.columns = rules.output.columns.map((c) => (c.header === 'Total' || c.header === 'Shipped' ? { header: c.header, from: null } : c));
  rules.unsupported = []; // only the AI step reports a column as unsupported
  rules.output.summaryRows = [];
  rules.transform.computed = [];
  rules.validations = [];
  rules.assumptions = [];
  return rules;
}

const PARTIAL = {
  reason: 'aiNotAllowed' as const,
  solved: ['Item', 'Supplier', 'Qty'],
  needsAi: ['Total', 'Shipped', 'Remarks'],
  external: ['Remarks'],
  solvedColumns: [0, 1, 2],
  needsAiParts: ['sort' as const, 'summaryRows' as const],
};

function partialOutput(over: Record<string, unknown> = {}): LearnOutput {
  return learnResult({
    path: 'partial',
    rules: partialRules(),
    partial: PARTIAL,
    verification: { verified: false, matched: 30, total: 30, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    readiness: { ready: true },
    ...over,
  });
}

async function learn(engine: ReturnType<typeof fakeEngine>['engine'], api = fakeApi(), lang: 'en' | 'he' = 'en') {
  renderApp({ engine, api, lang });
  const en = lang === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('Orders report.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ }));
  });
  return api;
}

const line = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-line-id="${id}"]`);
  if (!el) throw new Error(`no line ${id}`);
  return el as HTMLElement;
};

describe('a visitor whose example needs the AI step', () => {
  it('learns with the AI step NOT allowed, and never calls the API', async () => {
    const { engine, learn: learnMock } = fakeEngine(async () => partialOutput());
    const api = await learn(engine);
    await screen.findByTestId('rules-map');
    expect(learnMock.mock.calls[0]![0]).toMatchObject({ ai: 'notAllowed', tier: 'anonymous' });
    expect(api.learn).not.toHaveBeenCalled();
    expect(api.repair).not.toHaveBeenCalled();
  });

  it('opens the popup with the counts: worked out N of M, K need the AI step, sign in free, what a sign-in includes', async () => {
    const { engine } = fakeEngine(async () => partialOutput());
    await learn(engine);
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to finish' });
    expect(within(dialog).getByTestId('partial-popup-text').textContent).toBe(
      'We worked out 3 of 6 columns on your computer. 3 need the AI step — sign in free to finish (3 AI formats a month included).',
    );
    expect(await within(dialog).findByRole('button', { name: 'Continue with Google' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Continue with Microsoft' })).toBeTruthy();
  });

  it('says it in Hebrew, with the same numbers', async () => {
    const { engine } = fakeEngine(async () => partialOutput());
    await learn(engine, fakeApi(), 'he');
    const dialog = await screen.findByRole('dialog', { name: 'התחברו כדי להשלים' });
    const text = within(dialog).getByTestId('partial-popup-text').textContent!;
    expect(text).toContain('הבנו 3 מתוך 6 עמודות במחשב שלכם');
    expect(text).toContain('3 דורשות את שלב ה-AI');
    expect(text).toContain('כולל 3 פורמטים עם AI בחודש');
  });

  it('uses the "layout" sentence when every column is worked out and only parts of the layout are left', async () => {
    const rules = partialRules();
    rules.output.columns = rules.output.columns.map((c) => (c.header === 'Total' ? { header: 'Total', from: 'total' } : c.header === 'Shipped' ? { header: 'Shipped', from: 'shipped' } : c.header === 'Remarks' ? { header: 'Remarks', from: 'sku' } : c));
    rules.transform.computed = ordersRules().transform.computed;
    const { engine } = fakeEngine(async () =>
      partialOutput({ rules, partial: { ...PARTIAL, solved: ['Item', 'Supplier', 'Qty', 'Total', 'Shipped', 'Remarks'], needsAi: [], external: [], solvedColumns: [0, 1, 2, 3, 4, 5] } }),
    );
    await learn(engine);
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to finish' });
    expect(within(dialog).getByTestId('partial-popup-text').textContent).toContain('We worked out 6 of 6 columns on your computer. The rest of the format');
    expect(within(dialog).getByTestId('partial-popup-text').textContent).toContain('needs the AI step — sign in free to finish (3 AI formats a month included).');
  });

  it('shows the local result after "Not now": solved columns as usual, the others as "Needs the AI step", the parts in their own list', async () => {
    // (the layout parts it could not build: the sort and the summary rows are not in the rules)
    const rules = partialRules();
    rules.transform.sort = [];
    const { engine } = fakeEngine(async () => partialOutput({ rules }));
    await learn(engine);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Every column code could not explain says so; the others do not.
    for (const header of ['Total', 'Shipped', 'Remarks']) {
      expect(line(`col:${header}`).getAttribute('data-ai-step')).toBe('true');
      expect(line(`col:${header}`).textContent).toContain('Needs the AI step');
    }
    expect(line('col:Item').getAttribute('data-ai-step')).toBeNull();
    expect(line('col:Item').getAttribute('data-status')).toBe('matches');
    // A column with no trace in the input needs the AI step too, with the note that it may come from another source.
    expect(line('col:Remarks').textContent).toContain('it may come from another source');
    expect(line('col:Total').textContent).not.toContain('it may come from another source');

    // The parts (how the rows are sorted, the summary rows) are listed as what the AI step still does.
    const parts = screen.getByTestId('ai-step-parts');
    expect(within(parts).getByText('Needs the AI step')).toBeTruthy();
    expect(within(parts).getByText('How the rows are sorted.')).toBeTruthy();
    expect(within(parts).getByText('The summary or total rows.')).toBeTruthy();

    expect(screen.getByTestId('status-badge').textContent).toBe('3 columns need the AI step');
    // There is nothing to save yet: the one action is to finish.
    expect(screen.queryByRole('button', { name: /Save format/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in free to finish' })).toBeTruthy();
    expect(screen.getByText('This is only what your computer worked out so far, so it cannot be saved yet.')).toBeTruthy();
  });

  it('checks only the columns code built: the live check gets their positions', async () => {
    const liveCheck = vi.fn(async (_id: string, _rules: LearnResult | Rules, _options?: { onlyColumns?: number[] }) => liveResult({ matched: 30, total: 30 }));
    const { engine } = fakeEngine(async () => partialOutput(), undefined, { liveCheck });
    await learn(engine);
    await waitFor(() => expect(liveCheck).toHaveBeenCalled());
    expect(liveCheck.mock.calls[0]![2]!.onlyColumns).toEqual([0, 1, 2]);
    expect(screen.getByTestId('live-check-text').textContent).toBe('Matches 30 of 30 rows in your example');
  });

  it('"Sign in free to finish" opens the popup again, and Continue goes to the provider', async () => {
    const { engine } = fakeEngine(async () => partialOutput());
    await learn(engine);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in free to finish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to finish' });
    await act(async () => {
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue with Google' }));
    });
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith('/api/auth/google/start?returnTo=%2Fresult'));
  });
});

describe('a signed-in user', () => {
  it('learns with the free engine only, for their tier - the AI step is never called by the learn itself (details: deepAnalysis.test.tsx)', async () => {
    const { engine, learn: learnMock } = fakeEngine(async () => learnResult({ path: 'local' }));
    const api = await learn(engine, fakeApi({ user: USER }));
    await screen.findByTestId('rules-map');
    expect(learnMock.mock.calls[0]![0]).toMatchObject({ ai: 'notAllowed', tier: 'registered' });
    expect(api.learn).not.toHaveBeenCalled();
    expect(screen.queryByTestId('deep-panel')).toBeNull(); // nothing is missing: there is nothing to offer
  });

  it('sees no popup on a local result: "Run deep analysis with AI" asks the AI step for only what is missing, keeping the rules on screen', async () => {
    const full = ordersRules();
    const results: LearnOutput[] = [
      partialOutput(),
      learnResult({
        path: 'llm',
        rules: full,
        completion: { columns: [3, 4, 5], parts: ['summaryRows'], fixedProblems: [], matches: true, produced: { columns: 2, parts: 1 } },
      }),
    ];
    const { engine, learn: learnMock } = fakeEngine(async () => results.shift()!);
    await learn(engine, fakeApi({ user: USER }));
    await screen.findByTestId('rules-map');
    expect(screen.queryByRole('dialog')).toBeNull();
    // (this fake hands a partial result even to a signed-in user: what matters is what the button then does)
    fireEvent.click(await screen.findByRole('button', { name: 'Run deep analysis with AI' }));
    await waitFor(() => expect(learnMock).toHaveBeenCalledTimes(2));
    expect(learnMock.mock.calls[1]![0]).toMatchObject({ ai: 'allowed', tier: 'registered', complete: { columns: [3, 4, 5], parts: ['summaryRows'] } });
    // ... and the result screen comes back with the finished rules (details of the completion: completion.test.tsx).
    expect(await screen.findByRole('button', { name: 'Save format' })).toBeTruthy();
  });

  it('is told what the AI step costs, next to the button', async () => {
    const api = fakeApi({ user: USER, auth: { quota: vi.fn(async () => ({ remaining: 1, period: 'month' as const })) } });
    const { engine } = fakeEngine(async () => partialOutput());
    await learn(engine, api);
    await screen.findByTestId('rules-map');
    await waitFor(() => expect(screen.getByTestId('deep-uses').textContent).toBe('Uses 1 AI format (1 left this month), and only if it succeeds.'));
  });
});

describe('only an unexplained (external) column is left', () => {
  /** Everything but Remarks is worked out; Remarks has no trace in the input: it is NOT a finished local result, it needs the AI step. */
  function onlyRemarks(): LearnOutput {
    const rules = ordersRules();
    rules.output.columns = rules.output.columns.map((c) => (c.header === 'Remarks' ? { header: 'Remarks', from: null } : c));
    rules.unsupported = [];
    return learnResult({
      path: 'partial',
      rules,
      partial: { reason: 'aiNotAllowed', solved: ['Item', 'Supplier', 'Qty', 'Total', 'Shipped'], needsAi: ['Remarks'], external: ['Remarks'], solvedColumns: [0, 1, 2, 3, 4], needsAiParts: [] },
      readiness: { ready: true },
    });
  }

  it('a visitor gets the sign-in popup for it (1 needs the AI step), and the column says "Needs the AI step"', async () => {
    const { engine } = fakeEngine(async () => onlyRemarks());
    await learn(engine);
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to finish' });
    expect(within(dialog).getByTestId('partial-popup-text').textContent).toBe(
      'We worked out 5 of 6 columns on your computer. 1 needs the AI step — sign in free to finish (3 AI formats a month included).',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(line('col:Remarks').getAttribute('data-ai-step')).toBe('true');
    expect(line('col:Remarks').textContent).toContain('it may come from another source');
    expect(screen.queryByRole('button', { name: /Save format/ })).toBeNull();
  });

  it('a signed-in user can finish it: "Run deep analysis with AI" asks for that column', async () => {
    const results: LearnOutput[] = [onlyRemarks(), learnResult({ path: 'llm', rules: ordersRules(), completion: { columns: [5], parts: [], fixedProblems: [], matches: true, produced: { columns: 1, parts: 0 } } })];
    const { engine, learn: learnMock } = fakeEngine(async () => results.shift()!);
    await learn(engine, fakeApi({ user: USER }));
    await screen.findByTestId('rules-map');
    fireEvent.click(await screen.findByRole('button', { name: 'Run deep analysis with AI' }));
    await waitFor(() => expect(learnMock).toHaveBeenCalledTimes(2));
    expect(learnMock.mock.calls[1]![0]).toMatchObject({ ai: 'allowed', complete: { columns: [5], parts: [] } });
  });
});

describe('the AI readiness gate said no (nothing is used up)', () => {
  it('says what to fix, in words, and offers other files', async () => {
    const { engine } = fakeEngine(
      async () =>
        learnResult({
          path: 'notReady',
          rules: null,
          verification: null,
          readiness: { ready: false, issues: [{ code: 'noRowsMatched' }, { code: 'inputColumnsTooMany', params: { count: 90, limit: 60 } }] },
        }) as LearnOutput,
    );
    await learn(engine, fakeApi({ user: USER }));
    expect(await screen.findByRole('heading', { name: "The AI step can't help with these files" })).toBeTruthy();
    expect(screen.getByText(/None of the rows in your example output match a row of your input file/)).toBeTruthy();
    expect(screen.getByText(/Your input file has 90 columns, and the AI step can take at most 60/)).toBeTruthy();
    expect(screen.getByText('Nothing was used up.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose other files' }));
    expect(await screen.findByRole('heading', { name: 'Show us one example' })).toBeTruthy();
  });
});
