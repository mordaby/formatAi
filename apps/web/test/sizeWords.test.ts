// "Same name, different size" in words (SPEC 5 C, 8.15, 2026-10-08): the sizes as people say them (the tens, thousands, tens of thousands ...) in
// English and Hebrew, plain numbers for the decades nobody names, the attention that carries them, and the worker method that finds them.
import type { SizeRange } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { createConvertApi } from '../src/api/convert';
import { codeText, translate, type I18n, type Lang, type MessageKey } from '../src/i18n';
import { attentionLines, runAnywayLabel, willRunText } from '../src/pages/Convert/attention';
import { attentionOfGaps, canRunAnyway, keepsSizeRange, requiredAcross, sizeColumnsOf, sizeRangesToWiden, type SizeColumn } from '../src/pages/Convert/logic';
import { fileSizePhrase, savedSizePhrase } from '../src/pages/Convert/sizeWords';
import { createEngineClient } from '../src/worker/engineClient';
import { engineMethods } from '../src/worker/engineMethods';
import { loopbackWorker } from './helpers/loopback';
import { RULES } from './helpers/convertKit';

const i18n = (lang: Lang): I18n => ({ lang, dir: lang === 'he' ? 'rtl' : 'ltr', setLang: () => {}, toggle: () => {}, t: (key, params) => translate(lang, key, params), code: (msg) => codeText(lang, msg) });
const en = i18n('en');
const he = i18n('he');
const plain = (s: string): string => s.replace(/[⁦-⁩]/g, '');

const column = (over: Partial<SizeColumn> = {}): SizeColumn => ({ id: 'c_total', header: 'Total', saved: { lo: 3, hi: 4 }, file: { lo: 1, hi: 1 }, median: 1, ...over });

describe('the file side: where the numbers mostly are', () => {
  it('English: "in the" and the decade\'s word', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => fileSizePhrase(en, d))).toEqual([
      'in the single digits',
      'in the tens',
      'in the hundreds',
      'in the thousands',
      'in the tens of thousands',
      'in the hundreds of thousands',
      'in the millions',
      'in the tens of millions',
      'in the hundreds of millions',
      'in the billions',
    ]);
  });

  it('Hebrew: the preposition is part of the word', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((d) => fileSizePhrase(he, d))).toEqual(['בספרות בודדות', 'בעשרות', 'במאות', 'באלפים', 'בעשרות אלפים', 'במאות אלפים', 'במיליונים', 'בעשרות מיליונים']);
  });

  it('a decade nobody names is said as the plain numbers it spans, in the UI language', () => {
    expect(fileSizePhrase(en, -2)).toBe('between 0.01 and 0.1');
    expect(fileSizePhrase(en, 10)).toBe('between 10,000,000,000 and 100,000,000,000');
    expect(fileSizePhrase(he, -1)).toBe('בין 0.1 ל-1');
  });
});

describe('the saved side: what the format was learned on', () => {
  it('one decade is its word; a span is "from to"', () => {
    expect(savedSizePhrase(en, { lo: 3, hi: 3 })).toBe('thousands');
    expect(savedSizePhrase(en, { lo: 3, hi: 4 })).toBe('thousands to tens of thousands');
    expect(savedSizePhrase(en, { lo: 0, hi: 2 })).toBe('single digits to hundreds');
    expect(savedSizePhrase(he, { lo: 3, hi: 4 })).toBe('אלפים עד עשרות אלפים');
    expect(savedSizePhrase(he, { lo: 6, hi: 6 })).toBe('מיליונים');
  });

  it('when an end has no word, the whole range is plain numbers: from 10^lo up to 10^(hi+1)', () => {
    expect(savedSizePhrase(en, { lo: -2, hi: 1 })).toBe('numbers from 0.01 to 100');
    expect(savedSizePhrase(en, { lo: 8, hi: 11 })).toBe('numbers from 100,000,000 to 1,000,000,000,000');
    expect(savedSizePhrase(he, { lo: -1, hi: 0 })).toBe('מספרים בין 0.1 ל-10');
  });

  it('the dictionary has a word for every decade the code names, in both languages', () => {
    for (let d = 0; d <= 9; d++) {
      const key = `conv.size.d${d}` as MessageKey;
      expect(translate('en', key).length).toBeGreaterThan(0);
      expect(translate('he', key).length).toBeGreaterThan(0);
    }
  });
});

