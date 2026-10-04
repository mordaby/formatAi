// SPEC 5 E "The learned rules survive sign-in": before the browser leaves for the provider what has been learned is kept (in IndexedDB,
// never sent); when the app starts again the LOCAL analysis is re-run on the kept files, the kept edits are put back on top, and the
// Result screen comes back as it was - with "Run deep analysis with AI" for a user who is now signed in. A memory store stands in for
// IndexedDB here (its own round trip is in pendingLearn.test.ts).
import type { Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore, storeFile, type PendingLearn, type PendingLearnStore } from '../src/app/pendingLearn';
import { ordersRules } from '../src/editor/testkit';
import { webConfig } from '../src/config';
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
  setPendingStore(undefined);
});

/** What the local analysis gives for the orders example: three columns built, two for the AI step, one with no trace in the input (it needs the AI step too). */
function localRules(): Rules {
  const rules = ordersRules();
  rules.output.columns = rules.output.columns.map((c) => (c.header === 'Total' || c.header === 'Shipped' ? { header: c.header, from: null } : c));
  rules.unsupported = [];
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
  needsAiParts: ['sort' as const],
};

const partialOutput = () => learnResult({ path: 'partial', rules: localRules(), partial: PARTIAL, readiness: { ready: true } });

/** The record the app keeps just before it leaves: the two files, and the result screen as the user left it. */
async function kept(over: Partial<PendingLearn> = {}): Promise<PendingLearn> {
  const edited = localRules();
  edited.output.columns = edited.output.columns.map((c) => (c.header === 'Item' ? { ...c, header: 'SKU' } : c));
  return {
    version: 1,
    savedAt: Date.now(),
    path: '/result',
    input: await storeFile(csv('orders.csv', 'a,b\n1,2\n')),
    output: await storeFile(csv('Orders report.csv', 'x\n1\n')),
    masking: false,
    result: { name: 'My orders', rules: edited, edited: ['col:SKU'], exceptions: [5] },
    ...over,
  };
}

describe('coming back after signing in', () => {
  it('re-runs the LOCAL analysis on the kept files, puts the edits back, and shows the Result screen as it was', async () => {
    await store.save(await kept());
    const { engine, learn } = fakeEngine(async () => partialOutput());
    renderApp({ api: fakeApi({ user: USER }), engine, route: '/result' });

    // The screen waits for it (it does not go home meanwhile) ...
    await screen.findByTestId('rules-map');
    // ... the files were read again, with the masking choice kept and the AI step NOT run automatically.
    expect(learn).toHaveBeenCalledTimes(1);
    const args = learn.mock.calls[0]![0] as { input: { name: string; bytes: ArrayBuffer }; output: { name: string }; masking: boolean; ai: string; tier: string };
    expect(args.input.name).toBe('orders.csv');
    expect(new TextDecoder().decode(args.input.bytes)).toBe('a,b\n1,2\n');
    expect(args.output.name).toBe('Orders report.csv');
    expect(args.masking).toBe(false);
    expect(args.ai).toBe('notAllowed');
    expect(args.tier).toBe('registered'); // the tier they signed in with, not "anonymous"

    // The edits are back: the name, the renamed column (still marked edited), the exception.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('My orders');
    const skuLine = document.querySelector('[data-line-id="col:SKU"]') as HTMLElement;
    expect(skuLine).toBeTruthy();
    expect(skuLine.getAttribute('data-status')).toBe('edited');
    expect(document.querySelector('[data-line-id="col:Item"]')).toBeNull();

    // Signed in: no sign-in popup, and "Run deep analysis with AI" is the next click.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run deep analysis with AI' })).toBeTruthy();
    // It is used once: the kept copy is gone.
    expect(await store.load()).toBeNull();
  });

  it('"Run deep analysis with AI" then asks the AI step (allowed) for what is missing, on the kept files', async () => {
    await store.save(await kept());
    const results = [
      partialOutput(),
      learnResult({ path: 'llm', rules: ordersRules(), completion: { columns: [3, 4, 5], parts: ['sort'], fixedProblems: [], matches: true, produced: { columns: 2, parts: 1 } } }),
    ];
    const { engine, learn } = fakeEngine(async () => results.shift()!);
    renderApp({ api: fakeApi({ user: USER }), engine, route: '/result' });
    fireEvent.click(await screen.findByRole('button', { name: 'Run deep analysis with AI' }));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    const second = learn.mock.calls[1]![0] as { input: { name: string }; ai: string; masking: boolean; complete?: { columns: number[] } };
    expect(second).toMatchObject({ ai: 'allowed', masking: false, complete: { columns: [3, 4, 5] } });
    expect(second.input.name).toBe('orders.csv');
    expect(await screen.findByRole('button', { name: 'Save format' })).toBeTruthy();
  });

  it('after a sign-in that was declined the visitor gets the same screen back, and the popup again', async () => {
    await store.save(await kept());
    const { engine } = fakeEngine(async () => partialOutput());
    renderApp({ api: fakeApi(), engine, route: '/result?authError=denied' });
    await screen.findByTestId('rules-map');
    expect(await screen.findByText('You chose not to sign in, so nothing changed.')).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: 'Sign in to finish' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('My orders');
  });

  it('files that were only chosen (nothing learned yet) come back into the two drop zones, and nothing is learned', async () => {
    await store.save(await kept({ path: '/', result: null }));
    const { engine, learn } = fakeEngine();
    renderApp({ api: fakeApi({ user: USER }), engine, route: '/' });
    await waitFor(() => expect(screen.getByText('orders.csv')).toBeTruthy());
    expect(screen.getByText('Orders report.csv')).toBeTruthy();
    expect(learn).not.toHaveBeenCalled();
    expect(await store.load()).toBeNull();
  });

  it('a kept learn older than an hour is dropped, and /result goes home as it always did', async () => {
    await store.save(await kept({ savedAt: Date.now() - webConfig.pendingLearn.maxAgeMs - 60_000 }));
    const { engine, learn } = fakeEngine();
    renderApp({ api: fakeApi({ user: USER }), engine, route: '/result' });
    expect(await screen.findByRole('heading', { name: 'Show us one example' })).toBeTruthy();
    expect(learn).not.toHaveBeenCalled();
    expect(await store.load()).toBeNull();
    expect(screen.queryByText('orders.csv')).toBeNull();
  });

  it('a kept learn that cannot be analysed any more ends on Home, not on a spinner', async () => {
    await store.save(await kept());
    const { engine } = fakeEngine(async () => Promise.reject(new Error('boom')));
    renderApp({ api: fakeApi({ user: USER }), engine, route: '/result' });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(await screen.findByRole('heading', { name: /Show us one example|Learning your format/ })).toBeTruthy();
    expect(screen.queryByTestId('rules-map')).toBeNull();
  });

  it('nothing kept: a bare /result goes home at once', async () => {
    renderApp({ api: fakeApi({ user: USER }), route: '/result' });
    expect(await screen.findByRole('heading', { name: 'Show us one example' })).toBeTruthy();
  });
});

