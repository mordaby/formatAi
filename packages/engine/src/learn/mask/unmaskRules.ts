// Turns fake words back into real words inside a rules object the LLM
// returned (SPEC 7.2, 15: "the masking map stays local... saved rules contain
// only real constants"). Implemented as a generic deep walk over every string
// leaf, guarded by a DENYLIST of structural keys that are never constants —
// so a field added to the rules schema later (a new expression op, a new
// summary-row field, ...) is unmasked automatically as long as it isn't a
// structural reference, with no change needed here.

import { maskingIdentifiers } from '@formatai/shared';
import type { Masker } from './masker';
import { splitWords } from './words';

// Keys whose *string* value is a structural reference (an id, a column name,
// an enum member, a format token, ...) rather than a constant copied from the
// user's data, and so must never be run through the fake->real map. Values
// under any OTHER key are treated as constants and unmasked. Object KEYS are
// never touched here either, except the one open dictionary whose keys really
// are data words (`transform.valueMaps[].map` — see below), because every
// other keyed dictionary in the schema (expand.columnsToRows.labels,
// fixedFanOut.rows[].set, lookup tables' row cells, ...) is keyed by a
// synthetic id or column name the LLM invents, never by a real data word.
//
// Seed list per the M1 spec, plus fields with the same "always structural"
// shape found in packages/shared/src/rules/schema.ts (VALUE_TYPES/ColumnType
// enums, delimiters, dedupe/sum/table-column id arrays, and so on).
const STRUCTURAL_KEYS = new Set<string>([
  // SPEC-given seed list
  'op',
  'id',
  'col',
  'column',
  'from',
  'header',
  'headers',
  'type',
  'name',
  'fn',
  'param',
  'params',
  'table',
  'return',
  'returns',
  'labelColumn',
  'keys',
  'by',
  'format',
  'inputFormats',
  'aliases',
  'sheet',
  'pick',
  'reasonCode',
  'outputColumn',
  'rule',
  'severity',
  'on',
  'mode',
  'labelId',
  'valueId',
  'partId',
  'indexId',
  'countId',
  'dir',
  'agg',
  // Additional structural fields with the same shape (ids, column names or
  // fixed enum members — never copied from a data cell):
  'valueType', // Expand.columnsToRows.valueType: ColumnType
  'sum', // GroupSubtotal/GrandTotal.sum: column ids
  'columns', // RulesTable.columns: synthetic column names (input/output.columns hold objects, unaffected)
  'when', // StopAt.when: fixed enum literal
  'part', // datePart.part: 'year' | 'month' | 'day'
  'unit', // dateDiff.unit: 'days' | 'months' | 'years'
  'onMissing', // lookup/valueMap onMissing: fixed enum
  'char', // padLeft.char: the LLM's own choice of pad character, not data
  'delimiter',
  'encoding',
  'quote',
  // More fixed words (never a data word; they matter once a rules file is MASKED, see `maskRules`: a real word here would turn into a fake one):
  'headerRow', // 'auto'
  'sheetName', // a label, sent real with the example's layout
  'direction', // 'rtl' | 'ltr'
  'language', // 'he' | 'en'
  'keep', // Dedupe.keep
  'action', // Dedupe.action
]);

/** Summary-row `cells` map an OUTPUT HEADER to an aggregate name: both structural, so the whole subtree is left alone. */
const STRUCTURAL_SUBTREE_KEY = 'cells';

/** The one dictionary in the schema whose object *keys* (not just values) are
 * real data words: `transform.valueMaps[].map` maps a real "from" value to a
 * real "to" value (e.g. {"חיים": "LIFE"}). Every other record-typed field in
 * the schema is keyed by a synthetic id/column name. */
const OPEN_WORD_DICTIONARY_KEY = 'map';

/** A short number written as digits (no leading zero, fewer than `maskingIdentifiers.minUnmaskDigits`): see `unmaskString`. */
function isShortNumber(token: string): boolean {
  return /^[1-9][0-9]*$/.test(token) && token.length < maskingIdentifiers.minUnmaskDigits;
}

/**
 * One constant the AI wrote, unmasked. Amendment 2026-10-07 (engine audit) - THE RULE:
 *  1. a constant that is a WHOLE masked value (a cell or a constant exactly as the masker returned it, `Masker.realOfWhole`) is that
 *     value: restored whole;
 *  2. otherwise token by token: a word the masker produced as a fake (`fakeToReal`) is restored - except a short number (1-3 digits, no
 *     leading zero; the same threshold as a number constant, `Masker.realNumberOf`), which is kept as written: the AI's own "1" or "12"
 *     is far more likely than a short fake, and with few digits a fake takes nearly every value ("Floor 1" .. "Floor 9" make every digit
 *     a fake, and the AI's constant "1" came back as "9"). A run with leading zeros ("073") is a fake's: a fake keeps the real zeros.
 * Anything else (label words, punctuation, words never masked) stays as it is.
 */