describe('the sentence', () => {
  it('names the column and both sizes, and only says the file looks different', () => {
    const lines = attentionLines(en, 'Load file', { kind: 'size', columns: [column()] }).map(plain);
    expect(lines).toEqual(["'Total' in this file is mostly in the tens; this format was learned on thousands to tens of thousands."]);
    expect(lines.join(' ')).not.toMatch(/correct|wrong|should|error/i);
    const hebrew = attentionLines(he, 'קובץ טעינה', { kind: 'size', columns: [column()] }).map(plain);
    expect(hebrew).toEqual(["בעמודה 'Total' בקובץ הזה הערכים הם בעיקר בעשרות; הפורמט הזה נלמד על אלפים עד עשרות אלפים."]);
  });

  it('one line per column, and it comes after the missing-columns lines when a format has both', () => {
    const both = attentionOfGaps([{ header: 'SKU', required: false }], [column(), column({ id: 'c_qty', header: 'Qty', median: 7, saved: { lo: 0, hi: 1 } })])!;
    expect(attentionLines(en, 'Report', both).map(plain)).toEqual([
      "Report uses 'SKU', which is not in this file.",
      "'Total' in this file is mostly in the tens; this format was learned on thousands to tens of thousands.",
      "'Qty' in this file is mostly in the tens of millions; this format was learned on single digits to tens.",
    ]);
  });

  it('uses no word the source-wording rule forbids', () => {
    const text = attentionLines(en, 'F', { kind: 'size', columns: [column()] }).join(' ') + attentionLines(he, 'F', { kind: 'size', columns: [column()] }).join(' ');
    expect(text).not.toMatch(/source|מקור/i);
  });
});

describe('the attention', () => {
  it('a format with no gaps and no size is none; a size alone is its own reason; a size with missing columns is an addition to them', () => {
    expect(attentionOfGaps([], [])).toBeNull();
    expect(attentionOfGaps([])).toBeNull();
    expect(attentionOfGaps([], [column()])).toEqual({ kind: 'size', columns: [column()] });
    expect(attentionOfGaps([{ header: 'SKU', required: false }], [column()])).toEqual({ kind: 'missing', columns: ['SKU'], required: [], size: [column()] });
    expect(attentionOfGaps([{ header: 'SKU', required: true }])).toEqual({ kind: 'missing', columns: ['SKU'], required: ['SKU'] });
  });

  it('can run anyway (a size is not the engine\'s refusal), unless a required column is missing', () => {
    expect(canRunAnyway({ kind: 'size', columns: [column()] })).toBe(true);
    expect(canRunAnyway(attentionOfGaps([{ header: 'SKU', required: false }], [column()])!)).toBe(true);
    expect(canRunAnyway(attentionOfGaps([{ header: 'SKU', required: true }], [column()])!)).toBe(false);
    // ...so a source whose only problem is size is not the missing-columns stop
    expect(requiredAcross([{ kind: 'size', columns: [column()] }])).toEqual([]);
  });

  it('"Run anyway" says so plainly, and what will happen', () => {
    const size = { kind: 'size' as const, columns: [column()] };
    expect(runAnywayLabel(en, size)).toBe('Run anyway');
    expect(willRunText(en, size)).toBe('Will be made as it is');
    expect(runAnywayLabel(he, size)).toBe('להריץ בכל זאת');
  });

  it('what Run anyway widens with is this file\'s range of each column, nothing else', () => {
    const size = { kind: 'size' as const, columns: [column({ file: { lo: 0, hi: 1 } }), column({ id: 'c_qty', header: 'Qty', file: { lo: 2, hi: 2 } })] };
    expect(sizeRangesToWiden(size)).toEqual({ c_total: { lo: 0, hi: 1 }, c_qty: { lo: 2, hi: 2 } });
    expect(sizeColumnsOf(size)).toHaveLength(2);
    expect(sizeRangesToWiden({ kind: 'values', columns: [{ header: 'Qty', type: 'integer' }] })).toEqual({});
    expect(sizeRangesToWiden({ kind: 'missing', columns: ['SKU'], required: [] })).toEqual({});
    const range: SizeRange = { lo: 0, hi: 1 };
    expect(Object.keys(sizeRangesToWiden({ kind: 'size', columns: [column({ file: range })] }).c_total!).sort()).toEqual(['hi', 'lo']);
  });

  it('only rules that keep a size range need the file read', () => {
    expect(keepsSizeRange(RULES)).toBe(false);
    expect(keepsSizeRange({ ...RULES, input: { ...RULES.input, columns: RULES.input.columns.map((c, i) => (i === 1 ? { ...c, range: { lo: 0, hi: 1 } } : c)) } })).toBe(true);
  });
});

