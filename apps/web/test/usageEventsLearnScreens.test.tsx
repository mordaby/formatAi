// The usage events of the learn screens and the shell (SPEC 14.1; owner decision 2026-10-08): a page was viewed (`page_view`, by route NAME), a file
// was dropped or turned away (`file_uploaded`, `file_rejected`), how a learn ended (`learn_completed`, seen from the real screen), the sign-in
// wall appeared (`signin_wall_shown` with its trigger) and the learn result was downloaded (`download` learnResult). A fake worker and a fake
// API; the events are read from the fake emitter. Counts and codes only - and the last test holds that no file name or header is in any of them.
import { CLIENT_EVENT_TYPES, parseEvent } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { csv, fakeApi, fakeEngine, learnResult, renderApp, tracked, USER, type FakeApi } from './helpers/renderApp';

const { downloaded } = vi.hoisted(() => ({ downloaded: vi.fn() }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));
vi.mock('../src/app/redirect', () => ({ redirectTo: vi.fn(), openInNewTab: vi.fn() }));

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPendingStore(undefined);
});

const SUMMARY = { rowsIn: 3, rowsOut: 3, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] };
const converted = (): unknown => ({ ok: true, bytes: new ArrayBuffer(8), flags: [], summary: SUMMARY, preview: { name: 'Out', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] }, totalRows: 3 });

const events = (api: FakeApi, type: string): Record<string, unknown>[] => tracked(api).filter(([t]) => t === type).map(([, p]) => p);

/** Home with a fake worker: drops the two example files and learns; resolves once the Result screen shows. */
async function openResult(api: FakeApi, result: Record<string, unknown> = {}) {
  const { engine } = fakeEngine(async () => learnResult({ path: 'local', ...result }), undefined, { convert: vi.fn(async () => converted()) });
  const view = renderApp({ engine, api });
  fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('Secret orders.csv')] } });
  fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Secret report.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
  });
  await screen.findByTestId('rules-map');
  await waitFor(() => expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(false));
  return view;
}

describe('page_view', () => {
  it('the learn page is "home"; the result is "learn" - names of routes, never paths', async () => {
    const api = fakeApi();
    await openResult(api);
    expect(events(api, 'page_view')).toEqual([{ page: 'home' }, { page: 'learn' }]);
  });

  it.each([
    ['/', 'home'],
    ['/formats', 'formats'],
    ['/formats/65f0c2a1b3d4e5f607182930', 'format'],
    ['/convert', 'convert'],
    ['/convert?format=65f0c2a1b3d4e5f607182930', 'convert'],
    ['/business', 'business'],
    ['/privacy', 'privacy'],
    ['/terms', 'terms'],
    ['/accessibility', 'accessibility'],
    ['/admin', 'admin'],
  ])("%s is %s - the route's name, with no id or query in it", async (route, page) => {
    // (a visitor: the account pages meet their sign-in wall, and no screen asks the API for anything)
    const api = fakeApi();
    renderApp({ api, route });
    await waitFor(() => expect(events(api, 'page_view')[0]).toEqual({ page }));
    expect(JSON.stringify(events(api, 'page_view'))).not.toMatch(/65f0c2a1|format=/);
  });

  it('an address that is none of ours goes home and says so once, not twice', async () => {
    const api = fakeApi();
    renderApp({ api, route: '/no/such/page' });
    await waitFor(() => expect(events(api, 'page_view').length).toBeGreaterThan(0));
    expect(events(api, 'page_view')).toEqual([{ page: 'other' }, { page: 'home' }]);
  });
});

describe('files at the learn form', () => {
  it('a file dropped: file_uploaded by side, with its type, rows and columns from the worker - not its name', async () => {
    const api = fakeApi();
    renderApp({ api });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('Secret orders.csv')] } });
    await waitFor(() => expect(events(api, 'file_uploaded')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Secret report.csv')] } });
    await waitFor(() => expect(events(api, 'file_uploaded')).toHaveLength(2));
    expect(events(api, 'file_uploaded')).toEqual([
      { role: 'input', fileType: 'csv', rows: 1204, cols: 8 },
      { role: 'output', fileType: 'csv', rows: 1204, cols: 8 },
    ]);
  });

  it('coming back to the form with the same files does not count them again', async () => {
    const api = fakeApi();
    const { engine, inspect } = fakeEngine(async () => learnResult({ path: 'local' }));
    const view = renderApp({ engine, api, dataRouter: true });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
    });
    await screen.findByTestId('rules-map');
    expect(inspect).toHaveBeenCalledTimes(2);
    // back to Home: the form shows the same two files and reads them again for its drop zones ...
    await act(async () => {
      await view.router!.navigate('/');
    });
    await screen.findByLabelText('Example input');
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(4));
    // ... which is not two more uploads
    expect(events(api, 'file_uploaded')).toHaveLength(2);
  });

  it('a file of a type we do not read: file_rejected type, and no upload', async () => {
    const api = fakeApi();
    renderApp({ api });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [new File(['x'], 'Private notes.pdf')] } });
    await waitFor(() => expect(events(api, 'file_rejected')).toEqual([{ reason: 'type' }]));
    expect(events(api, 'file_uploaded')).toEqual([]);
  });

  it('a file the worker cannot read: file_rejected unreadable', async () => {
    const api = fakeApi();
    const { engine } = fakeEngine(async () => learnResult({}), () => ({ readable: false }));
    renderApp({ api, engine });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('broken.csv')] } });
    await waitFor(() => expect(events(api, 'file_rejected')).toEqual([{ reason: 'unreadable' }]));
    expect(events(api, 'file_uploaded')).toEqual([]);
  });

  it('a file with no table in it is uploaded without rows or columns - not as 0', async () => {
    const api = fakeApi();
    const { engine } = fakeEngine(async () => learnResult({}), () => ({ readable: true, rows: null, columns: null, direction: 'ltr' }));
    renderApp({ api, engine });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('empty.csv')] } });
    await waitFor(() => expect(events(api, 'file_uploaded')).toEqual([{ role: 'input', fileType: 'csv' }]));
  });
});

