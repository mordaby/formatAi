// A second rule the AI step gave for a column, that also fits every row (learn-v8; SPEC 8.11, 21 v12 item 17): the result screen asks the
// existing ambiguity question - the answer's rule (kept for now) or the alternative, each said in the rules map's own words - and until the
// user answers, the Checks section shows the sameAs check that flags a run-time row where the two differ. Answering with the alternative
// applies its formula (one undoable step, the check goes). The question is made by the engine's `resolveAlternatives` exactly as `judge` does;
// the live check and the API are fakes.
import { resolveAlternatives, type VerifyResult } from '@formatai/engine';
import type { Expr, LearnAlternative, LearnResult } from '@formatai/shared';
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

const N = 24;
const cutoff = (n: number, op: 'gte' | 'gt'): Expr => ({ op: 'if', cond: { op, args: [{ col: 'amount' }, { const: n }] }, then: { const: 'Urgent' }, else: { const: 'Normal' } }) as Expr;

const answer: LearnResult = {
  schemaVersion: 1,
  input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'order', header: 'Order', type: 'text' }, { id: 'amount', header: 'Amount', type: 'decimal' }] },
  transform: { computed: [{ id: 'priority', type: 'text', expr: cutoff(5000, 'gte') }], valueMaps: [], sort: [] },
  output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Order', from: 'order' }, { header: 'Priority', from: 'priority' }] },
  validations: [],
  unsupported: [],
  assumptions: [],
};
const alternative: LearnAlternative = { outputColumn: 'Priority', from: 'priorityAlt', computed: [{ id: 'priorityAlt', type: 'text', expr: cutoff(4800, 'gt') }] };
const fits: VerifyResult = { verified: true, matched: N, total: N, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] };

/** What the worker returns for an AI learn whose alternative also fits every row: the rules with the check, and the question. */
function aiResult(): LearnOutput {
  const resolved = resolveAlternatives({ rules: answer, masked: answer, verification: fits, alternatives: [alternative], verifyColumn: () => fits });
  return learnResult({
    path: 'llm',
    rules: resolved.rules,
    alternatives: resolved.results,
    ambiguous: resolved.results.flatMap((r) => (r.question ? [r.question] : [])),
    exampleId: 'ex1',
    loop: { rounds: 0, rowsSent: 0, end: 'verified' },
    verification: fits,
  });
}

const okLive = async (_id: string, r: LearnResult) =>
  liveResult({ matched: N, total: N, perColumn: r.output.columns.map((c) => ({ header: c.header, inExample: true, matched: N, total: N })), checkedInputRows: N, totalInputRows: N });

async function openWith(first: LearnOutput) {
  const liveCheck = vi.fn(okLive);
  const fake = fakeEngine(undefined, undefined, { liveCheck, fullCheck: liveCheck });
  fake.learn.mockImplementation(async () => first);
  const api = fakeApi({ user: USER });
  renderApp({ engine: fake.engine, api, lang: 'en' });
  fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('priority.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  await waitFor(() => expect((screen.getByRole('button', { name: /Learn the format/ }) as HTMLButtonElement).disabled).toBe(false));
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Learn the format/ })));
  await screen.findByTestId('rules-map');
  await waitFor(() => expect(liveCheck).toHaveBeenCalled());
  return { ...fake, api, liveCheck };
}

const lastRules = (liveCheck: ReturnType<typeof vi.fn>): LearnResult => liveCheck.mock.calls.at(-1)![1] as LearnResult;
const checkLines = (): string[] => [...document.querySelectorAll('[data-section="checks"] [data-line-id]')].map((e) => e.textContent ?? '');

describe('the question about an alternative rule', () => {
  it('is asked on the column, each rule in the map\'s words; the check that flags a differing row is in the Checks section - no AI call', async () => {
    const { api, learn } = await openWith(aiResult());
    const q = await screen.findByTestId('reading-question');
    expect(document.querySelector('[data-line-id="col:Priority"]')!.contains(q)).toBe(true);
    expect(q.textContent).toContain('Which one is Priority?');
    const choices = within(q).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(choices).toHaveLength(3);
    expect(choices[0]).toContain('5000');
    expect(choices[1]).toContain('4800');
    expect(choices[2]).toBe('Not sure yet');
    expect(checkLines().some((l) => l.includes('your example also fits') && l.includes('4800'))).toBe(true);
    expect(api.learn).not.toHaveBeenCalled();
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it('answering with the alternative applies its formula and takes the check out - one undoable step; undo asks again', async () => {
    const { liveCheck } = await openWith(aiResult());
    const q = await screen.findByTestId('reading-question');
    await act(async () => void fireEvent.click(within(q).getAllByRole('button')[1]!));
    await waitFor(() => expect(screen.queryByTestId('reading-question')).toBeNull());
    await waitFor(() => expect(lastRules(liveCheck).output.columns[1]!.from).toBe('priorityAlt'));
    const now = lastRules(liveCheck);
    expect(now.transform.computed).toEqual([{ id: 'priorityAlt', type: 'text', expr: cutoff(4800, 'gt') }]);
    expect(now.validations).toEqual([]);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Undo' })));
    expect(await screen.findByTestId('reading-question')).toBeTruthy();
  });

  it('"Not sure yet" keeps the answer\'s rule and says a differing row is flagged', async () => {
    await openWith(aiResult());
    const q = await screen.findByTestId('reading-question');
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'Not sure yet' })));
    const unsure = await screen.findByTestId('reading-unsure');
    expect(unsure.textContent).toMatch(/Not sure yet\. For now: .*5000.*We flag a row where .*4800.* would give a different value\./);
  });
});
