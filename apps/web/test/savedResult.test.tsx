// The Result screen after the first save (SPEC 8.11 "Saving", 8.12): the SAME screen becomes the editor of the saved source - the
// example files stay in the worker for the live check, the header says it is saved, "Save changes" writes a new version
// (PATCH /api/conversions/:id) with the format-change warning when the output side changes, "Unsaved changes" and the leave guard
// are back on, and the address is the source's own. A fake API and a fake worker.
import type { Rules } from '@formatai/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { resumeLeaveGuard } from '../src/app/unloadPrompt';
import { ordersRules } from '../src/editor/testkit';
import { conversionDetail, conversionSummary, formatSummary, getFormatResponse } from './helpers/registryKit';
import { fakeApi, USER } from './helpers/renderApp';
import { line, openLine, openResult, strip } from './helpers/resultKit';

const { downloaded } = vi.hoisted(() => ({ downloaded: vi.fn() }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resumeLeaveGuard();
});

const SUMMARY = { rowsIn: 30, rowsOut: 30, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] };
const converted = { ok: true, bytes: new ArrayBuffer(8), flags: [], summary: SUMMARY, preview: { name: 'Out', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] }, totalRows: 30 };
const created = { format: formatSummary({ id: 'F1', name: 'Orders report' }), conversion: conversionSummary({ id: 'C1', formatId: 'F1', sourceName: 'Source 1', version: 1 }) };
const patched = (over: Record<string, unknown> = {}) => ({ conversion: conversionSummary({ id: 'C1', version: 2 }), formatChanged: false, affectedSources: 0, needsReview: [], ...over });

/** How many row filters the orders rules start with. */
const FILTERS = ordersRules().input.rowFilters?.length ?? 0;
const flag = (): string => screen.getByTestId('unsaved-changes').textContent ?? '';
const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
const enabled = (name: string): void => expect(button(name).disabled).toBe(false);

/** Learns, waits for the rules to be saveable, and (unless `edit` is given) saves them: the screen is then the saved source's editor. */
async function openSaved(over: Record<string, unknown> = {}, edit?: () => Promise<void>) {
  const createFormat = vi.fn(async () => created);
  const updateConversion = vi.fn(async () => patched());
  const api = fakeApi({ user: USER, registry: { createFormat, updateConversion, ...over } });
  const ctx = await openResult({ api, convert: converted, dataRouter: true });
  await waitFor(() => enabled('Save format and download'));
  await edit?.();
  await waitFor(() => enabled('Save format and download'));
  fireEvent.click(button('Save format and download'));
  await screen.findByRole('button', { name: 'Save changes' });
  return { ...ctx, createFormat, updateConversion, api };
}

const renameTotal = async (to = 'Grand total'): Promise<void> => {
  openLine('col:Total');
  fireEvent.change(screen.getByLabelText('Column name'), { target: { value: to } });
  await waitFor(() => line(`col:${to}`));
};
const addFilter = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));
  await waitFor(() => expect(document.querySelector('[data-line-id="filter:2"]')).toBeTruthy());
};
const asked = (mock: ReturnType<typeof vi.fn>, at = 0): Record<string, unknown> => (mock.mock.calls[at] as unknown as [string, Record<string, unknown>])[1];

