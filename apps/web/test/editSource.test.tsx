// Editing a saved source (SPEC 8.11, 8.12): the rules open in the same map and editor WITHOUT an example (files are never stored);
// the live counter says to drop the example files, which is optional; an edit of the output side is said to be a change to the
// format for all its sources before saving, and after saving the sources that now need review are listed; saving writes a new
// version; every version can be restored. A fake API and a fake worker.
import type { LearnResult, Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { ordersRules } from '../src/editor/testkit';
import { safeReturnTo } from '../src/pages/Format/returnTo';
import { conversionDetail, conversionSummary, getFormatResponse } from './helpers/registryKit';
import { csv, fakeApi, fakeEngine, liveResult, renderApp, USER } from './helpers/renderApp';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPendingStore(undefined);
});

const ROUTE = '/formats/F1/sources/C1';

/** The orders rules without their external column, so nothing in them "needs your input". */
function cleanRules(): Rules {
  const rules = ordersRules();
  rules.output.columns = rules.output.columns.filter((c) => c.header !== 'Remarks');
  rules.unsupported = [];
  return rules;
}

const three = getFormatResponse({
  id: 'F1',
  name: 'Orders report',
  sources: [conversionSummary({ id: 'C1', sourceName: 'Supplier A' }), conversionSummary({ id: 'C2', sourceName: 'Supplier B' }), conversionSummary({ id: 'C3', sourceName: 'Supplier C' })],
});

function apiFor(over: Record<string, unknown> = {}, format = three) {
  return fakeApi({
    user: USER,
    registry: {
      getConversion: vi.fn(async () => conversionDetail({ id: 'C1', version: 4, sourceName: 'Supplier A' }, cleanRules())),
      getFormat: vi.fn(async () => format),
      versions: vi.fn(async () => [
        { version: 4, at: '2026-09-01T10:00:00.000Z', status: 'verified' as const, acceptedDifferences: 0, current: true },
        { version: 3, at: '2026-08-20T10:00:00.000Z', status: 'differencesAccepted' as const, acceptedDifferences: 2, current: false },
      ]),
      updateConversion: vi.fn(async () => ({ conversion: conversionSummary({ id: 'C1', version: 5 }), formatChanged: false, affectedSources: 0, needsReview: [] })),
      restore: vi.fn(async () => conversionSummary({ id: 'C1', version: 5 })),
      ...over,
    },
  });
}

