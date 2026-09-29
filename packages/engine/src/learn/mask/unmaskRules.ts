// Turns fake words back into real words inside a rules object the LLM
// returned (SPEC 7.2, 15: "the masking map stays local... saved rules contain
// only real constants"). Implemented as a generic deep walk over every string
// leaf, guarded by a DENYLIST of structural keys that are never constants —
// so a field added to the rules schema later (a new expression op, a new
// summary-row field, ...) is unmasked automatically as long as it isn't a
// structural reference, with no change needed here.

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
]);

/** The one dictionary in the schema whose object *keys* (not just values) are
 * real data words: `transform.valueMaps[].map` maps a real "from" value to a
 * real "to" value (e.g. {"חיים": "LIFE"}). Every other record-typed field in
 * the schema is keyed by a synthetic id/column name. */
const OPEN_WORD_DICTIONARY_KEY = 'map';

function unmaskString(s: string, fakeToReal: ReadonlyMap<string, string>): string {
  if (s === '') return s;
  // A constant can mix label words (already real) and fake words (SPEC "Masked
  // values"): replace token-by-token, leaving anything not in the map as-is —
  // that covers real words, punctuation/separators, and anything that was
  // never masked in the first place.
  return splitWords(s)
    .map((t) => (t.isWord ? (fakeToReal.get(t.text) ?? t.text) : t.text))
    .join('');
}

function unmaskValue(
  value: unknown,
  keyContext: string | undefined,
  fakeToReal: ReadonlyMap<string, string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => unmaskValue(item, keyContext, fakeToReal));
  }
  if (value !== null && typeof value === 'object') {
    const isOpenWordDictionary = keyContext === OPEN_WORD_DICTIONARY_KEY;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const newKey = isOpenWordDictionary ? unmaskString(k, fakeToReal) : k;
      out[newKey] = unmaskValue(v, k, fakeToReal);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (keyContext !== undefined && STRUCTURAL_KEYS.has(keyContext)) return value;
    return unmaskString(value, fakeToReal);
  }
  return value; // number, boolean, null
}

/**
 * Returns a deep copy of `rules` with every fake word inside a constant
 * (value maps, filter/expression constants, labels, table cells, ...)
 * replaced by its real word, using `masker.fakeToReal`. Structural fields
 * (ids, column/table names, enum members, formats — see STRUCTURAL_KEYS) are
 * left untouched. `rules` is treated as plain JSON, so this works unchanged
 * across schema versions/additions.
 */
export function unmaskRules<T>(rules: T, masker: Pick<Masker, 'fakeToReal'>): T {
  return unmaskValue(rules, undefined, masker.fakeToReal) as T;
}
