// The ambiguity question (SPEC 8.11, 16.1 screen 4, 21 v12 item 11): the example fits more than one rule for a column (a constant the input could
// write too: "00" or the first 2 digits of Employee number), so the result screen asks ONCE, quietly, on that column's line. The answer is the
// rule - no AI call. Unanswered ("Not sure yet") keeps the data reading with a visible, deletable check that flags a row where the readings
// differ. The question does not depend on the AI step, and the column is never one of the fields the AI step is asked for.
// The engine is real for what it analyses (the readings come from `analyzePair` over a synthetic pair, exactly as the worker makes them); the
// worker's live check and the API are fakes.
import { analyzePair, ambiguousColumns, fastPath, partialRules, preflight, type PairAnalysis, type RawWorkbook } from '@formatai/engine';
import type { LearnResult } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import type { LearnOutput } from '../src/worker/engineApi';
import { csv, fakeApi, fakeEngine, learnResult, liveResult, renderApp, USER } from './helpers/renderApp';

vi.mock('../src/app/redirect', () => ({ redirectTo: vi.fn() }));

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPendingStore(undefined);
});

// ---------- a synthetic pair, analysed by the real engine ----------

const N = 24;
const wb = (rows: (string | number | null)[][]): RawWorkbook => ({
  fileType: 'xlsx',
  sheets: [{ name: 'Sheet1', rows: rows.map((r) => r.map((v) => (v === null ? null : { v }))), merges: [], hiddenRows: [], hiddenCols: [], colWidths: [] }],
});

interface Names {
  ref: string;
  employee: string;
  branch: string;
  note: string;
}
const EN: Names = { ref: 'Ref', employee: 'Employee number', branch: 'Branch code', note: 'Note' };
const HE: Names = { ref: 'מספר פנימי', employee: 'מספר עובד', branch: 'קוד סניף', note: 'הערה' };

/** Every employee number starts with "00", and so does the Branch code column: a fixed code, or the first 2 digits of the number? */
function pair(n: Names, opts: { withNote?: boolean } = {}): PairAnalysis {
  const input: (string | number | null)[][] = [[n.ref, n.employee]];
  const output: (string | number | null)[][] = [opts.withNote ? [n.ref, n.employee, n.branch, n.note] : [n.ref, n.employee, n.branch]];
  for (let i = 0; i < N; i++) {
    const ref = `R-${1000 + i * 7}`;
    const emp = `00${3100 + i * 17}`;
    input.push([ref, emp]);
    // (a note nothing in the input can write)
    output.push(opts.withNote ? [ref, emp, '00', `${String.fromCharCode(97 + ((i * 7) % 26))}${(i * 131) % 977}`] : [ref, emp, '00']);
  }
  const a = analyzePair(wb(input), wb(output));
  if (!a.ok) throw new Error('analysis failed');
  return a;
}

/** What the worker returns for the free engine: the strict path when it builds everything, else the partial result. */
function freeResult(a: PairAnalysis): LearnOutput {
  const pf = preflight(a, 'registered');
  const ambiguous = ambiguousColumns(a);
  const fp = fastPath(a, pf);
  if ('rules' in fp) {
    return learnResult({ path: 'local', rules: fp.rules, ambiguous, exampleId: 'ex1' });
  }
  const p = partialRules(a, pf);
  if ('reason' in p) throw new Error(`no partial result: ${p.reason}`);
  return learnResult({
    path: 'partial',
    rules: p.rules,
    ambiguous,
    exampleId: 'ex1',
    partial: { reason: 'aiNotAllowed', solved: p.solved, needsAi: p.needsAi, external: p.external, solvedColumns: p.solvedColumns, needsAiParts: p.needsAiParts },
    readiness: { ready: true },
    verification: { verified: false, matched: N, total: N, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
  });
}

/** A live check that matches every row of whatever rules it is given. */
const okLive = async (_id: string, r: LearnResult) =>
  liveResult({ matched: N, total: N, perColumn: r.output.columns.map((c) => ({ header: c.header, inExample: true, matched: N, total: N })), checkedInputRows: N, totalInputRows: N });

async function dropFiles(lang: 'en' | 'he') {
  const en = lang === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('employees.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('branches.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
}

async function openWith(first: LearnOutput, opts: { lang?: 'en' | 'he'; user?: boolean; next?: (args: unknown) => LearnOutput } = {}) {
  const lang = opts.lang ?? 'en';
  const liveCheck = vi.fn(okLive);
  const fake = fakeEngine(undefined, undefined, { liveCheck, fullCheck: liveCheck });
  fake.learn.mockImplementation(async (args: unknown) => (fake.learn.mock.calls.length > 1 && opts.next ? opts.next(args) : first));
  const api = fakeApi(opts.user ? { user: USER } : {});
  renderApp({ engine: fake.engine, api, lang });
  await dropFiles(lang);
  if (opts.user) await waitFor(() => expect((screen.getByRole('button', { name: lang === 'en' ? /Learn the format/ : /ללמוד את הפורמט/ }) as HTMLButtonElement).disabled).toBe(false));
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: lang === 'en' ? /Learn the format/ : /ללמוד את הפורמט/ })));
  await screen.findByTestId('rules-map');
  await waitFor(() => expect(liveCheck).toHaveBeenCalled());
  return { ...fake, api };
}