describe('the whole trip: learn, sign in, come back', () => {
  it('what the visitor edited before signing in is what the signed-in user gets back', async () => {
    // 1. A visitor learns (locally) and edits the map: renames a column and the format.
    const first = fakeEngine(async () => partialOutput());
    const before = renderApp({ api: fakeApi(), engine: first.engine });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv', 'a,b\n1,2\n')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv', 'x\n1\n')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
    });
    await screen.findByTestId('rules-map');
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));

    const supplierLine = document.querySelector('[data-line-id="col:Supplier"] .map-line__main') as HTMLElement;
    fireEvent.click(supplierLine);
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Vendor' } });
    await waitFor(() => expect(document.querySelector('[data-line-id="col:Vendor"]')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Rename Orders report/ }));
    const nameField = screen.getByLabelText('Format name');
    fireEvent.change(nameField, { target: { value: 'Vendor orders' } });
    fireEvent.keyDown(nameField, { key: 'Enter' });

    // 2. They sign in: the browser keeps it and leaves.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in free to finish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to finish' });
    await act(async () => {
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue with Google' }));
    });
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith('/api/auth/google/start?returnTo=%2Fresult'));
    const record = await store.load();
    expect(record!.result!.name).toBe('Vendor orders');
    expect(record!.result!.rules.output.columns.map((c) => c.header)).toContain('Vendor');
    expect(record!.result!.edited).toContain('col:Vendor');
    expect(record!.input!.name).toBe('orders.csv');
    before.unmount();

    // 3. The app starts again (the page was reloaded after the provider), now signed in.
    const second = fakeEngine(async () => partialOutput());
    renderApp({ api: fakeApi({ user: USER }), engine: second.engine, route: '/result' });
    await screen.findByTestId('rules-map');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Vendor orders');
    expect(document.querySelector('[data-line-id="col:Vendor"]')).toBeTruthy();
    expect(document.querySelector('[data-line-id="col:Supplier"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run deep analysis with AI' })).toBeTruthy();
  });
});
