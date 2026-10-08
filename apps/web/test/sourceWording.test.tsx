// "Users never see the word 'source' while the switch is off" (owner decision 2026-10-07): a format is the output, and each kind of input file
// that makes it has its own rules - kept as a "source" behind the scenes. With "Formats with several sources" OFF the app says "input file":
// the format page lists its "Input files" by their saved names (no rename; "Remove this input file" unless it is the last one), the saved
// editor says "An input file of X", and the Run screen and every message say the same. With the switch ON the app says what it always said.
// Two kinds of test: every message that says "source" is either reworded or shown only by the explicit source UI (the dictionaries), and the
// rendered text of the format page, the editor and the Run screen holds no "source" (en, he).
import type { Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { ordersRules } from '../src/editor/testkit';
import { en, he, type MessageKey } from '../src/i18n';
import { inputCodeWording, inputWordingEn, inputWordingHe, SOURCE_UI_ONLY } from '../src/i18n/inputWording';
import { entry, fakeConvertApi, match } from './helpers/convertKit';
import { conversionDetail, conversionSummary, getFormatResponse } from './helpers/registryKit';
import { fakeApi, fakeEngine, renderApp, USER } from './helpers/renderApp';
import { apiErrorMessages, limitMessages, preflightWarnMessages } from '@formatai/shared';

vi.mock('../src/app/redirect', () => ({ redirectTo: vi.fn() }));
// The Run screen's own API: a fake (GET /api/signatures and the rest).
const convert = vi.hoisted(() => ({ api: null as unknown }));
vi.mock('../src/api/convert', async (original) => ({ ...(await original<typeof import('../src/api/convert')>()), useConvertApi: () => convert.api }));

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPendingStore(undefined);
});

/** The word, in either language ("מקורי" - original - is another word). */
const SOURCE_EN = /\bsources?\b/i;
const SOURCE_HE = /מקור(?!י)/;
/** (a `{source}` placeholder is a name the user gave, not the word) */
const saysSource = (text: string): boolean => {
  const words = text.replace(/\{\w+\}/g, '');
  return SOURCE_EN.test(words) || SOURCE_HE.test(words);
};
const pageText = (): string => document.body.textContent ?? '';

describe('the input wording (the dictionaries)', () => {
  it('every message that says "source" is reworded, or is shown only by the explicit source UI', () => {
    const reworded = new Set(Object.keys(inputWordingEn));
    const sourceOnly = new Set<string>(SOURCE_UI_ONLY);
    const missing = (Object.keys(en) as MessageKey[]).filter((k) => (saysSource(en[k]) || saysSource(he[k])) && !reworded.has(k) && !sourceOnly.has(k) && !k.startsWith('admin.'));
    expect(missing).toEqual([]);
  });

  it('the reworded messages never say it, in either language, and keep their placeholders', () => {
    for (const [k, text] of Object.entries(inputWordingEn)) {
      expect(saysSource(text), k).toBe(false);
      expect(saysSource(inputWordingHe[k as keyof typeof inputWordingHe]), k).toBe(false);
      const params = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
      expect(params(text), k).toEqual(params(en[k as MessageKey]));
      expect(params(inputWordingHe[k as keyof typeof inputWordingHe]), k).toEqual(params(he[k as MessageKey]));
    }
  });

  it('the shared codes that say it are reworded too', () => {
    for (const [code, text] of Object.entries(apiErrorMessages)) {
      if (saysSource(text.en) || saysSource(text.he)) expect(inputCodeWording.apiError[code as keyof typeof apiErrorMessages], code).toBeDefined();
    }
    for (const [code, text] of Object.entries(limitMessages)) {
      if (saysSource(text.en) || saysSource(text.he)) expect(inputCodeWording.limit[code as keyof typeof limitMessages], code).toBeDefined();
    }
    for (const [code, text] of Object.entries(preflightWarnMessages)) {
      if (saysSource(text.en) || saysSource(text.he)) expect(inputCodeWording.preflight[code as keyof typeof preflightWarnMessages], code).toBeDefined();
    }
    for (const group of Object.values(inputCodeWording)) for (const text of Object.values(group)) expect(saysSource(text!.en) || saysSource(text!.he)).toBe(false);
  });
});

const two = () =>
  getFormatResponse({
    id: 'F1',
    name: 'Orders report',
    sources: [conversionSummary({ id: 'C1', sourceName: 'Supplier A', runCount: 3, lastRun: { rows: 120, flagged: 4 } }), conversionSummary({ id: 'C2', sourceName: 'Supplier B', status: 'needsReview' })],
  });
const one = () => getFormatResponse({ id: 'F1', name: 'Orders report', sources: [conversionSummary({ id: 'C1', sourceName: 'Supplier A' })] });

