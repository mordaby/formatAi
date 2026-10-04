// learn-v7 (issue #40, SPEC 8.10, 15): what the AI step noted about a column it could not build - its plain-language GUESS ("The AI's guess (not
// applied): ...", unmasked, real words) and the note that a function request was recorded - is shown in the session on the map line and in the
// Deep analysis panel, and is NEVER persisted: not in the rules, not in a save, not in IndexedDB. The engine and the API are fakes.
import type { AiColumnNote, LearnResult, Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRegistryApi } from '../src/api/registry';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { ordersRules } from '../src/editor/testkit';
import { applyCompletionNotes, type ResultSession } from '../src/pages/Result/session';
import type { LearnOutput } from '../src/worker/engineApi';
import { conversionSummary, createFormatResponse, formatSummary } from './helpers/registryKit';
import { csv, fakeApi, fakeEngine, learnResult, renderApp, USER } from './helpers/renderApp';

vi.mock('../src/app/redirect', () => ({ redirectTo: vi.fn() }));
const { downloaded } = vi.hoisted(() => ({ downloaded: vi.fn() }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));

const SUMMARY = { rowsIn: 3, rowsOut: 3, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] };
const converted = (): unknown => ({ ok: true, bytes: new ArrayBuffer(8), flags: [], summary: SUMMARY, preview: { name: 'Out', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] }, totalRows: 3 });

const GUESS = 'Looks like the shipping code of each supplier.';
const NOTE: AiColumnNote = { header: 'Remarks', explanation: GUESS, functionRecorded: true };

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

const partialOutput = (): LearnOutput =>
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
  });

interface Args {
  complete?: { fixedRules: LearnResult; columns: number[]; parts: string[] };
}

/** The AI step's answer: Total, Shipped and the summary row produced; Remarks reported unsupported, with the notes beside the (clean) rules, as the engine returns them. */
function answerWithNotes(a: Args, notes: AiColumnNote[] = [NOTE]): LearnOutput {
  const fixed = a.complete!.fixedRules;
  const full = ordersRules();
  const rules: LearnResult = {
    ...fixed,
    transform: { ...fixed.transform, computed: full.transform.computed },
    output: {
      ...fixed.output,
      columns: fixed.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: 'total' } : c.header === 'Shipped' ? { ...c, from: 'shipped' } : c)),
      summaryRows: full.output.summaryRows,
    },
    unsupported: [{ outputColumn: 'Remarks', reasonCode: 'externalData' }],
  };
  return learnResult({
    path: 'llm',
    rules,
    aiNotes: notes,
    completion: { columns: a.complete!.columns, parts: a.complete!.parts, fixedProblems: [], matches: true, produced: { columns: 2, parts: 1 } },
    verification: { verified: true, matched: 30, total: 30, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
  });
}

function engineWith(next: (args: Args) => LearnOutput, first: () => LearnOutput = partialOutput) {
  const fake = fakeEngine(undefined, undefined, { convert: vi.fn(async () => converted()) });
  fake.learn.mockImplementation(async (args: unknown) => (fake.learn.mock.calls.length > 1 ? next(args as Args) : first()));
  return fake;
}

async function toResult(engine: ReturnType<typeof fakeEngine>['engine'], api = fakeApi({ user: USER }), lang: 'en' | 'he' = 'en') {
  renderApp({ engine, api, ...(lang === 'he' ? { lang } : {}) });
  const en = lang === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('Orders report.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ })));
  await screen.findByTestId('rules-map');
  return api;
}

const line = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-line-id="${id}"]`);
  if (!el) throw new Error(`no line ${id}`);
  return el as HTMLElement;
};
const run = async (lang: 'en' | 'he' = 'en') => {
  fireEvent.click(screen.getByRole('button', { name: lang === 'en' ? 'Run deep analysis with AI' : 'הפעלת ניתוח מעמיק עם AI' }));
  await screen.findByTestId('completion-done');
};

describe('the AI guess and the function-request note, in the session only', () => {
  it('shows "The AI\'s guess (not applied): ..." with the real (unmasked) words on the map line of the unsupported column, next to the way to fill it in yourself', async () => {
    const { engine } = engineWith((a) => answerWithNotes(a));
    await toResult(engine);
    await run();

    const remarks = line('col:Remarks');
    expect(remarks.getAttribute('data-status')).toBe('needsInput');
    const guess = within(remarks).getByTestId('ai-guess');
    expect(guess.textContent).toBe(`The AI's guess (not applied): ${GUESS}`);
    expect(within(remarks).getByRole('button', { name: 'Fill in' })).toBeTruthy(); // the guess is never applied: the user still fills the column in
    expect(within(remarks).getByTestId('function-recorded').textContent).toBe("This needs a function we don't have yet — we've recorded it.");
  });

  it('shows it in the Deep analysis panel too, under the field', async () => {
    const { engine } = engineWith((a) => answerWithNotes(a));
    await toResult(engine);
    await run();
    const panel = screen.getByTestId('deep-panel');
    const guess = within(panel).getByTestId('deep-guess');
    expect(guess.textContent).toContain(`The AI's guess (not applied): ${GUESS}`);
    expect(guess.textContent).toContain("This needs a function we don't have yet — we've recorded it.");
  });

  it('says both in Hebrew', async () => {
    const { engine } = engineWith((a) => answerWithNotes(a, [{ header: 'Remarks', explanation: 'נראה כמו קוד המשלוח של כל ספק.', functionRecorded: true }]));
    await toResult(engine, fakeApi({ user: USER }), 'he');
    await run('he');
    const remarks = line('col:Remarks');
    expect(within(remarks).getByTestId('ai-guess').textContent).toBe('הניחוש של ה-AI (לא הוחל): נראה כמו קוד המשלוח של כל ספק.');
    expect(within(remarks).getByTestId('function-recorded').textContent).toBe('זה דורש פונקציה שעדיין אין לנו — רשמנו אותה.');
  });

  it('a column with only a guess says only the guess; a column with only a recorded request says only that; a column with neither says neither', async () => {
    const { engine } = engineWith((a) => answerWithNotes(a, [{ header: 'Remarks', explanation: GUESS }]));
    await toResult(engine);
    await run();
    expect(within(line('col:Remarks')).getByTestId('ai-guess')).toBeTruthy();
    expect(within(line('col:Remarks')).queryByTestId('function-recorded')).toBeNull();
    expect(within(line('col:Total')).queryByTestId('ai-guess')).toBeNull();
  });

  it('a result with no notes shows no guess and no recorded-request line anywhere', async () => {
    const { engine } = engineWith((a) => answerWithNotes(a, []));
    await toResult(engine);
    await run();
    expect(document.querySelector('[data-testid="ai-guess"]')).toBeNull();
    expect(document.querySelector('[data-testid="function-recorded"]')).toBeNull();
    expect(document.querySelector('[data-testid="deep-guess"]')).toBeNull();
  });
});

