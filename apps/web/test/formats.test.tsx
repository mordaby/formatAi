// My formats (SPEC 16.1 screen 5), one format and its sources, and Home for a signed-in user who has formats. A fake API.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { conversionSummary, formatSummary, getFormatResponse } from './helpers/registryKit';
import { fakeApi, renderApp, USER } from './helpers/renderApp';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPendingStore(undefined);
});

const cards = (): HTMLElement[] => screen.queryAllByTestId('format-card');

const SUPPLIER = formatSummary({
  id: 'F1',
  name: 'Supplier price list',
  sources: 3,
  statuses: { verified: 2, needsReview: 1 },
  runCount: 12,
  lastRunAt: '2026-09-15T08:30:00.000Z',
  fileType: 'csv',
  outputColumns: 4,
});
const CONTACTS = formatSummary({ id: 'F2', name: 'Contacts export', sources: 1, statuses: { differencesAccepted: 1 }, runCount: 0 });

describe('My formats', () => {
  it('asks a visitor to sign in instead of listing anything', async () => {
    const api = fakeApi();
    renderApp({ api, route: '/formats' });
    expect(await screen.findByText('Sign in to see your saved formats.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeTruthy();
    expect(api.registry.listFormats).not.toHaveBeenCalled();
  });

  it('lists each format with "← N sources", its statuses, its runs and its actions', async () => {
    const api = fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER, CONTACTS]) } });
    renderApp({ api, route: '/formats' });
    await screen.findByTestId('format-list');
    expect(cards()).toHaveLength(2);

    const supplier = cards()[0]!;
    expect(within(supplier).getByRole('heading', { name: 'Supplier price list' })).toBeTruthy();
    expect(supplier.querySelector('.format-card__sources')!.textContent).toBe('←3 sources'); // (the arrow and the count sit in two spans: the space is CSS)
    // What needs a look comes first, in amber; then what is fine.
    expect(within(supplier).getByText('1 need review')).toBeTruthy();
    expect(within(supplier).getByText('2 verified')).toBeTruthy();
    expect(supplier.textContent).toContain('4 columns · csv');
    expect(supplier.textContent).toContain('Run 12 times');
    expect(supplier.textContent).toContain('Last run');

    expect(within(supplier).getByRole('link', { name: 'Convert a file' }).getAttribute('href')).toBe('/convert?format=F1');
    expect(within(supplier).getByRole('link', { name: 'Add a source' }).getAttribute('href')).toBe('/formats/F1/add-source');
    expect(within(supplier).getByRole('link', { name: 'Edit rules' }).getAttribute('href')).toBe('/formats/F1');
    expect(within(supplier).getByRole('button', { name: 'Rename' })).toBeTruthy();
    expect(within(supplier).getByRole('button', { name: 'Delete' })).toBeTruthy();

    const contacts = cards()[1]!;
    expect(contacts.querySelector('.format-card__sources')!.textContent).toBe('←1 source');
    expect(within(contacts).getByText('1 with differences')).toBeTruthy();
    expect(contacts.textContent).toContain('Not run yet');
  });

  it('shows how many of the plan\'s saved formats are used', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER, CONTACTS]) } }), route: '/formats' });
    expect(await screen.findByText('Saved formats: 2 of 3')).toBeTruthy();
  });

  it('shows the sources underneath, each with its status and a way to its rules', async () => {
    const getFormat = vi.fn(async () =>
      getFormatResponse({
        id: 'F1',
        name: 'Supplier price list',
        sources: [
          conversionSummary({ id: 'C1', sourceName: 'Supplier A' }),
          conversionSummary({ id: 'C2', sourceName: 'Supplier B', status: 'differencesAccepted', acceptedDifferences: 4 }),
          conversionSummary({ id: 'C3', sourceName: 'Supplier C', status: 'needsReview' }),
        ],
      }),
    );
    renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), getFormat } }), route: '/formats' });
    await screen.findByTestId('format-list');
    fireEvent.click(within(cards()[0]!).getByRole('button', { name: /3 sources/ }));
    const list = await within(cards()[0]!).findByRole('link', { name: 'Supplier A' });
    expect(list.getAttribute('href')).toBe('/formats/F1/sources/C1');
    const card = cards()[0]!;
    expect(within(card).getByRole('link', { name: 'Supplier B' })).toBeTruthy();
    expect(within(card).getByText('4 differences')).toBeTruthy();
    expect(within(card).getByText('Needs review')).toBeTruthy();
  });

  it('says so when there are no formats yet, and offers to teach one', async () => {
    renderApp({ api: fakeApi({ user: USER }), route: '/formats' });
    expect(await screen.findByTestId('formats-empty')).toBeTruthy();
    expect(screen.getByText('No saved formats yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Teach a new format' }).getAttribute('href')).toBe('/');
  });

  it('a list that cannot be loaded says so and can be tried again', async () => {
    const listFormats = vi.fn().mockRejectedValueOnce(new ApiError('server', 500)).mockResolvedValue([SUPPLIER]);
    renderApp({ api: fakeApi({ user: USER, registry: { listFormats } }), route: '/formats' });
    expect(await screen.findByText("We couldn't load your formats.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('format-list');
  });

  describe('rename', () => {
    it('renames in place with the server\'s answer', async () => {
      const renameFormat = vi.fn(async (_id: string, name: string) => ({ ...SUPPLIER, name }));
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), renameFormat } }), route: '/formats' });
      await screen.findByTestId('format-list');
      fireEvent.click(within(cards()[0]!).getByRole('button', { name: 'Rename' }));
      fireEvent.change(screen.getByLabelText('Format name'), { target: { value: 'ERP catalog' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
      await waitFor(() => expect(within(cards()[0]!).getByRole('heading', { name: 'ERP catalog' })).toBeTruthy());
      expect(renameFormat).toHaveBeenCalledWith('F1', 'ERP catalog');
      expect(screen.queryByLabelText('Format name')).toBeNull();
    });

    it('Enter saves, an unchanged or empty name just closes, and a failure says so', async () => {
      const renameFormat = vi.fn(async () => Promise.reject(new ApiError('server', 500)));
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), renameFormat } }), route: '/formats' });
      await screen.findByTestId('format-list');

      fireEvent.click(within(cards()[0]!).getByRole('button', { name: 'Rename' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save name' })); // unchanged
      expect(renameFormat).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Format name')).toBeNull();

      fireEvent.click(within(cards()[0]!).getByRole('button', { name: 'Rename' }));
      fireEvent.change(screen.getByLabelText('Format name'), { target: { value: 'Another' } });
      fireEvent.submit(screen.getByLabelText('Format name').closest('form')!);
      expect(await screen.findByText("We couldn't rename it. Try again.")).toBeTruthy();
      // the old name stays
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(within(cards()[0]!).getByRole('heading', { name: 'Supplier price list' })).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('asks first, says it frees a slot but gives back no AI learns, and then removes the format', async () => {
      const deleteFormat = vi.fn(async () => undefined);
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER, CONTACTS]), deleteFormat } }), route: '/formats' });
      await screen.findByTestId('format-list');
      fireEvent.click(within(cards()[0]!).getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete "Supplier price list"?' });
      expect(dialog.textContent).toContain('This deletes the format and its 3 sources.');
      expect(dialog.textContent).toContain('It frees a saved-format slot, but it does not give back any AI formats you used.');
      expect(deleteFormat).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete format' }));
      await waitFor(() => expect(cards()).toHaveLength(1));
      expect(deleteFormat).toHaveBeenCalledWith('F1');
      expect(within(cards()[0]!).getByRole('heading', { name: 'Contacts export' })).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('"Keep it" leaves everything as it was', async () => {
      const deleteFormat = vi.fn(async () => undefined);
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), deleteFormat } }), route: '/formats' });
      await screen.findByTestId('format-list');
      fireEvent.click(within(cards()[0]!).getByRole('button', { name: 'Delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Keep it' }));
      expect(deleteFormat).not.toHaveBeenCalled();
      expect(cards()).toHaveLength(1);
    });

    it('a failed delete says so and keeps the format', async () => {
      const deleteFormat = vi.fn(async () => Promise.reject(new ApiError('server', 500)));
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), deleteFormat } }), route: '/formats' });
      await screen.findByTestId('format-list');
      fireEvent.click(within(cards()[0]!).getByRole('button', { name: 'Delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Delete format' }));
      expect(await screen.findByText("We couldn't delete it. Try again.")).toBeTruthy();
      expect(cards()).toHaveLength(1);
    });
  });
});