describe('the format page', () => {
  it('switched off: "Input files" by their saved names, no rename, "Remove this input file" with a confirm - and no "source" anywhere', async () => {
    const deleteConversion = vi.fn(async () => undefined);
    renderApp({ api: fakeApi({ user: USER, registry: { getFormat: vi.fn(async () => two()), deleteConversion } }), route: '/formats/F1' });
    expect(await screen.findByRole('heading', { name: 'Orders report' })).toBeTruthy();
    await act(async () => {});
    expect(screen.getByRole('heading', { level: 2, name: 'Input files' })).toBeTruthy();
    const rows = screen.getAllByTestId('source-row');
    expect(rows.map((r) => within(r).getByRole('heading').textContent)).toEqual(['Supplier A', 'Supplier B']);
    expect(screen.queryByRole('button', { name: /Rename/ })).toBeNull();
    expect(saysSource(pageText())).toBe(false);

    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Remove this input file' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the input file "Supplier B"?' });
    expect(dialog.textContent).toContain('The format and its other input files stay.');
    expect(saysSource(pageText())).toBe(false);
    await act(async () => void fireEvent.click(within(dialog).getByRole('button', { name: 'Remove this input file' })));
    await waitFor(() => expect(deleteConversion).toHaveBeenCalledWith('C2'));
    await waitFor(() => expect(screen.getAllByTestId('source-row')).toHaveLength(1));
    // The format's last input file is not removed here (the format itself is deleted from My formats).
    expect(screen.queryByRole('button', { name: 'Remove this input file' })).toBeNull();
  });

  it('switched off, a format with one input file: nothing to remove', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { getFormat: vi.fn(async () => one()) } }), route: '/formats/F1' });
    expect(await screen.findByRole('heading', { name: 'Orders report' })).toBeTruthy();
    await act(async () => {});
    expect(screen.getAllByTestId('source-row')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Remove this input file' })).toBeNull();
  });

  it('switched off, in Hebrew', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { getFormat: vi.fn(async () => two()) } }), route: '/formats/F1', lang: 'he' });
    expect(await screen.findByRole('heading', { name: 'Orders report' })).toBeTruthy();
    await act(async () => {});
    expect(screen.getByRole('heading', { level: 2, name: 'קובצי קלט' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'הסרת קובץ הקלט הזה' })).toHaveLength(2);
    expect(saysSource(pageText())).toBe(false);
  });

  it('switched on: as ever - "Sources", rename and delete', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { getFormat: vi.fn(async () => one()) }, features: { formatSources: true } }), route: '/formats/F1' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Sources' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename source' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete source' })).toBeTruthy();
  });
});

/** The orders rules without their external column. */
function cleanRules(): Rules {
  const rules = ordersRules();
  rules.output.columns = rules.output.columns.filter((c) => c.header !== 'Remarks');
  rules.unsupported = [];
  return rules;
}

function editorApi(formatSources: boolean) {
  return fakeApi({
    user: USER,
    features: { formatSources },
    registry: {
      getConversion: vi.fn(async () => conversionDetail({ id: 'C1', version: 4, sourceName: 'Supplier A' }, cleanRules())),
      getFormat: vi.fn(async () => two()),
      versions: vi.fn(async () => [{ version: 4, at: '2026-09-01T10:00:00.000Z', status: 'verified' as const, acceptedDifferences: 0, current: true }]),
    },
  });
}

describe('the saved editor', () => {
  for (const lang of ['en', 'he'] as const) {
    it(`switched off (${lang}): "An input file of X", and no "source" anywhere`, async () => {
      renderApp({ api: editorApi(false), engine: fakeEngine().engine, route: '/formats/F1/sources/C1', lang });
      await screen.findByTestId('rules-map');
      await act(async () => {});
      expect(pageText()).toContain(lang === 'en' ? 'An input file of "Orders report". We do not keep your files.' : 'קובץ קלט של "Orders report". אנחנו לא שומרים את הקבצים שלכם.');
      expect(saysSource(pageText())).toBe(false);
    });
  }

  it('switched on: "A source of X", as ever', async () => {
    renderApp({ api: editorApi(true), engine: fakeEngine().engine, route: '/formats/F1/sources/C1' });
    await screen.findByTestId('rules-map');
    expect(await screen.findByText('A source of "Orders report". We do not keep your files.')).toBeTruthy();
  });
});

describe('the Run screen', () => {
  const entries = [
    entry({ conversionId: 'c1', sourceId: 'S1', sourceName: 'Supplier A', formatId: 'F1', formatName: 'Orders report' }),
    entry({ conversionId: 'c2', sourceId: 'S2', sourceName: 'Supplier B', formatId: 'F2', formatName: 'Stock list' }),
  ];
  /** A dropped file two input kinds fit: the screen asks which. */
  function openRun(formatSources: boolean, lang: 'en' | 'he' = 'en') {
    convert.api = fakeConvertApi({ user: USER, entries });
    const matchFile = vi.fn(async () => {
      const options = [match({ id: 'S1', name: 'Supplier A', score: 0.8 }), match({ id: 'S2', name: 'Supplier B', score: 0.78 })];
      return { ok: true, headers: ['Item Code', 'Qty'], ranked: options, pick: { kind: 'choose', options } };
    });
    const { engine } = fakeEngine(undefined, undefined, { matchFile });
    renderApp({ api: fakeApi({ user: USER, features: { formatSources } }), engine, route: '/convert', lang });
    return { matchFile };
  }

  for (const lang of ['en', 'he'] as const) {
    it(`switched off (${lang}): the screen and the "which kind of input file" question hold no "source"`, async () => {
      const { matchFile } = openRun(false, lang);
      const drop = await screen.findByLabelText(lang === 'en' ? 'Files to convert' : 'קבצים להמרה');
      await act(async () => {});
      expect(saysSource(pageText())).toBe(false);
      fireEvent.change(drop, { target: { files: [new File(['a'], 'stock.csv', { type: 'text/csv' })] } });
      await waitFor(() => expect(matchFile).toHaveBeenCalled());
      expect(await screen.findByRole('heading', { name: lang === 'en' ? 'Which kind of input file is this?' : 'איזה סוג של קובץ קלט זה?' })).toBeTruthy();
      expect(saysSource(pageText())).toBe(false);
    });
  }

  it('switched on: "Which source is this file?", as ever', async () => {
    const { matchFile } = openRun(true);
    const drop = await screen.findByLabelText('Files to convert');
    await act(async () => {});
    fireEvent.change(drop, { target: { files: [new File(['a'], 'stock.csv', { type: 'text/csv' })] } });
    await waitFor(() => expect(matchFile).toHaveBeenCalled());
    expect(await screen.findByRole('heading', { name: 'Which source is this file?' })).toBeTruthy();
  });

});