describe('never persisted', () => {
  it('saving the format sends rules with no explanation and no function request (and nothing of the guess)', async () => {
    const created = createFormatResponse({ format: formatSummary({ id: 'F1', name: 'Orders report' }), conversion: conversionSummary({ id: 'C1', formatId: 'F1' }) });
    const createFormat = vi.fn(async () => created);
    const api = fakeApi({ user: USER, registry: { createFormat } });
    const { engine } = engineWith((a) => answerWithNotes(a));
    await toResult(engine, api);
    await run();
    const save = (await screen.findByRole('button', { name: 'Save format' })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    const body = (createFormat.mock.calls[0] as unknown as [{ rules: LearnResult }])[0];
    const sent = JSON.stringify(body);
    expect(sent).not.toContain(GUESS);
    expect(sent).not.toMatch(/explanation|functionRequest|lookupSite/);
    expect(body.rules.unsupported).toEqual([{ outputColumn: 'Remarks', reasonCode: 'externalData' }]);
  });

  it('the registry API client strips the notes at the boundary, whatever the caller passes (create, attach, update)', async () => {
    const request = vi.fn(async () => ({}));
    const api = createRegistryApi(request as never);
    const rules = {
      ...ordersRules(),
      unsupported: [{ outputColumn: 'Remarks', reasonCode: 'externalData' as const, explanation: GUESS, functionRequest: { name: 'lookupSite', purpose: 'x', args: [], returns: 'text' as const } }],
    };
    const base = { rules, status: 'verified' as const, acceptedDifferences: 0, exampleExceptions: [], learnPath: 'llm' as const, masking: false };
    await api.createFormat({ ...base, name: 'N' } as never);
    await api.attachSource('F1', base as never);
    await api.updateConversion('C1', { rules, status: 'verified', acceptedDifferences: 0 } as never);
    expect(request).toHaveBeenCalledTimes(3);
    for (const call of request.mock.calls as unknown as [string, string, unknown][]) {
      const sent = JSON.stringify(call[2]);
      expect(sent).not.toContain(GUESS);
      expect(sent).not.toMatch(/explanation|functionRequest|lookupSite/);
    }
    // a body with no rules (a rename) is passed through untouched
    await api.updateConversion('C1', { sourceName: 'Supplier' } as never);
    expect((request.mock.calls[3] as unknown as [string, string, unknown])[2]).toEqual({ sourceName: 'Supplier' });
  });

  it('the session keeps the notes apart from the rules: a later completion replaces the notes of the columns it was asked for only', () => {
    const session = { aiNotes: [{ header: 'Remarks', explanation: 'old' }, { header: 'Other', explanation: 'keep me' }] } as unknown as ResultSession;
    applyCompletionNotes(session, ['Remarks'], [{ header: 'Remarks', explanation: 'new' }, { header: 'NotAsked', explanation: 'ignored' }]);
    expect(session.aiNotes).toEqual([{ header: 'Other', explanation: 'keep me' }, { header: 'Remarks', explanation: 'new' }]);
    applyCompletionNotes(session, ['Remarks'], []); // asked again, now has a rule: its note goes
    expect(session.aiNotes).toEqual([{ header: 'Other', explanation: 'keep me' }]);
    applyCompletionNotes(session, ['Other'], []);
    expect(session.aiNotes).toBeUndefined();
  });
});