describe('after the first save', () => {
  it('the header becomes the saved source\'s: the format name, "Saved" + the source name, Save changes (nothing to save yet) and Download', async () => {
    await openSaved();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Orders report');
    // The name is saved with the format: no longer renamed in place here.
    expect(screen.queryByRole('button', { name: /Rename/ })).toBeNull();
    expect(screen.getByText('Saved as the source "Source 1". We do not keep your files.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save format and download' })).toBeNull();
    expect(button('Save changes').disabled).toBe(true);
    expect(screen.getByText('No changes to save.')).toBeTruthy();
    expect(button('Download')).toBeTruthy();
    expect(flag()).toBe('');
    // What the first save said stays, with the way to My formats.
    expect(await screen.findByText('Saved. "Orders report" is in My formats, and your file is downloading.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open My formats' })).toBeTruthy();
    expect(screen.getByTestId('versions')).toBeTruthy();
  });

  it('the address becomes the source\'s own - even with edits pending, without asking to leave - and the same screen stays (no example lost, no reload from the server)', async () => {
    const { router, api, liveCheck } = await openSaved({}, async () => {
      await renameTotal();
      await waitFor(() => expect(flag()).toBe('Unsaved changes'));
    });
    await waitFor(() => expect(router!.state.location.pathname).toBe('/formats/F1/sources/C1'));
    expect(screen.queryByRole('dialog')).toBeNull();
    // The rules map is the one that was on screen (the edit is still there), not a saved-source editor built from the server.
    expect(line('col:Grand total')).toBeTruthy();
    expect(api.registry.getConversion).not.toHaveBeenCalled();
    expect(api.registry.getFormat).not.toHaveBeenCalled();
    // The example is still in the worker: the live check answers (the drop zone of a saved source is not here).
    expect(screen.queryByTestId('example-drop')).toBeNull();
    expect(strip()).toMatch(/^Matches \d+ of \d+ rows in your example$/);
    expect(flag()).toBe('');
    expect(liveCheck).toHaveBeenCalled();
    expect(liveCheck.mock.calls.every((c) => c[0] === 'ex1')).toBe(true);
  });

  it('an edit says "Unsaved changes"; Save changes PATCHes the source with the rules and the version it is based on, and clears it', async () => {
    const { updateConversion, createFormat, liveCheck } = await openSaved();
    const before = liveCheck.mock.calls.length;
    await addFilter();
    await waitFor(() => expect(flag()).toBe('Unsaved changes'));
    // The example is still what the live check reads.
    await waitFor(() => expect(liveCheck.mock.calls.length).toBeGreaterThan(before));
    expect(liveCheck.mock.calls.at(-1)![0]).toBe('ex1');
    expect(document.querySelectorAll('.btn--primary')).toHaveLength(1);
    expect(button('Save changes').classList.contains('btn--primary')).toBe(true);
    expect(screen.queryByTestId('format-change-warning')).toBeNull();

    await waitFor(() => enabled('Save changes'));
    fireEvent.click(button('Save changes'));
    await waitFor(() => expect(updateConversion).toHaveBeenCalledTimes(1));
    const [id, body] = updateConversion.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(id).toBe('C1');
    // (the orders rules have a column that needs the user's input: "confirmed", as in the saved-source editor)
    expect(body).toMatchObject({ status: 'userConfirmed', acceptedDifferences: 0, exampleExceptions: [], baseVersion: 1 });
    // The body is the rules as edited (the new filter), not the ones that were first saved.
    expect((body.rules as Rules).input.rowFilters).toHaveLength(FILTERS + 1);
    expect(createFormat).toHaveBeenCalledTimes(1);

    expect(await screen.findByText('Saved as version 2.')).toBeTruthy();
    // The first save's message has done its job.
    expect(screen.queryByText(/is in My formats, and your file is downloading/)).toBeNull();
    await waitFor(() => expect(flag()).toBe(''));
    expect(button('Save changes').disabled).toBe(true);

    // The next save is based on the version just written.
    await addFilterAgain();
    await waitFor(() => enabled('Save changes'));
    fireEvent.click(button('Save changes'));
    await waitFor(() => expect(updateConversion).toHaveBeenCalledTimes(2));
    expect(asked(updateConversion, 1)).toMatchObject({ baseVersion: 2 });
  });

  it('a change to the output side says it changes the format BEFORE saving (once), and what it reached afterwards', async () => {
    const updateConversion = vi.fn(async () => patched({ formatChanged: true }));
    await openSaved({ updateConversion });
    expect(screen.queryByTestId('format-change-warning')).toBeNull();
    await renameTotal();
    const warnings = screen.getAllByText('This changes the format for its source.');
    expect(warnings).toHaveLength(1);
    expect(screen.getByTestId('format-change-warning')).toBeTruthy();
    await waitFor(() => enabled('Save changes'));
    fireEvent.click(button('Save changes'));
    await waitFor(() => expect(updateConversion).toHaveBeenCalledTimes(1));
    expect(((updateConversion.mock.calls[0] as unknown as [string, { rules: Rules }])[1].rules).output.columns.map((c) => c.header)).toContain('Grand total');
    expect(await screen.findByText('The format changed. It has no other sources.')).toBeTruthy();
    // Written: nothing left to warn about.
    await waitFor(() => expect(screen.queryByTestId('format-change-warning')).toBeNull());
  });

  it('an edit that keeps to the source (a new filter) has no format warning', async () => {
    await openSaved();
    await addFilter();
    expect(screen.queryByTestId('format-change-warning')).toBeNull();
    expect(screen.queryByText(/This changes the format/)).toBeNull();
  });

  it('asks before leaving with further edits (a link, the back button), and not once they are saved', async () => {
    await openSaved();
    await addFilter();
    fireEvent.click(screen.getByRole('link', { name: 'Privacy' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByTestId('rules-map')).toBeTruthy();

    await waitFor(() => enabled('Save changes'));
    fireEvent.click(button('Save changes'));
    await screen.findByText('Saved as version 2.');
    await waitFor(() => expect(flag()).toBe(''));
    fireEvent.click(screen.getByRole('link', { name: 'Privacy' }));
    await waitFor(() => expect(screen.queryByTestId('rules-map')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closing the tab asks too, while there is something unsaved', async () => {
    await openSaved();
    const closeTab = (): boolean => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(closeTab()).toBe(false);
    await addFilter();
    await waitFor(() => expect(flag()).toBe('Unsaved changes'));
    expect(closeTab()).toBe(true);
  });

  it('a save that lost to another edit says so, and Reload opens the source as the server has it (same screen, example kept)', async () => {
    const updateConversion = vi.fn<() => Promise<unknown>>(async () => Promise.reject(new ApiError('versionConflict', 409)));
    const server = ordersRules();
    server.output.columns = server.output.columns.filter((c) => c.header !== 'Remarks');
    const getConversion = vi.fn(async () => conversionDetail({ id: 'C1', version: 7, sourceName: 'Source 1' }, server));
    const getFormat = vi.fn(async () => getFormatResponse({ id: 'F1', name: 'Orders report' }));
    const { liveCheck } = await openSaved({ updateConversion, getConversion, getFormat });
    await addFilter();
    await waitFor(() => enabled('Save changes'));
    fireEvent.click(button('Save changes'));
    expect(await screen.findByText('This source was changed somewhere else in the meantime. Reload it and try again.')).toBeTruthy();
    const calls = liveCheck.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(getConversion).toHaveBeenCalledWith('C1'));
    await waitFor(() => expect(screen.queryByText(/changed somewhere else/)).toBeNull());
    expect(document.querySelector('[data-line-id="filter:2"]')).toBeNull();
    expect(flag()).toBe('');
    await waitFor(() => expect(liveCheck.mock.calls.length).toBeGreaterThan(calls));
    expect(liveCheck.mock.calls.at(-1)![0]).toBe('ex1');
    // The next save is based on the version the server has now.
    await addFilter();
    await waitFor(() => enabled('Save changes'));
    updateConversion.mockImplementationOnce(async () => patched({ conversion: conversionSummary({ id: 'C1', version: 8 }) }));
    fireEvent.click(button('Save changes'));
    await waitFor(() => expect(updateConversion).toHaveBeenCalledTimes(2));
    expect(asked(updateConversion, 1)).toMatchObject({ baseVersion: 7 });
  });

  it('a refusal of the new version (a plan limit) is told with Upgrade, and the edits stay', async () => {
    const updateConversion = vi.fn(async () => Promise.reject(new ApiError('limitHit', 403, { limit: 'rulesPerFormat' })));
    await openSaved({ updateConversion });
    await addFilter();
    await waitFor(() => enabled('Save changes'));
    fireEvent.click(button('Save changes'));
    expect(await screen.findByText('This format has more rules than your plan allows. Simplify it, or upgrade.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeTruthy();
    expect(flag()).toBe('Unsaved changes');
  });
});

describe('Download after saving', () => {
  it('stays available: the example input converted with the rules as they are on screen, saved edits or not', async () => {
    const { convert } = await openSaved();
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
    await addFilter();
    await waitFor(() => enabled('Download'));
    fireEvent.click(button('Download'));
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(2));
    const full = convert.mock.calls.filter((c) => (c as unknown as [{ previewRows: number }])[0].previewRows === 0);
    expect(full).toHaveLength(2);
    // The second file was made with the new filter.
    expect((full[1] as unknown as [{ rules: Rules }])[0].rules.input.rowFilters).toHaveLength(FILTERS + 1);
    expect((full[0] as unknown as [{ rules: Rules }])[0].rules.input.rowFilters ?? []).toHaveLength(FILTERS);
    expect(downloaded.mock.calls[1]![0]).toBe('orders (converted).xlsx');
  });

  it('a file that cannot be made says so, and Download can be tried again', async () => {
    const { convert } = await openSaved();
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
    (convert as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ ok: false, error: { code: 'noTable' } }));
    fireEvent.click(button('Download'));
    expect(await screen.findByText("We couldn't prepare the file. Try again.")).toBeTruthy();
    expect(downloaded).toHaveBeenCalledTimes(1);
  });
});

