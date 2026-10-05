// What code filled in an AI answer (SPEC 21 v12 items 15, 16): the learn result carries kinds and counts only (`filled`), and after an AI learn the
// Result screen says it in one quiet line under the learn path - "Completed from your example: 40 lookup entries, 1 cut-off (please confirm the
// check)" - each kind in its own words, in both languages. Nothing amber, nothing when code filled nothing, nothing for a local result.
import type { FillSummary } from '@formatai/engine';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { translate } from '../src/i18n';
import { filledNote } from '../src/pages/Result/filledNote';
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

const say = (lang: 'en' | 'he') => (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(lang, key, params);
const summary = (filled: FillSummary['filled'], checks = 0): FillSummary => ({ filled, checks });

describe('filledNote', () => {
  it('says each kind in its own words, the way the engine lists them, with the check to confirm', () => {
    const f = summary([{ kind: 'lookup', count: 40 }, { kind: 'cutoff', count: 1 }], 1);
    expect(filledNote(f, say('en'))).toBe('Completed from your example: 40 lookup entries, 1 cut-off (please confirm the check)');
    expect(filledNote(f, say('he'))).toBe('הושלם מהדוגמה שלכם: 40 רשומות חיפוש, סף אחד (אשרו את הבדיקה)');
  });

  it('has the singular and the plural of every kind in both languages, and a line for several checks', () => {
    const kinds = ['lookup', 'valueMap', 'valueList', 'cutoff', 'band', 'dayMonthOrder', 'dedupeKeep', 'filterList'] as const;
    for (const lang of ['en', 'he'] as const) {
      for (const kind of kinds) {
        const one = filledNote(summary([{ kind, count: 1 }]), say(lang))!;
        const many = filledNote(summary([{ kind, count: 7 }]), say(lang))!;
        // (the count is said, except for the one that is never more than one)
        if (kind !== 'dedupeKeep') {
          expect([lang, kind, one]).not.toEqual([lang, kind, many]);
          expect(many).toContain('7');
        }
        expect(one).not.toMatch(/\{|\}/);
        expect(many).not.toMatch(/\{|\}/);
      }
    }
    expect(filledNote(summary([{ kind: 'band', count: 3 }], 3), say('en'))).toBe('Completed from your example: 3 band boundaries (please confirm the 3 checks)');
    expect(filledNote(summary([{ kind: 'valueMap', count: 1 }, { kind: 'dayMonthOrder', count: 2 }, { kind: 'filterList', count: 1 }]), say('en'))).toBe(
      'Completed from your example: 1 translated value, the day/month order of 2 dates, 1 value in a filter',
    );
  });

  it('says nothing when code filled nothing', () => {
    expect(filledNote(undefined, say('en'))).toBeNull();
    expect(filledNote(summary([]), say('en'))).toBeNull();
    expect(filledNote(summary([{ kind: 'lookup', count: 0 }]), say('he'))).toBeNull();
  });
});

describe('the Result screen', () => {
  const okLive = async () => liveResult();

  async function openWith(first: LearnOutput, lang: 'en' | 'he' = 'en') {
    const en = lang === 'en';
    const liveCheck = vi.fn(okLive);
    const fake = fakeEngine(undefined, undefined, { liveCheck, fullCheck: liveCheck });
    fake.learn.mockImplementation(async () => first);
    renderApp({ engine: fake.engine, api: fakeApi({ user: USER }), lang });
    fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('in.csv')] } });
    fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('out.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await waitFor(() => expect((screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ })));
    await screen.findByTestId('rules-map');
  }

  it('after an AI learn, one quiet line sits with the learn-path note - and is not an alert', async () => {
    await openWith(learnResult({ path: 'llm', filled: summary([{ kind: 'lookup', count: 40 }, { kind: 'cutoff', count: 1 }], 1) }));
    const note = await screen.findByTestId('filled-note');
    expect(note.textContent).toBe('Completed from your example: 40 lookup entries, 1 cut-off (please confirm the check)');
    expect(note.className).toBe('muted');
    expect(note.getAttribute('role')).toBeNull();
    expect(note.previousElementSibling!.textContent).toBe('Learned with help from the server');
  });

  it('has its Hebrew copy', async () => {
    await openWith(learnResult({ path: 'llm', filled: summary([{ kind: 'lookup', count: 40 }, { kind: 'dayMonthOrder', count: 1 }]) }), 'he');
    expect((await screen.findByTestId('filled-note')).textContent).toBe('הושלם מהדוגמה שלכם: 40 רשומות חיפוש, סדר יום/חודש בתאריך אחד');
  });

  it('says nothing when code filled nothing, and nothing for a result the free engine built', async () => {
    await openWith(learnResult({ path: 'llm', filled: summary([]) }));
    expect(screen.queryByTestId('filled-note')).toBeNull();
    cleanup();
    await openWith(learnResult({ path: 'local', filled: summary([{ kind: 'lookup', count: 3 }]) }));
    expect(screen.queryByTestId('filled-note')).toBeNull();
  });
});