describe('one format', () => {
  const two = getFormatResponse({
    id: 'F1',
    name: 'Supplier price list',
    sources: [conversionSummary({ id: 'C1', sourceName: 'Supplier A', runCount: 3, lastRun: { rows: 120, flagged: 4 } }), conversionSummary({ id: 'C2', sourceName: 'Supplier B', status: 'needsReview' })],
  });

  it('lists the sources with status and last run, and the two things a format is for', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { getFormat: vi.fn(async () => two) } }), route: '/formats/F1' });
    expect(await screen.findByRole('heading', { name: 'Supplier price list' })).toBeTruthy();
    const rows = screen.getAllByTestId('source-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('heading', { name: 'Supplier A' })).toBeTruthy();
    expect(rows[0]!.textContent).toContain('Last run: 120 rows, 4 flagged');
    expect(within(rows[0]!).getByRole('link', { name: 'Edit rules' }).getAttribute('href')).toBe('/formats/F1/sources/C1');
    expect(within(rows[1]!).getByText('Needs review')).toBeTruthy();
    expect(rows[1]!.textContent).toContain('The format changed since the last run.');
    expect(screen.getByRole('link', { name: 'Add a source' }).getAttribute('href')).toBe('/formats/F1/add-source');
    expect(screen.getByRole('link', { name: 'Convert a file' }).getAttribute('href')).toBe('/convert?format=F1');
  });

  it('renames a source (a name another source has is refused in words) and deletes one', async () => {
    const updateConversion = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('nameTaken', 409))
      .mockImplementation(async (id: string, body: { sourceName: string }) => ({
        conversion: conversionSummary({ id, sourceName: body.sourceName }),
        formatChanged: false,
        affectedSources: 0,
        needsReview: [],
      }));
    const deleteConversion = vi.fn(async () => undefined);
    renderApp({ api: fakeApi({ user: USER, registry: { getFormat: vi.fn(async () => two), updateConversion, deleteConversion } }), route: '/formats/F1' });
    await screen.findByTestId('source-rows');
    const first = screen.getAllByTestId('source-row')[0]!;

    fireEvent.click(within(first).getByRole('button', { name: 'Rename source' }));
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Supplier B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Another source of this format already has that name. Choose a different name.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(within(screen.getAllByTestId('source-row')[0]!).getByRole('heading', { name: 'Acme' })).toBeTruthy());
    expect(updateConversion).toHaveBeenLastCalledWith('C1', { sourceName: 'Acme' });

    fireEvent.click(within(screen.getAllByTestId('source-row')[1]!).getByRole('button', { name: 'Delete source' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete the source "Supplier B"?' });
    expect(dialog.textContent).toContain('The format and its other sources stay.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete source' }));
    await waitFor(() => expect(screen.getAllByTestId('source-row')).toHaveLength(1));
    expect(deleteConversion).toHaveBeenCalledWith('C2');
  });

  it('a format that is not there (or not yours) says so', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { getFormat: vi.fn(async () => Promise.reject(new ApiError('notFound', 404))) } }), route: '/formats/nope' });
    expect(await screen.findByText("We couldn't find this format. It may have been deleted.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All formats' })).toBeTruthy();
  });

  it('"Edit rules" from My formats goes straight to the rules when there is only one source', async () => {
    const one = getFormatResponse({ id: 'F2', name: 'Contacts export', sources: [conversionSummary({ id: 'C9', formatId: 'F2', sourceName: 'CRM' })] });
    const api = fakeApi({
      user: USER,
      registry: {
        listFormats: vi.fn(async () => [CONTACTS]),
        getFormat: vi.fn(async () => one),
        getConversion: vi.fn(async () => Promise.reject(new ApiError('notFound', 404))),
      },
    });
    renderApp({ api, route: '/formats' });
    await screen.findByTestId('format-list');
    fireEvent.click(within(cards()[0]!).getByRole('link', { name: 'Edit rules' }));
    // It lands in the source's editor route (which asks for the conversion).
    await waitFor(() => expect(api.registry.getConversion).toHaveBeenCalledWith('C9', expect.anything()));
  });
});