describe('Start over from the saved screen', () => {
  it('goes home and forgets the learn - without opening the saved source\'s plain editor on the way', async () => {
    const { api, router } = await openSaved();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(await screen.findByRole('button', { name: /Learn the format/ })).toBeTruthy();
    expect(router!.state.location.pathname).toBe('/');
    expect(screen.queryByTestId('rules-map')).toBeNull();
    expect(api.registry.getConversion).not.toHaveBeenCalled();
  });

  it('asks first when there are unsaved edits (and Keep editing stays)', async () => {
    const { router } = await openSaved();
    await addFilter();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByTestId('rules-map')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', { name: 'Leave without saving' }));
    expect(await screen.findByRole('button', { name: /Learn the format/ })).toBeTruthy();
    expect(router!.state.location.pathname).toBe('/');
    // (no second question from the guard)
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('a visitor', () => {
  it('cannot save: the first save asks to sign in, and the screen stays the fresh result', async () => {
    const createFormat = vi.fn();
    const api = fakeApi({ registry: { createFormat } });
    const { router } = await openResult({ api, convert: converted, dataRouter: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeTruthy();
    expect(createFormat).not.toHaveBeenCalled();
    expect(router!.state.location.pathname).toBe('/result');
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });
});

// (declared last: it needs `addFilter`'s counterpart for the second filter)
async function addFilterAgain(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));
  await waitFor(() => expect(document.querySelector('[data-line-id="filter:3"]')).toBeTruthy());
}