describe('learn_completed from the real screen', () => {
  it('a free learn that verified: once, as local / verified, with the masking switch as it was and no AI click', async () => {
    const api = fakeApi();
    await openResult(api);
    expect(events(api, 'learn_completed')).toEqual([{ path: 'local', status: 'verified', masking: true, aiClicked: false }]);
  });

  it('with masking switched off', async () => {
    const api = fakeApi();
    const { engine } = fakeEngine(async () => learnResult({ path: 'local' }));
    renderApp({ engine, api });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    fireEvent.click(screen.getByRole('switch'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
    });
    await screen.findByTestId('rules-map');
    expect(events(api, 'learn_completed')).toEqual([{ path: 'local', status: 'verified', masking: false, aiClicked: false }]);
  });
});

describe('signin_wall_shown', () => {
  it('a visitor who saves: the wall opens with the save reason - once for the wall, not once per render', async () => {
    const api = fakeApi();
    await openResult(api);
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
    await screen.findByRole('dialog', { name: 'Sign in' });
    expect(events(api, 'signin_wall_shown')).toEqual([{ trigger: 'save' }]);
  });

  it('a visitor who asks for the file: the download reason', async () => {
    const api = fakeApi();
    await openResult(api);
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    await screen.findByRole('dialog', { name: 'Sign in' });
    expect(events(api, 'signin_wall_shown')).toEqual([{ trigger: 'download' }]);
  });

  it('every time it opens: closed and opened again is two, the same open wall asked for again is not', async () => {
    const api = fakeApi();
    await openResult(api);
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    await screen.findByRole('dialog', { name: 'Sign in' });
    expect(events(api, 'signin_wall_shown')).toEqual([{ trigger: 'save' }, { trigger: 'download' }]);
  });

  it('a signed-in user meets no wall and so reports none', async () => {
    const api = fakeApi({ user: USER, registry: { createFormat: vi.fn(async () => Promise.reject(new Error('not reached'))) } });
    await openResult(api);
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    await waitFor(() => expect(downloaded).toHaveBeenCalled());
    expect(events(api, 'signin_wall_shown')).toEqual([]);
  });

  it('a visitor who opens My formats meets the formats wall (a page that asks to sign in)', async () => {
    const api = fakeApi();
    renderApp({ api, route: '/formats' });
    await screen.findByText('Sign in to see your saved formats.');
    expect(events(api, 'signin_wall_shown')).toEqual([{ trigger: 'formats' }]);
  });
});

describe('download: the learn screen\'s file', () => {
  it('a signed-in user who downloads the example converted: download learnResult - once the file was made', async () => {
    const api = fakeApi({ user: USER });
    await openResult(api);
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(events(api, 'download')).toEqual([{ kind: 'learnResult' }]));
  });

  it('a file that could not be made is no download', async () => {
    const api = fakeApi({ user: USER });
    const { engine } = fakeEngine(async () => learnResult({ path: 'local' }), undefined, { convert: vi.fn(async () => ({ ok: false, error: { code: 'noTable' } })) });
    renderApp({ engine, api });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
    });
    await screen.findByTestId('rules-map');
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    await screen.findByText("We couldn't prepare the file. Try again.");
    expect(events(api, 'download')).toEqual([]);
  });
});

describe('what the events hold', () => {
  it('a whole visit - drop, learn, sign-in wall, download - tracks no file name, header or value; every event passes the server\'s strict schema', async () => {
    const visitor = fakeApi();
    await openResult(visitor);
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
    await screen.findByRole('dialog', { name: 'Sign in' });
    cleanup();
    const signedIn = fakeApi({ user: USER });
    await openResult(signedIn);
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    await waitFor(() => expect(downloaded).toHaveBeenCalled());
    await waitFor(() => expect(events(signedIn, 'download')).toHaveLength(1));

    for (const api of [visitor, signedIn]) {
      const all = tracked(api);
      expect(all.length).toBeGreaterThan(4);
      const text = JSON.stringify(all);
      for (const secret of ['Secret', 'orders', 'report', '.csv', 'Name', 'Total', 'Order ID', 'dana@example.com', 'Dana']) expect(text, secret).not.toContain(secret);
      for (const [type, props] of all) expect(parseEvent({ type, props }, CLIENT_EVENT_TYPES), type).not.toBeNull();
    }
    void within;
  });
});