describe('Home for a signed-in user (SPEC 16.1 screen 5)', () => {
  it('starts from "Convert a file", with "Teach a new format" next to it, when there are saved formats', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]) } }) });
    const convert = await screen.findByRole('button', { name: 'Convert a file' });
    const teach = screen.getByRole('button', { name: 'Teach a new format' });
    expect(convert.compareDocumentPosition(teach) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByLabelText('Example input')).toBeNull();

    fireEvent.click(teach);
    expect(await screen.findByLabelText('Example input')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Show us one example' })).toBeTruthy();
  });

  it('is the tool as ever for a signed-in user with no formats, and for a visitor', async () => {
    const { unmount } = renderApp({ api: fakeApi({ user: USER }) });
    await screen.findByRole('button', { name: /Account menu/ });
    await act(async () => {});
    expect(screen.getByLabelText('Example input')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Convert a file' })).toBeNull();
    unmount();

    renderApp({ api: fakeApi({ registry: { listFormats: vi.fn(async () => [SUPPLIER]) } }) });
    await act(async () => {});
    expect(screen.getByLabelText('Example input')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Convert a file' })).toBeNull();
  });

  it('"Teach a new format" from My formats opens the two zones', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]) } }), route: '/formats' });
    await screen.findByTestId('format-list');
    fireEvent.click(screen.getByRole('link', { name: 'Teach a new format' }));
    expect(await screen.findByLabelText('Example input')).toBeTruthy();
  });
});