function unmaskString(s: string, fakeToReal: ReadonlyMap<string, string>, realOfWhole?: (fake: string) => string | undefined): string {
  if (s === '') return s;
  const whole = realOfWhole?.(s);
  if (whole !== undefined) return whole;
  return splitWords(s)
    .map((t) => (t.isWord && !isShortNumber(t.text) ? (fakeToReal.get(t.text) ?? t.text) : t.text))
    .join('');
}

/**
 * Amendment 2026-10-06 (identifiers stored as numbers are masked): the keys a NUMBER constant copied from the data can sit under - an
 * expression's `{ const }` leaf, `oneOf`'s `values`, a row filter's `value` (one, or a list), a lookup table's `rows`. Every other number
 * in a rules file is structural (`round`'s digits, `substr`'s start, `padLeft`, a header row, a width, a range check's min/max) and is
 * never mapped, so a fake ID that happens to equal one cannot change it.
 */
const NUMBER_CONSTANT_KEYS = new Set<string>(['const', 'values', 'value', 'rows']);

interface ConstantFns {
  text: (s: string) => string;
  number?: (n: number) => number;
}

function mapValue(value: unknown, keyContext: string | undefined, fns: ConstantFns): unknown {
  if (keyContext === STRUCTURAL_SUBTREE_KEY) return value;
  if (Array.isArray(value)) {
    return value.map((item) => mapValue(item, keyContext, fns));
  }
  if (value !== null && typeof value === 'object') {
    const isOpenWordDictionary = keyContext === OPEN_WORD_DICTIONARY_KEY;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const newKey = isOpenWordDictionary ? fns.text(k) : k;
      out[newKey] = mapValue(v, k, fns);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (keyContext !== undefined && STRUCTURAL_KEYS.has(keyContext)) return value;
    return fns.text(value);
  }
  if (typeof value === 'number' && fns.number && keyContext !== undefined && NUMBER_CONSTANT_KEYS.has(keyContext)) return fns.number(value);
  return value; // any other number, boolean, null
}

/**
 * Returns a deep copy of `rules` with `fn` applied to every constant: every string that is not under a
 * structural key (see STRUCTURAL_KEYS), plus the keys of the one open word dictionary - and, given `numberFn`,
 * every number in a constant position (NUMBER_CONSTANT_KEYS). The shared walk behind `unmaskRules`
 * (fake -> real) and `maskRules` (real -> fake, for the rules a completion call sends).
 */
export function mapRuleConstants<T>(rules: T, fn: (s: string) => string, numberFn?: (n: number) => number): T {
  return mapValue(rules, undefined, numberFn ? { text: fn, number: numberFn } : { text: fn }) as T;
}

/**
 * Returns a deep copy of `rules` with every fake word inside a constant
 * (value maps, filter/expression constants, labels, table cells, ...)
 * replaced by its real word, using `masker.fakeToReal`. Structural fields
 * (ids, column/table names, enum members, formats — see STRUCTURAL_KEYS) are
 * left untouched. `rules` is treated as plain JSON, so this works unchanged
 * across schema versions/additions.
 *
 * Amendment 2026-10-06: a NUMBER constant (`{ const: 912384771 }`, a filter value, a table cell) that is the fake of an ID stored as a
 * number - or written by the AI as a number for an ID it saw as digits - is unmasked too (`Masker.realNumberOf`: only fakes of whole
 * IDs of 4+ digits; any other number is left as it is).
 */
export function unmaskRules<T>(rules: T, masker: Pick<Masker, 'fakeToReal'> & Partial<Pick<Masker, 'realNumberOf' | 'realOfWhole'>>): T {
  const realNumberOf = masker.realNumberOf;
  return mapRuleConstants(
    rules,
    (s) => unmaskString(s, masker.fakeToReal, masker.realOfWhole),
    realNumberOf ? (n) => realNumberOf(n) ?? n : undefined,
  );
}

/**
 * The inverse of `unmaskRules`: a deep copy of `rules` (real Expr trees, not formula text) with every constant
 * masked like the samples are (SPEC 7.2) - the `complete.fixed` of a completion call. A pure-digit constant is
 * masked like an ID cell (so it matches a masked ID in the samples), a constant with a letter like text, and a
 * constant with neither (a separator, a date) stays; label words the payload sends real stay real. Structural
 * fields are untouched, exactly as in `unmaskRules`. A NUMBER constant that is a real ID the masker has masked
 * as a number (amendment 2026-10-06, `Masker.fakeNumberOf`) is masked like it; every other number stays real.
 */
export function maskRules<T>(rules: T, masker: Pick<Masker, 'maskText' | 'maskIdLike'> & Partial<Pick<Masker, 'fakeNumberOf'>>): T {
  const fakeNumberOf = masker.fakeNumberOf;
  return mapRuleConstants(
    rules,
    (s) => {
      if (/^[0-9]{1,9}$/.test(s)) return masker.maskIdLike(s);
      // No letter at all (a separator, a date like 2026-01-31, a number written as text): sent real, like numbers and dates are in the samples.
      if (!/\p{L}/u.test(s)) return s;
      return masker.maskText(s);
    },
    fakeNumberOf ? (n) => fakeNumberOf(n) ?? n : undefined,
  );
}
