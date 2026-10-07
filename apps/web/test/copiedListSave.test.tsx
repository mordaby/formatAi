// A list copied from the example is asked at Save only (owner decision 2026-10-06: fewer clicks, and nothing is stored before Save). While
// learning and converting nothing is asked - the list is used as it is. At Save, only when the rules about to be stored hold such a list the
// server does not hold yet, one small dialog: "Save this format?" - Keep it / Save without it / Cancel (en, he). Keep saves the list; Save
// without takes it out (the column needs your input, its copied values never sent); Cancel saves nothing; a format with no list saves with no
// dialog. Every save path: the Result screen's Save format and Save changes, Add a source; the saved-source editor saves its own (the
// server's) rules as before. Account Manager looked up by Account: a table code filled from the 40 rows of external-agent-column.
// And (owner rule, 2026-10-06) a table nothing reads any more is never saved: "Leave empty" on the list's column sends no table at all - the
// Result screen's saves go through the real registry client here (`request` is what is sent).
import type { CopiedListQuestion } from '@formatai/engine';
import type { Expr, LearnResult, Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/http';
import { createRegistryApi } from '../src/api/registry';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { resumeLeaveGuard } from '../src/app/unloadPrompt';
import type { LearnHost, LearnOutput } from '../src/worker/engineApi';
import { conversionDetail, conversionSummary, createFormatResponse, formatSummary, getFormatResponse } from './helpers/registryKit';
import { csv, fakeApi, fakeEngine, learnResult, liveResult, renderApp, USER } from './helpers/renderApp';

const { downloaded } = vi.hoisted(() => ({ downloaded: vi.fn() }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));
vi.mock('../src/app/redirect', () => ({ redirectTo: vi.fn() }));

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPendingStore(undefined);
  resumeLeaveGuard();
});

const ROWS = 40;
const lookupOf = (table: string, ret: string): Expr => ({ op: 'lookup', table, key: { col: 'account' }, return: ret, onMissing: 'flag' });
const tableOf = (name: string, ret: string, value: (i: number) => string) => ({ name, columns: ['account', ret], rows: Array.from({ length: ROWS }, (_, i) => [`ACC-${1001 + i}`, value(i)]) });