const line = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-line-id="${id}"]`);
  if (!el) throw new Error(`no line ${id}: ${[...document.querySelectorAll('[data-line-id]')].map((e) => e.getAttribute('data-line-id')).join(', ')}`);
  return el as HTMLElement;
};
const question = (): HTMLElement | null => screen.queryByTestId('reading-question');
const checkLines = (): string[] => [...document.querySelectorAll('[data-section="checks"] [data-line-id]')].map((e) => e.textContent ?? '');
const oneOfChecks = (): string[] => checkLines().filter((t) => /one of|אחד מ/.test(t));

describe('the question', () => {
  it('is asked on the column\'s own line, quietly, with each answer said in the rules map\'s words - and nothing was sent to the AI', async () => {
    const { learn, api } = await openWith(freeResult(pair(EN)));
    const q = (await screen.findByTestId('reading-question')) as HTMLElement;
    // On the line of the column in the Columns section: not a modal, not a banner.
    expect(line('col:Branch code').contains(q)).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(q.textContent).toContain('Which one is Branch code?');
    const buttons = within(q).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([expect.stringMatching(/fixed value.*00/), expect.stringMatching(/first 2 characters of.*Employee number/), 'Not sure yet']);
    // The column is built from the data reading, with the check that marks the question as open (visible in the Checks section, deletable).
    expect(line('col:Branch code').textContent).toMatch(/first 2 characters of/);
    expect(oneOfChecks()).toHaveLength(1);
    expect(oneOfChecks()[0]).toMatch(/Branch code.*00/);
    // No amber for a question: the line is an ordinary "matches" line, and it is not "missing" for the AI step.
    expect(line('col:Branch code').getAttribute('data-status')).toBe('matches');
    expect(screen.queryByTestId('deep-panel')).toBeNull();
    expect(learn).toHaveBeenCalledTimes(1);
    expect(api.learn).not.toHaveBeenCalled();
  });

  it('answering "fixed value" makes it the rule and takes the check out - one undoable step, no AI call', async () => {
    const { api, learn } = await openWith(freeResult(pair(EN)));
    const q = await screen.findByTestId('reading-question');
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: /fixed value/ })));
    expect(question()).toBeNull();
    expect(line('col:Branch code').textContent).toMatch(/fixed value.*00/);
    expect(oneOfChecks()).toEqual([]);
    expect(api.learn).not.toHaveBeenCalled();
    expect(learn).toHaveBeenCalledTimes(1);
    // Undo puts the question back (the check is its marker).
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Undo' })));
    expect(await screen.findByTestId('reading-question')).toBeTruthy();
    expect(oneOfChecks()).toHaveLength(1);
    expect(line('col:Branch code').textContent).toMatch(/first 2 characters of/);
  });

  it('answering with the data reading keeps the rule and takes the check out', async () => {
    await openWith(freeResult(pair(EN)));
    const q = await screen.findByTestId('reading-question');
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: /first 2 characters of/ })));
    expect(question()).toBeNull();
    expect(line('col:Branch code').textContent).toMatch(/first 2 characters of/);
    expect(oneOfChecks()).toEqual([]);
  });

  it('"Not sure yet" keeps the data reading and the check, folds the question into one line, and can be opened again', async () => {
    const { api } = await openWith(freeResult(pair(EN)));
    const q = await screen.findByTestId('reading-question');
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'Not sure yet' })));
    const folded = await screen.findByTestId('reading-unsure');
    expect(folded.textContent).toMatch(/Not sure yet\. For now: the first 2 characters of.*Employee number\. We flag a row where fixed value.*00.* would give a different value\./);
    expect(line('col:Branch code').textContent).toMatch(/first 2 characters of/);
    expect(oneOfChecks()).toHaveLength(1);
    expect(api.learn).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(within(question()!).getByRole('button', { name: 'Choose' })));
    expect(screen.queryByTestId('reading-unsure')).toBeNull();
    expect(question()!.textContent).toContain('Which one is Branch code?');
  });

  it('deleting the check in the editor closes the question: the check is its marker, and the user\'s to delete', async () => {
    await openWith(freeResult(pair(EN)));
    await screen.findByTestId('reading-question');
    const checks = [...document.querySelectorAll('[data-section="checks"] [data-line-id]')];
    const at = checks.findIndex((e) => /one of/.test(e.textContent ?? ''));
    fireEvent.click(within(checks[at] as HTMLElement).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
    fireEvent.click(await screen.findByRole('button', { name: /Delete this check|Remove this check|Delete|Remove/ }));
    await waitFor(() => expect(question()).toBeNull());
    expect(oneOfChecks()).toEqual([]);
  });

  it('has its Hebrew copy', async () => {
    await openWith(freeResult(pair(HE)), { lang: 'he' });
    const q = await screen.findByTestId('reading-question');
    expect(q.textContent).toContain('מה נכון בעמודה קוד סניף?');
    expect(q.textContent).toContain('הדוגמה שלכם מתאימה לכל אחד מהם, אבל בנתונים אחרים הם יתנו תוצאות שונות.');
    const labels = within(q).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(labels[0]).toMatch(/ערך קבוע/);
    expect(labels[1]).toMatch(/2 התווים הראשונים של/);
    expect(labels[2]).toBe('עוד לא בטוחים');
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'עוד לא בטוחים' })));
    expect((await screen.findByTestId('reading-unsure')).textContent).toMatch(/^עוד לא בטוחים\. בינתיים: .*נסמן שורה שבה .* היה נותן ערך אחר\.$/);
  });
});

describe('the AI step never gets this column', () => {
  const missingNote = (): LearnOutput => freeResult(pair(EN, { withNote: true }));

  it('the free result has it solved: the panel lists only what has no rule, and "Finish with AI" asks for that alone', async () => {
    const out = missingNote();
    expect(out.path).toBe('partial');
    const noteAt = out.rules!.output.columns.findIndex((c) => c.header === 'Note');
    const { learn } = await openWith(out, { user: true, next: () => learnResult({ path: 'llm', rules: out.rules, completion: { columns: [noteAt], parts: [], fixedProblems: [], matches: true, produced: { columns: 0, parts: 0 } } }) });
    // The panel counts the question's column as solved ("3 of 4"), and lists "Note" only.
    const panel = await screen.findByTestId('deep-panel');
    expect(panel.textContent).toContain('solved 3 of 4');
    expect(within(screen.getByTestId('deep-fields')).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringMatching(/^Note/)]);
    expect(line('col:Branch code').getAttribute('data-ai-step')).toBeNull();
    expect(line('col:Branch code').getAttribute('data-status')).toBe('matches');
    // ... and the question is there next to it.
    expect(await screen.findByTestId('reading-question')).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Finish with AI' })));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    expect(learn.mock.calls[1]![0]).toMatchObject({ ai: 'allowed', complete: { columns: [noteAt] } });
    // The answer was asked for Note only: the rules it must keep hold the data reading and its check.
    const fixed = (learn.mock.calls[1]![0] as { complete: { fixedRules: LearnResult } }).complete.fixedRules;
    expect(fixed.output.columns.find((c) => c.header === 'Branch code')!.from).not.toBeNull();
    expect(fixed.validations.filter((v) => v.rule === 'oneOf')).toHaveLength(1);
  });

  it('an answer given before it still holds when the AI step runs', async () => {
    const out = missingNote();
    const noteAt = out.rules!.output.columns.findIndex((c) => c.header === 'Note');
    const { learn } = await openWith(out, { user: true, next: () => learnResult({ path: 'llm', rules: out.rules }) });
    const q = await screen.findByTestId('reading-question');
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: /fixed value/ })));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Finish with AI' })));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    const call = learn.mock.calls[1]![0] as { complete: { columns: number[]; fixedRules: LearnResult } };
    expect(call.complete.columns).toEqual([noteAt]);
    const fixed = call.complete.fixedRules;
    const from = fixed.output.columns.find((c) => c.header === 'Branch code')!.from;
    expect(fixed.transform.computed.find((c) => c.id === from)?.expr).toEqual({ const: '00' });
    expect(fixed.validations.filter((v) => v.rule === 'oneOf')).toEqual([]);
  });
});

describe('it does not depend on the AI step', () => {
  it('a whole learn by the AI step that wrote the column its own way (a constant): the same question is asked, with the data reading as the default', async () => {
    const a = pair(EN);
    const free = freeResult(a);
    // What an AI answer could look like: the constant, no check.
    const constant = ambiguousColumns(a)[0]!;
    const rules = structuredClone(free.rules!) as LearnResult;
    const constantFragment = constant.readings[0]!.fragment;
    rules.transform.computed = [...rules.transform.computed.filter((c) => c.id !== rules.output.columns[2]!.from), ...constantFragment.computed];
    rules.output.columns[2] = { ...rules.output.columns[2]!, from: constantFragment.from };
    rules.validations = rules.validations.filter((v) => v.rule !== 'oneOf');
    const out = learnResult({
      path: 'llm',
      rules,
      ambiguous: [constant],
      exampleId: 'ex1',
      loop: { rounds: 0, rowsSent: 0, end: 'verified' },
      verification: { verified: true, matched: N, total: N, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    });
    await openWith(out, { user: true });
    const q = await screen.findByTestId('reading-question');
    expect(q.textContent).toContain('Which one is Branch code?');
    expect(line('col:Branch code').textContent).toMatch(/first 2 characters of/);
    expect(oneOfChecks()).toHaveLength(1);
  });

  it('no question for a result without ambiguous columns (a real constant label)', async () => {
    await openWith(learnResult({ path: 'local' }));
    expect(question()).toBeNull();
  });
});
