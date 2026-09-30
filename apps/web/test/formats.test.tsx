// My formats (SPEC 16.1 screen 5) with the company's sources under the list (SPEC 8.15), one format and its sources, and Home for a
// signed-in user who has formats. A fake API.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { conversionSummary, formatSummary, getFormatResponse, sourceDetail, sourceSummary } from './helpers/registryKit';
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
      expect(dialog.textContent).toContain('This deletes the format. Its 3 sources stay in your sources.');
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

describe('the company\'s sources on My formats (SPEC 8.15)', () => {
  const sectionCards = (): HTMLElement[] => screen.queryAllByTestId('source-card');
  const feedsOne = { conversionId: 'C1', formatId: 'F1', formatName: 'Supplier price list', status: 'verified' as const };
  const MASTER = sourceSummary({
    id: 'S1',
    name: 'Master prices',
    columns: 9,
    conversions: [feedsOne, { conversionId: 'C9', formatId: 'F2', formatName: 'Contacts export', status: 'needsReview' }],
    runCount: 3,
    lastRunAt: '2026-09-15T08:30:00.000Z',
  });
  const IDLE = sourceSummary({ id: 'S2', name: 'Old supplier', columns: 1 });
  const listSources = (...list: ReturnType<typeof sourceSummary>[]) => vi.fn(async () => list);

  it('lists each source with its name, the formats it feeds (as links), its statuses and how big it is', async () => {
    const api = fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER, CONTACTS]), listSources: listSources(MASTER, IDLE) } });
    renderApp({ api, route: '/formats' });
    const section = await screen.findByTestId('sources-section');
    expect(within(section).getByRole('heading', { level: 2, name: 'Sources' })).toBeTruthy();
    expect(sectionCards()).toHaveLength(2);

    const master = sectionCards()[0]!;
    expect(within(master).getByRole('heading', { name: 'Master prices' })).toBeTruthy();
    expect(master.textContent).toContain('Feeds 2 formats');
    expect(within(master).getByRole('link', { name: 'Supplier price list' }).getAttribute('href')).toBe('/formats/F1');
    expect(within(master).getByRole('link', { name: 'Contacts export' }).getAttribute('href')).toBe('/formats/F2');
    // What needs a look comes first, as on a format's card.
    expect(within(master).getByText('1 need review')).toBeTruthy();
    expect(within(master).getByText('1 verified')).toBeTruthy();
    expect(master.textContent).toContain('9 columns');
    expect(master.textContent).toContain('Run 3 times');
    expect(master.textContent).toContain('Last run');

    const idle = sectionCards()[1]!;
    expect(idle.textContent).toContain('Feeds no format yet');
    expect(idle.textContent).toContain('1 column');
    expect(idle.textContent).toContain('Not run yet');
  });

  it('says "Feeds 1 format" for one, and is under the format list', async () => {
    const one = sourceSummary({ id: 'S3', name: 'Supplier A', conversions: [feedsOne] });
    renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: listSources(one) } }), route: '/formats' });
    const section = await screen.findByTestId('sources-section');
    expect(section.textContent).toContain('Feeds 1 format');
    expect(screen.getByTestId('format-list').compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not there when the company has no sources', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]) } }), route: '/formats' });
    await screen.findByTestId('format-list');
    await act(async () => {});
    expect(screen.queryByTestId('sources-section')).toBeNull();
  });

  it('finds a source whose formats are all gone (with no format listed at all)', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { listSources: listSources(IDLE) } }), route: '/formats' });
    expect(await screen.findByTestId('formats-empty')).toBeTruthy();
    expect(await screen.findByTestId('sources-section')).toBeTruthy();
    expect(within(sectionCards()[0]!).getByRole('heading', { name: 'Old supplier' })).toBeTruthy();
  });

  it('a list of sources that cannot be loaded says so and can be tried again', async () => {
    const list = vi.fn().mockRejectedValueOnce(new ApiError('server', 500)).mockResolvedValue([IDLE]);
    renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: list } }), route: '/formats' });
    expect(await screen.findByText("We couldn't load your sources.")).toBeTruthy();
    // (the formats are there all the same)
    expect(screen.getByTestId('format-list')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]!);
    await screen.findByTestId('sources-section');
  });

  it('a format\'s open list of sources hints at the OTHER formats a source also feeds', async () => {
    const getFormat = vi.fn(async () => getFormatResponse({ id: 'F1', name: 'Supplier price list', sources: [conversionSummary({ id: 'C1', sourceName: 'Master prices' })] }));
    renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), getFormat, listSources: listSources(MASTER) } }), route: '/formats' });
    await screen.findByTestId('sources-section');
    fireEvent.click(within(cards()[0]!).getByRole('button', { name: /3 sources/ }));
    const item = (await within(cards()[0]!).findByRole('link', { name: 'Master prices' })).closest('li')!;
    expect(item.textContent).toContain('Also feeds:');
    expect(item.textContent).toContain('Contacts export');
    expect(item.textContent).not.toContain('Supplier price list');
  });

  describe('rename', () => {
    it('renames through the source (PATCH name), shows the new name, and a name in use is refused in words', async () => {
      const updateSource = vi
        .fn()
        .mockRejectedValueOnce(new ApiError('nameTaken', 409))
        .mockImplementation(async (id: string, body: { name: string }) => ({
          source: sourceDetail({ id, name: body.name, conversions: MASTER.conversions }),
          structureChanged: false,
          affectedConversions: 0,
          needsReview: [],
        }));
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: listSources(MASTER, IDLE), updateSource } }), route: '/formats' });
      await screen.findByTestId('sources-section');
      fireEvent.click(within(sectionCards()[0]!).getByRole('button', { name: 'Rename' }));
      fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'old SUPPLIER' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
      expect(await screen.findByText('You already have a source with that name. Choose a different name.')).toBeTruthy();
      // the old name stays until it is saved
      expect(updateSource).toHaveBeenCalledWith('S1', { name: 'old SUPPLIER' });

      fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Price master' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
      await waitFor(() => expect(within(sectionCards()[0]!).getByRole('heading', { name: 'Price master' })).toBeTruthy());
      expect(updateSource).toHaveBeenLastCalledWith('S1', { name: 'Price master' });
      expect(screen.queryByLabelText('Source name')).toBeNull();
      // what else it is stays: the formats it feeds
      expect(within(sectionCards()[0]!).getByRole('link', { name: 'Contacts export' })).toBeTruthy();
    });

    it('an unchanged or empty name just closes, and another failure says so plainly', async () => {
      const updateSource = vi.fn(async () => Promise.reject(new ApiError('server', 500)));
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: listSources(MASTER), updateSource } }), route: '/formats' });
      await screen.findByTestId('sources-section');
      fireEvent.click(within(sectionCards()[0]!).getByRole('button', { name: 'Rename' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
      expect(updateSource).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Source name')).toBeNull();

      fireEvent.click(within(sectionCards()[0]!).getByRole('button', { name: 'Rename' }));
      fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Another' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
      expect(await screen.findByText("We couldn't rename it. Try again.")).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(within(sectionCards()[0]!).getByRole('heading', { name: 'Master prices' })).toBeTruthy();
    });

    it('a rename made here is read by the format cards that are open (they name the source)', async () => {
      const getFormat = vi.fn(async () => getFormatResponse({ id: 'F1', name: 'Supplier price list', sources: [conversionSummary({ id: 'C1', sourceName: 'Master prices' })] }));
      const updateSource = vi.fn(async (id: string, body: { name: string }) => ({ source: sourceDetail({ id, name: body.name, conversions: MASTER.conversions }), structureChanged: false, affectedConversions: 0, needsReview: [] }));
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), getFormat, listSources: listSources(MASTER), updateSource } }), route: '/formats' });
      await screen.findByTestId('sources-section');
      fireEvent.click(within(cards()[0]!).getByRole('button', { name: /3 sources/ }));
      await within(cards()[0]!).findByRole('link', { name: 'Master prices' });
      expect(getFormat).toHaveBeenCalledTimes(1);

      fireEvent.click(within(sectionCards()[0]!).getByRole('button', { name: 'Rename' }));
      fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Price master' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
      await waitFor(() => expect(getFormat).toHaveBeenCalledTimes(2));
    });

    it('the other way round: a rename of the source from a format\'s page renames the source (PATCH conversion { sourceName }) and is what My formats shows next', async () => {
      // (one API, two screens: the format page's rename, then My formats read again)
      let name = 'Master prices';
      const updateConversion = vi.fn(async (id: string, body: { sourceName: string }) => {
        name = body.sourceName;
        return { conversion: conversionSummary({ id, sourceName: name }), formatChanged: false, affectedSources: 0, needsReview: [] };
      });
      const api = fakeApi({
        user: USER,
        registry: {
          getFormat: vi.fn(async () => getFormatResponse({ id: 'F1', name: 'Supplier price list', sources: [conversionSummary({ id: 'C1', sourceName: name })] })),
          listSources: vi.fn(async () => [sourceSummary({ id: 'S1', name, conversions: [feedsOne] })]),
          listFormats: vi.fn(async () => [SUPPLIER]),
          updateConversion,
        },
      });
      const { unmount } = renderApp({ api, route: '/formats/F1' });
      await screen.findByTestId('source-rows');
      fireEvent.click(screen.getByRole('button', { name: 'Rename source' }));
      fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Price master' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
      await waitFor(() => expect(updateConversion).toHaveBeenCalledWith('C1', { sourceName: 'Price master' }));
      unmount();

      renderApp({ api, route: '/formats' });
      const section = await screen.findByTestId('sources-section');
      expect(within(section).getByRole('heading', { name: 'Price master' })).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('is offered only for a source that feeds no format (the others say why not)', async () => {
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: listSources(MASTER, IDLE) } }), route: '/formats' });
      await screen.findByTestId('sources-section');
      const [master, idle] = sectionCards() as [HTMLElement, HTMLElement];
      expect(within(master).queryByRole('button', { name: 'Delete' })).toBeNull();
      expect(master.textContent).toContain('To delete it, first remove it from its formats.');
      expect(within(idle).getByRole('button', { name: 'Delete' })).toBeTruthy();
      expect(idle.textContent).not.toContain('To delete it');
    });

    it('asks first, then removes the source (its formats are not touched)', async () => {
      const deleteSource = vi.fn(async () => undefined);
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: listSources(MASTER, IDLE), deleteSource } }), route: '/formats' });
      await screen.findByTestId('sources-section');
      fireEvent.click(within(sectionCards()[1]!).getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete the source "⁨Old supplier⁩"?' });
      expect(dialog.textContent).toContain('This source feeds no format, so no format changes.');
      expect(deleteSource).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete source' }));
      await waitFor(() => expect(sectionCards()).toHaveLength(1));
      expect(deleteSource).toHaveBeenCalledWith('S2');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(within(sectionCards()[0]!).getByRole('heading', { name: 'Master prices' })).toBeTruthy();
      expect(cards()).toHaveLength(1);
    });

    it('"Keep it" leaves the source as it was', async () => {
      const deleteSource = vi.fn(async () => undefined);
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: listSources(IDLE), deleteSource } }), route: '/formats' });
      await screen.findByTestId('sources-section');
      fireEvent.click(within(sectionCards()[0]!).getByRole('button', { name: 'Delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Keep it' }));
      expect(deleteSource).not.toHaveBeenCalled();
      expect(sectionCards()).toHaveLength(1);
    });

    it('the last source going takes the section with it', async () => {
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: listSources(IDLE) } }), route: '/formats' });
      await screen.findByTestId('sources-section');
      fireEvent.click(within(sectionCards()[0]!).getByRole('button', { name: 'Delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Delete source' }));
      await waitFor(() => expect(screen.queryByTestId('sources-section')).toBeNull());
    });

    it('a source that turns out to feed a format (the list was old) is refused with the server\'s sentence, and the list is read again', async () => {
      const deleteSource = vi.fn(async () => Promise.reject(new ApiError('sourceInUse', 409)));
      const list = vi.fn().mockResolvedValueOnce([IDLE]).mockResolvedValue([{ ...IDLE, conversions: [feedsOne], statuses: { verified: 1 } }]);
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: list, deleteSource } }), route: '/formats' });
      await screen.findByTestId('sources-section');
      fireEvent.click(within(sectionCards()[0]!).getByRole('button', { name: 'Delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Delete source' }));
      const dialog = await screen.findByRole('dialog');
      expect(await within(dialog).findByText('This source still feeds a format. Remove it from its formats first.')).toBeTruthy();
      expect(sectionCards()).toHaveLength(1);
      // read again: it now feeds a format, so it can't be deleted from here
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
      await waitFor(() => expect(within(sectionCards()[0]!).queryByRole('button', { name: 'Delete' })).toBeNull());
      expect(sectionCards()[0]!.textContent).toContain('Feeds 1 format');
    });

    it('any other failure says so and keeps the source', async () => {
      const deleteSource = vi.fn(async () => Promise.reject(new ApiError('server', 500)));
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: listSources(IDLE), deleteSource } }), route: '/formats' });
      await screen.findByTestId('sources-section');
      fireEvent.click(within(sectionCards()[0]!).getByRole('button', { name: 'Delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Delete source' }));
      expect(await screen.findByText("We couldn't delete the source. Try again.")).toBeTruthy();
      expect(sectionCards()).toHaveLength(1);
    });

    it('a deleted FORMAT leaves its sources: the list is read again, and a source that now feeds nothing can be deleted', async () => {
      const deleteFormat = vi.fn(async () => undefined);
      const list = vi
        .fn()
        .mockResolvedValueOnce([sourceSummary({ id: 'S5', name: 'Only supplier', conversions: [feedsOne] })])
        .mockResolvedValue([sourceSummary({ id: 'S5', name: 'Only supplier' })]);
      renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: list, deleteFormat } }), route: '/formats' });
      await screen.findByTestId('sources-section');
      expect(within(sectionCards()[0]!).queryByRole('button', { name: 'Delete' })).toBeNull();
      fireEvent.click(within(cards()[0]!).getByRole('button', { name: 'Delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Delete format' }));
      await waitFor(() => expect(cards()).toHaveLength(0));
      await waitFor(() => expect(within(sectionCards()[0]!).getByRole('button', { name: 'Delete' })).toBeTruthy());
      expect(sectionCards()[0]!.textContent).toContain('Feeds no format yet');
    });
  });

  it('says it in Hebrew', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [SUPPLIER]), listSources: listSources(MASTER, IDLE) } }), route: '/formats', lang: 'he' });
    const section = await screen.findByTestId('sources-section');
    expect(within(section).getByRole('heading', { level: 2, name: 'מקורות' })).toBeTruthy();
    expect(sectionCards()[0]!.textContent).toContain('מזין 2 פורמטים');
    expect(sectionCards()[0]!.textContent).toContain('כדי למחוק אותו, קודם הסירו אותו מהפורמטים שלו.');
    expect(sectionCards()[1]!.textContent).toContain('עוד לא מזין פורמט');
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
    expect(await screen.findByText('You already have a source with that name. Choose a different name.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(within(screen.getAllByTestId('source-row')[0]!).getByRole('heading', { name: 'Acme' })).toBeTruthy());
    expect(updateConversion).toHaveBeenLastCalledWith('C1', { sourceName: 'Acme' });

    fireEvent.click(within(screen.getAllByTestId('source-row')[1]!).getByRole('button', { name: 'Delete source' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete the source "Supplier B"?' });
    expect(dialog.textContent).toContain('The format and its other sources stay.');
    expect(dialog.textContent).toContain('The source itself stays in your sources');
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