/** Account, Company, Account Manager (a lookup of the 40 accounts) - and, with `owner`, Account Owner (a second such list). */
function listed(owner = false): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'account', header: 'Account', type: 'idLike' },
        { id: 'company', header: 'Company', type: 'text' },
      ],
    },
    transform: {
      computed: [
        { id: 'accountManager', type: 'text', expr: lookupOf('accountManagers', 'manager') },
        ...(owner ? [{ id: 'accountOwner', type: 'text' as const, expr: lookupOf('accountOwners', 'owner') }] : []),
      ],
      valueMaps: [],
      sort: [],
      tables: [tableOf('accountManagers', 'manager', (i) => `Manager ${i % 8}`), ...(owner ? [tableOf('accountOwners', 'owner', (i) => `Owner ${i % 5}`)] : [])],
    },
    output: {
      sheetName: 'Accounts with manager',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Account', from: 'account' },
        { header: 'Company', from: 'company' },
        { header: 'Account Manager', from: 'accountManager' },
        ...(owner ? [{ header: 'Account Owner', from: 'accountOwner' }] : []),
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

const managerList: CopiedListQuestion = { kind: 'copiedList', out: 2, header: 'Account Manager', keyColumn: 'Account', entries: ROWS, list: { kind: 'lookup', computed: 'accountManager', table: 'accountManagers' } };
const ownerList: CopiedListQuestion = { kind: 'copiedList', out: 3, header: 'Account Owner', keyColumn: 'Account', entries: ROWS, list: { kind: 'lookup', computed: 'accountOwner', table: 'accountOwners' } };

/** The learn's answer: the rules, and the copied lists the engine found in them (none: a format with no list). */
function aiResult(lists: CopiedListQuestion[] = [managerList], rules = listed(lists.length > 1)): LearnOutput {
  return learnResult({
    path: 'llm',
    rules,
    exampleId: 'ex1',
    loop: { rounds: 0, rowsSent: 0, end: 'verified' },
    verification: { verified: true, matched: ROWS, total: ROWS, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    ...(lists.length > 0 ? { oneTimers: { questions: lists, handedOff: [] } } : {}),
  });
}

/** The worker's check: every column that has a rule matches (a copied list reproduces its example by construction). */
function live(rules: LearnResult | Rules) {
  const headers = rules.output.columns.filter((c) => c.from !== null).map((c) => c.header);
  return liveResult({
    verified: true,
    matched: ROWS,
    total: ROWS,
    differences: 0,
    perColumn: headers.map((header) => ({ header, inExample: true, matched: ROWS, total: ROWS })),
    checkedInputRows: ROWS,
    totalInputRows: ROWS,
  });
}

const created = createFormatResponse({ format: formatSummary({ id: 'F1', name: 'Accounts' }), conversion: conversionSummary({ id: 'C1', formatId: 'F1', sourceName: 'Source 1', version: 1 }) });
const patched = (version: number) => ({ conversion: conversionSummary({ id: 'C1', version }), formatChanged: false, affectedSources: 0, needsReview: [] });

/** Learns (fake worker) and opens the Result screen of a signed-in user. */
async function openResult(result: LearnOutput = aiResult(), lang: 'en' | 'he' = 'en') {
  const liveCheck = vi.fn(async (_id: string, r: LearnResult | Rules) => live(r));
  const fake = fakeEngine(async () => result, undefined, { liveCheck, fullCheck: liveCheck, convert: vi.fn(async () => converted()) });
  // The real registry client over a fake server: `request` is what is SENT (the client's boundary applied), the mocks what the screen asked.
  const request = vi.fn(async (method: string, _path: string, body: { baseVersion?: number }) => (method === 'POST' ? created : patched((body.baseVersion ?? 0) + 1)));
  const registry = createRegistryApi(request as never);
  const createFormat = vi.fn((body: Parameters<typeof registry.createFormat>[0]) => registry.createFormat(body));
  const updateConversion = vi.fn((id: string, body: Parameters<typeof registry.updateConversion>[1]) => registry.updateConversion(id, body));
  const api = fakeApi({ user: USER, registry: { createFormat, updateConversion } });
  renderApp({ engine: fake.engine, api, lang, dataRouter: true });
  const en = lang === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('accounts.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('managers.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  const learnButton = screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ }) as HTMLButtonElement;
  await waitFor(() => expect(learnButton.disabled).toBe(false));
  await act(async () => void fireEvent.click(learnButton));
  await screen.findByTestId('rules-map');
  await waitFor(() => expect(liveCheck).toHaveBeenCalled());
  return { ...fake, api, liveCheck, createFormat, updateConversion, request };
}

const SUMMARY = { rowsIn: ROWS, rowsOut: ROWS, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] };
const converted = () => ({ ok: true, bytes: new ArrayBuffer(8), flags: [], summary: SUMMARY, preview: { name: 'Out', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] }, totalRows: ROWS });

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
/** Clicks a button once it can be clicked (the rules have been checked). */
async function press(name: string): Promise<void> {
  await waitFor(() => expect(button(name).disabled).toBe(false));
  await act(async () => void fireEvent.click(button(name)));
}
const dialog = (): HTMLElement | null => screen.queryByRole('dialog');
const answer = async (name: string): Promise<void> => {
  await act(async () => void fireEvent.click(within(dialog()!).getByRole('button', { name })));
};
const badge = (): string => screen.getByTestId('status-badge').textContent ?? '';
const bodyOf = (mock: ReturnType<typeof vi.fn>, at = 0): { rules: Rules; status: string } => (mock.mock.calls[at] as unknown as [unknown, { rules: Rules; status: string }]).at(-1) as { rules: Rules; status: string };
const managerOf = (rules: LearnResult | Rules) => rules.output.columns.find((c) => c.header === 'Account Manager');
/** No value of the copied list is in what was sent. */
const noCopiedValues = (rules: Rules): void => {
  const text = JSON.stringify(rules);
  expect(text).not.toContain('Manager ');
  expect(text).not.toContain('ACC-');
};