describe('the API client', () => {
  it('POST /api/conversions/:id/widen-ranges with column ids and two integers each, and nothing else', async () => {
    const fetchMock = async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ widened: ['c_qty'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const calls: [string, RequestInit][] = [];
    const api = createConvertApi({ baseUrl: 'https://api.test', fetch: (async (u: RequestInfo | URL, i?: RequestInit) => (calls.push([String(u), i ?? {}]), fetchMock(u, i))) as unknown as typeof fetch });
    // A caller cannot make anything else ride along: the body is built field by field.
    const widened = await api.widenRanges('c/1', { c_qty: { lo: 0, hi: 1, median: 5, fileName: 'jan.csv' } as SizeRange });
    expect(widened).toEqual(['c_qty']);
    const [url, init] = calls[0]!;
    expect(url).toBe('https://api.test/api/conversions/c%2F1/widen-ranges');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ columns: { c_qty: { lo: 0, hi: 1 } } });
  });
});

describe('the worker method sizeGaps', () => {
  const enc = (s: string): ArrayBuffer => {
    const u8 = new TextEncoder().encode(s);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
  };
  const engine = () => createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });
  const ranged = (range: SizeRange) => ({ ...RULES, input: { ...RULES.input, columns: RULES.input.columns.map((c) => (c.id === 'c_qty' ? { ...c, range } : c)) } });
  const CSV = 'Item Code,Qty,Price\n00001,12,1\n00002,30,2\n00003,7,3\n';

  it('answers per rules, in order: ids, headers and decades - no value', async () => {
    const out = await engine().sizeGaps({ file: { name: 'a.csv', bytes: enc(CSV) }, rules: [ranged({ lo: 3, hi: 4 }), ranged({ lo: 0, hi: 1 }), RULES] });
    expect(out).toEqual([[{ id: 'c_qty', header: 'Qty', saved: { lo: 3, hi: 4 }, file: { lo: 0, hi: 1 }, median: 1 }], [], []]);
  });

  it('does not open the file at all when no rules keep a range (old rules cost nothing, even with a file that is not one)', async () => {
    const out = await engine().sizeGaps({ file: { name: 'a.csv', bytes: enc('not a table') }, rules: [RULES, RULES] });
    expect(out).toEqual([[], []]);
  });

  it('a file that cannot be opened claims nothing', async () => {
    const out = await engine().sizeGaps({ file: { name: 'broken.xlsx', bytes: enc('not a workbook') }, rules: [ranged({ lo: 3, hi: 4 })] });
    expect(out).toEqual([[]]);
  });
});
