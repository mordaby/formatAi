// SPEC 9.5 "Cache": the key is a hash of the STRUCTURE (headers, types, layout, masking mode),
// never of any cell value; if the same structure comes in again, the saved rules are returned
// without an LLM call, and the browser verifies them as usual.
//
// DECISION (privacy): rules can contain constants derived from one user's data - value-map entries,
// filter values, labels, split/replace text: masked fakes when masking is on, REAL values when it is
// off. So a cache entry is only ever returned to the SAME owner (anonId now, userId in M3), never
// across users: the store is keyed (owner, structureHash) and there is no lookup by hash alone. One
// user's data can therefore never surface in another user's rules, however identical the two
// structures are (which, for a generic report format, they often will be).
//
// DECISION (masking): with masking ON, a text constant in the cached rules is a fake made with the
// browser session's random HMAC key, which is gone by the next session - unmasking it would produce
// nonsense. So with masking on, an entry is stored and returned only when its rules contain no text
// constants at all (`rulesHaveTextConstants`); otherwise it is a miss and the learn goes to the LLM.
//
// DECISION (owner, 2026-10-05): with masking OFF nothing is cached at all. Its constants would be REAL values from the user's
// example (a name in a condition, a value-map entry) kept on the server even when the user never saves the format; the cache
// only saves an LLM call, so it isn't worth holding real data for. (An entry written under the old rule is never served: the
// read re-checks `isCacheable`; it expires with the TTL.)
import { createHash } from 'node:crypto';
import { promptVersion, type LearnPayload, type LearnResult } from '@formatai/shared';

/** Bump when the set of fields hashed below changes, so old entries can never match. */
const KEY_VERSION = 1;

/** Deterministic JSON: object keys sorted recursively, `undefined` fields dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * sha256 (hex) of the payload's STRUCTURE only: input headers + types (+ the input layout, which
 * shapes the rules' header/footer handling), output headers + types + formats, the output layout,
 * `output.file`, the masking flag, `promptVersion`, `skipColumns` and - when adding a source to an
 * existing format - the `target`. Samples, dropped rows, hints, profile stats and shapes are data
 * derived and are deliberately NOT part of it. The input sheet name is left out too: it often
 * carries a date or period ("Report 2026-09") and does not change how the rules are built.
 */
export function learnCacheKey(payload: LearnPayload): string {
  const structure = {
    v: KEY_VERSION,
    promptVersion,
    masking: payload.masking,
    input: {
      layout: payload.input.layout,
      columns: payload.input.columns.map((c) => ({ header: c.header, type: c.type })),
    },
    output: {
      file: payload.output.file,
      layout: payload.output.layout,
      columns: payload.output.columns.map((c) => ({ header: c.header, type: c.type, format: c.format ?? null })),
    },
    target: payload.target ?? null,
    skipColumns: [...(payload.skipColumns ?? [])].sort((a, b) => a - b),
  };
  return createHash('sha256').update(canonicalJson(structure)).digest('hex');
}

/** Keys whose string values are structural - ids, headers, enum words, formats - and therefore
 * identical in every session. Any string under a key NOT listed here is treated as a possible
 * data-derived constant (fail closed: a new rules field can only lower the hit rate, never leak). */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'op', 'col', 'param', 'fn', 'table', 'return', 'id', 'type', 'header', 'from', 'to', 'column',
  'columns', 'labelColumn', 'labelId', 'valueId', 'partId', 'indexId', 'countId', 'mode', 'pick',
  'dir', 'rule', 'when', 'agg', 'onMissing', 'keep', 'action', 'severity', 'on', 'direction',
  'language', 'valueType', 'returns', 'keys', 'sum', 'by', 'reasonCode', 'outputColumn', 'format',
  'inputFormats', 'sheetName', 'name', 'aliases', 'unit', 'part', 'delimiter', 'encoding', 'quote',
  'headerRow',
]);

/** A string counts as a text constant when it has a letter or a digit: masking rewrites words and
 * digits, but keeps separators and punctuation as they are. */
const WORD_CHARS = /[\p{L}\p{N}]/u;

function recordHasText(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([k, v]) => WORD_CHARS.test(k) || (typeof v === 'string' && WORD_CHARS.test(v)),
  );
}

function walk(value: unknown, key: string | null): boolean {
  if (typeof value === 'string') return !(key !== null && STRUCTURAL_KEYS.has(key)) && WORD_CHARS.test(value);
  if (Array.isArray(value)) return value.some((v) => walk(v, key));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => {
      // The open dictionaries: value-map / label entries are all constants, whatever their keys are.
      if (k === 'map' || k === 'labels') return recordHasText(v);
      // Summary-row cells map an output header to an aggregate name: both structural.
      if (k === 'cells') return false;
      return walk(v, k);
    });
  }
  return false;
}

/** True when `rules` carries any text constant derived from the user's data or labels: value-map
 * or label entries, filter/`oneOf`/`switch`/`replaceText`/`startsWith` text, title and summary
 * labels, lookup-table cells, footer stop values, `oneOf` validations. Numbers, dates, ids,
 * headers and enum words are not text constants. */
export function rulesHaveTextConstants(rules: LearnResult): boolean {
  return walk(rules, null);
}

/** Whether `rules`, learned with this masking mode, may be stored in and served from the cache. */
export function isCacheable(rules: LearnResult, masking: boolean): boolean {
  return masking && !rulesHaveTextConstants(rules);
}