describe('while learning and converting: no question', () => {
  it('the Result screen asks nothing about the list: no question on the column\'s line, no dialog - the list is used as it is', async () => {
    const { liveCheck, engine } = await openResult();
    await waitFor(() => expect(badge()).toBe('Verified'));
    expect(screen.queryByTestId('one-time-question')).toBeNull();
    expect(document.querySelector('[data-line-id="col:Account Manager"] .map-line__ask')).toBeNull();
    expect(document.body.textContent).not.toMatch(/is this the rule|copied from your example/);
    expect(dialog()).toBeNull();
    expect(managerOf(liveCheck.mock.calls.at(-1)![1] as LearnResult)?.from).toBe('accountManager');
    // The download converts with the list as it is.
    await press('Download the file');
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
    const [args] = (engine.convert as ReturnType<typeof vi.fn>).mock.calls[0] as [{ rules: LearnResult }];
    expect(args.rules.transform.tables).toEqual(listed().transform.tables);
    expect(dialog()).toBeNull();
  });
});

describe('Save format with a list copied from the example', () => {
  it('asks once, in a small dialog, before anything is sent: the column, how many values, the key column - and no value', async () => {
    const { createFormat } = await openResult();
    // (a click moves the focus to the button, as a real one does)
    const save = button('Save format');
    await waitFor(() => expect(save.disabled).toBe(false));
    save.focus();
    await press('Save format');
    const box = dialog()!;
    expect(box.getAttribute('aria-modal')).toBe('true');
    expect(within(box).getByRole('heading').textContent).toBe('Save this format?');
    expect(screen.getByRole('dialog', { name: 'Save this format?' })).toBe(box);
    expect(within(box).getByTestId('copied-list-dialog').textContent).toBe(
      'Account Manager is a list of 40 fixed values taken from your example (one for each Account). Keep this list in the saved format?',
    );
    expect(within(box).getByText('Account Manager').closest('strong')).toBeTruthy();
    expect(within(box).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Close', 'Keep it', 'Save without it', 'Cancel']);
    expect(box.textContent).not.toContain('Manager 0');
    expect(box.textContent).not.toMatch(/next month/i);
    // Focus is in the dialog; nothing has been sent.
    expect(box.contains(document.activeElement)).toBe(true);
    expect(createFormat).not.toHaveBeenCalled();
    // Escape is Cancel: nothing saved, focus back on Save.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(save);
    expect(createFormat).not.toHaveBeenCalled();
  });

  it('"Keep it" saves the format with the list, as before', async () => {
    const { createFormat } = await openResult();
    await press('Save format');
    await answer('Keep it');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    const body = bodyOf(createFormat);
    expect(body.rules).toEqual(listed());
    expect(body.status).toBe('verified');
    expect(await screen.findByText(/^Saved\. ".+" is in My formats\.$/)).toBeTruthy();
  });

  it('"Save without it": the column needs your input, its copied values are dropped, and that is what is saved - the screen shows it', async () => {
    const { createFormat, liveCheck } = await openResult();
    await press('Save format');
    await answer('Save without it');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    const { rules, status } = bodyOf(createFormat);
    expect(managerOf(rules)).toEqual({ header: 'Account Manager', from: null });
    expect(rules.unsupported).toEqual([{ outputColumn: 'Account Manager', reasonCode: 'overfit' }]);
    expect([rules.transform.computed, rules.transform.tables]).toEqual([[], []]);
    noCopiedValues(rules);
    // Saved with the status of the rules as saved: checked again without the list (one column needs your input).
    expect(status).toBe('userConfirmed');
    expect(managerOf(liveCheck.mock.calls.at(-1)![1] as LearnResult)?.from).toBeNull();
    // The screen is updated: the column needs your input, and it is saved.
    expect(badge()).toBe('1 column needs your input');
    expect(await screen.findByText(/^Saved\. ".+" is in My formats\.$/)).toBeTruthy();
  });

  it('"Cancel" saves nothing and changes nothing', async () => {
    const { createFormat, liveCheck } = await openResult();
    const calls = liveCheck.mock.calls.length;
    await press('Save format');
    await answer('Cancel');
    expect(dialog()).toBeNull();
    expect(createFormat).not.toHaveBeenCalled();
    expect(liveCheck.mock.calls.length).toBe(calls);
    expect(badge()).toBe('Verified');
    expect(button('Undo').disabled).toBe(true);
    // The close button is Cancel too.
    await press('Save format');
    await act(async () => void fireEvent.click(within(dialog()!).getByRole('button', { name: 'Close' })));
    expect(dialog()).toBeNull();
    expect(createFormat).not.toHaveBeenCalled();
  });

  it('several lists: a line each, one answer for all ("Keep them" / "Save without them")', async () => {
    const { createFormat } = await openResult(aiResult([managerList, ownerList]));
    await press('Save format');
    const box = dialog()!;
    expect([...box.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Account Manager is a list of 40 fixed values taken from your example (one for each Account).',
      'Account Owner is a list of 40 fixed values taken from your example (one for each Account).',
    ]);
    expect(within(box).getByText('Keep these lists in the saved format?')).toBeTruthy();
    expect(within(box).getAllByRole('button').map((b) => b.textContent).slice(1)).toEqual(['Keep them', 'Save without them', 'Cancel']);
    await answer('Save without them');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    const { rules } = bodyOf(createFormat);
    expect(rules.output.columns.filter((c) => c.from === null).map((c) => c.header)).toEqual(['Account Manager', 'Account Owner']);
    expect(rules.transform.tables).toEqual([]);
    expect(JSON.stringify(rules)).not.toContain('Owner ');
    noCopiedValues(rules);
    expect(badge()).toBe('2 columns need your input');
  });

  it('has its Hebrew copy', async () => {
    const { createFormat } = await openResult(aiResult(), 'he');
    await press('שמירת הפורמט');
    const box = dialog()!;
    expect(within(box).getByRole('heading').textContent).toBe('לשמור את הפורמט?');
    expect(within(box).getByTestId('copied-list-dialog').textContent).toBe(
      'העמודה Account Manager היא רשימה של 40 ערכים קבועים שנלקחו מהדוגמה שלכם (אחד לכל Account). להשאיר את הרשימה הזאת בפורמט השמור?',
    );
    expect(within(box).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['סגירה', 'להשאיר אותה', 'לשמור בלעדיה', 'ביטול']);
    await answer('לשמור בלעדיה');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    expect(managerOf(bodyOf(createFormat).rules)?.from).toBeNull();
    expect(badge()).toBe('עמודה אחת דורשת מידע מכם');
  });

  it('Hebrew, several lists: plural answers', async () => {
    await openResult(aiResult([managerList, ownerList]), 'he');
    await press('שמירת הפורמט');
    const box = dialog()!;
    expect(within(box).getByText('להשאיר את הרשימות האלה בפורמט השמור?')).toBeTruthy();
    expect(within(box).getAllByRole('button').map((b) => b.textContent).slice(1)).toEqual(['להשאיר אותן', 'לשמור בלעדיהן', 'ביטול']);
  });
});

describe('a format with no copied list', () => {
  it('saves at the first click: no dialog', async () => {
    const { createFormat } = await openResult(aiResult([], listed()));
    await press('Save format');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    expect(bodyOf(createFormat).rules).toEqual(listed());
  });
});

describe('after the first save (the Result screen is the editor of the new source)', () => {
  const renameCompany = async (to: string): Promise<void> => {
    const row = document.querySelector('[data-line-id="col:Company"]') as HTMLElement;
    fireEvent.click(within(row).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: to } });
    await waitFor(() => expect(document.querySelector(`[data-line-id="col:${to}"]`)).toBeTruthy());
  };

  it('a list kept at the first save is not asked about again: Save changes saves at once, with it', async () => {
    const { createFormat, updateConversion } = await openResult();
    await press('Save format');
    await answer('Keep it');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Save changes' });
    await renameCompany('Customer');
    await press('Save changes');
    await waitFor(() => expect(updateConversion).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    expect(bodyOf(updateConversion).rules.transform.tables).toEqual(listed().transform.tables);
  });

  it('saved without it, then put back (undo): Save changes asks again - and "Save without it" saves a new version without it', async () => {
    const { createFormat, updateConversion } = await openResult();
    await press('Save format');
    await answer('Save without it');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Save changes' });
    await press('Undo');
    await waitFor(() => expect(badge()).toBe('Verified'));
    await press('Save changes');
    expect(dialog()).toBeTruthy();
    expect(updateConversion).not.toHaveBeenCalled();
    await answer('Save without it');
    await waitFor(() => expect(updateConversion).toHaveBeenCalledTimes(1));
    const { rules, status } = bodyOf(updateConversion);
    expect(managerOf(rules)?.from).toBeNull();
    noCopiedValues(rules);
    expect(status).toBe('userConfirmed');
    expect(await screen.findByText('Saved as version 2.')).toBeTruthy();
  });

  it('... or "Keep it" saves it in the new version; Cancel saves nothing', async () => {
    const { createFormat, updateConversion } = await openResult();
    await press('Save format');
    await answer('Save without it');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Save changes' });
    await press('Undo');
    await press('Save changes');
    await answer('Cancel');
    expect(updateConversion).not.toHaveBeenCalled();
    await press('Save changes');
    await answer('Keep it');
    await waitFor(() => expect(updateConversion).toHaveBeenCalledTimes(1));
    expect(bodyOf(updateConversion).rules.transform.tables).toEqual(listed().transform.tables);
  });
});

