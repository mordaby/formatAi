// Matching a file to a conversion (SPEC 8.12, DECISION 10): exact, then aliases, then normalized headers;
// score = share of required columns found minus a small penalty per extra column; auto-pick at >= 0.9 with a
// 0.1 margin, otherwise the top 3 for the user. Synthetic, domain-neutral signatures.
import { limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/pipeline';
import {
  headerSimilarity,
  inputSignatureOf,
  matchConversions,
  pickConversion,
  type ConversionSignatureInput,
  type SignatureColumnInput,
} from '../../src/registry';
import { col, rules, table } from '../pipeline/helpers';

function c(header: string, opts: Partial<SignatureColumnInput> = {}): SignatureColumnInput {
  return { header, aliases: [], type: 'text', required: true, ...opts };
}

const items: ConversionSignatureInput = {
  id: 'items',
  name: 'Item list',
  columns: [c('SKU', { aliases: ['Item Code'] }), c('Name'), c('Qty', { type: 'integer' }), c('Price', { type: 'decimal' })],
};
const orders: ConversionSignatureInput = {
  id: 'orders',
  name: 'Order export',
  columns: [c('Order No'), c('Customer'), c('Total', { type: 'decimal' }), c('Notes', { required: false })],
};
const contacts: ConversionSignatureInput = {
  id: 'contacts',
  name: 'Contacts',
  columns: [c('Full Name'), c('Email'), c('Phone')],
};

const first = <T>(xs: T[]): T => xs[0]!;

describe('matchConversions: how a header is found', () => {
  it('finds exact headers: score 1, nothing missing, nothing extra', () => {
    const [top] = matchConversions(['SKU', 'Name', 'Qty', 'Price'], [items, orders, contacts]);
    expect(top).toMatchObject({ id: 'items', name: 'Item list', score: 1, missingRequired: [], extra: [], renamedCandidates: [] });
  });

  it('finds a column by one of its aliases', () => {
    const [top] = matchConversions(['Item Code', 'Name', 'Qty', 'Price'], [items]);
    expect(top).toMatchObject({ score: 1, missingRequired: [], extra: [] });
  });

  it('finds a column by its normalized header: case, spacing, quote marks', () => {
    const [top] = matchConversions(['  sku ', 'NAME', 'qty', 'price'], [items]);
    expect(top).toMatchObject({ score: 1, missingRequired: [] });

    const he: ConversionSignatureInput = { id: 'he', name: 'he', columns: [c('מק"ט'), c('שם  פריט')] };
    const [hebrew] = matchConversions(['מק״ט', 'שם פריט'], [he]);
    expect(hebrew).toMatchObject({ score: 1, missingRequired: [] });
  });

  it('finds a normalized alias too', () => {
    const [top] = matchConversions(['item  CODE', 'Name', 'Qty', 'Price'], [items]);
    expect(top).toMatchObject({ score: 1, missingRequired: [] });
  });

  it('never claims one file column for two conversion columns, and an exact match beats a loose one', () => {
    const sig: ConversionSignatureInput = { id: 's', name: 's', columns: [c('Code'), c('code ', { aliases: ['Other'] })] };
    const [m] = matchConversions(['Code', 'Other'], [sig]);
    expect(m).toMatchObject({ score: 1, missingRequired: [], extra: [] });
    const [single] = matchConversions(['Code'], [sig]);
    expect(single!.missingRequired).toEqual(['code ']);
  });

  it('agrees with the engine: a file is "missing nothing" exactly when the rules can run it', () => {
    const r = rules({
      columns: [col('sku', 'text', { header: 'SKU', aliases: ['Item Code'], required: true }), col('name', 'text', { header: 'Name', required: true })],
    });
    const sig = { id: 'r', name: 'r', ...inputSignatureOf(r) };
    for (const headers of [['SKU', 'Name'], ['item code', 'name'], ['Item Code', 'Title'], ['Name'], ['SKU  ', ' name ']]) {
      const [m] = matchConversions(headers, [sig]);
      const res = runRules(r, table(headers, [['a', 'b']]));
      expect(m!.missingRequired.length === 0, headers.join('|')).toBe(res.ok);
    }
  });
});

describe('matchConversions: the score', () => {
  it('is the share of required columns found', () => {
    const [m] = matchConversions(['SKU', 'Name'], [items]);
    expect(m!.score).toBe(0.5);
    expect(m!.missingRequired).toEqual(['Qty', 'Price']);
  });

  it('ignores optional columns: missing or present, the score does not change', () => {
    const [without] = matchConversions(['Order No', 'Customer', 'Total'], [orders]);
    const [withNotes] = matchConversions(['Order No', 'Customer', 'Total', 'Notes'], [orders]);
    expect(without!.score).toBe(1);
    expect(withNotes!.score).toBe(1);
    expect(withNotes!.extra).toEqual([]);
  });

  it('subtracts a small penalty per extra unknown column, up to a cap', () => {
    const p = limits.matching.extraColumnPenalty;
    const three = matchConversions(['SKU', 'Name', 'Qty', 'Price', 'x1', 'x2', 'x3'], [items])[0]!;
    expect(three.extra).toEqual(['x1', 'x2', 'x3']);
    expect(three.score).toBeCloseTo(1 - 3 * p, 9);
    const many = matchConversions(['SKU', 'Name', 'Qty', 'Price', ...Array.from({ length: 40 }, (_, i) => `x${i}`)], [items])[0]!;
    expect(many.score).toBeCloseTo(1 - limits.matching.maxExtraPenalty, 9);
    expect(many.score).toBeGreaterThanOrEqual(limits.matching.autoScore);
  });

  it('ignores empty headers, and never goes below 0', () => {
    const [m] = matchConversions(['SKU', '', '  ', 'Name', 'Qty', 'Price'], [items]);
    expect(m!.extra).toEqual([]);
    const [none] = matchConversions(['a', 'b'], [items]);
    expect(none!.score).toBe(0);
  });

  it('uses every column when a conversion declares none as required', () => {
    const loose: ConversionSignatureInput = { id: 'l', name: 'l', columns: [c('A', { required: false }), c('B', { required: false })] };
    const [m] = matchConversions(['A'], [loose]);
    expect(m!.score).toBe(0.5);
    expect(m!.missingRequired).toEqual([]);
  });

  it('a conversion without columns scores 0', () => {
    const [m] = matchConversions(['A'], [{ id: 'e', name: 'e', columns: [] }]);
    expect(m!.score).toBe(0);
  });
});

describe('matchConversions: renamed columns', () => {
  it('offers the unclaimed file headers that look like a missing required column', () => {
    const [m] = matchConversions(['SKU', 'Product Name', 'Qty', 'Unit Price', 'Whatever'], [items]);
    expect(m!.missingRequired).toEqual(['Name', 'Price']);
    expect(m!.extra).toEqual(['Product Name', 'Unit Price', 'Whatever']);
    expect(m!.renamedCandidates).toEqual([
      { required: 'Name', candidates: ['Product Name'] },
      { required: 'Price', candidates: ['Unit Price'] },
    ]);
  });

  it('lists a missing column with no similar header as an entry with no candidates', () => {
    const [m] = matchConversions(['SKU', 'Name', 'Qty', 'Zzz'], [items]);
    expect(m!.renamedCandidates).toEqual([{ required: 'Price', candidates: [] }]);
  });

  it('never offers a header another column of the conversion already claimed', () => {
    const sig: ConversionSignatureInput = { id: 's', name: 's', columns: [c('Amount'), c('Total Amount')] };
    const [m] = matchConversions(['Total Amount', 'Amount (USD)', 'Amount Net'], [sig]);
    expect(m!.missingRequired).toEqual(['Amount']);
    expect(m!.renamedCandidates).toEqual([{ required: 'Amount', candidates: ['Amount (USD)', 'Amount Net'] }]);
  });

  it('offers at most the configured number, most similar first', () => {
    const sig: ConversionSignatureInput = { id: 's', name: 's', columns: [c('Amount')] };
    const [m] = matchConversions(['Amount (USD)', 'Amount Net', 'Amount Gross', 'Amounts', 'Amt X'], [sig]);
    const list = m!.renamedCandidates[0]!.candidates;
    expect(list).toHaveLength(limits.matching.maxRenamedCandidates);
    expect(list[0]).toBe('Amounts');
  });

  it('never offers a header the source already knew (ignoredHeaders), as a suggestion or among the others', () => {
    const sig: ConversionSignatureInput = { id: 's', name: 's', columns: [c('Name'), c('Phone'), c('Price')], ignoredHeaders: ['City', 'Unit Price'] };
    const [m] = matchConversions(['Name', 'City', 'Unit Price', 'Region'], [sig]);
    expect(m!.missingRequired).toEqual(['Phone', 'Price']);
    // still unclaimed (the score and the ranking are as before), but only "Region" can be a renamed column
    expect(m!.extra).toEqual(['City', 'Unit Price', 'Region']);
    expect(m!.unknownExtra).toEqual(['Region']);
    expect(m!.renamedCandidates).toEqual([
      { required: 'Phone', candidates: [] },
      { required: 'Price', candidates: [] },
    ]);
  });

  it('compares the ignored headers like the engine does: case, spacing and quotes do not matter', () => {
    const sig: ConversionSignatureInput = { id: 's', name: 's', columns: [c('Name'), c('Phone')], ignoredHeaders: ['  city', 'Cust.  Notes'] };
    const [m] = matchConversions(['Name', 'CITY', 'Cust. Notes', 'Mobile'], [sig]);
    expect(m!.unknownExtra).toEqual(['Mobile']);
  });

  it('costs no extra-column penalty: the source knows an ignored header, though it is still an extra column', () => {
    const plain: ConversionSignatureInput = { id: 's', name: 's', columns: [c('Name'), c('Phone')] };
    const [without] = matchConversions(['Name', 'Phone', 'City'], [plain]);
    const [withIgnored] = matchConversions(['Name', 'Phone', 'City'], [{ ...plain, ignoredHeaders: ['City'] }]);
    expect(without!.score).toBeLessThan(1);
    expect(withIgnored!.score).toBe(1);
    expect(withIgnored!.extra).toEqual(['City']);
    expect(withIgnored!.unknownExtra).toEqual([]);
  });

  it('a signature with no ignored headers offers every extra header, as before', () => {
    const [m] = matchConversions(['SKU', 'Product Name', 'Qty', 'Unit Price', 'Whatever'], [items]);
    expect(m!.unknownExtra).toEqual(m!.extra);
  });

  it('header similarity: punctuation, containment, partial overlap, nothing in common', () => {
    expect(headerSimilarity('Item-Code', 'item code')).toBe(1);
    expect(headerSimilarity('Price', 'Unit Price')).toBe(0.8);
    expect(headerSimilarity('Customer Name', 'Name of Customer')).toBeGreaterThanOrEqual(limits.matching.minRenamedSimilarity);
    expect(headerSimilarity('Quantity', 'Warehouse')).toBeLessThan(limits.matching.minRenamedSimilarity);
    expect(headerSimilarity('', 'x')).toBe(0);
    expect(headerSimilarity('מחיר', 'מחיר ליחידה')).toBe(0.8);
  });
});

describe('matchConversions: ranking', () => {
  it('returns every signature, best first, with ties broken by fewer missing, fewer extra, then id', () => {
    const ranked = matchConversions(['SKU', 'Name', 'Qty', 'Price'], [contacts, orders, items]);
    expect(ranked.map((m) => m.id)).toEqual(['items', 'contacts', 'orders']);
    expect(ranked.map((m) => m.score)).toEqual([1, 0, 0]);

    const a: ConversionSignatureInput = { id: 'a', name: 'a', columns: [c('X'), c('Y')] };
    const b: ConversionSignatureInput = { id: 'b', name: 'b', columns: [c('X'), c('Y')] };
    expect(matchConversions(['X', 'Y'], [b, a]).map((m) => m.id)).toEqual(['a', 'b']);
    expect(matchConversions(['X', 'Y'], [a, b]).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('is deterministic and does not modify its inputs', () => {
    const sigs = [items, orders, contacts];
    const before = structuredClone(sigs);
    const headers = ['SKU', 'Name', 'Qty', 'Order No'];
    expect(matchConversions(headers, sigs)).toEqual(matchConversions(headers, sigs));
    expect(sigs).toEqual(before);
    expect(matchConversions([], [])).toEqual([]);
  });
});

describe('pickConversion: the auto-pick threshold (DECISION 10)', () => {
  it('picks automatically when the top score is >= 0.9 and at least 0.1 above the next', () => {
    const ranked = matchConversions(['SKU', 'Name', 'Qty', 'Price'], [items, orders, contacts]);
    const pick = pickConversion(ranked);
    expect(pick.kind).toBe('auto');
    if (pick.kind === 'auto') expect(pick.match.id).toBe('items');
  });

  it('picks automatically when it is the only conversion', () => {
    expect(pickConversion(matchConversions(['SKU', 'Name', 'Qty', 'Price'], [items])).kind).toBe('auto');
  });

  it('exactly 0.9 is enough; 0.89 is not', () => {
    const ten: ConversionSignatureInput = { id: 'ten', name: 'ten', columns: Array.from({ length: 10 }, (_, i) => c(`Col ${i}`)) };
    const nine = Array.from({ length: 9 }, (_, i) => `Col ${i}`);
    const at = matchConversions(nine, [ten]);
    expect(at[0]!.score).toBe(0.9);
    expect(pickConversion(at).kind).toBe('auto');
    const below = matchConversions([...nine, 'a', 'b', 'c', 'd', 'e', 'f'].slice(0, 9), [{ ...ten, columns: ten.columns.slice(0, 9).concat([c('Col 9'), c('Col 10')]) }]);
    expect(below[0]!.score).toBeCloseTo(9 / 11, 5);
    expect(pickConversion(below).kind).toBe('choose');
  });

  it('a score below 0.9 is never picked automatically, even with no competitor', () => {
    const ranked = matchConversions(['SKU', 'Name', 'Qty'], [items]);
    expect(ranked[0]!.score).toBe(0.75);
    const pick = pickConversion(ranked);
    expect(pick).toEqual({ kind: 'choose', options: ranked });
  });

  it('asks the user when the runner-up is within 0.1 of the top, even at score 1', () => {
    const wide: ConversionSignatureInput = { id: 'wide', name: 'wide', columns: [...items.columns, c('Category', { required: false })] };
    // The file has all of items' columns; `wide` has one more it doesn't know (optional, so the score stays 1),
    // and `items` sees the file's extra column as unknown.
    const ranked = matchConversions(['SKU', 'Name', 'Qty', 'Price', 'Category'], [items, wide]);
    expect(ranked.map((m) => m.id)).toEqual(['wide', 'items']);
    expect(ranked[0]!.score - ranked[1]!.score).toBeLessThan(limits.matching.autoMargin);
    const pick = pickConversion(ranked);
    expect(pick.kind).toBe('choose');
    if (pick.kind === 'choose') expect(pick.options.map((m) => m.id)).toEqual(['wide', 'items']);
  });

  it('a margin of exactly 0.1 is enough', () => {
    const names = Array.from({ length: 10 }, (_, i) => 'C' + i);
    const ten = names.map((n) => c(n));
    const ranked = matchConversions(names, [
      { id: 'full', name: 'full', columns: ten },
      // 9 of its 10 required columns are in the file; the file's C9 is one of its optional columns, so no extras.
      { id: 'partial', name: 'partial', columns: [...ten.slice(0, 9), c('Zz'), c('C9', { required: false })] },
    ]);
    expect(ranked.map((m) => m.score)).toEqual([1, 0.9]);
    expect(pickConversion(ranked).kind).toBe('auto');
  });

  it('offers the top 3 (never a score of 0), and nothing when nothing matches', () => {
    const mk = (id: string, headers: string[]): ConversionSignatureInput => ({ id, name: id, columns: headers.map((h) => c(h)) });
    const sigs = [mk('a', ['P', 'Q']), mk('b', ['P', 'R']), mk('c', ['P', 'S']), mk('d', ['P', 'T']), mk('e', ['U', 'V'])];
    const pick = pickConversion(matchConversions(['P'], sigs));
    expect(pick.kind).toBe('choose');
    if (pick.kind === 'choose') expect(pick.options.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(pickConversion(matchConversions(['Z'], sigs))).toEqual({ kind: 'choose', options: [] });
    expect(pickConversion([])).toEqual({ kind: 'choose', options: [] });
  });
});

describe('inputSignatureOf', () => {
  it('lists the input columns: header, aliases, type and required, in order', () => {
    const r = rules({
      columns: [
        col('sku', 'idLike', { header: 'SKU', aliases: ['Item Code', 'Code'], required: true, padLeft: 8 }),
        col('qty', 'integer', { header: 'Qty' }),
        col('day', 'date', { header: 'Day', required: false, inputFormats: ['DD/MM/YYYY'] }),
      ],
    });
    expect(inputSignatureOf(r)).toEqual({
      columns: [
        { header: 'SKU', aliases: ['Item Code', 'Code'], type: 'idLike', required: true },
        { header: 'Qty', aliases: [], type: 'integer', required: false },
        { header: 'Day', aliases: [], type: 'date', required: false },
      ],
    });
  });

  it('copies: changing the signature does not touch the rules', () => {
    const r = rules({ columns: [col('a', 'text', { aliases: ['x'] })] });
    const sig = inputSignatureOf(r);
    sig.columns[0]!.aliases.push('y');
    expect(r.input.columns[0]!.aliases).toEqual(['x']);
  });

  it("scores 1 against the rules' own headers", () => {
    const r = rules({ columns: [col('a', 'text', { header: 'A', required: true }), col('b', 'text', { header: 'B', required: true })] });
    const [m] = matchConversions(['A', 'B'], [{ id: 'r', name: 'r', ...inputSignatureOf(r) }]);
    expect(m!.score).toBe(1);
  });
});