const line = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-line-id="${id}"]`);
  if (!el) throw new Error(`no line ${id}: ${[...document.querySelectorAll('[data-line-id]')].map((e) => e.getAttribute('data-line-id')).join(', ')}`);
  return el as HTMLElement;
};
const openLine = (id: string): void => {
  fireEvent.click(within(line(id)).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
};
const strip = (): string => screen.getByTestId('live-check-text').textContent ?? '';

async function openEditor(api = apiFor(), engine = fakeEngine().engine, route = ROUTE) {
  renderApp({ api, engine, route });
  await screen.findByTestId('rules-map');
  await waitFor(() => expect(screen.getByTestId('live-check-text')).toBeTruthy());
  return { api, engine };
}

describe('opening a saved source', () => {
  it('shows its rules with no example: the counter says to drop the example files, and there is nothing to save yet', async () => {
    const { engine } = await openEditor();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Supplier A');
    expect(screen.getByText('A source of "Orders report". We do not keep your files.')).toBeTruthy();
    await waitFor(() => expect(strip()).toBe('Drop your example files to check against them'));
    expect(screen.getByTestId('status-badge').textContent).toBe('Not checked against an example');
    // The rules map works as ever, and is honest that nothing was compared.
    expect(line('col:Item').getAttribute('data-status')).toBe('matches');
    expect(within(line('col:Item')).getByRole('img', { name: 'No problem found (not compared with an example)' })).toBeTruthy();
    // Only the static checks ran (no example to compare rows with).
    expect(engine.staticChecks).toHaveBeenCalled();
    expect(engine.liveCheck).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('No changes to save.')).toBeTruthy();
    // The optional drop zone
    expect(screen.getByTestId('example-drop')).toBeTruthy();
    expect(screen.getByLabelText('Example input')).toBeTruthy();
  });

  it('shows versions, newest first, with the current one marked', async () => {
    await openEditor();
    const versions = await screen.findByTestId('versions');
    await waitFor(() => expect(within(versions).getByText('Version 4')).toBeTruthy());
    expect(within(versions).getByText('Current')).toBeTruthy();
    expect(within(versions).getByText('2 differences')).toBeTruthy();
    expect(within(versions).getAllByRole('button', { name: 'Restore' })).toHaveLength(1);
  });

  it('a source that is not there says so', async () => {
    const api = apiFor({ getConversion: vi.fn(async () => Promise.reject(new ApiError('notFound', 404))) });
    renderApp({ api, route: ROUTE });
    expect(await screen.findByText("We couldn't find this format. It may have been deleted.")).toBeTruthy();
  });

  it('a visitor is asked to sign in', async () => {
    const api = fakeApi();
    renderApp({ api, route: ROUTE });
    expect(await screen.findByText('Sign in to see your saved formats.')).toBeTruthy();
    expect(api.registry.getConversion).not.toHaveBeenCalled();
  });
});

describe('an edit that changes the format (the output side)', () => {
  it('says "This changes the format for all N sources" BEFORE saving, once', async () => {
    await openEditor();
    openLine('col:Total');
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Grand total' } });
    await waitFor(() => line('col:Grand total'));
    const warnings = screen.getAllByText('This changes the format for all 3 sources.');
    expect(warnings).toHaveLength(1);
    expect(screen.getByTestId('format-change-warning')).toBeTruthy();
  });

  it('is not blocked by the format lock (an edit of the output side IS an edit of the format), and saves a new version', async () => {
    const updateConversion = vi.fn(async () => ({ conversion: conversionSummary({ id: 'C1', version: 5 }), formatChanged: true, affectedSources: 2, needsReview: [] }));
    const { engine } = await openEditor(apiFor({ updateConversion }));
    openLine('col:Total');
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Grand total' } });
    await waitFor(() => line('col:Grand total'));
    // The checks are asked WITHOUT the format: no lock to trip over.
    const asked = (engine.staticChecks as ReturnType<typeof vi.fn>).mock.calls as unknown as [unknown, Record<string, unknown>][];
    expect(asked.length).toBeGreaterThan(0);
    for (const [, options] of asked) expect(options).not.toHaveProperty('format');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateConversion).toHaveBeenCalledTimes(1));
    const [id, body] = updateConversion.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(id).toBe('C1');
    // No example, so the rules are the user's word ("confirmed"), never "verified".
    expect(body).toMatchObject({ status: 'userConfirmed', acceptedDifferences: 0, exampleExceptions: [], baseVersion: 4 });
    expect((body.rules as Rules).output.columns.map((c) => c.header)).toContain('Grand total');

    // And afterwards: which version, and who else the change reached.
    expect(await screen.findByText('Saved as version 5.')).toBeTruthy();
    expect(screen.getByText('The format changed, and the change reached 2 other sources.')).toBeTruthy();
  });

  it('lists the sources that now need review, each a link to its rules', async () => {
    const updateConversion = vi.fn(async () => ({
      conversion: conversionSummary({ id: 'C1', version: 5 }),
      formatChanged: true,
      affectedSources: 2,
      needsReview: [
        { id: 'C2', sourceName: 'Supplier B' },
        { id: 'C3', sourceName: 'Supplier C' },
      ],
    }));
    await openEditor(apiFor({ updateConversion }));
    openLine('col:Total');
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Grand total' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const notice = await screen.findByTestId('saved-notice');
    expect(within(notice).getByText('2 sources need review')).toBeTruthy();
    expect(within(notice).getByText(/Their columns no longer line up with the format/)).toBeTruthy();
    expect(within(notice).getByRole('link', { name: 'Supplier B' }).getAttribute('href')).toBe('/formats/F1/sources/C2');
    expect(within(notice).getByRole('link', { name: 'Supplier C' }).getAttribute('href')).toBe('/formats/F1/sources/C3');
  });

  it('an edit that keeps to the source (a new filter) has no format warning, and says nothing about other sources afterwards', async () => {
    const updateConversion = vi.fn(async () => ({ conversion: conversionSummary({ id: 'C1', version: 5 }), formatChanged: false, affectedSources: 0, needsReview: [] }));
    await openEditor(apiFor({ updateConversion }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));
    await waitFor(() => expect(line('filter:2')).toBeTruthy());
    expect(screen.queryByTestId('format-change-warning')).toBeNull();
    expect(screen.queryByText(/This changes the format/)).toBeNull();

    await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved as version 5.')).toBeTruthy();
    expect(screen.queryByText(/The format changed/)).toBeNull();
    // Saved: nothing newer to save.
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a save that lost to another edit says so and offers to reload', async () => {
    const updateConversion = vi.fn(async () => Promise.reject(new ApiError('versionConflict', 409)));
    const api = apiFor({ updateConversion });
    await openEditor(api);
    fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This source was changed somewhere else in the meantime. Reload it and try again.')).toBeTruthy();
    const before = (api.registry.getConversion as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect((api.registry.getConversion as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before));
  });

  it('a limit on the rules of a format is told with Upgrade', async () => {
    const updateConversion = vi.fn(async () => Promise.reject(new ApiError('limitHit', 403, { limit: 'rulesPerFormat' })));
    await openEditor(apiFor({ updateConversion }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This format has more rules than your plan allows. Simplify it, or upgrade.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeTruthy();
  });
});

describe('the optional example', () => {
  const dropExample = async (): Promise<void> => {
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  };

  it('reading the two files turns the live check on (with the format as the target), and a matching example makes a save "verified"', async () => {
    const liveCheck = vi.fn(async (_id: string, _r: LearnResult | Rules) => liveResult({ matched: 30, total: 30 }));
    const fullCheck = vi.fn(async () => liveResult({ matched: 30, total: 30 }));
    const updateConversion = vi.fn(async () => ({ conversion: conversionSummary({ id: 'C1', version: 5 }), formatChanged: false, affectedSources: 0, needsReview: [] }));
    const { engine } = await openEditor(apiFor({ updateConversion }), fakeEngine(undefined, undefined, { liveCheck, fullCheck }).engine);
    await dropExample();
    fireEvent.click(screen.getByRole('button', { name: 'Check against these files' }));

    await waitFor(() => expect(engine.loadExample).toHaveBeenCalledTimes(1));
    const args = (engine.loadExample as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { input: { name: string }; output: { name: string }; target: { output: unknown } };
    expect(args.input.name).toBe('orders.csv');
    expect(args.output.name).toBe('report.csv');
    expect(args.target.output).toBeTruthy();

    await waitFor(() => expect(liveCheck).toHaveBeenCalled());
    expect(liveCheck.mock.calls[0]![0]).toBe('ex-loaded');
    await waitFor(() => expect(strip()).toBe('Matches 30 of 30 rows in your example'));
    // The zone has done its job.
    expect(screen.queryByTestId('example-drop')).toBeNull();
    expect(screen.getByTestId('status-badge').textContent).toContain('Verified');

    fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateConversion).toHaveBeenCalled());
    expect((updateConversion.mock.calls[0] as unknown as [string, { status: string }])[1].status).toBe('verified');
  });

  it('two files that do not belong together are told so, and the zone stays', async () => {
    const engine = fakeEngine(undefined, undefined, { loadExample: vi.fn(async () => ({ ok: false, reason: 'analysisFailed' })) }).engine;
    await openEditor(apiFor(), engine);
    await dropExample();
    fireEvent.click(screen.getByRole('button', { name: 'Check against these files' }));
    expect(await screen.findByText("We couldn't compare these two files. Check that the output was made from this input.")).toBeTruthy();
    expect(screen.getByTestId('example-drop')).toBeTruthy();
    expect(strip()).toBe('Drop your example files to check against them');
  });
});

describe('versions', () => {
  it('restores an earlier version as a new one, and opens the editor on it', async () => {
    const restore = vi.fn(async () => conversionSummary({ id: 'C1', version: 5 }));
    const getConversion = vi
      .fn()
      .mockResolvedValueOnce(conversionDetail({ id: 'C1', version: 4, sourceName: 'Supplier A' }, cleanRules()))
      .mockResolvedValue(conversionDetail({ id: 'C1', version: 5, sourceName: 'Supplier A' }, cleanRules()));
    await openEditor(apiFor({ restore, getConversion }));
    const versions = await screen.findByTestId('versions');
    fireEvent.click(await within(versions).findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('C1', 3));
    await waitFor(() => expect(getConversion).toHaveBeenCalledTimes(2));
    await screen.findByTestId('rules-map');
  });

  it('a version from before a change to the format is refused in words', async () => {
    const restore = vi.fn(async () => Promise.reject(new ApiError('formatMismatch', 422)));
    await openEditor(apiFor({ restore }));
    const versions = await screen.findByTestId('versions');
    fireEvent.click(await within(versions).findByRole('button', { name: 'Restore' }));
    expect(await within(versions).findByText(/That version is from before the format changed/)).toBeTruthy();
  });
});

describe('the way back to converting', () => {
  const back = '/convert?resume=1&format=F1';
  const route = `${ROUTE}?returnTo=${encodeURIComponent(back)}`;

  it('is a link to the address Convert gave, and after a save it is the main action', async () => {
    await openEditor(apiFor(), undefined, route);
    expect(screen.getByTestId('back-to-convert').getAttribute('href')).toBe(back);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Saved as version 5.');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
    const links = screen.getAllByRole('link', { name: 'Back to converting' });
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) expect(link.getAttribute('href')).toBe(back);
  });

  it('is not there without one, and never follows an address that could leave the site', async () => {
    await openEditor(apiFor(), undefined, ROUTE);
    expect(screen.queryByTestId('back-to-convert')).toBeNull();
    cleanup();
    await openEditor(apiFor(), undefined, `${ROUTE}?returnTo=${encodeURIComponent('https://evil.example/convert')}`);
    expect(screen.queryByTestId('back-to-convert')).toBeNull();
  });

  it('safeReturnTo accepts a same-site path and nothing else', () => {
    expect(safeReturnTo('/convert?resume=1')).toBe('/convert?resume=1');
    expect(safeReturnTo('/formats/F1')).toBe('/formats/F1');
    for (const bad of [null, undefined, '', 'convert', 'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/a\nb', `/${'x'.repeat(600)}`, 'http:/x']) {
      expect(safeReturnTo(bad as string | null)).toBeNull();
    }
  });
});

describe('in Hebrew', () => {
  it('the same screen, right to left', async () => {
    renderApp({ api: apiFor(), route: ROUTE, lang: 'he' });
    await screen.findByTestId('rules-map');
    expect(screen.getByTestId('app').getAttribute('dir')).toBe('rtl');
    await waitFor(() => expect(strip()).toBe('העלו את קבצי הדוגמה כדי לבדוק מולם'));
    expect(screen.getByRole('button', { name: 'שמירת השינויים' })).toBeTruthy();
    void act;
  });
});