describe('a list nothing reads any more is never saved (owner rule, 2026-10-06)', () => {
  const sent = (request: ReturnType<typeof vi.fn>, at = 0): { method: string; path: string; rules: Rules } => {
    const [method, path, body] = request.mock.calls[at] as [string, string, { rules: Rules }];
    return { method, path, rules: body.rules };
  };

  it('"Leave empty" on the list column, then Save: nothing to ask, and no table and no copied value is sent', async () => {
    const { request } = await openResult();
    const row = document.querySelector('[data-line-id="col:Account Manager"]') as HTMLElement;
    fireEvent.click(within(row).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
    fireEvent.click(await screen.findByRole('radio', { name: 'Leave empty' }));
    await waitFor(() => expect(badge()).toBe('1 column needs your input'));
    await press('Save format');
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    const { method, path, rules } = sent(request);
    expect([method, path]).toEqual(['POST', '/api/formats']);
    expect(managerOf(rules)?.from).toBeNull();
    expect(rules.transform.tables).toEqual([]);
    expect(rules.transform.computed).toEqual([]);
    noCopiedValues(rules);
  });

  it('a table that is still read is kept: "Keep it" sends the list as it is', async () => {
    const { request } = await openResult();
    await press('Save format');
    await answer('Keep it');
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(sent(request).rules).toEqual(listed());
  });

  it('the save body of a normal format is unchanged', async () => {
    const { request, createFormat } = await openResult(aiResult([], listed()));
    await press('Save format');
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect((request.mock.calls[0] as unknown[])[2]).toEqual((createFormat.mock.calls[0] as unknown[])[0]);
    // (the very rules the screen saved: nothing taken out)
    expect(sent(request).rules).toBe(bodyOf(createFormat).rules);
  });
});

// ---------------------------------------------------------------------------
// Add a source: the learn's lists are asked about when the source is saved (POST /api/formats/:id/conversions).
// ---------------------------------------------------------------------------

describe('Add a source', () => {
  const HEADERS = ['Account', 'Company', 'Account Manager'];
  const format = getFormatResponse({
    id: 'F1',
    name: 'Accounts',
    sources: [conversionSummary({ id: 'C1', sourceName: 'CRM A' })],
    detail: { outputHeaders: HEADERS, outputColumns: 3, fileType: 'xlsx', output: { file: { type: 'xlsx' }, columns: HEADERS.map((header) => ({ header })), titleRows: [], summaryRows: [], sheetName: 'S', direction: 'ltr', language: 'en' } },
  });
  const xlsx = (name: string): File => new File(['x'], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  async function openAdd(result: LearnOutput) {
    const attachSource = vi.fn(async () => ({ conversion: conversionSummary({ id: 'C2', sourceId: 'S2', sourceName: 'CRM B' }), source: { id: 'S2', name: 'CRM B', formats: 1 } }));
    const api = fakeApi({
      user: USER,
      registry: { getFormat: vi.fn(async () => format), attachSource },
      learn: vi.fn(async () => ({ rules: result.rules, verified: true, problems: [], learnId: 'L1', cached: false, counted: true, failedAttempts: 0, quota: { remaining: 2, period: 'month' as const, limit: null } })),
    });
    const liveCheck = vi.fn(async (_id: string, r: LearnResult | Rules) => live(r));
    const { engine } = fakeEngine(
      async (host: LearnHost) => {
        await host.callLearn({ masking: true } as never);
        return result;
      },
      undefined,
      {
        liveCheck,
        fullCheck: liveCheck,
        readHeaders: vi.fn(async ({ file }: { file: { name: string } }) => ({ ok: true, headers: file.name === 'crm-b.xlsx' ? HEADERS : ['Account', 'Company'], sheetName: 'S', direction: 'ltr', rows: ROWS })),
      },
    );
    renderApp({ api, engine, route: '/formats/F1/add-source' });
    await screen.findByTestId('add-format-columns');
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'CRM B' } });
    fireEvent.change(await screen.findByLabelText('Example input'), { target: { files: [csv('crm-b.csv')] } });
    fireEvent.change(await screen.findByLabelText('Example output'), { target: { files: [xlsx('crm-b.xlsx')] } });
    const learn = (): HTMLButtonElement => screen.getByRole('button', { name: /Learn this source/ }) as HTMLButtonElement;
    await waitFor(() => expect(learn().disabled).toBe(false));
    await act(async () => void fireEvent.click(learn()));
    await screen.findByTestId('rules-map');
    return { attachSource };
  }

  it('asks at "Add source"; "Save without it" adds the source without the list', async () => {
    const { attachSource } = await openAdd(aiResult());
    expect(screen.queryByTestId('one-time-question')).toBeNull();
    await press('Add source');
    expect(within(dialog()!).getByTestId('copied-list-dialog').textContent).toContain('Account Manager is a list of 40 fixed values taken from your example');
    expect(attachSource).not.toHaveBeenCalled();
    await answer('Save without it');
    await waitFor(() => expect(attachSource).toHaveBeenCalledTimes(1));
    const { rules, status } = bodyOf(attachSource);
    expect(managerOf(rules)?.from).toBeNull();
    noCopiedValues(rules);
    expect(status).toBe('userConfirmed');
    expect(await screen.findByText('Added "CRM B" to "Accounts".')).toBeTruthy();
  });

  it('"Keep it" adds it with the list; with no list there is no dialog', async () => {
    const kept = await openAdd(aiResult());
    await press('Add source');
    await answer('Keep it');
    await waitFor(() => expect(kept.attachSource).toHaveBeenCalledTimes(1));
    expect(bodyOf(kept.attachSource).rules.transform.tables).toEqual(listed().transform.tables);
    cleanup();

    const plain = await openAdd(aiResult([], listed()));
    await press('Add source');
    await waitFor(() => expect(plain.attachSource).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The saved-source editor: its rules are the server's own (a list in them was stored by the Save that asked about it). Nothing to ask.
// ---------------------------------------------------------------------------

describe('the saved-source editor', () => {
  it('saves a source whose stored rules hold a list at the first click, the list as it is', async () => {
    const stored = { ...listed(), name: 'CRM A', meta: { source: 'examplePair', status: 'verified' } } as unknown as Rules;
    const updateConversion = vi.fn(async () => patched(5));
    const api = fakeApi({
      user: USER,
      registry: {
        getConversion: vi.fn(async () => conversionDetail({ id: 'C1', version: 4, sourceName: 'CRM A' }, stored)),
        getFormat: vi.fn(async () => getFormatResponse({ id: 'F1', name: 'Accounts', sources: [conversionSummary({ id: 'C1', sourceName: 'CRM A' })] })),
        updateConversion,
      },
    });
    renderApp({ api, engine: fakeEngine().engine, route: '/formats/F1/sources/C1' });
    await screen.findByTestId('rules-map');
    const row = document.querySelector('[data-line-id="col:Company"]') as HTMLElement;
    fireEvent.click(within(row).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Customer' } });
    await press('Save changes');
    await waitFor(() => expect(updateConversion).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    expect(bodyOf(updateConversion).rules.transform.tables).toEqual(listed().transform.tables);
  });
});

// ---------------------------------------------------------------------------
// What a saved format may keep (docs/proposals/saved-format-contents.md section 6; SPEC 21 v15): one popup, a line per finding - a list of
// fixed values, an identifier-shaped value (an ID number, a phone, an email, a card or bank account number) - and the same three answers.
// ---------------------------------------------------------------------------

const ID = '039337423';
/** Account Manager (a list), and Target customer: a logic rule whose label is an ID number ("amount > 1000 -> target customer <id>"). */
function withTarget(label = ID, list = true): LearnResult {
  const base = listed();
  const target = { id: 'target', type: 'text' as const, expr: { op: 'if' as const, cond: { op: 'eq' as const, args: [{ col: 'company' }, { const: 'Acme' }] as [Expr, Expr] }, then: { const: label }, else: { const: '' } } };
  return {
    ...base,
    transform: list ? { ...base.transform, computed: [...base.transform.computed, target] } : { ...base.transform, computed: [target], tables: [] },
    output: {
      ...base.output,
      columns: [...base.output.columns.filter((c) => list || c.header !== 'Account Manager'), { header: 'Target customer', from: 'target' }],
    },
  };
}

describe('Save format: a list and an identifier-shaped value, one popup', () => {
  it('a line for each - the column, the count and the key; the column and the kind - then one question, plural answers; no value', async () => {
    const { createFormat } = await openResult(aiResult([managerList], withTarget()));
    await press('Save format');
    const box = dialog()!;
    expect(within(box).getByRole('heading').textContent).toBe('Save this format?');
    expect([...box.querySelectorAll('li')].map((li) => [li.getAttribute('data-kind'), li.textContent])).toEqual([
      ['list', 'Account Manager is a list of 40 fixed values taken from your example (one for each Account).'],
      ['israeliId', 'Target customer keeps an ID number in its rules.'],
    ]);
    expect(within(box).getByText('Keep these in the saved format?')).toBeTruthy();
    expect(within(box).getAllByRole('button').map((b) => b.textContent).slice(1)).toEqual(['Keep them', 'Save without them', 'Cancel']);
    expect(box.textContent).not.toContain(ID);
    expect(createFormat).not.toHaveBeenCalled();
  });

  it('"Keep them" saves both as they are', async () => {
    const { createFormat } = await openResult(aiResult([managerList], withTarget()));
    await press('Save format');
    await answer('Keep them');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    expect(bodyOf(createFormat).rules).toEqual(withTarget());
  });

  it('"Save without them": both columns need your input (the list: overfit; the ID: savedWithout), neither value is sent', async () => {
    const { createFormat } = await openResult(aiResult([managerList], withTarget()));
    await press('Save format');
    await answer('Save without them');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    const { rules, status } = bodyOf(createFormat);
    expect(rules.output.columns.filter((c) => c.from === null).map((c) => c.header)).toEqual(['Account Manager', 'Target customer']);
    expect(rules.unsupported).toEqual([
      { outputColumn: 'Account Manager', reasonCode: 'overfit' },
      { outputColumn: 'Target customer', reasonCode: 'savedWithout' },
    ]);
    expect(JSON.stringify(rules)).not.toContain(ID);
    noCopiedValues(rules);
    expect(status).toBe('userConfirmed');
    expect(badge()).toBe('2 columns need your input');
  });

  it('"Cancel" saves nothing', async () => {
    const { createFormat } = await openResult(aiResult([managerList], withTarget()));
    await press('Save format');
    await answer('Cancel');
    expect(dialog()).toBeNull();
    expect(createFormat).not.toHaveBeenCalled();
  });

  it('an identifier alone: its own question and answers ("Keep it" saves it)', async () => {
    const { createFormat } = await openResult(aiResult([], withTarget(ID, false)));
    await press('Save format');
    const box = dialog()!;
    expect(within(box).getByTestId('copied-list-dialog').textContent).toBe('Target customer keeps an ID number in its rules. Keep it in the saved format?');
    expect(within(box).getAllByRole('button').map((b) => b.textContent).slice(1)).toEqual(['Keep it', 'Save without it', 'Cancel']);
    await answer('Keep it');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(bodyOf(createFormat).rules)).toContain(ID);
  });

  it.each([
    ['a phone number', '050-1234567'],
    ['an email address', 'dana@example.com'],
    ['a card number', '4111 1111 1111 1111'],
    ['a bank account number', 'IL62 0108 0000 0009 9999 999'],
  ])('says %s by its kind', async (what, label) => {
    await openResult(aiResult([], withTarget(label, false)));
    await press('Save format');
    expect(within(dialog()!).getByTestId('copied-list-dialog').textContent).toBe(`Target customer keeps ${what} in its rules. Keep it in the saved format?`);
  });

  it('has its Hebrew copy: both reasons, plural answers', async () => {
    const { createFormat } = await openResult(aiResult([managerList], withTarget()), 'he');
    await press('שמירת הפורמט');
    const box = dialog()!;
    expect(within(box).getByRole('heading').textContent).toBe('לשמור את הפורמט?');
    expect([...box.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'העמודה Account Manager היא רשימה של 40 ערכים קבועים שנלקחו מהדוגמה שלכם (אחד לכל Account).',
      'הכללים של העמודה Target customer שומרים מספר זהות.',
    ]);
    expect(within(box).getByText('להשאיר את כל אלה בפורמט השמור?')).toBeTruthy();
    expect(within(box).getAllByRole('button').map((b) => b.textContent).slice(1)).toEqual(['להשאיר אותם', 'לשמור בלעדיהם', 'ביטול']);
    await answer('לשמור בלעדיהם');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(bodyOf(createFormat).rules)).not.toContain(ID);
  });

  it('Hebrew, an identifier alone', async () => {
    await openResult(aiResult([], withTarget(ID, false)), 'he');
    await press('שמירת הפורמט');
    const box = dialog()!;
    expect(within(box).getByTestId('copied-list-dialog').textContent).toBe('הכללים של העמודה Target customer שומרים מספר זהות. להשאיר את הערך הזה בפורמט השמור?');
    expect(within(box).getAllByRole('button').map((b) => b.textContent).slice(1)).toEqual(['להשאיר אותו', 'לשמור בלעדיו', 'ביטול']);
  });
});

describe('no popup for a small vocabulary or ledger-account labels', () => {
  it('a status translation (no list found by the engine) and 8-digit ledger accounts as labels: Save saves at the first click', async () => {
    const base = withTarget('61000100', false);
    const rules: LearnResult = { ...base, transform: { ...base.transform, valueMaps: [{ column: 'company', map: { Open: 'פתוח', Closed: 'סגור' }, onMissing: 'keep' }] } };
    const { createFormat } = await openResult(aiResult([], rules));
    await press('Save format');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    expect(JSON.stringify(bodyOf(createFormat).rules)).toContain('61000100');
  });
});

describe('a save over a cap of what a saved format may keep', () => {
  it.each(['en', 'he'] as const)('the refusal of the server (400 rulesTooLarge) is said in plain words (%s)', async (lang) => {
    const liveCheck = vi.fn(async (_id: string, r: LearnResult | Rules) => live(r));
    const fake = fakeEngine(async () => aiResult([], listed()), undefined, { liveCheck, fullCheck: liveCheck });
    const createFormat = vi.fn(async () => Promise.reject(new ApiError('rulesTooLarge', 400)));
    renderApp({ engine: fake.engine, api: fakeApi({ user: USER, registry: { createFormat } }), lang, dataRouter: true });
    const en = lang === 'en';
    fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('accounts.csv')] } });
    fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('managers.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    const learn = screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ }) as HTMLButtonElement;
    await waitFor(() => expect(learn.disabled).toBe(false));
    await act(async () => void fireEvent.click(learn));
    await screen.findByTestId('rules-map');
    await press(en ? 'Save format' : 'שמירת הפורמט');
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    const text = en
      ? 'This format is too large to save: a list, a value or a title in its rules is longer than a saved format may keep. Shorten it and try again.'
      : 'הפורמט הזה גדול מדי לשמירה: רשימה, ערך או כותרת בכללים שלו ארוכים יותר ממה שפורמט שמור יכול להכיל. קצרו אותם ונסו שוב.';
    expect(await screen.findByText(text)).toBeTruthy();
  });
});

describe('the saved-source editor: what the server already holds is not asked again', () => {
  it('stored rules that keep an ID number save at the first click, the ID as it is', async () => {
    const stored = { ...withTarget(), name: 'CRM A', meta: { source: 'examplePair', status: 'verified' } } as unknown as Rules;
    const updateConversion = vi.fn(async () => patched(5));
    const api = fakeApi({
      user: USER,
      registry: {
        getConversion: vi.fn(async () => conversionDetail({ id: 'C1', version: 4, sourceName: 'CRM A' }, stored)),
        getFormat: vi.fn(async () => getFormatResponse({ id: 'F1', name: 'Accounts', sources: [conversionSummary({ id: 'C1', sourceName: 'CRM A' })] })),
        updateConversion,
      },
    });
    renderApp({ api, engine: fakeEngine().engine, route: '/formats/F1/sources/C1' });
    await screen.findByTestId('rules-map');
    const row = document.querySelector('[data-line-id="col:Company"]') as HTMLElement;
    fireEvent.click(within(row).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Customer' } });
    await press('Save changes');
    await waitFor(() => expect(updateConversion).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    expect(JSON.stringify(bodyOf(updateConversion).rules)).toContain(ID);
  });
});
